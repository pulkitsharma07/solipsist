import type { AgentEngine, AgentSession, AgentStep, RunResult, StartOptions } from "../engine";
import { brief, clip, DETAIL } from "../engine";
import { track } from "../leftovers";

/**
 * The test stand-in for an engine: `AGENT_CMD` (a JSON argv) is a process that speaks a stream-json protocol on its
 * stdin and stdout, and takes the model as its last argument. Only registered when `AGENT_CMD` is set (see
 * `engines/index.ts`); it is named `fake`, so a test's saved choice reads `fake:small`.
 */

/** The command for the agent process: `AGENT_CMD` and the model. Prompts arrive on stdin. */
const command = (o: StartOptions): string[] => [...(JSON.parse(process.env.AGENT_CMD ?? "[]") as string[]), o.model];

/**
 * One line of the stream-json output, as a step (null: not worth showing). `detail` is the longer form the
 * margin note shows on hover; a tool call also names the tool and what it is about (`brief`).
 */
function step(msg: any): AgentStep | null {
  if (msg.type === "system" && msg.subtype === "init") return { kind: "init", text: `session ${String(msg.session_id).slice(0, 8)} · ${msg.model}` };
  const parts: any[] = msg.message?.content ?? [];
  if (msg.type === "assistant") {
    for (const p of parts) {
      if (p.type === "text" && p.text.trim()) return { kind: "text", text: clip(p.text.trim()), detail: clip(p.text.trim(), DETAIL) };
      if (p.type === "tool_use") return { kind: "tool", text: `${p.name} ${clip(JSON.stringify(p.input), 200)}`, detail: clip(JSON.stringify(p.input, null, 2), DETAIL), name: String(p.name), brief: clip(brief(p.input), 200) };
    }
  }
  if (msg.type === "user") {
    for (const p of parts) {
      if (p.type !== "tool_result") continue;
      const body = typeof p.content === "string" ? p.content : Array.isArray(p.content) ? p.content.map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c))).join("\n") : JSON.stringify(p.content);
      return { kind: "tool_result", text: clip(body, 200), detail: clip(body, DETAIL) };
    }
  }
  return null;
}

/**
 * A stream-json process: one process per agent, kept alive between runs. Each run is a fresh user message on its stdin,
 * ended by a `result` line on its stdout. The process keeps the conversation, so a run remembers the earlier ones.
 */
export const cmdEngine: AgentEngine = {
  name: "fake",
  title: "Fake",
  // It passes `total_cost_usd` through from the process it runs; nothing about that process is confined.
  reportsCost: true,
  confined: false,
  models: () => [{ id: "small", title: "Small" }, { id: "large", title: "Large" }],
  unavailable: () => null,
  async start(o): Promise<AgentSession> {
    const proc = Bun.spawn(command(o), { cwd: o.scratch, stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
    // Recorded until it exits, so a server started after this one dies can stop it (see `killLeftovers`).
    void proc.exited.then(track(proc.pid));
    const err = new Response(proc.stderr as ReadableStream).text();
    let waiting: ((r: RunResult) => void) | undefined;
    // The process reports the total cost of the process so far; a run costs the difference.
    let lastCost = 0;
    const read = (async () => {
      let buf = "";
      for await (const chunk of (proc.stdout as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>)) {
        buf += chunk;
        for (let i; (i = buf.indexOf("\n")) >= 0; ) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg: any;
          try { msg = JSON.parse(line); } catch { continue; }
          const s = step(msg);
          if (s) o.onStep(s);
          if (msg.type !== "result") continue;
          const total = typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;
          const costUsd = total === undefined ? undefined : Math.max(0, total - lastCost);
          if (total !== undefined) lastCost = total;
          const done = waiting;
          waiting = undefined;
          // The whole reply: it carries the run's result. Whoever shows it clips it.
          done?.({ ok: !msg.is_error, result: String(msg.result ?? ""), costUsd, ...(msg.is_error ? { error: clip(String(msg.result ?? "error")) } : {}) });
        }
      }
    })().catch(() => {});
    const died = read.then(async () => { const code = await proc.exited; return clip((await err).trim() || `exit ${code}`); });
    return {
      run: (prompt) => new Promise<RunResult>((resolve) => {
        waiting = resolve;
        try {
          const stdin = proc.stdin as import("bun").FileSink;
          stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`);
          stdin.flush();
        } catch {}
      }),
      died,
      async close() { proc.kill(); await proc.exited; },
    };
  },
};
