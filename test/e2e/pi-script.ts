// Pi on its scripted `faux` model (no network) and a scratch Pi config folder (never ~/.pi), for `pi-server.ts` and
// `test/e2e-dom/pi.dom.tsx`: the agent loop (`PageAgents`), the reply tools, kept agents and the chat run for real,
// only the model is scripted. The model answers by the task the latest prompt names (see `respond`), and logs every
// request to `<root>/requests.jsonl` for the test to read.
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { piEngine } from "../../src/server/agent/engines/pi";
import { REVIEW_QUOTE } from "./review-quote";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TABLE = "| Team | Date |\n| --- | --- |\n| Web | 3 Sep |";
const say = (s: string) => fauxAssistantMessage(fauxText(s));
const call = (name: string, args: Record<string, any>) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
const text = (m: any) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c: any) => c.text ?? "").join(""));

/**
 * The scripted model. A run's prompt names its task ("the gen task tls"); a chat message is in <chat>
 * tags and names it too. After a reply tool's call failed, the model fixes it; after one that counted, the run is over
 * (the tool ends it), so it is never asked.
 */
const responder = (root: string) => async function respond(ctx: any, options?: { signal?: AbortSignal }) {
  const messages: any[] = ctx.messages;
  const users = messages.filter((m) => m.role === "user");
  const prompt = text(users.at(-1) ?? {});
  const chat = prompt.includes("<chat>");
  // Named by the run's prompt, or by a chat's first message; later chat messages don't name it, so look back. (The
  // protocol, in a first prompt, says "placeholder" plenty: only these two phrasings count.)
  const named = (t: string) => t.match(/Your task this run: the [a-z][a-z0-9-]* task ([a-z0-9]{3,6}),/)?.[1] ?? t.match(/a chat with you about task ([a-z0-9]{3,6}) /)?.[1];
  const task = users.map(text).reverse().map(named).find(Boolean) ?? "?";
  const last = messages.at(-1);
  const failed = last?.role === "toolResult" && last.isError;
  appendFileSync(join(root, "requests.jsonl"), `${JSON.stringify({ task, chat, failed, users: users.length, system: JSON.stringify(messages.filter((m) => m.role === "system")).includes("left a **task**"), inMessage: prompt.includes("left a **task**"), askedAgain: prompt.includes("asked again") })}\n`);

  // A reading (`reader/`) names no task — it is not one — so it is known by what it asks for. The first call quotes
  // something that is not in the page, so the in-turn check sends it back; the second is right. That is the whole
  // point of the `comment` tool over an envelope, and this is the only place it runs in a real browser.
  if (/raise at most \d+ question/.test(prompt)) {
    const q = (quote: string) => call("comment", { comments: [{ quote, title: "What does “soon” mean here, in days?", gloss: "how soon is soon?", description: "The date carries the plan and nothing in the page pins it down.", score: 9 }] });
    return failed ? q(REVIEW_QUOTE) : q("a sentence that is nowhere in this page");
  }

  if (chat) {
    // In the chat on `cht`: asked for a shorter one, a call the card can't take (a point's result goes `at`), then fixed.
    if (failed) return call("suggest", { mode: "at", place: "inline", markdown: "smoothly", note: "Shorter, as asked." });
    if (prompt.includes("shorter")) return call("suggest", { mode: "after", place: "inline", markdown: "smoothly" });
    return say("Happy to talk it through.");
  }
  switch (task) {
    // A wrong call first (a point's result goes `at`), its error read, then the right one: one run, one suggestion.
    case "tls": return failed ? call("suggest", { mode: "at", place: "inline", markdown: "fixed by the tool", note: "Fixed my call." }) : call("suggest", { mode: "after", place: "inline", markdown: "wrong mode" });
    case "ans": return call("answer", { answer: "No: water boils at 100°C at sea level." });
    case "edt": return call("suggest", { edits: [{ before: TABLE, after: "" }], note: "Removed the old table." });
    case "dcl": return prompt.includes("asked again") ? call("suggest", { mode: "at", place: "inline", markdown: "second try, same agent" }) : call("decline", { reason: "Nothing says what goes here." });
    // No tool: the text envelope still works.
    case "env": return say('Done.\n\n<suggestion mode="at" place="inline">\nby the envelope\n</suggestion>');
    // A step the margin shows (`ls`), then held until the test lets it go (`release-<task>`), so the tab can close and
    // open again mid-run, or the agent be turned off; stopped by an abort, as a real request is.
    case "slo": case "off":
      if (last?.role !== "toolResult") return call("ls", { path: root });
      for (const t = Date.now(); !existsSync(join(root, `release-${task}`)) && Date.now() - t < 30_000;) {
        if (options?.signal?.aborted) throw new Error("aborted");
        await wait(50);
      }
      return call("suggest", { mode: "at", place: "inline", markdown: "slow but done" });
    case "ma1": case "ma2": case "ma3":
      await wait(400); // long enough for the three runs to overlap
      return call("suggest", { mode: "at", place: "inline", markdown: `filled ${task}` });
    case "cht": return call("suggest", { mode: "at", place: "inline", markdown: "with no trouble at all", note: "First version." });
    default: return say("I don't know this one.");
  }
};

/** The engine: Pi, its config in `agentDir`, the model's requests logged in `root`. */
export async function scriptedPi(root: string, agentDir: string) {
  const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
  const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  // A queue of the same responder, longer than any run of the suite needs.
  const respond = responder(root);
  faux.setResponses(Array.from({ length: 5000 }, () => respond));
  return piEngine({ agentDir: () => agentDir, runtime: async () => runtime, model: () => faux.getModel() });
}
