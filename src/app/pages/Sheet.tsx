import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useLoaderData, useNavigate, useParams } from "react-router";
import { PAGE_CHAT } from "../../shared/chat";
import { markerSpots, type CommentEntry } from "../../shared/docfile";
import { editorExtensions } from "../editor/behaviour";
import { answerSupport, forgetPageChat, getPage, getSupport, openAgent, reviewPage as askToRead, saveAgentSettings, scheduleButton, type AgentEvent, type SupportView } from "../doc/client";
import { instructionOf } from "../editor/instructionInput";
import { pluginFor } from "../../shared/plugin";
import { DocSession } from "../doc/session";
import { browserCopyIO, copyPage } from "../doc/copyPage";
import { CopyButton } from "./CopyButton";
import { useSync } from "./SyncDialog";
import { ConnectModel } from "./ConnectModel";
import { resolveLink, scrollToHeading } from "../editor/links";
import { pageUrl } from "../../shared/ids";
import { setAssetBase } from "../../shared/docfile";
import { AgentNotes } from "./AgentFeed";
import { ChatModal, type ChatState } from "./ChatModal";
import { asPageChatStatus, ChatLaunch, type PageChatStatus } from "./ChatLaunch";
import { agentPhase, DebugPanel, type AgentLink, type AgentModelOption } from "./DebugPanel";
import { engineOf } from "./EngineIcon";
import { engineLabel } from "../../shared/choice";
import { focusQuietly } from "../editor/focus";
import { Banners, SupportNudge, TopBar } from "./Frame";
import { Margin } from "./Margin";
import { NewerPage, newerFormat } from "./NewerPage";
import { StatusBar } from "./StatusBar";

export const sheetLoader = ({ params }: { params: { "*"?: string } }) => getPage(params["*"]!);

/** One page's screen. Following a link to another page starts it afresh: its editor, session and agents are per page. */
export function Sheet() {
  const { "*": id } = useParams();
  const file = useLoaderData() as Awaited<ReturnType<typeof getPage>>;
  // A page from a newer Solipsist is only shown: no session, no saves, no agents (`NewerPage`).
  const newer = useMemo(() => newerFormat(file.file), [file]);
  if (newer !== null) return <NewerPage key={id} title={file.path ?? `${id}.md`} file={file.file} format={newer} />;
  return <Page key={id} />;
}

function Page() {
  const { "*": id } = useParams();
  const file = useLoaderData() as Awaited<ReturnType<typeof getPage>>;
  // A new session per page (and per hot reload of the loader's data).
  const session = useMemo(() => {
    // A project's images are found from the page's own folder.
    setAssetBase(file.path ? file.path.replace(/[^/]*$/, "") : "");
    return new DocSession(id!, file);
  }, [id, file]);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);

  const [singleAgent, setSingleAgent] = useState(false);
  const [build, setBuild] = useState<{ version: string; line: string } | null>(null);
  // The agent stream: the server runs Pi agents on the page's tasks while this page is open.
  const [debugOpen, setDebugOpen] = useState(false);
  const [agentEvents, setAgentEvents] = useState<AgentEvent[]>([]);
  /** What the page-wide chat's agent is doing, for its button. */
  const [pageChat, setPageChat] = useState<PageChatStatus>({ state: "none" });
  const [agentLink, setAgentLink] = useState<AgentLink>("offline");
  // Kept apart from the events, which are capped and can be cleared.
  const [agentCost, setAgentCost] = useState(0);
  // The page's agent settings are kept in its file: the server's hello and
  // events say what they are, so a reload and a second browser agree.
  const [agentOn, setAgentOn] = useState(true);
  const agentPaused = !agentOn;
  // The page's `engine:model` choice; until the server says (its hello), the default.
  const [agentModel, setModel] = useState("pi:~deepseek/deepseek-flash-latest");
  // What the server offers, from its hello (kept apart from the events, which can be cleared).
  const [agentModels, setAgentModels] = useState<AgentModelOption[]>([]);
  const chooseModel = async (m: string) => {
    const old = agentModel;
    setModel(m);
    const saved = await saveAgentSettings(id!, { model: m });
    if (!saved) setModel(old);
  };
  /** Turns the page's agents off and on; the server keeps it in the page's file, so every tab and a reload agree. */
  const toggleAgents = () => {
    const next = !agentOn;
    setAgentOn(next);
    void saveAgentSettings(id!, { on: next }).then((saved) => { if (!saved) setAgentOn(!next); });
  };
  /**
   * One review, asked for by hand. The questions arrive as margin comments through
   * the watcher, like any other change to the file, so there is nothing to apply here; a review that raised none
   * says so where the writer asked for it.
   */
  const [reviewing, setReviewing] = useState(false);
  /** The questions on screen now: open comments the page found a place for. */
  const questionCount = snap.comments.filter((c) => c.status === "open" && snap.placed.has(c.id)).length;
  const [reviewSaid, setReviewSaid] = useState<string | null>(null);
  /**
   * The questions a review wrote that this tab has not been given yet. The run answering is not the end of it: the
   * file goes to disk, the watcher sees it, and the page receives it a moment later — so the review stays running
   * until its questions are actually on the page, which is what the writer is waiting for.
   */
  const [landing, setLanding] = useState<string[]>([]);
  const reviewPage = async () => {
    setReviewing(true);
    setReviewSaid(null);
    setLanding([]);
    const r = await askToRead(id!);
    if ("error" in r) { setReviewing(false); setReviewSaid(r.error); return; }
    if (!r.placed.length) { setReviewing(false); setReviewSaid("Nothing to ask about on this page."); return; }
    setLanding(r.placed);
  };
  // Still running until every question it wrote has arrived. A page that never gets them (the watcher missed the
  // write) would blink for ever, so the wait gives up after a few seconds and says what it knows.
  const landed = landing.length > 0 && landing.every((cid) => snap.comments.some((c) => c.id === cid));
  useEffect(() => {
    if (!landing.length) return;
    const done = (said: string) => { setLanding([]); setReviewing(false); setReviewSaid(said); };
    if (landed) return done(`${landing.length} question${landing.length === 1 ? "" : "s"} in the margin.`);
    const t = setTimeout(() => done("The questions were written, but this page hasn't received them yet."), 8000);
    return () => clearTimeout(t);
  }, [landing, landed]);
  // The page-wide chat is on the page's model: a change made inside it saves the page's choice and starts a new chat.
  const [chatEpoch, setChatEpoch] = useState(0);
  const chatModel = async (m: string) => { await chooseModel(m); setChatEpoch((e) => e + 1); };
  // The page-wide chat keeps its conversation (closing it leaves the agent going): New chat forgets it and opens afresh.
  const newChat = async () => { await forgetPageChat(id!); setChatEpoch((e) => e + 1); };
  const refused = snap.conn === "refused";
  // The page's agents keep working when the tab closes, so the stream is always open: when they are off it only waits
  // to hear them turned on, and then a fresh one starts them.
  useEffect(() => {
    if (refused) return;
    return openAgent(id!, {
      onEvent: (e) => {
        // The page chat's state is for its button, not a message of the page's agents.
        if (e.event === "pichat") { const s = asPageChatStatus(e); if (s) setPageChat(s); return; }
        if (e.event === "hello") setPageChat(asPageChatStatus(e.pageChat) ?? { state: "none" });
        setAgentEvents((prev) => [...prev.slice(-999), e]);
        // The server says what the page's settings are, and when another tab changes them.
        if (e.event === "hello") { if (Array.isArray(e.models)) setAgentModels(e.models as AgentModelOption[]); if (typeof e.model === "string") setModel(e.model); if (typeof e.on === "boolean") setAgentOn(e.on); if (typeof e.singleAgent === "boolean") setSingleAgent(e.singleAgent); if (typeof e.noEngine === "boolean") setNoEngine(e.noEngine); if (typeof e.version === "string" && typeof e.build === "string") setBuild({ version: e.version, line: e.build }); }
        if ((e.event === "model" || e.event === "settings") && typeof e.model === "string") setModel(e.model);
        if (e.event === "settings" && typeof e.on === "boolean") setAgentOn(e.on);
        if (e.event === "end" && typeof e.costUsd === "number") setAgentCost((c) => c + (e.costUsd as number));
      },
      onState: setAgentLink,
    });
  }, [id, refused]);
  // The ask for support: checked once when the page opens, so it never appears in the middle of a session.
  const [support, setSupport] = useState<SupportView | null>(null);
  useEffect(() => { void getSupport().then(setSupport); }, []);
  const answerNudge = (action: "later" | "paid") => { setSupport(null); void answerSupport(action); };
  // The chat with the agent kept behind a suggestion (Chat on its card, Mod-Alt-c, vim `gc`).
  const [chat, setChat] = useState<ChatState | null>(null);
  const startChat = useRef((_task: string) => {});
  const followLink = useRef((_href: string, _newTab: boolean) => {});
  // No engine can run: the status bar says so, and asking the agent explains how to connect one and leaves no marker.
  const [noEngine, setNoEngine] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const noEngineRef = useRef(false);
  noEngineRef.current = noEngine;
  const navigate = useNavigate();

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: editorExtensions({ onLink: (href, newTab) => followLink.current(href, newTab), canAsk: () => !noEngineRef.current, onCannotAsk: () => setConnecting(true), onChat: (p) => startChat.current(p), onSchedule: (task, every) => { void scheduleButton(id!, task, every); } }),
      content: session.initialContent,
      // Keep the caret clear of the status bar and the top edge when vim (or anything) moves it off screen.
      editorProps: { attributes: { spellcheck: "true" }, scrollMargin: { top: 80, bottom: 96, left: 0, right: 0 }, scrollThreshold: { top: 80, bottom: 96, left: 0, right: 0 } },
      // The editor is focused on load, so vim keys (or typing) work without a click first.
      autofocus: "start",
    },
    [session],
  );

  useEffect(() => {
    if (!editor) return;
    session.attach(editor);
    return () => session.destroy();
  }, [editor, session]);

  followLink.current = (href, newTab) => {
    const to = resolveLink(id!, href);
    if (to.kind === "external") window.open(to.url, "_blank", "noopener");
    else if (to.kind === "anchor") { if (editor) scrollToHeading(editor, to.hash); }
    else if (to.kind === "page") {
      const url = `${pageUrl(to.id)}${to.hash ? `#${to.hash}` : ""}`;
      if (newTab) window.open(url, "_blank");
      else navigate(url);
    }
  };
  // Arriving by a link to a heading.
  useEffect(() => {
    if (editor && window.location.hash) scrollToHeading(editor, decodeURIComponent(window.location.hash.slice(1)));
  }, [editor]);

  startChat.current = (task) => {
    if (!editor) return;
    // A suggestion, or a task an agent is still working on.
    const what = instructionOf(editor.state.doc, task);
    const title = what ? `Suggestion · ${what}` : "Suggestion";
    setChat({ task, title });
  };
  // Closing the modal closes its stream, which gives the agent back to the page.
  const endChat = () => {
    setChat(null);
    // Not scrolled to the caret: it may be at the start of the page while the writer was reading the suggestion.
    if (editor) focusQuietly(editor);
  };

  // What the page's agent is called: the engine of the model chosen, as the picker names it.
  const engineTitle = agentModels.find((m) => m.id === agentModel)?.engine ?? engineLabel(agentModel);

  const title = file.path ?? (editor?.state.doc.firstChild?.textContent.trim() || "Untitled");
  const sync = useSync(id!, file.path, snap.save, () => session.save());
  useEffect(() => { document.title = `${title} · Solipsist`; }, [title]);

  return (
    <div className={`app${debugOpen ? " debug-open" : ""}`}>
      <TopBar title={title} save={snap.save} actions={sync.buttons} />
      {sync.dialog}
      {connecting && <ConnectModel onClose={() => setConnecting(false)} />}
      <Banners conn={snap.conn} conflict={!!snap.conflict} onReload={() => session.reloadTheirs()} onKeepMine={() => session.keepMine()} />
      {support?.show && <SupportNudge days={support.days} url={support.url} onLater={() => answerNudge("later")} onPaid={() => answerNudge("paid")} />}
      <main className="desk">
        <div className="sheet-row">
          {editor && <div className="sheet-tools"><CopyButton run={() => copyPage(editor.state.doc.toJSON(), browserCopyIO())} /></div>}
          <article className="sheet" aria-label="Page">
            <ChatLaunch engine={engineOf(agentModel)} engineTitle={engineTitle} status={pageChat} onOpen={() => setChat({ task: PAGE_CHAT, title: `Chat with ${engineTitle}` })} />
            <EditorContent editor={editor} />
          </article>
          <Margin
            editor={editor}
            comments={snap.comments}
            placed={snap.placed}
            onDismiss={(id) => session.dismissComment(id)}
            onOpen={(id) => session.openComment(id)}
          />
          <AgentNotes editor={editor} events={agentEvents} link={agentPaused ? "paused" : agentLink} engine={engineOf(agentModel)} onChat={(p) => startChat.current(p)} />
        </div>
      </main>
      {chat && (chat.task === PAGE_CHAT
        ? <ChatModal key={`${PAGE_CHAT}-${chatEpoch}`} page={id!} chat={{ ...chat, title: `Chat with ${engineTitle}` }} models={{ model: agentModel, models: agentModels, onModel: (m) => void chatModel(m), onNew: () => void newChat() }} onClose={endChat} />
        : <ChatModal key={chat.task} page={id!} chat={chat} onClose={endChat} />)}
      {debugOpen && <DebugPanel events={agentEvents} link={agentPaused ? "paused" : agentLink} cost={agentCost} model={agentModel} models={agentModels} agent={{ on: agentOn, toggle: toggleAgents }} read={{ busy: reviewing, count: questionCount, said: reviewSaid, start: reviewPage }} onModel={chooseModel} onClear={() => setAgentEvents([])} onClose={() => setDebugOpen(false)} />}
      {editor && (
        <StatusBar
          editor={editor}
          agent={{ noEngine, onConnect: () => setConnecting(true), on: agentOn, model: agentModel, single: singleAgent, cost: agentCost }}
          build={build}
          read={{ busy: reviewing, count: questionCount, said: reviewSaid, start: reviewPage }}
          debug={{ open: debugOpen, tone: agentPhase(agentEvents, agentPaused ? "paused" : agentLink).tone, toggle: () => setDebugOpen((o) => !o) }}
        />
      )}
    </div>
  );
}
