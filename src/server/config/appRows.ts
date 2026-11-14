// Settings of prompts, comments, the support nudge, the log and development.
import type { Setting } from "./types";

export const APP_ROWS: Setting[] = [
  { key: "prompts.dir", env: "SOLIPSIST_PROMPTS_DIR", kind: "path", default: "~/.config/solipsist/prompts",
    summary: "The folder where your edited prompts are kept, one markdown file per prompt.",
    purpose: "A prompt with a file here uses it; one without uses the built-in text, so deleting a file brings the default back. Point it at a shared or committed folder to keep prompts with a team. Edits apply to the next run and the next agent started." },

  { key: "comments.orphan_keep_ms", env: "ORPHAN_KEEP_MS", kind: "int", default: 30000, min: 0,
    summary: "How long an orphaned comment or a decided suggestion is kept before it is removed (ms).",
    purpose: "An orphan is a comment whose text is gone. The delay lets an undo bring it back." },

  { key: "support.after_days", env: "SOLIPSIST_SUPPORT_AFTER_DAYS", kind: "int", default: 14, min: 0,
    summary: "After how many days of writing the page asks you to buy a licence.",
    purpose: "A day counts when you save a page on it. \"Later\" asks again 7 such days on; \"I've bought one\" stops it. `0` never asks." },
  { key: "support.dir", env: "SOLIPSIST_SUPPORT_DIR", kind: "path", default: "~/.config/solipsist",
    summary: "The folder of `support.json`, which keeps that count and your answer.",
    purpose: "Delete the file to start the count again." },

  { key: "log.file", env: "SOLIPSIST_LOG", kind: "logfile", example: "off",
    summary: "The server's log of its core actions, one JSON line each: a file path, or `off`.",
    purpose: "Saves, refused saves, outside edits, runs, waits, chats, stops and errors. Default: `.solipsist/server.log` in the folder Solipsist runs in. Always off under `bun test`." },
  { key: "log.max_bytes", env: "SOLIPSIST_LOG_MAX_BYTES", kind: "int", default: 10485760, min: 1024,
    summary: "The size at which the log is moved aside (bytes).",
    purpose: "Past it, the file moves to `server.log.1` (the one before is dropped) and a new one starts, so the log never grows for ever." },
  { key: "log.tui", env: "SOLIPSIST_TUI", kind: "bool", default: true,
    summary: "Whether the server shows the agents in a terminal view when it runs in a terminal.",
    purpose: "`false` gives the plain line output instead, which is easier to read in a CI log or a pipe." },

  { key: "dev.mock_comments", env: "MOCK_COMMENTS", kind: "bool", default: false,
    summary: "Add a mock comment to every watched page every dev.mock_interval_ms.",
    purpose: "For trying the comment margin without an agent." },
  { key: "dev.mock_interval_ms", env: "MOCK_INTERVAL_MS", kind: "int", default: 5000, min: 1,
    summary: "The interval of the mock comments (ms).",
    purpose: "Only used with dev.mock_comments." },
];
