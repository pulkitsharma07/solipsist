import { Mark, mergeAttributes, Node } from "@tiptap/core";
import { asInstruction, asState, DEFAULT_STATE, markerText, POINT_NODE, RANGE_MARK } from "./markers";

/** The attributes every marker has: its task type, its id, how far along it is, and what the writer asked (see `markers.ts`). */
const attributes = () => ({
  taskType: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-task-type"), renderHTML: (attrs: Record<string, any>) => ({ "data-task-type": attrs.taskType }) },
  id: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-id"), renderHTML: (attrs: Record<string, any>) => ({ "data-id": attrs.id }) },
  state: {
    default: DEFAULT_STATE,
    parseHTML: (el: HTMLElement) => asState(el.getAttribute("data-state")),
    renderHTML: (attrs: Record<string, any>) => ({ "data-state": asState(attrs.state) }),
  },
  instruction: {
    default: null,
    parseHTML: (el: HTMLElement) => asInstruction(el.getAttribute("data-instruction")) ?? null,
    renderHTML: (attrs: Record<string, any>) => (asInstruction(attrs.instruction) ? { "data-instruction": attrs.instruction } : {}),
  },
});

/**
 * A point marker (a `gen` marker, or any other point task type): an inline atom, written to the markdown as the HTML
 * comment `<!-- type:abc -->` (see `markdown.ts`). The editor draws its loader; the markdown stays readable anywhere.
 */
export const MarkerPoint = Node.create({
  name: POINT_NODE,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  addAttributes: attributes,
  parseHTML: () => [{ tag: 'span[data-ph="point"]' }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "task-point", "data-ph": "point" })],
});

/**
 * A range marker (a `sel` range, or any other range task type): text the writer asked for something about. Written to
 * the markdown as a pair of comments around the text, `<!-- type:abc -->the text<!-- /type:abc -->`, and drawn with a
 * soft highlight and a loader after it. One range per stretch of text: ranges replace each other, of any task type.
 */
export const MarkerRange = Mark.create({
  name: RANGE_MARK,
  inclusive: false, // typing at the edge of the range doesn't extend it
  addAttributes: attributes,
  parseHTML: () => [{ tag: 'span[data-ph="range"]' }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes, { class: "task-range", "data-ph": "range" }), 0],
  // The opening and closing text is taken from around the children, so this gives the pair of comments (as markers).
  renderMarkdown: (node, h) => {
    const { taskType, id, instruction } = node.attrs ?? {};
    const state = asState(node.attrs?.state);
    return `${markerText("s", taskType, id, state, asInstruction(instruction))}${h.renderChildren(node)}${markerText("e", taskType, id, state)}`;
  },
});
