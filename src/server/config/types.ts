// What a setting is: the shape of a row of the table (see ../config.ts).
export class ConfigError extends Error {}

export type Kind = "int" | "number" | "bool" | "string" | "strings" | "path" | "logfile";

export interface Setting {
  /** Where it sits in the file: `agent.concurrency`, or a top-level key such as `md_search_paths`. */
  key: string;
  /** Its one env name. An empty variable counts as unset. */
  env: string;
  kind: Kind;
  /** Absent: the setting is optional and has no value unless one is given. */
  default?: unknown;
  /** `int` and `strings` bounds; a `number` is > 0, or ≥ 0 when `min` is 0. */
  min?: number;
  max?: number;
  /** One line, for the file's comments and the reference. */
  summary: string;
  /** Why and when a writer would change it. */
  purpose: string;
  /** A `string` that must be one of these words. */
  choices?: string[];
  /** What the example file shows for an optional setting. */
  example?: unknown;
  /** Never printed: not in errors, not by `--print-config`. */
  secret?: boolean;
}
