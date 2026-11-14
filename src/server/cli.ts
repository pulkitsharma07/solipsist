/**
 * The command line: `solipsist [--config <file>] [--print-config] [--help] [--version]`. Everything else is a setting
 * (`solipsist.yaml` or the environment, CONFIGURATION.md), so an unknown flag is a mistake, not a setting to pass on.
 */
import { VERSION } from "./version";

export { VERSION };

export const USAGE = `Solipsist ${VERSION}: a writing app on the .md files in a folder, with agents that suggest.

Usage: solipsist [options]

  --config <file>   Use this settings file (default: ./solipsist.yaml, then ~/.config/solipsist/config.yaml).
  --print-config    Print every setting, its value and where it came from, then exit.
  --version         Print the version and exit.
  --help            Print this and exit.

Settings (pages folders, port, agents, keys) go in solipsist.yaml or the environment: see CONFIGURATION.md.`;

export type Cli = { run: "serve" | "print-config" | "help" | "version" } | { run: "error"; message: string };

/** What the arguments (after the program's own) ask for. `--config`'s value is read by `config()`. */
export function parseArgs(args: string[]): Cli {
  let run: "serve" | "print-config" | "help" | "version" = "serve";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") return { run: "help" };
    if (a === "--version" || a === "-v") run = run === "serve" ? "version" : run;
    else if (a === "--print-config") run = "print-config";
    else if (a === "--config") {
      if (!args[i + 1] || args[i + 1]!.startsWith("-")) return { run: "error", message: "--config needs a file: --config <file>" };
      i++;
    } else if (a.startsWith("--config=")) {
      if (a === "--config=") return { run: "error", message: "--config needs a file: --config=<file>" };
    } else return { run: "error", message: `Unknown option ${a}` };
  }
  return { run };
}
