import { Extension } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import { Plugin } from "@tiptap/pm/state";
import { instructionInput } from "./instructionInput";
import { imageTargets } from "./imageTargets";
import { links } from "./links";
import { markerKeys } from "./markerCommands";
import { rangeLoaders } from "./rangeLoaders";
import { taskButtons } from "./taskButtons";
import { acceptedSpots } from "./acceptedSpots";
import { freshText } from "./freshText";
import { newBlocks } from "./newBlocks";
import { HtmlCommentChip, HtmlCommentInlineChip } from "./htmlCommentChips";
import { PointWithLoader } from "./pointView";
import { vim } from "./vim";
import { suggestions } from "./suggestions";
import { oneBlockPerComment, pageExtensions, stripCommentMarks } from "../../shared/docfile";

/** What the page needs beyond its schema: one block per comment, and pasting that doesn't copy comments. */
export const pageBehaviour = Extension.create({
  name: "pageBehaviour",
  addProseMirrorPlugins() {
    return [oneBlockPerComment(), new Plugin({ props: { transformPasted: (slice, view) => stripCommentMarks(slice, view.state.doc) } })];
  },
});

/** Everything the editor loads, in the page and in the tests. */
export const editorExtensions = (opts: { onChat?: (id: string) => void; onSchedule?: (task: string, every: number | null) => void; onLink?: (href: string, newTab: boolean) => void; canAsk?: () => boolean; onCannotAsk?: () => void } = {}) => [
  // A point marker is drawn as its loader in the editor, a hand-written HTML comment as a chip.
  ...pageExtensions().map((e) => [PointWithLoader, HtmlCommentChip, HtmlCommentInlineChip].find((v) => v.name === e.name) ?? e),
  // A decoration: drawn by CSS from `data-marker`, never part of the document.
  Placeholder.configure({ placeholder: ({ node, pos }) => (node.type.name === "heading" ? (pos === 0 ? "Untitled" : "Heading") : "Write normally…") }),
  pageBehaviour,
  freshText,
  newBlocks,
  markerKeys.configure({ canAsk: opts.canAsk ?? (() => true), onCannotAsk: opts.onCannotAsk ?? (() => {}) }),
  ...(opts.onLink ? [links.configure({ onLink: opts.onLink })] : []),
  imageTargets,
  instructionInput,
  rangeLoaders,
  taskButtons.configure({ onSchedule: opts.onSchedule ?? null }),
  acceptedSpots,
  suggestions.configure({ onChat: opts.onChat ?? null }),
  vim,
];
