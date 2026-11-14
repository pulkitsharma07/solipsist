import type { JSONContent } from "@tiptap/core";
import { diffPatch } from "node-diff3";
import { blockKey } from "./markdown";
import { POINT_NODE, RANGE_MARK } from "./markers";
import { schema } from "./schema";

/**
 * A three-way merge of documents that works on their structure: the page's blocks, a list's items, a table's rows and
 * a row's cells. Changes to different ones never conflict, whatever the serializer does to numbering, padding or fences.
 * The smallest unit is a text block (a paragraph, heading, cell paragraph or code block): one changed on both sides is
 * a conflict (decided 2026-10-21), except when one side only finished a marker in it (`spliceFill`).
 *
 * Returns the merged document, or null on a conflict.
 */
export function mergeDocs(base: JSONContent, mine: JSONContent, theirs: JSONContent): JSONContent | null {
  const content = mergeSequence(base.content ?? [], mine.content ?? [], theirs.content ?? [], blockKey);
  return content && { ...mine, content };
}

const json = (x: unknown) => JSON.stringify(x ?? null);
/** Below the top level a node is known by its JSON: every side was parsed from markdown, so it is canonical. */
const nodeKey = (n: JSONContent) => json(n);

interface Hunk {
  /** The base items [start, end) it replaces; start === end for a pure insertion. */
  start: number;
  end: number;
  items: JSONContent[];
  keys: string[];
}

function hunks(baseKeys: string[], items: JSONContent[], key: (n: JSONContent) => string): Hunk[] {
  const keys = items.map(key);
  return diffPatch(baseKeys, keys).map((p) => {
    const n = p.buffer2.chunk.length;
    return { start: p.buffer1.offset, end: p.buffer1.offset + p.buffer1.length, items: items.slice(p.buffer2.offset, p.buffer2.offset + n), keys: keys.slice(p.buffer2.offset, p.buffer2.offset + n) };
  });
}

/** How alike two nodes are: the length of the JSON they share at the start and the end. */
function likeness(a: JSONContent, b: JSONContent): number {
  const [x, y] = [json(a), json(b)];
  let pre = 0;
  while (pre < x.length && pre < y.length && x[pre] === y[pre]) pre++;
  let suf = 0;
  while (suf < x.length - pre && suf < y.length - pre && x[x.length - 1 - suf] === y[y.length - 1 - suf]) suf++;
  return pre + suf;
}

/**
 * A hunk that replaced some items with a different number of others, split into what happened to each: an item
 * paired with the most alike new item of its type (in order) was changed; new items left over were inserted, base
 * items left over removed. The diff groups a changed block with a block added next to it ("the list changed, and a
 * paragraph was added after it"), which then met the other side's edit to that list as one bigger change: a conflict.
 */
function align(h: Hunk, base: JSONContent[]): Hunk[] {
  const n = h.end - h.start;
  if (!n || !h.items.length || n === h.items.length) return [h];
  const out: Hunk[] = [];
  let next = 0; // the first new item not yet placed
  const insert = (at: number, upTo: number) => {
    if (upTo > next) out.push({ start: at, end: at, items: h.items.slice(next, upTo), keys: h.keys.slice(next, upTo) });
    next = Math.max(next, upTo);
  };
  for (let i = 0; i < n; i++) {
    const b = base[h.start + i]!;
    let best = -1;
    for (let j = next; j < h.items.length; j++) {
      if (h.items[j]!.type === b.type && (best < 0 || likeness(b, h.items[j]!) > likeness(b, h.items[best]!))) best = j;
    }
    if (best < 0) { out.push({ start: h.start + i, end: h.start + i + 1, items: [], keys: [] }); continue; }
    insert(h.start + i, best);
    out.push({ start: h.start + i, end: h.start + i + 1, items: [h.items[best]!], keys: [h.keys[best]!] });
    next = best + 1;
  }
  insert(h.end, h.items.length);
  return out;
}

/**
 * A run of items replaced one for one, as one hunk per item. The diff groups neighbouring changes, so two items the
 * writer changed were one hunk, and an edit by the other side to just one of them (another cell of that row, another
 * child of that list item) overlapped it without lining up: a conflict. Item by item, it meets only its own item.
 */
const oneByOne = (hs: Hunk[]): Hunk[] =>
  hs.flatMap((h) => (h.items.length > 1 && h.items.length === h.end - h.start
    ? h.items.map((item, i) => ({ start: h.start + i, end: h.start + i + 1, items: [item], keys: [h.keys[i]!] }))
    : [h]));

const sameHunk = (a: Hunk, b: Hunk) => a.start === b.start && a.end === b.end && json(a.keys) === json(b.keys);

/** Is `ins` an insertion that `h` makes too, at the same place: `h` starts there with the same items, or ends there with them? */
function alsoIn(ins: Hunk, h: Hunk): boolean {
  if (ins === h || ins.start !== ins.end || !ins.keys.length || h.keys.length < ins.keys.length) return false;
  const at = (offset: number) => ins.keys.every((k, i) => h.keys[offset + i] === k);
  return (h.start === ins.start && at(0)) || (h.end === ins.start && at(h.keys.length - ins.keys.length));
}

/** Do two edits of the base collide? An insertion right before or after a changed item is compatible with it. */
function collide(a: Hunk, b: Hunk): boolean {
  if (sameHunk(a, b)) return false; // the same edit made twice
  const insertion = (h: Hunk) => h.start === h.end;
  if (insertion(a) && insertion(b)) return a.start === b.start;
  if (insertion(a)) return b.start < a.start && a.start < b.end;
  if (insertion(b)) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/**
 * Merges three versions of a sequence of nodes. Where both sides replaced the same items one for one, each item is
 * merged on its own (`mergeNode`): two edits inside one list, table or row then meet only if they touch the same leaf.
 */
function mergeSequence(base: JSONContent[], mine: JSONContent[], theirs: JSONContent[], key: (n: JSONContent) => string): JSONContent[] | null {
  const baseKeys = base.map(key);
  const theirsKeys = theirs.map(key);
  // Nothing of theirs, or we agree. (Mine matching the base still goes the long way, which keeps the writer's copy of
  // each block: the same key, but maybe a trailing space just typed.)
  if (json(theirsKeys) === json(baseKeys) || json(theirsKeys) === json(mine.map(key))) return mine;
  // An insertion the other side also made, as the start or end of a bigger edit at the same place, is made once.
  const split = (hs: Hunk[]) => oneByOne(hs.flatMap((h) => align(h, base)));
  const ours = split(hunks(baseKeys, mine, key)).sort((a, b) => a.start - b.start || Number(a.start !== a.end) - Number(b.start !== b.end));
  let others = split(hunks(baseKeys, theirs, key));
  ours.splice(0, ours.length, ...ours.filter((x) => !others.some((y) => alsoIn(x, y))));
  others = others.filter((y) => !ours.some((x) => alsoIn(y, x)));
  const used = new Set<Hunk>();
  for (const x of ours) {
    const hit = others.filter((y) => collide(x, y));
    if (!hit.length) continue;
    const y = hit[0]!;
    const n = x.end - x.start;
    if (hit.length > 1 || used.has(y) || y.start !== x.start || y.end !== x.end || x.items.length !== n || y.items.length !== n) return null;
    const merged: JSONContent[] = [];
    for (let i = 0; i < n; i++) {
      const m = mergeNode(base[x.start + i]!, x.items[i]!, y.items[i]!);
      if (!m) return null;
      merged.push(m);
    }
    x.items = merged;
    x.keys = merged.map(key);
    used.add(y);
  }
  // Apply every edit, in base order; at the same place an insertion goes before a replacement that starts there.
  const all = [...ours, ...others.filter((y) => !used.has(y) && !ours.some((x) => sameHunk(x, y)))]
    .sort((a, b) => a.start - b.start || Number(a.start !== a.end) - Number(b.start !== b.end));
  // Items neither side changed are taken as the writer has them: the same key, but maybe a trailing space just typed.
  const kept = (from: number, to: number) => base.slice(from, to).map((x, i) => mineAt(ours, from + i, mine) ?? x);
  const out: JSONContent[] = [];
  let at = 0;
  for (const h of all) {
    out.push(...kept(at, h.start), ...h.items);
    at = Math.max(at, h.end);
  }
  out.push(...kept(at, base.length));
  return out;
}

/** The writer's copy of a base item their edits didn't touch: its index shifted by what their edits before it added or removed. */
function mineAt(ours: Hunk[], index: number, mine: JSONContent[]): JSONContent | undefined {
  let shift = 0;
  for (const h of ours) {
    if (h.start > index) break;
    if (index < h.end) return undefined;
    shift += h.items.length - (h.end - h.start);
  }
  return mine[index + shift];
}

/** One attribute set merged: each attribute from the side that changed it; both changing it differently is a conflict. */
function mergeAttrs(b: JSONContent["attrs"], m: JSONContent["attrs"], t: JSONContent["attrs"]): JSONContent["attrs"] | null {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(b ?? {}), ...Object.keys(m ?? {}), ...Object.keys(t ?? {})])) {
    const [vb, vm, vt] = [b?.[k], m?.[k], t?.[k]];
    if (json(vm) === json(vb)) out[k] = vt;
    else if (json(vt) === json(vb) || json(vt) === json(vm)) out[k] = vm;
    else return null;
  }
  return Object.keys(out).length ? out : undefined;
}

const isContainer = (type: string | undefined) => {
  const t = type ? schema.nodes[type] : undefined;
  return !!t && !t.isTextblock && !t.isLeaf;
};

/** One node changed on both sides: its attributes merged, and its children (a container) or its text (a text block). */
function mergeNode(b: JSONContent, m: JSONContent, t: JSONContent): JSONContent | null {
  if (nodeKey(m) === nodeKey(t) || nodeKey(t) === nodeKey(b)) return m;
  if (nodeKey(m) === nodeKey(b)) return t;
  if (m.type !== b.type || t.type !== b.type) return null;
  const attrs = mergeAttrs(b.attrs, m.attrs, t.attrs);
  if (attrs === null) return null;
  const [cb, cm, ct] = [json(b.content), json(m.content), json(t.content)];
  let content: JSONContent[] | undefined | null;
  if (cm === cb) content = t.content;
  else if (ct === cb || ct === cm) content = m.content;
  else if (isContainer(b.type)) content = mergeSequence(b.content ?? [], m.content ?? [], t.content ?? [], nodeKey);
  else if (schema.nodes[b.type!]?.isTextblock) content = spliceFill(b, t, m); // their fill, into the block as the writer has it
  else content = null;
  if (content === null) return null;
  const out: JSONContent = { ...m, content };
  if (attrs) out.attrs = attrs; else delete out.attrs;
  if (!content) delete out.content;
  return out;
}

// ---- marker fills (decided 2026-10-25) ----

/** Inline content as units: one per character (with its marks) or per inline node, so text can be compared and spliced. */
type Unit = { ch: string; marks: JSONContent["marks"] } | { node: JSONContent };
const units = (content: JSONContent[] | undefined): Unit[] =>
  (content ?? []).flatMap((n): Unit[] => (n.type === "text" ? [...(n.text ?? "")].map((ch) => ({ ch, marks: n.marks })) : [{ node: n }]));
const unitKey = (u: Unit) => ("ch" in u ? `t${u.ch}${json(u.marks ?? [])}` : `n${json(u.node)}`);
function fromUnits(us: Unit[]): JSONContent[] {
  const out: JSONContent[] = [];
  for (const u of us) {
    if ("node" in u) { out.push(u.node); continue; }
    const last = out[out.length - 1];
    if (last?.type === "text" && json(last.marks ?? []) === json(u.marks ?? [])) last.text += u.ch;
    else out.push({ type: "text", text: u.ch, ...(u.marks?.length && { marks: u.marks }) });
  }
  return out;
}

const idsIn = (us: Unit[]) => {
  const ids = new Set<string>();
  for (const u of us) {
    if ("node" in u && u.node.type === POINT_NODE) ids.add(u.node.attrs?.id);
    for (const mk of ("node" in u ? u.node.marks : u.marks) ?? []) if (mk.type === RANGE_MARK) ids.add(mk.attrs?.id);
  }
  return ids;
};

/** The units with markers `ids` taken out (a point removed, a range's marks dropped), and where each ended. */
function without(us: Unit[], ids: Set<string>): { rest: Unit[]; at: Map<string, number> } {
  const rest: Unit[] = [];
  const at = new Map<string, number>();
  for (const u of us) {
    if ("node" in u && u.node.type === POINT_NODE && ids.has(u.node.attrs?.id)) { at.set(u.node.attrs!.id, rest.length); continue; }
    const marks = ("node" in u ? u.node.marks : u.marks) ?? [];
    const ranges = marks.filter((mk) => mk.type === RANGE_MARK && ids.has(mk.attrs?.id)).map((mk) => mk.attrs!.id as string);
    const kept = marks.filter((mk) => !(mk.type === RANGE_MARK && ids.has(mk.attrs?.id)));
    const next: Unit = "node" in u ? { node: { ...u.node, ...(kept.length ? { marks: kept } : { marks: undefined }) } } : { ch: u.ch, marks: kept.length ? kept : undefined };
    if ("node" in next && !kept.length) delete next.node.marks;
    rest.push(next);
    for (const id of ranges) at.set(id, rest.length);
  }
  return { rest, at };
}

/**
 * A text block in which `done` only finished markers: took each out (a point's marker, a range's comments) and
 * added one run of content where it ended (a run may be empty). Each run is put where the same marker sits in
 * `other`, which keeps everything else it changed in the block. Null when the change was anything else, or `other`
 * no longer has one of them.
 */
function spliceFill(base: JSONContent, done: JSONContent, other: JSONContent): JSONContent[] | null {
  const [b, d, o] = [units(base.content), units(done.content), units(other.content)];
  const [inDone, inOther] = [idsIn(d), idsIn(o)];
  const finished = new Set([...idsIn(b)].filter((id) => !inDone.has(id)));
  if (!finished.size || [...finished].some((id) => !inOther.has(id))) return null;
  const { rest, at } = without(b, finished);
  if ([...at.values()].length !== finished.size) return null;
  // The base without them, cut where each one ended: `done` must be those pieces in order, with a run between each.
  const order = [...at.entries()].sort((x, y) => x[1] - y[1]);
  const cuts = [0, ...order.map(([, pos]) => pos), rest.length];
  const pieces = cuts.slice(1).map((end, i) => rest.slice(cuts[i]!, end).map(unitKey));
  const dk = d.map(unitKey);
  const startsAt = (piece: string[], from: number) => piece.every((k, i) => dk[from + i] === k);
  if (!startsAt(pieces[0]!, 0)) return null;
  const last = pieces[pieces.length - 1]!;
  const lastFrom = dk.length - last.length;
  if (lastFrom < pieces[0]!.length || !startsAt(last, lastFrom)) return null;
  const runs = new Map<string, Unit[]>();
  let from = pieces[0]!.length;
  for (let i = 0; i < order.length; i++) {
    // The run of marker i ends where the next piece is found (the last piece is pinned to the end).
    const piece = pieces[i + 1]!;
    let to = i === order.length - 1 ? lastFrom : -1;
    if (to < 0) for (let k = from; k + piece.length <= lastFrom; k++) if (startsAt(piece, k)) { to = k; break; }
    if (to < from) return null;
    runs.set(order[i]![0], d.slice(from, to));
    from = to + piece.length;
  }
  const mine = without(o, finished);
  if (mine.at.size !== finished.size) return null;
  // Right to left, so each insertion leaves the positions before it as they were.
  for (const [id, pos] of [...mine.at.entries()].sort((x, y) => y[1] - x[1])) mine.rest.splice(pos, 0, ...runs.get(id)!);
  return fromUnits(mine.rest);
}
