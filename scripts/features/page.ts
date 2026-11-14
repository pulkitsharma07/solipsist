import type { Editor } from "@tiptap/core";
import type { TaskRecord } from "../../src/shared/docfile";

/** A real editor, with the app's own extensions, on `markdown` (and the suggestions' records, if any), in the fake DOM. */
export async function pageEditor(markdown: string, records: Record<string, TaskRecord> = {}, opts: { onChat?: boolean } = {}): Promise<Editor> {
  // Vim keys are a setting kept in the browser: every page here starts in Standard editing, whatever an earlier one left.
  const { setVim } = await import("../../src/app/editor/vim");
  const { Editor } = await import("@tiptap/core");
  const { editorExtensions } = await import("../../src/app/editor/behaviour");
  const { markdownToDoc } = await import("../../src/shared/docfile");
  const { suggestionKey } = await import("../../src/app/editor/suggestions");
  const el = document.createElement("div");
  document.body.append(el);
  const editor = new Editor({ element: el, extensions: editorExtensions({ ...(opts.onChat && { onChat: () => {} }) }), content: markdownToDoc(markdown).toJSON() });
  setVim(editor, false);
  if (Object.keys(records).length) editor.view.dispatch(editor.state.tr.setMeta(suggestionKey, { records }).setMeta("addToHistory", false));
  return editor;
}

/** The editor's DOM as the page shows it, as a string. */
export const editorHtml = (editor: Editor) => editor.view.dom.outerHTML;

/**
 * A page the agent has answered, as the server writes it: the task `id` acknowledged and its reply checked and
 * recorded (the server's own functions, `test/sim.ts`). Returns the body (task at `:sug`) and the records.
 */
export async function answered(markdown: string, id: string, reply: string, agent?: { engine: string; model: string; session: string }) {
  const { Server } = await import("../../test/sim");
  const { parseFile } = await import("../../src/shared/docfile");
  const server = new Server(markdown);
  server.agentRun(id, reply, undefined, agent);
  const f = parseFile(server.src);
  return { markdown: f.markdown, records: f.block.tasks ?? {} };
}

/** The envelope the agent replies with (`src/server/agent/protocol.md`). */
export const suggestion = (text: string, o: { mode?: string; place?: string; note?: string } = {}) =>
  `<suggestion mode="${o.mode ?? "at"}" place="${o.place ?? "inline"}">\n${text}\n</suggestion>${o.note ? `\n<note>${o.note}</note>` : ""}`;

/** Opens the suggestion `id`'s card (a click on its diff, as the writer does) and returns the card's HTML. */
export function openCard(editor: Editor, id: string): string {
  const preview = editor.view.dom.querySelector<HTMLElement>(`[data-sug="${id}"]`);
  if (!preview) return "";
  preview.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  const card = document.querySelector<HTMLElement>(".sug-card");
  const html = card?.outerHTML ?? "";
  document.querySelectorAll(".sug-side").forEach((el) => el.remove());
  return html;
}
