// The one table: every setting, in the order of the reference. Its rows live in the files beside this one by area.
import { AGENT_ROWS } from "./agentRows";
import { APP_ROWS } from "./appRows";
import { ENGINE_ROWS } from "./engineRows";
import { PAGE_ROWS } from "./pageRows";
import type { Setting } from "./types";

export { DEFAULT_PI_MODELS, DEFAULT_PI_TOOLS } from "./engineRows";

/** The sections of the file, in order, with the text that opens each in the reference. */
export const GROUPS: { id: string; title: string; intro: string }[] = [
  { id: "pages", title: "Pages", intro: "Which files Solipsist offers to work on. This key sits at the top of the file, outside any section." },
  { id: "server", title: "server", intro: "How the web server is reached." },
  { id: "agent", title: "agent", intro: "The background agents: when a run starts, how many run at once, how long they may take and cost, and how long a finished agent is kept for a chat." },
  { id: "review", title: "review", intro: "Page Review: the agent that reads a page and leaves questions in the margin. It has no way to write the page, so a review never changes a word of it. These settings say how many questions a review may raise and how many the page may hold." },
  { id: "suggestions", title: "suggestions", intro: "The limits on what an agent may suggest." },
  { id: "chat", title: "chat", intro: "The chat with an agent." },
  { id: "pi", title: "pi", intro: "The Pi agent engine, on OpenRouter. It is the default engine." },
  { id: "prompts", title: "prompts", intro: "Where your edits to the agents' prompts are kept. Edit them in the app (the gear on a page) or by hand; the built-in text is the default." },
  { id: "comments", title: "comments", intro: "How long the hidden block at the end of a page keeps what it no longer needs." },
  { id: "support", title: "support", intro: "The strip that asks you to buy a licence once you have used Solipsist for a while. Nothing is locked and nothing is sent anywhere: the count stays on this machine." },
  { id: "log", title: "log", intro: "What the server records about itself, and how it shows the agents in a terminal." },
  { id: "dev", title: "dev", intro: "For working on Solipsist itself." },
];

export const TABLE: Setting[] = [...PAGE_ROWS, ...AGENT_ROWS, ...ENGINE_ROWS, ...APP_ROWS];

/** Plain environment variables that are not ours or not a user setting, and so stay outside the table. */
export const ENV_ONLY: { name: string; why: string }[] = [
  { name: "SOLIPSIST_CONFIG", why: "The path of the config file, the same as `--config <path>` on the command line." },
  { name: "NODE_ENV", why: "Bun's and every tool's, not ours." },
  { name: "AGENT_CMD", why: "The test fake: a JSON argv that stands in for an engine. Read only when `NODE_ENV` is `test`, and never when a `.env` in the folder sets it. Never a user setting." },
  { name: "PI_CODING_AGENT_DIR", why: "Pi's own: where it keeps its configuration." },
  { name: "OPENROUTER_API_KEY", why: "Pi reads it itself. A fallback behind `pi.openrouter_key`." },
  { name: "FUZZ_RUNS", why: "Test runner only (`test/fuzz.test.ts`)." },
  { name: "E2E_CHANNEL", why: "Test runner only (the browser the UI tests use)." },
  { name: "E2E_VIDEO", why: "Test runner only (where the UI tests record videos)." },
];
