// Settings of the agent engine, Pi.
import type { Setting } from "./types";

export const DEFAULT_PI_MODELS = ["openrouter/~deepseek/deepseek-flash-latest", "openrouter/anthropic/claude-haiku-5.5", "openrouter/anthropic/claude-sonnet-5.5", "openrouter/~z-ai/glm-latest", "openrouter/~moonshotai/kimi-latest", "openrouter/google/gemini-3.5-flash"];
export const DEFAULT_PI_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit"];

export const ENGINE_ROWS: Setting[] = [
  { key: "pi.models", env: "SOLIPSIST_PI_MODELS", kind: "strings", default: DEFAULT_PI_MODELS, min: 1,
    summary: "The models the picker lists at a glance, the first being the default.",
    purpose: "Ids as `<provider>/<model>`, e.g. `openrouter/anthropic/claude-haiku-5.5`. This is only the shortlist: the picker's search offers every model your Pi has credentials for, read from Pi's own catalog. One your Pi can't run is left out, and when Pi names a default of its own (`defaultModel` in `~/.pi/agent/settings.json`) it is listed first. In the environment, a comma-separated list." },
  { key: "pi.tools", env: "SOLIPSIST_PI_TOOLS", kind: "strings", default: DEFAULT_PI_TOOLS, min: 1,
    summary: "The tools a Pi agent may use (Pi's names).",
    purpose: "The default leaves out MCP, codemode and tool search, so an agent starts none of your MCP servers. Bash runs where Solipsist runs and is not confined; a write guard limits `write` and `edit` to the page's image folder. In the environment, a comma-separated list." },
  { key: "pi.openrouter_key", env: "SOLIPSIST_OPENROUTER_KEY", kind: "string", secret: true, example: "sk-or-...",
    summary: "Your OpenRouter API key.",
    purpose: "Better kept in your environment than in this file, which you may commit. `OPENROUTER_API_KEY` works too, and so does any login Pi has saved of its own (`pi`, then `/login`) — for OpenRouter or any other provider, which a key set here overrides. With none of them Pi is listed but greyed out." },
  { key: "pi.key_store", env: "SOLIPSIST_KEY_STORE", kind: "string", default: "keychain", choices: ["keychain", "file", "off"],
    summary: "Where the OpenRouter key you paste into the app is kept.",
    purpose: "With no key set and no login of Pi's own, a page asks for your OpenRouter key and keeps it here. `keychain` is your system's own store (macOS Keychain, Windows Credential Manager, the Secret Service on Linux), or `pi.key_file` when there is none. `file` always uses `pi.key_file`. `off` keeps nothing: the page only says how to set a key. A key in `pi.openrouter_key` comes first. `solipsist forget-key` removes a saved one." },
  { key: "pi.key_file", env: "SOLIPSIST_KEY_FILE", kind: "path", default: "~/.config/solipsist/openrouter.key",
    summary: "The file a pasted OpenRouter key is kept in when there is no keychain.",
    purpose: "Written readable by you only (mode 0600). Used when `pi.key_store` is `file`, or `keychain` on a system without one." },

];
