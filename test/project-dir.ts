// A scratch project for a test to work in.
//
// There is one mode: Solipsist works on the `.md` files of the project it is started in, through working copies in
// `.solipsist/pages/` (`src/server/project.ts`). So a test isolates itself the way a writer would — by being in a
// project of its own — and not by naming a pages folder: `DOCS_DIR` used to do that, and it was the only thing in
// the app with two modes behind it.
//
// `enter()` names the project in the environment (`SOLIPSIST_PROJECT_ROOT`) rather than changing directory: every
// test file in the process shares one working directory, so a file that changed it would be overruled by the next,
// and a file loaded later would decide where an earlier one's pages are. Call it from `beforeAll` or `beforeEach`
// (or at module level — it is only an environment variable), and `done()` when the test is over.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ProjectDir {
  /** The project's root: the working directory while the test runs. */
  root: string;
  /** The working copies, which is what the server reads and writes (`<root>/.solipsist/pages`). */
  docs: string;
  /** The images a page's agent draws (`<root>/.solipsist/images`). */
  images: string;
  /** Makes this the project the server works on. Safe to call again. */
  enter(): void;
  /** Puts the project back to what it was and removes this one. */
  done(): void;
}

/**
 * Makes a project in a temp folder, with its pages folder already there — an empty one means the writer has not
 * picked any files yet, and the app asks them to before anything else.
 *
 * `realpathSync`: on macOS the temp folder is a symlink, and the server compares real paths.
 */
export function projectDir(prefix = "solip-"): ProjectDir {
  const was = process.env.SOLIPSIST_PROJECT_ROOT;
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const docs = join(root, ".solipsist", "pages");
  const images = join(root, ".solipsist", "images");
  mkdirSync(docs, { recursive: true });
  mkdirSync(images, { recursive: true });
  return {
    root,
    docs,
    images,
    enter: () => void (process.env.SOLIPSIST_PROJECT_ROOT = root),
    done() {
      if (was === undefined) delete process.env.SOLIPSIST_PROJECT_ROOT;
      else process.env.SOLIPSIST_PROJECT_ROOT = was;
      rmSync(root, { recursive: true, force: true });
    },
  };
}
