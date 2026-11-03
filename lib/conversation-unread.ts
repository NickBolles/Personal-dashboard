/**
 * C4 unread state, pure (server/chat/reads.ts stores the markers).
 * A conversation is unread when it moved after the later of its own read
 * marker and the person's "Mark all read" baseline. The count is shown only
 * when it is exact: the conversation's own marker is the newest one and both
 * message counts are known; otherwise the row gets a dot without a number.
 */
export type ReadMarker = { readAt: string; readCount: number | null };
export type Unread = { unread: boolean; unreadCount: number | null };

const ms = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : null;
};

export function unreadState(
  c: { lastActiveAt: string | null; messageCount?: number | null },
  marker: ReadMarker | null | undefined,
  baseline: string | null | undefined,
): Unread {
  const active = ms(c.lastActiveAt);
  const own = ms(marker?.readAt);
  const base = ms(baseline);
  const read = Math.max(own ?? -Infinity, base ?? -Infinity);
  // Never read and no baseline yet: treat as read (the baseline is set on first use).
  if (active === null || read === -Infinity || active <= read) return { unread: false, unreadCount: null };
  const exact = own !== null && (base === null || own >= base) && marker?.readCount != null && c.messageCount != null;
  const n = exact ? c.messageCount! - marker!.readCount! : null;
  return { unread: true, unreadCount: n !== null && n > 0 ? n : null };
}

/** Total unread conversations (the Unread chip's number). */
export function unreadTotal(rows: { unread?: boolean }[]) {
  return rows.reduce((n, r) => n + (r.unread ? 1 : 0), 0);
}
