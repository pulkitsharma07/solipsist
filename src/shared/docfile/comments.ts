import type { Node as PMNode } from "@tiptap/pm/model";
import type { Anchor } from "./anchor";
import type { CommentEntry, CommentsBlock, CommentStatus } from "./file";

/** CRUD on the comments block. Pure: a block in, a new block out. */

export const listComments = (block: CommentsBlock, status?: CommentStatus) =>
  Object.values(block.comments).filter((c) => !status || c.status === status);

export function mintId(taken: Set<string> | Record<string, unknown>): string {
  const has = (id: string) => (taken instanceof Set ? taken.has(id) : id in taken);
  for (;;) {
    const id = Math.random().toString(36).slice(2, 8).padEnd(6, "0");
    if (!has(id)) return id;
  }
}

export type NewComment = Omit<CommentEntry, "id" | "status" | "created" | "created_rev">;

export function addComment(block: CommentsBlock, c: NewComment, now = new Date()): { block: CommentsBlock; id: string } {
  const id = mintId(block.comments);
  const entry: CommentEntry = { ...c, id, status: "open", created: now.toISOString(), created_rev: block.meta.rev + 1 };
  return { id, block: { ...block, comments: { ...block.comments, [id]: entry } } };
}

export function setStatus(block: CommentsBlock, id: string, status: CommentStatus, opts: { anchor?: Anchor; now?: Date; opened?: boolean } = {}): CommentsBlock {
  const c = block.comments[id];
  if (!c) return block;
  const next: CommentEntry = { ...c, status, ...(opts.anchor && { anchor: opts.anchor }) };
  if (status === "orphaned" && c.status !== "orphaned") next.orphaned_at = (opts.now ?? new Date()).toISOString();
  if (status !== "orphaned") delete next.orphaned_at;
  // The first open wins: the writer read it once, and that is what keeps a better comment off its block.
  if (opts.opened && !next.opened_at) next.opened_at = (opts.now ?? new Date()).toISOString();
  return { ...block, comments: { ...block.comments, [id]: next } };
}

export function deleteComment(block: CommentsBlock, id: string): CommentsBlock {
  const { [id]: _, ...rest } = block.comments;
  return { ...block, comments: rest };
}

/** The most live comments a page may carry: max(minKept, round(perBlock × non-empty text blocks)). */
export function commentCap(doc: PMNode, minKept = MIN_KEPT, perBlock = KEPT_PER_BLOCK): number {
  let blocks = 0;
  doc.descendants((n) => {
    if (!n.isTextblock) return true;
    if (n.textContent.trim()) blocks++;
    return false;
  });
  return Math.max(minKept, Math.round(perBlock * blocks));
}

/** The cap's defaults, so a caller without settings (the browser) agrees with the server. */
export const MIN_KEPT = 4;
export const KEPT_PER_BLOCK = 0.2;

/** How long an orphaned comment is kept before it is removed from the file: long enough for Undo and for a slow save. */
export const ORPHAN_KEEP_MS = 30_000;

const orphanExpiry = (c: CommentEntry, keepMs: number) => (c.orphaned_at ? Date.parse(c.orphaned_at) + keepMs : 0);

/**
 * Drops the comments that can't be placed anywhere: orphaned ones (their passage is gone from the page) that have been
 * orphaned for at least `keepMs`. Open and dismissed comments are never removed here.
 */
export function pruneOrphans(block: CommentsBlock, now = new Date(), keepMs = ORPHAN_KEEP_MS): { block: CommentsBlock; removed: string[] } {
  const removed = Object.values(block.comments)
    .filter((c) => c.status === "orphaned" && orphanExpiry(c, keepMs) <= now.getTime())
    .map((c) => c.id);
  if (!removed.length) return { block, removed };
  const comments = { ...block.comments };
  for (const id of removed) delete comments[id];
  return { block: { ...block, comments }, removed };
}

/** When the next orphaned comment becomes removable (epoch ms), or null if there are none waiting. */
export function nextOrphanExpiry(block: CommentsBlock, keepMs = ORPHAN_KEEP_MS): number | null {
  const times = Object.values(block.comments).filter((c) => c.status === "orphaned").map((c) => orphanExpiry(c, keepMs));
  return times.length ? Math.min(...times) : null;
}
