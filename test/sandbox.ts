// The test sandbox: the tests never read the developer's own settings, prompt edits, Pi, logins or keys. Loaded before
// every test file (`setup.ts`, the bunfig preload) and first by every test helper that runs as a process of its own
// (`agent-server.ts`): a helper started by hand, outside `bun test`, would otherwise run on the developer's real
// engines and be charged for it. `test/sandbox.test.ts` holds both to that.
// An empty config file stands in for ~/.config/solipsist/config.yaml and ./solipsist.yaml, and the prompt edits, the
// support count and Pi's own configuration (its logins and model catalog, which the engine reads to list its models)
// go to a scratch folder. A test that wants other values sets its own env (or SOLIPSIST_PROMPTS_DIR) and puts it back.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "solip-test-home-"));
writeFileSync(join(dir, "solipsist.yaml"), "");

// Every test works on a scratch project of its own, never on the developer's.
//
// There is one mode: the pages are the working copies in `<project>/.solipsist/pages` (`src/server/project.ts`), and
// the project is where the server was started — or, for the tests, `SOLIPSIST_PROJECT_ROOT`. A test file that named
// no project would otherwise read and write the developer's own pages, so one is named here for every file. A test
// that wants a project it controls makes one with `projectDir()` and enters that instead.
//
// Named, not entered by changing directory: the files of a run share one working directory, so whichever was loaded
// last would decide where all of them looked.
process.env.SOLIPSIST_TEST_REPO = process.cwd();
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "solip-test-project-")));
mkdirSync(join(scratch, ".solipsist", "pages"), { recursive: true });
process.env.SOLIPSIST_PROJECT_ROOT ??= scratch;
process.env.SOLIPSIST_CONFIG ??= join(dir, "solipsist.yaml");
process.env.SOLIPSIST_PROMPTS_DIR ??= join(dir, "prompts");
process.env.SOLIPSIST_SUPPORT_DIR ??= join(dir, "support");
// Pi's own (`getAgentDir`): empty, so no login of the developer's is found and no model of theirs is listed.
process.env.PI_CODING_AGENT_DIR ??= join(dir, "pi");
// The OpenRouter key pasted on a page: a scratch file, never the developer's keychain (which holds their real key).
process.env.SOLIPSIST_KEY_STORE = "file";
process.env.SOLIPSIST_KEY_FILE = join(dir, "openrouter.key");
// The daily cap on runs nobody can price counts across every test file in this process: off, unless a test sets its own.
process.env.AGENT_MAX_UNMETERED_RUNS_DAY ??= "0";
// No key of the developer's either, whatever `.env` holds (Bun loads it before this runs). Set, not defaulted: a key
// here would make Pi ready, and since a preferred model (`agent.preferred_models`) is the default choice, an ordinary
// `bun test` would send the real thing to a real provider and be charged for it. A test that wants a key sets its own.
process.env.SOLIPSIST_OPENROUTER_KEY = "";
process.env.OPENROUTER_API_KEY = "";
// Pi also reads each provider's own key from the environment (`<PROVIDER>_API_KEY`, some a token): blank them all.
for (const k of Object.keys(process.env)) if (/_(API_KEY|OAUTH_TOKEN|AUTH_TOKEN)$/.test(k)) process.env[k] = "";
