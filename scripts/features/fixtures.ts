import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "../../src/app/doc/client";
import type { ChatMessage } from "../../src/shared/chat";

const t0 = Date.parse("2026-11-01T10:42:00Z");

/** A run as the panel hears it: the greeting, a start, a few steps, the end, then what the loop does next. */
export const EVENTS: AgentEvent[] = [
  { event: "hello", at: t0, model: "pi:openrouter/~moonshotai/kimi-latest", concurrency: 3 },
  { event: "start", at: t0 + 1000, run: 1, taskType: "gen", task: "abc", model: "pi:openrouter/~moonshotai/kimi-latest", engine: "pi", chat: true },
  { event: "step", at: t0 + 1500, run: 1, kind: "init", text: "session 3f9a2c1d · kimi-latest" },
  { event: "step", at: t0 + 2500, run: 1, kind: "tool", text: "Read /docs/plan.md", name: "Read", brief: "/docs/plan.md" },
  { event: "step", at: t0 + 2900, run: 1, kind: "tool_result", text: "# Plan\n\nThe deadline is …" },
  { event: "step", at: t0 + 5200, run: 1, kind: "text", text: "The plan says 30 September." },
  { event: "end", at: t0 + 6000, run: 1, task: "abc", ok: true, durationMs: 5000, costUsd: 0.0123, outcome: "suggested" },
  { event: "wait", at: t0 + 6000, run: 1, task: "abc", engine: "pi", until: t0 + 306000 },
  { event: "settling", at: t0 + 9000 },
  { event: "start", at: t0 + 12000, run: 2, taskType: "sel", task: "xyz", model: "pi:openrouter/~moonshotai/kimi-latest", engine: "pi" },
  { event: "step", at: t0 + 13000, run: 2, kind: "error", text: "The agent asked for permission (Write /docs/plan.md), which can't be answered here, so it was refused." },
  { event: "end", at: t0 + 14000, run: 2, task: "xyz", ok: false, durationMs: 2000, error: "the reply had no suggestion" },
  { event: "warning", at: t0 + 14100, run: 2, message: "The run left 1 placeholder(s) acknowledged but unfinished: moved back to waiting." },
  { event: "model", at: t0 + 15000, model: "pi:~deepseek/deepseek-flash-latest" },
  { event: "start", at: t0 + 15500, run: 3, taskType: "gen", task: "pqr", model: "pi:~deepseek/deepseek-flash-latest", engine: "pi", chat: true },
  // A run that said nothing about what it cost: no dollar limit saw it, so it was counted against the daily run limit.
  { event: "end", at: t0 + 17000, run: 3, task: "pqr", ok: true, durationMs: 1500, outcome: "suggested", costUnknown: true },
  { event: "skip", at: t0 + 16000, reason: "nothing pending" },
  { event: "snooze", at: t0 + 306000, run: 1, task: "abc", engine: "pi" },
];

/** The shortlist the picker shows at a glance: the writer's preferred model, then each engine's own. */
export const MODELS = [
  { id: "pi:openrouter/~moonshotai/kimi-latest", engine: "Pi", title: "Kimi Latest", vendor: "MoonshotAI", preferred: true, context: 256_000, inUsd: 0.5, outUsd: 2 },
  { id: "pi:openrouter/~deepseek/deepseek-flash-latest", engine: "Pi", title: "DeepSeek Flash Latest", vendor: "DeepSeek", note: "Pi's own default", context: 1_048_576, inUsd: 0.02, outUsd: 1 },
  { id: "pi:openrouter/~z-ai/glm-latest", engine: "Pi", title: "GLM Latest", vendor: "Z.ai", context: 200_000, inUsd: 0.6, outUsd: 2.2 },
  { id: "pi:openrouter/google/gemini-3.5-flash", engine: "Pi", title: "Gemini 3.5 Flash", vendor: "Google", context: 1_048_576, inUsd: 0.3, outUsd: 2.5 },
];

/** Every model the writer's engines can run, which the picker searches: their own Pi's, whatever they have. */
export const MODEL_CATALOG = [
  ...MODELS,
  { id: "pi:openrouter/openai/gpt-6.1-sol", engine: "Pi", title: "GPT-6.1 Sol", vendor: "OpenAI", context: 1_050_000, inUsd: 2, outUsd: 10 },
  { id: "pi:openrouter/qwen/qwen-4-flash", engine: "Pi", title: "Qwen 4 Flash", vendor: "Qwen", context: 1_000_000, inUsd: 0.05, outUsd: 0.4 },
  { id: "pi:openrouter/mistralai/mistral-medium-4", engine: "Pi", title: "Mistral Medium 4", vendor: "Mistral", context: 128_000, inUsd: 0.4, outUsd: 2 },
  { id: "pi:openrouter/meta/llama-4-scout-free", engine: "Pi", title: "Llama 4 Scout (free)", vendor: "Meta", context: 128_000, inUsd: 0, outUsd: 0 },
];

const tool = (id: string, name: string, brief: string, o: object = {}) => ({ type: "tool" as const, id, name, brief, args: JSON.stringify({ file_path: brief }, null, 2), ...o });

/** A call to one of Solipsist's own tools (`replyTools.ts`), as an engine marks it in the chat. */
const reply = (id: string, name: string, args: object, o: object = {}) =>
  ({ type: "tool" as const, id, name, brief: "", args: JSON.stringify(args, null, 2), reply: true, ...o });

/** What the agent gives back with Solipsist's own tools: a call the page refused, then the one that counted. */
export const CHAT_REPLY: ChatMessage[] = [
  { id: "r1", role: "user", at: t0, blocks: [{ type: "text", text: "Could it be shorter?" }] },
  {
    id: "r2", role: "assistant", at: t0 + 1000,
    blocks: [
      { type: "text", text: "Shorter, then." },
      reply("r-bad", "suggest", { mode: "after", place: "inline", markdown: "30 September" }, { isError: true, result: "A point placeholder's result goes `at`, not `after`." }),
      reply("r-good", "suggest", { mode: "at", place: "inline", markdown: "30 September", note: "The plan's own date.", edits: [{ before: "The deadline is end of Q3.", after: "The deadline is 30 September." }] }, { result: "ok" }),
    ],
    stats: { model: "kimi-latest", input: 13200, output: 96, costUsd: 0.0131, ms: 4300 },
  },
];

/** A conversation with every kind of message in it. */
export const CHAT: ChatMessage[] = [
  { id: "m1", role: "task", at: t0, blocks: [{ type: "text", text: "You are working on the page /docs/plan.md. Your placeholder is gen:abc …" }] },
  {
    id: "m2", role: "assistant", at: t0 + 1000,
    blocks: [
      { type: "thinking", text: "The writer wants a date; the plan names one in the first section." },
      tool("t1", "Read", "/docs/plan.md", { result: "# Plan\n\nThe deadline is end of Q3 …", durationMs: 40 }),
      { type: "text", text: "Done.\n\n<suggestion mode=\"at\" place=\"inline\">30 September</suggestion>\n<note>Used the plan's own date.</note>" },
    ],
    stats: { model: "kimi-latest", input: 13200, output: 86, costUsd: 0.0123, ms: 5100, tokensPerSec: 42 },
  },
  { id: "m3", role: "user", at: t0 + 20000, blocks: [{ type: "text", text: "Could it say the weekday too?" }] },
  {
    id: "m4", role: "assistant", at: t0 + 21000,
    blocks: [
      tool("t2", "Bash", "date -j -f %Y-%m-%d 2026-09-30 +%A", { isError: true, result: "date: illegal option", durationMs: 120 }),
      tool("t3", "WebSearch", "weekday of 30 September 2026", { result: "Wednesday", durationMs: 1400 }),
      { type: "text", text: "<edit><before>\nThe deadline is end of Q3.\n</before><after>\nThe deadline is Wednesday, 30 September.\n</after></edit>\n<answer>Yes: it is a Wednesday.</answer>" },
    ],
    stats: { model: "kimi-latest", input: 14800, output: 140, costUsd: 0.0151, ms: 6800 },
  },
  {
    id: "m5", role: "assistant", at: t0 + 40000, streaming: true,
    blocks: [tool("t4", "Read", "/docs/notes.md", { running: true, args: "{}" })],
  },
];

/** What the settings dialog is sent: the real prompts (their built-in text), one of them edited, and the real settings table. */
export async function settingsData() {
  const { listPrompts } = await import("../../src/server/prompts");
  const { configView, loadConfig } = await import("../../src/server/config");
  // Each prompt's file is named as in a writer's folder: the real one would put this machine's home in the page.
  const shown = "/home/me/.config/solipsist/prompts";
  const prompts = listPrompts()
    .map((p) => ({ ...p, file: `${shown}/${p.id}.md` }))
    .map((p) => (p.id === "run.again" ? { ...p, custom: true, text: p.text.replace("a different one", "a clearly different one") } : p));
  // A real file in a scratch folder, shown under the name it would have in a writer's notes folder.
  const dir = mkdtempSync(join(tmpdir(), "solip-features-config-"));
  const file = join(dir, "solipsist.yaml");
  writeFileSync(file, "server:\n  port: 4000\nagent:\n  cost_limit_usd: 5\n");
  const cfg = loadConfig({ cwd: dir, home: dir, file, env: { AGENT_CONCURRENCY: "2", SOLIPSIST_OPENROUTER_KEY: "sk-or-v1-not-shown-anywhere" } });
  rmSync(dir, { recursive: true, force: true });
  return { prompts: { dir: shown, prompts }, config: (() => {
      // Shown as in a writer's notes folder, not under the scratch one it was loaded from.
      // Every path under it (the home-derived defaults too) reads as /home/me: the scratch name is random and this machine's.
      const v = JSON.parse(JSON.stringify(configView(cfg)).replaceAll(dir, "/home/me")) as ReturnType<typeof configView>;
      return { ...v, file: "/home/me/notes/solipsist.yaml", settings: v.settings.map((s) => (s.key === "md_search_paths" ? { ...s, value: ["docs=/home/me/notes/docs"] } : s)) };
    })() };
}

/**
 * Two charts as `data:` images, so the pictures of image requests show a real picture (the app serves a page's own
 * images from disk; a specimen has no page on disk). The second is the first drawn again with horizontal bars.
 */
export const CHART = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MjAgMjAwIiB3aWR0aD0iNDIwIiBoZWlnaHQ9IjIwMCI+PHJlY3QgeD0iMC41IiB5PSIwLjUiIHdpZHRoPSI0MTkiIGhlaWdodD0iMTk5IiByeD0iMTIiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iI2U1ZTdlYiIvPjx0ZXh0IHg9IjI0IiB5PSIzNCIgZm9udC1mYW1pbHk9IkludGVyLCBIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjE0IiBmb250LXdlaWdodD0iNjAwIiBmaWxsPSIjMTExODI3Ij5TaWdudXBzIGJ5IHdlZWs8L3RleHQ+PHJlY3QgeD0iNDAiIHk9IjEyMCIgd2lkdGg9IjQ2IiBoZWlnaHQ9IjQ4IiByeD0iNCIgZmlsbD0iI2M3ZDJmZSIvPjx0ZXh0IHg9IjYzIiB5PSIxMTQiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJJbnRlciwgSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMSIgZm9udC13ZWlnaHQ9IjUwMCIgZmlsbD0iIzM3NDE1MSI+MTIwPC90ZXh0Pjx0ZXh0IHg9IjYzIiB5PSIxODQiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJJbnRlciwgSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMSIgZmlsbD0iIzZiNzI4MCI+VzE8L3RleHQ+PHJlY3QgeD0iMTI2IiB5PSI5NiIgd2lkdGg9IjQ2IiBoZWlnaHQ9IjcyIiByeD0iNCIgZmlsbD0iI2M3ZDJmZSIvPjx0ZXh0IHg9IjE0OSIgeT0iOTAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJJbnRlciwgSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMSIgZm9udC13ZWlnaHQ9IjUwMCIgZmlsbD0iIzM3NDE1MSI+MTgwPC90ZXh0Pjx0ZXh0IHg9IjE0OSIgeT0iMTg0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZpbGw9IiM2YjcyODAiPlcyPC90ZXh0PjxyZWN0IHg9IjIxMiIgeT0iNzIiIHdpZHRoPSI0NiIgaGVpZ2h0PSI5NiIgcng9IjQiIGZpbGw9IiNjN2QyZmUiLz48dGV4dCB4PSIyMzUiIHk9IjY2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZvbnQtd2VpZ2h0PSI1MDAiIGZpbGw9IiMzNzQxNTEiPjI0MDwvdGV4dD48dGV4dCB4PSIyMzUiIHk9IjE4NCIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZm9udC1mYW1pbHk9IkludGVyLCBIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjExIiBmaWxsPSIjNmI3MjgwIj5XMzwvdGV4dD48cmVjdCB4PSIyOTgiIHk9IjQ0IiB3aWR0aD0iNDYiIGhlaWdodD0iMTI0IiByeD0iNCIgZmlsbD0iIzYzNjZmMSIvPjx0ZXh0IHg9IjMyMSIgeT0iMzgiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGZvbnQtZmFtaWx5PSJJbnRlciwgSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMSIgZm9udC13ZWlnaHQ9IjUwMCIgZmlsbD0iIzM3NDE1MSI+MzEwPC90ZXh0Pjx0ZXh0IHg9IjMyMSIgeT0iMTg0IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZpbGw9IiM2YjcyODAiPlc0PC90ZXh0PjxsaW5lIHgxPSIzMiIgeTE9IjE2OC41IiB4Mj0iMzk2IiB5Mj0iMTY4LjUiIHN0cm9rZT0iI2U1ZTdlYiIvPjwvc3ZnPg==";
export const CHART_AGAIN = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA0MjAgMjAwIiB3aWR0aD0iNDIwIiBoZWlnaHQ9IjIwMCI+PHJlY3QgeD0iMC41IiB5PSIwLjUiIHdpZHRoPSI0MTkiIGhlaWdodD0iMTk5IiByeD0iMTIiIGZpbGw9IiNmZmZmZmYiIHN0cm9rZT0iI2U1ZTdlYiIvPjx0ZXh0IHg9IjI0IiB5PSIzNCIgZm9udC1mYW1pbHk9IkludGVyLCBIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjE0IiBmb250LXdlaWdodD0iNjAwIiBmaWxsPSIjMTExODI3Ij5TaWdudXBzIGJ5IHdlZWs8L3RleHQ+PHRleHQgeD0iMjQiIHk9IjcwIiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZpbGw9IiM2YjcyODAiPlcxPC90ZXh0PjxyZWN0IHg9IjUyIiB5PSI1NiIgd2lkdGg9IjEwOCIgaGVpZ2h0PSIyMCIgcng9IjQiIGZpbGw9IiNjN2QyZmUiLz48dGV4dCB4PSIxNjgiIHk9IjcwIiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZvbnQtd2VpZ2h0PSI1MDAiIGZpbGw9IiMzNzQxNTEiPjEyMDwvdGV4dD48dGV4dCB4PSIyNCIgeT0iMTAyIiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZpbGw9IiM2YjcyODAiPlcyPC90ZXh0PjxyZWN0IHg9IjUyIiB5PSI4OCIgd2lkdGg9IjE2MiIgaGVpZ2h0PSIyMCIgcng9IjQiIGZpbGw9IiNjN2QyZmUiLz48dGV4dCB4PSIyMjIiIHk9IjEwMiIgZm9udC1mYW1pbHk9IkludGVyLCBIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjExIiBmb250LXdlaWdodD0iNTAwIiBmaWxsPSIjMzc0MTUxIj4xODA8L3RleHQ+PHRleHQgeD0iMjQiIHk9IjEzNCIgZm9udC1mYW1pbHk9IkludGVyLCBIZWx2ZXRpY2EsIEFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjExIiBmaWxsPSIjNmI3MjgwIj5XMzwvdGV4dD48cmVjdCB4PSI1MiIgeT0iMTIwIiB3aWR0aD0iMjE2IiBoZWlnaHQ9IjIwIiByeD0iNCIgZmlsbD0iI2M3ZDJmZSIvPjx0ZXh0IHg9IjI3NiIgeT0iMTM0IiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZvbnQtd2VpZ2h0PSI1MDAiIGZpbGw9IiMzNzQxNTEiPjI0MDwvdGV4dD48dGV4dCB4PSIyNCIgeT0iMTY2IiBmb250LWZhbWlseT0iSW50ZXIsIEhlbHZldGljYSwgQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMTEiIGZpbGw9IiM2YjcyODAiPlc0PC90ZXh0PjxyZWN0IHg9IjUyIiB5PSIxNTIiIHdpZHRoPSIyNzkiIGhlaWdodD0iMjAiIHJ4PSI0IiBmaWxsPSIjNjM2NmYxIi8+PHRleHQgeD0iMzM5IiB5PSIxNjYiIGZvbnQtZmFtaWx5PSJJbnRlciwgSGVsdmV0aWNhLCBBcmlhbCwgc2Fucy1zZXJpZiIgZm9udC1zaXplPSIxMSIgZm9udC13ZWlnaHQ9IjUwMCIgZmlsbD0iIzM3NDE1MSI+MzEwPC90ZXh0Pjwvc3ZnPg==";
