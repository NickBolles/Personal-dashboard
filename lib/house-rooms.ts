/**
 * H1: House tiles grouped by Home Assistant area (room). Rooms sort by name;
 * devices with no area land in "Unassigned", always last. Within a room the
 * order is doors/locks first, then lights, then cameras, each by name.
 */
export const UNASSIGNED_ROOM = "Unassigned";

const KIND_ORDER: Record<string, number> = { lock: 0, garage: 0, door: 0, window: 0, cover: 0, light: 1, camera: 2 };

export type RoomGroup<T> = { room: string; devices: T[] };

export function groupByRoom<T extends { name: string; kind: string; area?: string | null }>(devices: T[]): RoomGroup<T>[] {
  const rooms = new Map<string, T[]>();
  for (const d of devices) {
    const room = d.area?.trim() || UNASSIGNED_ROOM;
    const list = rooms.get(room);
    if (list) list.push(d);
    else rooms.set(room, [d]);
  }
  const byKind = (a: T, b: T) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || a.name.localeCompare(b.name);
  return [...rooms.entries()]
    .sort(([a], [b]) => (a === UNASSIGNED_ROOM ? 1 : b === UNASSIGNED_ROOM ? -1 : a.localeCompare(b)))
    .map(([room, list]) => ({ room, devices: [...list].sort(byKind) }));
}

/** Stable DOM id fragment for a room header. */
export const roomSlug = (room: string) =>
  room
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "room";
