// Settings of the pages and the web server.
import type { Setting } from "./types";

export const PAGE_ROWS: Setting[] = [
  { key: "md_search_paths", env: "SOLIPSIST_SEARCH_PATHS", kind: "strings", min: 1, default: ["*.md"],
    summary: "Glob patterns for the .md files the file dialog offers.",
    purpose: "Relative to the folder Solipsist runs in. `*.md` is that folder only; `docs/**/*.md` goes deep; a folder name means the .md files directly in it. A brace holding a slash (`{a,b/c}/*.md`) matches nothing, so list those as separate patterns. Dot-folders and `node_modules` are never offered. Anything git ignores isn't either, unless the pattern starts with the folder's name: `docs/*.md` finds them in an ignored `docs/`, and `**/*.md` doesn't. An absolute path or `..` is an error. Change it and restart, and the file dialog opens again with the new files it finds." },

  { key: "server.port", env: "PORT", kind: "int", default: 3000, min: 0, max: 65535,
    summary: "The port of the server.",
    purpose: "Give each checkout or worktree its own port in `.env` when you run several servers. `0` lets the system pick one." },
  { key: "server.host", env: "SOLIPSIST_HOST", kind: "string", default: "localhost",
    summary: "The address the server listens on.",
    purpose: "`localhost` keeps the server to this machine. `0.0.0.0` opens it to the network. There is no login, so do that only on a network you trust." },

];
