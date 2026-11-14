import { Extension, type Editor } from "@tiptap/core";
import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey, Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { chatAt, decideSuggestion, suggestionAt } from "./suggestions";

export type VimMode = "normal" | "insert" | "visual" | "vline";

export interface VimState {
  on: boolean;
  mode: VimMode;
  /** Visual modes: the fixed end and the moving end (both are characters, so both are inclusive). */
  anchor: number;
  cursor: number;
  /** A half-typed command: `2d` + `w`. */
  count: string;
  op: "" | "d" | "c" | "y";
  g: boolean;
  /** Where j/k keep returning to, in screen pixels. */
  goalX: number | null;
}

export const vimKey = new PluginKey<VimState>("vim");

const STORE = "solipsist.vim";
const stored = () => { try { return localStorage.getItem(STORE) === "1"; } catch { return false; } };

// ---- text geometry: pure functions of the document --------------------------------------------------------------

interface Block { start: number; end: number }

export function blocks(doc: PMNode): Block[] {
  const out: Block[] = [];
  doc.descendants((n, pos) => {
    if (!n.isTextblock) return true;
    out.push({ start: pos + 1, end: pos + 1 + n.content.size });
    return false;
  });
  return out;
}

const blockAt = (bs: Block[], pos: number) => {
  let i = 0;
  while (i + 1 < bs.length && bs[i + 1]!.start <= pos) i++;
  return i;
};

/** The document as a run of characters, one `\n` entry closing each textblock. Positions are strictly increasing. */
export interface Ch { pos: number; ch: string }
export function flatten(doc: PMNode): Ch[] {
  const out: Ch[] = [];
  for (const b of blocks(doc)) {
    const t = doc.textBetween(b.start, b.end, "", " ");
    for (let i = 0; i < t.length; i++) out.push({ pos: b.start + i, ch: t[i]! });
    out.push({ pos: b.end, ch: "\n" });
  }
  return out;
}

const indexOf = (L: Ch[], pos: number) => {
  let lo = 0, hi = L.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (L[mid]!.pos < pos) lo = mid + 1; else hi = mid;
  }
  return lo;
};

const cls = (c: Ch | undefined, big: boolean) => {
  if (!c || c.ch === "\n" || /\s/.test(c.ch)) return 0;
  return big || /\w/.test(c.ch) ? 1 : 2;
};
const emptyLine = (L: Ch[], j: number) => L[j]!.ch === "\n" && (j === 0 || L[j - 1]!.ch === "\n");
const blank = (L: Ch[], j: number) => cls(L[j], false) === 0 && (L[j]!.ch !== "\n" || !emptyLine(L, j));

/** `w`: start of the next word; an empty line counts as a word. */
export function wordForward(L: Ch[], pos: number, big = false): number {
  const n = L.length;
  let j = indexOf(L, pos);
  const c = cls(L[j], big);
  if (c > 0) while (j < n && cls(L[j], big) === c) j++;
  else if (L[j]?.ch === "\n") j++;
  while (j < n && blank(L, j)) j++;
  return L[Math.min(j, n - 1)]!.pos;
}

/** `e`: last character of this or the next word. */
export function wordEnd(L: Ch[], pos: number, big = false): number {
  const n = L.length;
  let j = indexOf(L, pos) + 1;
  while (j < n && cls(L[j], big) === 0) j++;
  if (j >= n) return L[n - 1]!.pos;
  const c = cls(L[j], big);
  while (j + 1 < n && cls(L[j + 1], big) === c) j++;
  return L[j]!.pos;
}

/** `b`: start of this or the previous word. */
export function wordBack(L: Ch[], pos: number, big = false): number {
  let j = indexOf(L, pos) - 1;
  while (j > 0 && blank(L, j)) j--;
  if (j <= 0) return L[0]!.pos;
  const c = cls(L[j], big);
  if (c > 0) while (j > 0 && cls(L[j - 1], big) === c) j--;
  return L[j]!.pos;
}

/** A position the normal-mode caret can sit at: inside a textblock, and on a character unless the line is empty. */
function clamp(doc: PMNode, pos: number, allowEnd = false): number {
  pos = Math.max(0, Math.min(pos, doc.content.size));
  let $ = doc.resolve(pos);
  if (!$.parent.isTextblock) {
    pos = Selection.near($, 1).from;
    $ = doc.resolve(pos);
  }
  const s = $.start(), e = $.end();
  if (!allowEnd && pos >= e && e > s) return e - 1;
  return pos;
}

function selectionFor(doc: PMNode, mode: VimMode, anchor: number, cursor: number): Selection {
  if (mode === "visual") {
    const lo = Math.min(anchor, cursor), hi = Math.max(anchor, cursor);
    const $h = doc.resolve(hi);
    const to = Math.max(hi, Math.min(hi + 1, $h.end()));
    return anchor <= cursor ? TextSelection.create(doc, lo, to) : TextSelection.create(doc, to, lo);
  }
  if (mode === "vline") {
    const bs = blocks(doc);
    const a = bs[blockAt(bs, Math.min(anchor, cursor))]!, b = bs[blockAt(bs, Math.max(anchor, cursor))]!;
    return anchor <= cursor ? TextSelection.create(doc, a.start, b.end) : TextSelection.create(doc, b.end, a.start);
  }
  return TextSelection.create(doc, cursor);
}

// ---- the keys ---------------------------------------------------------------------------------------------------

interface Register { slice: Slice; linewise: boolean }
let register: Register | null = null;

interface Target { pos: number; linewise?: boolean; inclusive?: boolean; goalX?: number | null; scroll?: number }

/** The element that scrolls the page: the nearest scrollable ancestor of the editor, else the document. */
function scroller(view: EditorView): HTMLElement {
  for (let el = view.dom.parentElement; el; el = el.parentElement) {
    const o = getComputedStyle(el).overflowY;
    if ((o === "auto" || o === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const MOTIONS = new Set(["h", "l", "j", "k", "w", "W", "b", "B", "e", "E", "0", "^", "$", "G", "{", "}", "gg", "C-d", "C-u"]);

function motion(view: EditorView, st: VimState, cursor: number, k: string, n: number | null, hasOp: boolean): Target | null {
  const doc = view.state.doc;
  const bs = blocks(doc);
  const bi = blockAt(bs, cursor);
  const b = bs[bi]!;
  const cnt = n ?? 1;
  const L = () => flatten(doc);
  const repeat = (f: (p: number) => number) => { let p = cursor; for (let i = 0; i < cnt; i++) p = f(p); return p; };
  switch (k) {
    case "h": return { pos: Math.max(b.start, cursor - cnt) };
    case "l": return { pos: Math.min(cursor + cnt, b.end) };
    case "j":
    case "k": {
      const dir = k === "j" ? 1 : -1;
      if (hasOp || st.mode === "vline") {
        const t = bs[Math.max(0, Math.min(bs.length - 1, bi + dir * cnt))]!;
        return { pos: t.start, linewise: true };
      }
      const holdsImage = (blk: Block) => { let f = false; doc.nodesBetween(blk.start, blk.end, (n) => { if (n.type.name === "image") f = true; return !f; }); return f; };
      let p = cursor, x = st.goalX;
      for (let i = 0; i < cnt; i++) {
        // A line with a picture on it, or next to one, is as tall as the picture: probing a few text-lines away from
        // it lands past the next line (or never leaves the picture). Those go one block at a time.
        const here = blockAt(bs, p), next = here + dir;
        if (next < 0 || next >= bs.length) break;
        // Pictures in one paragraph sit on lines of their own when they are wide: from a picture, j and k go to the
        // neighbouring picture in the same paragraph before leaving it.
        if (doc.resolve(p).nodeAfter?.type.name === "image") {
          const imgs: number[] = [];
          doc.nodesBetween(bs[here]!.start, bs[here]!.end, (n, pos) => { if (n.type.name === "image") imgs.push(pos); });
          const sib = dir > 0 ? imgs.find((q) => q > p) : [...imgs].reverse().find((q) => q < p);
          if (sib != null) { p = sib; continue; }
        }
        if (holdsImage(bs[here]!) || holdsImage(bs[next]!)) {
          // Coming up into a paragraph of pictures lands on its last one, the line nearest.
          let land = bs[next]!.start;
          if (dir < 0) doc.nodesBetween(bs[next]!.start, bs[next]!.end, (n, pos) => { if (n.type.name === "image") land = pos; });
          p = clamp(doc, land);
          continue;
        }
        let c;
        try { c = view.coordsAtPos(p); } catch { break; }
        x ??= c.left;
        const lh = Math.max(c.bottom - c.top, 12);
        // The probe can land in the gap between paragraphs (or on an empty one) and resolve to where we already are, so
        // look further out until the position moves; at the very end fall back to the neighbouring block.
        let q = p;
        for (const f of [0.5, 1, 1.5, 2, 3]) {
          const hit = view.posAtCoords({ left: x, top: dir > 0 ? c.bottom + lh * f : c.top - lh * f });
          if (!hit) continue;
          const r = clamp(doc, hit.pos);
          if (dir > 0 ? r > p : r < p) { q = r; break; }
        }
        // Never past the neighbouring line.
        if (q !== p && Math.abs(blockAt(bs, q) - here) > 1) q = p;
        if (q === p) {
          const j = blockAt(bs, p) + dir;
          if (j < 0 || j >= bs.length) break;
          q = clamp(doc, bs[j]!.start);
        }
        p = q;
      }
      return { pos: p, goalX: x };
    }
    case "C-d": case "C-u": {
      // Half a screen: the caret goes as far down (up) the page as the page scrolls, so it keeps its place on screen.
      const dir = k === "C-d" ? 1 : -1;
      const sc = scroller(view);
      const half = Math.max(1, Math.round((sc === document.scrollingElement || sc === document.documentElement ? window.innerHeight : sc.clientHeight) / 2));
      let c;
      try { c = view.coordsAtPos(cursor); } catch { return { pos: cursor }; }
      const x = st.goalX ?? c.left;
      const hit = view.posAtCoords({ left: x, top: (c.top + c.bottom) / 2 + dir * half });
      // Past either end of the page, or nothing under the probe: the last (first) line.
      const edge = (dir > 0 ? bi < bs.length - 1 : bi > 0) ? (dir > 0 ? bs[bs.length - 1]! : bs[0]!).start : cursor;
      const pos = hit && (dir > 0 ? hit.pos > cursor : hit.pos < cursor) ? clamp(doc, hit.pos) : clamp(doc, edge);
      return { pos, goalX: x, scroll: dir * half };
    }
    case "w": case "W": { const l = L(); return { pos: repeat((p) => wordForward(l, p, k === "W")) }; }
    case "e": case "E": { const l = L(); return { pos: repeat((p) => wordEnd(l, p, k === "E")), inclusive: true }; }
    case "b": case "B": { const l = L(); return { pos: repeat((p) => wordBack(l, p, k === "B")) }; }
    case "0": return { pos: b.start };
    case "^": {
      const t = doc.textBetween(b.start, b.end, "", " ");
      return { pos: b.start + (t.length - t.trimStart().length) };
    }
    case "$": return { pos: b.end };
    case "gg": return { pos: bs[n == null ? 0 : Math.min(bs.length, n) - 1]!.start, linewise: true };
    case "G": return { pos: bs[n == null ? bs.length - 1 : Math.min(bs.length, n) - 1]!.start, linewise: true };
    case "{": case "}": {
      const empties = bs.map((x, i) => (x.start === x.end ? i : -1)).filter((i) => i >= 0);
      let i = bi;
      for (let r = 0; r < cnt; r++) {
        const next = k === "}" ? empties.find((e) => e > i) : [...empties].reverse().find((e) => e < i);
        if (next == null) return { pos: k === "}" ? bs[bs.length - 1]!.end : bs[0]!.start };
        i = next;
      }
      return { pos: bs[i]!.start };
    }
  }
  return null;
}

function commit(view: EditorView, tr: Transaction, patch: Partial<VimState>) {
  const st = vimKey.getState(view.state)!;
  const next = { ...st, ...patch };
  const cursor = patch.cursor ?? tr.mapping.map(st.cursor);
  const anchor = patch.anchor ?? tr.mapping.map(st.anchor);
  if (next.mode === "insert") {
    if (patch.cursor != null) tr.setSelection(TextSelection.create(tr.doc, clamp(tr.doc, patch.cursor, true)));
  } else {
    tr.setSelection(selectionFor(tr.doc, next.mode, anchor, cursor));
  }
  tr.setMeta(vimKey, patch);
  view.dispatch(tr.scrollIntoView());
}

const IDLE = { count: "", op: "" as const, g: false, goalX: null };

function toNormal(view: EditorView, cursor: number, tr = view.state.tr) {
  commit(view, tr, { ...IDLE, mode: "normal", cursor: clamp(tr.doc, cursor) });
}

function yank(view: EditorView, from: number, to: number, linewise: boolean) {
  register = { slice: view.state.doc.slice(from, to), linewise };
  try { void navigator.clipboard?.writeText(view.state.doc.textBetween(from, to, "\n")); } catch { /* not allowed here */ }
}

/** Applies an operator to a span. Linewise spans are given as the first and last block's content bounds. */
function operate(view: EditorView, op: "d" | "c" | "y", from: number, to: number, linewise: boolean) {
  const doc = view.state.doc;
  const $f = doc.resolve(from), $t = doc.resolve(to);
  const outer = linewise ? [$f.before(), $t.after()] : [from, to];
  yank(view, outer[0]!, outer[1]!, linewise);
  if (op === "y") return toNormal(view, linewise ? Math.min(from, view.state.selection.head) : from);

  const tr = view.state.tr;
  if (linewise && op === "d") {
    const lone = $f.node(-1).childCount === $t.index(-1) - $f.index(-1) + 1;
    if (lone || $f.before() === 0) tr.delete(from, to);
    else tr.delete($f.before(), $t.after());
  } else if (from < to) {
    tr.delete(from, to);
  }
  const at = tr.mapping.map(from);
  if (op === "c") return commit(view, tr, { ...IDLE, mode: "insert", cursor: at });
  toNormal(view, at, tr);
}

function paste(view: EditorView, before: boolean, cursor: number) {
  if (!register) return;
  const tr = view.state.tr;
  const $c = tr.doc.resolve(cursor);
  let at: number;
  if (register.linewise) at = before ? $c.before() : $c.after();
  else at = before || $c.start() === $c.end() ? cursor : cursor + 1;
  tr.replaceRange(at, at, register.slice);
  const end = register.linewise
    ? Selection.near(tr.doc.resolve(tr.mapping.map(at, -1)), 1).from
    : tr.mapping.map(at, 1) - 1;
  toNormal(view, end, tr);
}

function runOp(view: EditorView, st: VimState, cursor: number, op: "d" | "c" | "y", k: string, cnt: number) {
  const t = motion(view, st, cursor, k, cnt, true);
  if (!t) return;
  rangeOp(view, st, cursor, op, k, t, cnt);
}

function rangeOp(view: EditorView, st: VimState, cursor: number, op: "d" | "c" | "y", k: string, t: Target, cnt: number) {
  const doc = view.state.doc;
  const bs = blocks(doc);
  if (t.linewise) {
    const a = bs[blockAt(bs, cursor)]!, b = bs[blockAt(bs, t.pos)]!;
    return operate(view, op, Math.min(a.start, b.start), Math.max(a.end, b.end), true);
  }
  let target = t.pos, inclusive = !!t.inclusive;
  const here = bs[blockAt(bs, cursor)]!;
  if (k === "w" || k === "W") {
    const L = flatten(doc), big = k === "W";
    if (op === "c" && cls(L[indexOf(L, cursor)], big) > 0) {
      // `cw` stops at the end of the word instead of eating the space after it.
      const j = indexOf(L, cursor);
      let e = j;
      while (cls(L[e + 1], big) === cls(L[j], big)) e++;
      target = L[e]!.pos;
      for (let i = 1; i < cnt; i++) target = wordEnd(L, target, big);
      inclusive = true;
    } else if (target > here.end) {
      target = here.end; // `dw` on the last word of a line stays on the line
    }
  }
  const a = Math.min(cursor, target), b = Math.max(cursor, target) + (inclusive ? 1 : 0);
  operate(view, op, a, Math.min(b, doc.content.size), false);
  void st;
}

/** One key in normal or visual mode. Returns whether it was used. */
function handleKey(view: EditorView, editor: Editor, st: VimState, k: string): boolean {
  const doc = view.state.doc;
  const visual = st.mode === "visual" || st.mode === "vline";
  const cursor = visual ? st.cursor : view.state.selection.head;
  const patch = (p: Partial<VimState>) => { view.dispatch(view.state.tr.setMeta(vimKey, p)); return true; };
  const reset = () => patch(IDLE);

  if (k === "Escape") {
    if (visual) { toNormal(view, cursor); return true; }
    return reset();
  }
  const n = st.count ? parseInt(st.count, 10) : null;
  const cnt = n ?? 1;

  if (k === "Backspace") k = "h";
  if (k === "Enter") k = "j";

  if (/^[0-9]$/.test(k) && !(k === "0" && st.count === "") && !st.g) return patch({ count: st.count + k });
  if (st.g) {
    // `ga` / `gr`: accept or reject the suggestion at the caret; `gc`: chat with the agent behind it, or working on it.
    if (k === "a" || k === "r" || k === "c") {
      reset();
      if (k === "c") return chatAt(view, view.state.selection.from);
      const s = suggestionAt(view.state, view.state.selection.from);
      return !!s && decideSuggestion(view, s.id, k === "a" ? "accepted" : "rejected");
    }
    return k === "g" ? doMotion("gg") : reset();
  }
  if (k === "g") return patch({ g: true });

  function doMotion(m: string): boolean {
    const t = motion(view, st, cursor, m, n, !visual && !!st.op);
    if (!t) return reset();
    if (!visual && st.op) {
      rangeOp(view, st, cursor, st.op, m, t, cnt);
      return true;
    }
    const pos = clamp(doc, t.pos);
    const tr = view.state.tr;
    if (t.scroll) scroller(view).scrollBy?.({ top: t.scroll });
    if (visual) commit(view, tr, { ...IDLE, cursor: pos, goalX: t.goalX ?? null });
    else commit(view, tr, { ...IDLE, mode: "normal", cursor: pos, goalX: t.goalX ?? null });
    return true;
  }

  if (MOTIONS.has(k)) return doMotion(k);

  if (visual) {
    const bs = blocks(doc);
    const lo = Math.min(st.anchor, st.cursor), hi = Math.max(st.anchor, st.cursor);
    const span = (): [number, number, boolean] => {
      if (st.mode === "vline") return [bs[blockAt(bs, lo)]!.start, bs[blockAt(bs, hi)]!.end, true];
      return [lo, Math.max(hi, Math.min(hi + 1, doc.resolve(hi).end())), false];
    };
    switch (k) {
      case "d": case "x": case "X": case "D": return operate(view, "d", ...span()), true;
      case "y": case "Y": return operate(view, "y", ...span()), true;
      case "c": case "s": case "C": case "S": return operate(view, "c", ...span()), true;
      case "o": commit(view, view.state.tr, { anchor: st.cursor, cursor: st.anchor }); return true;
      case "v": return st.mode === "visual" ? (toNormal(view, cursor), true) : (commit(view, view.state.tr, { mode: "visual" }), true);
      case "V": return st.mode === "vline" ? (toNormal(view, cursor), true) : (commit(view, view.state.tr, { mode: "vline" }), true);
    }
    return true;
  }

  if (k === "d" || k === "c" || k === "y") {
    if (st.op === k) {
      const bs = blocks(doc);
      const i = blockAt(bs, cursor);
      const last = bs[Math.min(bs.length - 1, i + cnt - 1)]!;
      operate(view, k, bs[i]!.start, last.end, true);
    } else {
      patch({ op: k, g: false });
    }
    return true;
  }
  if (st.op) return reset();

  const line = doc.resolve(cursor);
  const mode = (m: VimMode, p: Partial<VimState> = {}) => commit(view, view.state.tr, { ...IDLE, mode: m, ...p });
  switch (k) {
    case "i": return mode("insert", { cursor }), true;
    case "a": return mode("insert", { cursor: line.start() === line.end() ? cursor : cursor + 1 }), true;
    case "I": return mode("insert", { cursor: motion(view, st, cursor, "^", null, false)!.pos }), true;
    case "A": return mode("insert", { cursor: line.end() }), true;
    case "o":
    case "O": {
      const where = k === "o" ? line.end() : line.start();
      mode("insert", { cursor: where });
      editor.commands.splitBlock();
      if (k === "O") {
        const $ = view.state.selection.$from;
        view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve($.before()), -1)));
      }
      return true;
    }
    case "x": runOp(view, st, cursor, "d", "l", cnt); return true;
    case "X": runOp(view, st, cursor, "d", "h", cnt); return true;
    case "D": runOp(view, st, cursor, "d", "$", 1); return true;
    case "C": runOp(view, st, cursor, "c", "$", 1); return true;
    case "s": runOp(view, st, cursor, "c", "l", cnt); return true;
    case "S": case "Y": {
      const bs = blocks(doc);
      const i = blockAt(bs, cursor);
      operate(view, k === "S" ? "c" : "y", bs[i]!.start, bs[Math.min(bs.length - 1, i + cnt - 1)]!.end, true);
      return true;
    }
    case "p": case "P": paste(view, k === "P", cursor); return true;
    case "u": case "U":
      editor.commands.undo();
      toNormal(view, view.state.selection.from);
      return true;
    case "v": return mode("visual", { anchor: cursor, cursor }), true;
    case "V": return mode("vline", { anchor: cursor, cursor }), true;
  }
  return true; // every other key is swallowed: normal mode never types
}

// ---- the plugin -------------------------------------------------------------------------------------------------

const cursorDeco = (state: EditorState, st: VimState): Decoration | null => {
  const pos = st.mode === "normal" ? state.selection.head : st.cursor;
  if (pos < 0 || pos > state.doc.content.size) return null;
  const $ = state.doc.resolve(pos);
  if (!$.parent.isTextblock) return null;
  if (pos < $.end()) return Decoration.inline(pos, pos + 1, { class: "vim-cursor" });
  return Decoration.widget(pos, () => {
    const el = document.createElement("span");
    el.className = "vim-cursor vim-cursor-empty";
    el.textContent = "​";
    return el;
  }, { side: 1, key: "vim-cursor-empty" });
};

export const vim = Extension.create({
  name: "vim",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin<VimState>({
        key: vimKey,
        state: {
          init: () => {
            const on = stored();
            return { on, mode: on ? "normal" : "insert", anchor: 0, cursor: 0, ...IDLE };
          },
          apply(tr, st) {
            let next = st;
            const p = tr.getMeta(vimKey) as Partial<VimState> | undefined;
            if (tr.docChanged) next = { ...next, anchor: tr.mapping.map(next.anchor), cursor: tr.mapping.map(next.cursor) };
            if (p) next = { ...next, ...p };
            else if (tr.selectionSet) next = { ...next, goalX: null };
            if (next.on && next.mode === "normal" && next.cursor !== tr.selection.head) next = { ...next, cursor: tr.selection.head };
            return next;
          },
        },
        // Mouse and shift-arrow selections become visual mode; a caret past the last character steps back onto it.
        appendTransaction(trs, _old, state) {
          const st = vimKey.getState(state)!;
          if (!st.on || st.mode === "insert" || trs.some((t) => t.getMeta(vimKey))) return null;
          const sel = state.selection;
          if (!(sel instanceof TextSelection)) return null;
          if (!sel.empty) {
            if (!trs.some((t) => t.selectionSet)) return null;
            const fwd = sel.head >= sel.anchor;
            return state.tr.setMeta(vimKey, {
              ...IDLE,
              mode: "visual" as const,
              anchor: fwd ? sel.anchor : sel.anchor - 1,
              cursor: fwd ? sel.head - 1 : sel.head,
            });
          }
          if (st.mode !== "normal") return state.tr.setMeta(vimKey, { ...IDLE, mode: "normal" as const, cursor: clamp(state.doc, sel.head) });
          const at = clamp(state.doc, sel.head);
          return at === sel.head ? null : state.tr.setSelection(TextSelection.create(state.doc, at)).setMeta(vimKey, {});
        },
        props: {
          attributes: (state) => {
            const st = vimKey.getState(state)!;
            return { class: st.on ? `vim vim-${st.mode}` : "" };
          },
          decorations: (state) => {
            const st = vimKey.getState(state)!;
            if (!st.on || st.mode === "insert") return null;
            const d = cursorDeco(state, st);
            return d ? DecorationSet.create(state.doc, [d]) : null;
          },
          handleTextInput: (view) => {
            const st = vimKey.getState(view.state)!;
            return st.on && st.mode !== "insert";
          },
          handleKeyDown: (view, e) => {
            const st = vimKey.getState(view.state)!;
            if (!st.on || e.isComposing) return false;
            if (st.mode === "insert") {
              if (e.key !== "Escape" && !(e.ctrlKey && e.key === "[")) return false;
              const $ = view.state.selection.$from;
              toNormal(view, $.pos > $.start() ? $.pos - 1 : $.pos);
              e.preventDefault();
              return true;
            }
            if (e.metaKey || e.altKey) return false;
            let k = e.key;
            if (e.ctrlKey) {
              if (k === "[") k = "Escape";
              else if (k === "r") {
                editor.commands.redo();
                toNormal(view, view.state.selection.from);
                e.preventDefault();
                return true;
              } else if ((k === "d" || k === "u") && !st.op) k = k === "d" ? "C-d" : "C-u";
              else return false;
            }
            const printable = k.length === 1 || k === "C-d" || k === "C-u" || k === "Escape" || k === "Backspace" || k === "Enter";
            if (!printable) return false;
            e.preventDefault();
            return handleKey(view, editor, st, k);
          },
        },
      }),
    ];
  },
});

/** Turns vim keys on or off (remembered in this browser). Off puts the writer back in the ordinary editor. */
export function setVim(editor: Editor, on: boolean) {
  const view = editor.view;
  try { localStorage.setItem(STORE, on ? "1" : "0"); } catch { /* private window */ }
  const tr = view.state.tr;
  if (on) {
    const at = clamp(tr.doc, tr.selection.head);
    commit(view, tr, { ...IDLE, on, mode: "normal", cursor: at });
  } else {
    const head = tr.selection.head;
    tr.setSelection(TextSelection.create(tr.doc, head));
    tr.setMeta(vimKey, { ...IDLE, on, mode: "insert" });
    view.dispatch(tr);
  }
  view.focus();
}
