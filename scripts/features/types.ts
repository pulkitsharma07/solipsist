/** How a writer meets the parts, in the order the page is arranged: where they are, then what they do next. */
export type GroupId = "frame" | "writing" | "asking" | "reading" | "watching" | "talking" | "primitives";

export const GROUPS: { id: GroupId; title: string; blurb: string }[] = [
  { id: "frame", title: "The frame", blurb: "What is always on the screen around a page: where you are, whether it is saved, and what is wrong with the connection." },
  { id: "writing", title: "Writing", blurb: "The page itself, and the small things that happen inside it while you type." },
  { id: "asking", title: "Asking the agent", blurb: "How a writer hands the agent a task from inside the text, and what the page shows while it is picked up and worked on." },
  { id: "reading", title: "Reading its answer", blurb: "What the agent's result looks like in the page, and the ways to accept, reject or send it back." },
  { id: "watching", title: "Watching the agent", blurb: "Quiet signs of what the agents are doing, and the panels that show everything." },
  { id: "talking", title: "Talking to it", blurb: "The chat window: the page-wide chat, and the chat behind a suggestion." },
  { id: "primitives", title: "Primitives", blurb: "The small parts everything above is made of: buttons, key chips, dots, spinners and the motion they use." },
];

/** What kind of thing it is in the code. */
export type Kind = "React component" | "Tiptap extension" | "DOM widget" | "ProseMirror decoration" | "CSS pattern" | "Key binding" | "Diagram";

export interface Specimen {
  label: string;
  /** What this variant is, in a line. */
  note?: string;
  /** HTML, as the app produces it (a component rendered, or an editor's DOM). */
  html: string | (() => string | Promise<string>);
  /** The frame it is shown in (page chrome the part needs to look right). */
  frame?: "plain" | "sheet" | "bar" | "margin" | "panel" | "window" | "side" | "popup" | "review";
}

export interface Entry {
  id: string;
  group: GroupId;
  /** The name it has in the code (and in conversation). */
  name: string;
  kind: Kind;
  /** Where on the screen it is. */
  where: string;
  summary: string;
  /** What it is for, from the writer's side. */
  use: string[];
  /** What happens when the writer touches it: clicks, keys, hover. */
  handlers?: string[];
  specimens: Specimen[];
  /** The files it lives in. */
  source: string[];
}
