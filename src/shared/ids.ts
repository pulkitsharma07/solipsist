/**
 * Every id the app checks or makes, in one place (browser and server). A page id is a `.md` file's path from the
 * project, without the `.md`; a task id is in the page's comments and in the records. The `*_SOURCE` strings go inside
 * larger regexes.
 */

const MAX_PAGE_ID_BYTES = 1024;
/** A page id: a relative path. Dot-leading segments cover `.`, `..` and hidden folders. */
export const isPageId = (id: unknown): id is string =>
  typeof id === "string" && id.length > 0 && new TextEncoder().encode(id).length <= MAX_PAGE_ID_BYTES &&
  // eslint-disable-next-line no-control-regex
  !/[\\\x00-\x1f]/.test(id) && id.split("/").every((s) => s.length > 0 && !s.startsWith("."));

/** The address of a page in the app. */
export const pageUrl = (id: string) => `/d/${id.split("/").map(encodeURIComponent).join("/")}`;

/** New task ids are this long. Pages written before had three characters, so reading takes 3 to 6. */
export const NEW_TASK_ID_LENGTH = 5;
export const TASK_ID_SOURCE = "[a-z0-9]{3,6}";
export const TASK_ID = new RegExp(`^${TASK_ID_SOURCE}$`);
export const isTaskId = (id: unknown): id is string => typeof id === "string" && TASK_ID.test(id);

const ID_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new task id that none in `taken` uses. All kinds share one id space. `random` is for tests. */
export function newTaskId(taken: Iterable<string> | Set<string>, random: () => number = Math.random): string {
  const used = new Set(taken);
  for (;;) {
    let id = "";
    for (let i = 0; i < NEW_TASK_ID_LENGTH; i++) id += ID_CHARS[Math.floor(random() * ID_CHARS.length)];
    if (!used.has(id)) return id;
  }
}
