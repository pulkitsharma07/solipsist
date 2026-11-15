/**
 * What `NODE_ENV` turns on, and why a folder can't turn it on.
 *
 * Bun loads the working directory's `.env` into the environment before any of our code runs, and the working directory
 * is the writer's project: a folder someone else wrote. So a variable that only a developer should set counts only when
 * no `.env` there sets it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** `.env` files Bun loads from the working directory by itself. */
const DOTENV = [".env", ".env.local", ".env.test", ".env.development", ".env.production"];
const textOf = (file: string) => { try { return readFileSync(file, "utf8"); } catch { return ""; } };

/** Whether a `.env` file in the working directory sets one of `names`. */
export function setByFolder(...names: string[]): boolean {
  const line = new RegExp(`^\\s*(export\\s+)?(${names.join("|")})\\s*=`, "m");
  return DOTENV.some((f) => line.test(textOf(join(process.cwd(), f))));
}

/** `NODE_ENV`, unless the folder's `.env` set it: then none. */
export const nodeEnv = (): string | undefined => (setByFolder("NODE_ENV") ? undefined : process.env.NODE_ENV);

/** A test: `bun test` sets `NODE_ENV=test`, and the tests pass it on to the servers they start. */
export const isTest = () => nodeEnv() === "test";

/** The dev routes are on only when asked for: under `bun test`, or `bun run dev` (`NODE_ENV=development`). */
export const devRoutesOn = () => nodeEnv() === "test" || nodeEnv() === "development";

/** Bun's dev server (hot reload, the browser's console in the terminal): only for `bun run dev`. */
export const bunDevServer = () => nodeEnv() === "development";
