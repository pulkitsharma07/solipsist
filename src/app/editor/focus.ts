import type { Editor } from "@tiptap/core";

/**
 * Gives the editor focus back (a modal closed, say) without scrolling to the caret: it may still be at the start of
 * the page while the writer was reading far below it.
 */
export function focusQuietly(editor: Editor) {
  editor.commands.focus(null, { scrollIntoView: false });
}
