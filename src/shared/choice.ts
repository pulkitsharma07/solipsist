/**
 * Reading a model choice (`engine:model`) for display only. The server's `parseChoice` is the one place that decides
 * what a choice means (a bare name is resolved there, and the server always sends the full form); the client only
 * ever shows a choice the server gave it, so these never build or rewrite one.
 */
export const engineOf = (choice: string) => choice.split(":")[0] ?? "";
/** The model part of a choice, as the server's lists name it. */
export const modelOf = (choice: string) => choice.split(":").slice(1).join(":") || choice;
/** An engine's name for the writer, when the server's list doesn't carry its title. */
export const engineLabel = (choice: string) => { const e = engineOf(choice); return e.charAt(0).toUpperCase() + e.slice(1); };
