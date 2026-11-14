import { useEffect, useRef, useState } from "react";
import { REVIEW } from "../../shared/chat";
import type { AgentEvent } from "../doc/client";
import { EngineIcon, engineOf } from "./EngineIcon";
import { ModelSelect, type AgentModelOption } from "./ModelPicker";

export type AgentLink = "live" | "offline" | "refused" | "paused";
// The model picker is its own part of the interface (`ModelPicker.tsx`); it is shown in this panel's header and in the
// page chat's, both of which import it from here, as they did when it lived in this file.
export { ModelSelect, type AgentModelOption };

/** The events since the stream last (re)connected: run numbers start again at each `hello`. */
const current = (events: AgentEvent[]) => {
  const i = events.findLastIndex((e) => e.event === "hello");
  return i < 0 ? events : events.slice(i);
};

/** One run of the current stream: what it works on, when it started, and how it ended (`ok` undefined: still running). */
export interface RunInfo { run: number; taskType?: string; task?: string; at: number; ended: boolean; ok?: boolean }
/** Every run of the current stream, oldest first. */
export function runsIn(events: AgentEvent[]): RunInfo[] {
  const evs = current(events);
  const ends = new Map(evs.filter((e) => e.event === "end").map((e) => [e.run, e]));
  return evs.filter((e) => e.event === "start" && typeof e.run === "number").map((e) => {
    const end = ends.get(e.run);
    return { run: e.run!, taskType: e.taskType as string | undefined, task: e.task as string | undefined, at: e.at, ended: !!end, ...(end ? { ok: !!end.ok } : {}) };
  });
}

/** What the agent is doing now, worked out from the last events. */
export function agentPhase(events: AgentEvent[], link: AgentLink): { label: string; tone: "run" | "wait" | "idle" | "bad"; since: number | null } {
  if (link === "paused") return { label: "Agent is off", tone: "idle", since: null };
  if (link === "refused") return { label: "Agent runs in another tab", tone: "bad", since: null };
  if (link === "offline") return { label: "Reconnecting…", tone: "bad", since: null };
  const running = runsIn(events).filter((r) => !r.ended);
  if (running.length === 1) return { label: `Running #${running[0]!.run}`, tone: "run", since: running[0]!.at };
  if (running.length > 1) return { label: `Running ${running.length} runs`, tone: "run", since: running[0]!.at };
  const last = [...events].reverse().find((e) => e.event === "end" || e.event === "skip" || e.event === "settling");
  if (!last) return { label: "Connecting", tone: "idle", since: null };
  if (last.event === "settling") return { label: "Waiting for the page to stop changing", tone: "wait", since: null };
  if (last.event === "skip") return { label: last.reason === "nothing pending" ? "Idle: nothing to do" : last.reason === "busy" ? "Waiting: other pages' runs" : last.reason === "cost" ? "Stopped: cost limit reached" : "Idle: page unchanged", tone: "wait", since: null };
  return { label: "Waiting for the next run", tone: "wait", since: null };
}

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function Row({ e }: { e: AgentEvent }) {
  const t = <time>{clock(e.at)}</time>;
  switch (e.event) {
    case "hello": return <li className="ev ev-info">{t}<b>connected</b><span>{String(e.model)}{typeof e.concurrency === "number" ? `, up to ${e.concurrency} runs at once` : ""}</span></li>;
    // A review has no task behind it, so it says what it is rather than `reading:reading`.
    case "start": return <li className="ev ev-start">{t}<b>run #{e.run} started</b>{e.task === REVIEW ? <span>reading the page for questions{e.model ? ` · ${String(e.model)}` : ""}</span> : e.taskType ? <span>{String(e.taskType)}:{String(e.task)}{e.model ? ` · ${String(e.model)}` : ""}</span> : null}</li>;
    case "step": return <li className={`ev ev-${e.kind}`}>{t}<b>{String(e.kind).replace("_", " ")}</b><span>{String(e.text)}</span></li>;
    case "read": return <li className="ev ev-info">{t}<b>reading</b><span>{String(e.message)}</span></li>;
    case "end": return (
      <li className={`ev ${e.ok ? "ev-ok" : "ev-fail"}`}>
        {t}<b>run #{e.run} {e.ok ? "finished" : "failed"}</b>
        <span>{secs(Number(e.durationMs))}{typeof e.costUsd === "number" ? ` · $${e.costUsd.toFixed(4)}` : e.costUnknown ? " · cost not known" : ""}{e.error ? ` · ${e.error}` : ""}</span>
      </li>
    );
    case "model": return <li className="ev ev-info">{t}<b>model</b><span>now {String(e.model)}, on a fresh process</span></li>;
    case "settling": return <li className="ev ev-wait">{t}<b>page changed</b><span>waiting until it stops changing</span></li>;
    case "skip": return <li className="ev ev-wait">{t}<b>{e.task === REVIEW ? "reading skipped" : "skipped"}</b><span>{e.reason === "nothing pending" ? "no request is waiting" : e.reason === "reading" ? "this page is being read already" : e.reason === "stopped" ? "this page's agents are stopped" : e.reason === "busy" ? "the run limit is reached (AGENT_CONCURRENCY, AGENT_MAX_RUNS)" : e.reason === "cost" ? "the cost limit is reached (AGENT_COST_LIMIT_USD, _DAY_USD or _MONTH_USD): no new run starts" : "page unchanged since the last prompt"}</span></li>;
    case "error": return <li className="ev ev-fail">{t}<b>error</b><span>{String(e.message)}</span></li>;
    case "warning": return <li className="ev ev-fail">{t}<b>warning</b><span>{String(e.message)}</span></li>;
    default: return <li className="ev ev-info">{t}<b>{e.event}</b></li>;
  }
}

/** What a run's tab says: its number and the task it works on. */
const runName = (r: RunInfo) => `#${r.run}${r.taskType ? ` ${r.taskType}:${r.task}` : ""}`;

/**
 * The right-hand sidebar that shows the agent stream: the state on top, the stats, the runs in flight, then every
 * message, or only those of the run picked (‹ › cycle through them). A run picked stays listed once it has ended, until
 * another is picked.
 */
export function DebugPanel({ events, link, cost, model, models = [], agent, read, onModel, onClear, onClose }: { events: AgentEvent[]; link: AgentLink; cost: number; model: string; models?: AgentModelOption[]; agent?: { on: boolean; toggle(): void }; read?: { busy: boolean; count?: number; said?: string | null; start(): void }; onModel(m: string): void; onClear(): void; onClose(): void }) {
  // Grouped by engine; before the server has said, the current choice alone.
  const phase = agentPhase(events, link);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (phase.since === null) return;
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, [phase.since]);

  // The run whose messages alone are shown (null: all of them). One that no longer exists (the stream reconnected) means all.
  const [picked, setPicked] = useState<number | null>(null);
  const runs = runsIn(events);
  const tabs = runs.filter((r) => !r.ended || r.run === picked);
  const pick = tabs.some((r) => r.run === picked) ? picked : null;
  const cycle = (by: number) => {
    const order = [null, ...tabs.map((r) => r.run)];
    setPicked(order[(order.indexOf(pick) + by + order.length) % order.length]!);
  };
  const shown = pick === null ? events : current(events).filter((e) => e.run === pick);

  const ends = events.filter((e) => e.event === "end");
  const failed = ends.filter((e) => !e.ok).length;
  const avg = ends.length ? ends.reduce((n, e) => n + Number(e.durationMs), 0) / ends.length : 0;

  // Follow the newest message, unless the reader has scrolled up to look at something.
  const list = useRef<HTMLOListElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = list.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, pick]);

  return (
    <aside className="debug" aria-label="Agent debug">
      <header>
        <h2><EngineIcon engine={engineOf(model)} /> Agent</h2>
        <ModelSelect model={model} models={models} onModel={onModel} title="This page's model. A run in progress finishes on the old one; the next starts on the new one. A suggestion's own agent keeps its engine." />
        {/* The page's agents, off and on. It is kept in the page's file, so a reload and every other tab agree. */}
        {agent && (
          <button
            type="button"
            className={`btn btn-ghost agent-switch${agent.on ? " on" : ""}`}
            title={agent.on ? "The background agent is running. Click to stop it." : "The background agent is stopped. Click to start it."}
            onMouseDown={(e) => { e.preventDefault(); agent.toggle(); }}
          >
            <span className={`dot${agent.on ? " dot-live" : ""}`} />Agent <b>{agent.on ? "on" : "off"}</b>
          </button>
        )}
        {/* One review: Page Review raises questions in the margin and writes nothing in the page. */}
        {read && (
          <button
            type="button"
            className="btn btn-ghost review-page"
            disabled={read.busy}
            title="Review this page and leave questions in the margin. Nothing is written into the page."
            onClick={read.start}
          >
            {read.busy ? "Reviewing…" : "Page review"}
          </button>
        )}
        {read?.said && <span className="review-said">{read.said}</span>}
        <button className="btn btn-ghost" onClick={onClear}>Clear</button>
        <button className="btn btn-ghost" onClick={onClose} aria-label="Close">✕</button>
      </header>

      <div className={`phase ${phase.tone}`}>
        <span className="dot" />
        <span>{phase.label}</span>
        {phase.since !== null && <span className="elapsed">{secs(now - phase.since)}</span>}
      </div>
      <dl className="stats">
        <div><dt>Runs</dt><dd>{ends.length}</dd></div>
        <div><dt>Failed</dt><dd>{failed}</dd></div>
        <div><dt>Average</dt><dd>{ends.length ? secs(avg) : "–"}</dd></div>
        <div><dt>Skipped</dt><dd>{events.filter((e) => e.event === "skip").length}</dd></div>
        <div><dt>Cost</dt><dd>${cost.toFixed(4)}</dd></div>
      </dl>
      <nav className="runs" aria-label="Runs">
        <button className="btn btn-ghost" onClick={() => cycle(-1)} disabled={!tabs.length} aria-label="Previous run" title="Previous run">‹</button>
        <div className="run-tabs">
          <button className={`run-tab${pick === null ? " on" : ""}`} onClick={() => setPicked(null)} aria-pressed={pick === null}>All</button>
          {tabs.map((r) => (
            <button key={r.run} className={`run-tab${pick === r.run ? " on" : ""}${r.ended ? (r.ok ? " ok" : " fail") : " live"}`} onClick={() => setPicked(r.run)} aria-pressed={pick === r.run} title={r.ended ? "This run has ended." : "Show only this run's messages."}>
              <span className="dot" />
              {runName(r)}
              <span className="elapsed">{r.ended ? (r.ok ? "done" : "failed") : secs(now - r.at)}</span>
            </button>
          ))}
          {!tabs.length && <span className="none">No run in flight</span>}
        </div>
        <button className="btn btn-ghost" onClick={() => cycle(1)} disabled={!tabs.length} aria-label="Next run" title="Next run">›</button>
      </nav>
      <ol
        className="events"
        ref={list}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24; }}
      >
        {shown.length === 0 && <li className="ev ev-info"><span>No messages yet.</span></li>}
        {shown.map((e, i) => <Row key={i} e={e} />)}
      </ol>
    </aside>
  );
}
