import { serve } from "bun";
import index from "./index.html";
import { killLeftovers } from "./server/agent/leftovers";
import { closeChats } from "./server/chat";
import { apiRoutes } from "./server/routes";
import { startMockGenerator, startPushing } from "./server/live";
import { stopAllPages } from "./server/agent/pageAgents";
import { warmEngines } from "./server/agent/engines";
import { startSchedules } from "./server/agent/schedules";
import { config, ConfigError, printConfig } from "./server/config";
import { pagesDir } from "./server/runtime";
import { log, logFile, why } from "./server/log";
import { startTui, wantsTui } from "./server/tui";
import { parseArgs, USAGE } from "./server/cli";
import { versionInfo, versionLine } from "./server/version";
import { bunDevServer } from "./server/devMode";
import { doctor } from "./server/doctor";
import { forgetKey, loadSavedKey } from "./server/keyStore";
import { acquire as acquireLock, conflictMessage, release as releaseLock } from "./server/lock";

/** Which build is serving, on the log's start line: a bug report's log says which code wrote it. */
const versionFields = () => { const v = versionInfo(); return { version: v.version, commit: v.commit, built: v.built, target: v.target }; };

const cli = parseArgs(process.argv.slice(2));
if (cli.run === "help" || cli.run === "version") {
  console.log(cli.run === "help" ? USAGE : versionLine());
  process.exit(0);
}
if (cli.run === "error") {
  console.error(`${cli.message}\n\n${USAGE}`);
  process.exit(2);
}

// Every setting comes from `config()` (CONFIGURATION.md). A wrong one stops the server here, naming the setting.
function settings() {
  try {
    return config();
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
const cfg = settings();
if (cli.run === "print-config") {
  console.log(printConfig(cfg));
  process.exit(0);
}
if (cli.run === "doctor") {
  console.log(await doctor());
  process.exit(0);
}
if (cli.run === "forget-key") {
  console.log((await forgetKey()) ? "Forgot the saved OpenRouter key." : "No OpenRouter key was saved.");
  process.exit(0);
}
// The key pasted on a page, if any: read before the engines are, since the keychain answers asynchronously.
await loadSavedKey();
const { port, host } = cfg.server;

function start() {
  try {
    return serve({
      port,
      hostname: host,
      routes: {
        ...apiRoutes(),
        "/*": index,
      },
      // Bun's dev server (hot reload, the browser's console in the terminal) only when asked: `bun run dev`.
      development: bunDevServer() && { hmr: true, console: true },
    });
  } catch (e: any) {
    if (e?.code !== "EADDRINUSE") throw e;
    console.error(`Port ${port} on ${host} is already in use. Set a different server.port in solipsist.yaml, or PORT in the environment (see CONFIGURATION.md).`);
    process.exit(1);
  }
}

// One server per folder: a second one would write the same pages and answer every request twice.
const held = await acquireLock(host, port);
if (!held.ok) {
  console.error(conflictMessage(held.other));
  process.exit(1);
}
process.on("exit", () => releaseLock());

const server = start();

// Agents a server that died left running would go on editing their pages.
const leftovers = killLeftovers();
if (leftovers.length) console.log(`Stopped ${leftovers.length} agent(s) left running by an earlier server.`);

startPushing();
startMockGenerator();
// Reads each engine's model catalog once (Pi's, from its own files), so the first page's picker is already warm.
void warmEngines();
log("server.start", { ...versionFields(), url: String(server.url), docs: pagesDir(), config: cfg.file, pid: process.pid });

/**
 * What outlives a hot reload (`bun --hot` runs this file again): the terminal view and the process handlers, so each
 * reload replaces them instead of adding more.
 */
const kept = globalThis as typeof globalThis & { solipsist?: { stopTui?: () => void; off?: () => void; stopSchedules?: () => void } };
kept.solipsist?.stopTui?.();
kept.solipsist?.off?.();
kept.solipsist?.stopSchedules?.();
// Buttons on a schedule run here, page open or not (`agent/schedules.ts`).
const stopSchedules = startSchedules();
const stopTui = wantsTui() ? startTui(String(server.url)) : undefined;
if (!stopTui) {
  console.log(`Solipsist ${versionInfo().version} on ${server.url}${logFile() ? ` (log: ${logFile()})` : ""}`);
  console.log(`Config: ${cfg.file ?? "no config file, defaults"}. Pages: ${pagesDir()}`);
}

let stopping = false;
/** Stops the page's agents (their acks reset, waiting agents snoozed), gives the terminal back, and exits. */
async function shutdown(signal: string) {
  if (stopping) process.exit(1); // a second Ctrl-C: now
  stopping = true;
  log("server.stop", { signal });
  stopTui?.();
  console.log("Stopping the agents…");
  await Promise.race([Promise.all([stopAllPages("server stopping"), closeChats("server stopping")]), new Promise((r) => setTimeout(r, 3000))]);
  process.exit(0);
}
const onSigint = () => void shutdown("SIGINT");
const onSigterm = () => void shutdown("SIGTERM");
// Kept running: one failed promise somewhere is no reason to stop every page's agents. Logged, so it is seen.
const onRejection = (e: unknown) => log("server.error", { kind: "unhandled rejection", message: why(e), stack: (e as Error)?.stack?.split("\n").slice(0, 6).join("\n") });
const onException = (e: Error) => log("server.error", { kind: "uncaught exception", message: why(e), stack: e?.stack?.split("\n").slice(0, 6).join("\n") });
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
process.on("unhandledRejection", onRejection);
process.on("uncaughtException", onException);
kept.solipsist = {
  stopTui,
  stopSchedules,
  off: () => { process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm); process.off("unhandledRejection", onRejection); process.off("uncaughtException", onException); },
};
