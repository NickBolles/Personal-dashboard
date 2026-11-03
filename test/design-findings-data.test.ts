import { describe, expect, it } from "vitest";
import { unreadState, unreadTotal } from "@/lib/conversation-unread";
import { UNASSIGNED_ROOM, groupByRoom, roomSlug } from "@/lib/house-rooms";
import { parseAreaSettings } from "@/lib/work";

describe("C4 unread state", () => {
  const base = "2026-11-03T12:00:00.000Z";
  it("is read before the baseline and with no activity", () => {
    expect(unreadState({ lastActiveAt: "2026-11-03T11:00:00.000Z" }, null, base)).toEqual({ unread: false, unreadCount: null });
    expect(unreadState({ lastActiveAt: null }, null, base).unread).toBe(false);
    // never read and no baseline yet: read (the baseline is set on first use)
    expect(unreadState({ lastActiveAt: "2026-11-03T13:00:00.000Z" }, null, null).unread).toBe(false);
  });
  it("is unread after the baseline; count only when the own marker is exact", () => {
    expect(unreadState({ lastActiveAt: "2026-11-03T13:00:00.000Z", messageCount: 9 }, null, base)).toEqual({ unread: true, unreadCount: null });
    const marker = { readAt: "2026-11-03T12:30:00.000Z", readCount: 6 };
    expect(unreadState({ lastActiveAt: "2026-11-03T13:00:00.000Z", messageCount: 9 }, marker, base)).toEqual({ unread: true, unreadCount: 3 });
    // unknown message count → dot only
    expect(unreadState({ lastActiveAt: "2026-11-03T13:00:00.000Z" }, marker, base)).toEqual({ unread: true, unreadCount: null });
  });
  it("opening marks read; Mark all read (a later baseline) wins over older markers", () => {
    const marker = { readAt: "2026-11-03T13:05:00.000Z", readCount: 9 };
    expect(unreadState({ lastActiveAt: "2026-11-03T13:00:00.000Z", messageCount: 9 }, marker, base).unread).toBe(false);
    const old = { readAt: "2026-11-03T10:00:00.000Z", readCount: 2 };
    expect(unreadState({ lastActiveAt: "2026-11-03T11:00:00.000Z", messageCount: 5 }, old, base).unread).toBe(false);
    // moved after the baseline, own marker older than the baseline → not exact
    expect(unreadState({ lastActiveAt: "2026-11-03T12:10:00.000Z", messageCount: 5 }, old, base)).toEqual({ unread: true, unreadCount: null });
  });
  it("counts unread rows", () => {
    expect(unreadTotal([{ unread: true }, { unread: false }, {}, { unread: true }])).toBe(2);
  });
});

describe("H1 room grouping", () => {
  const d = (name: string, kind: string, area?: string) => ({ name, kind, area });
  it("groups by area, sorts rooms, Unassigned last, doors before lights before cameras", () => {
    const g = groupByRoom([
      d("Porch light", "light", "Front porch"),
      d("Driveway camera", "camera"),
      d("Front door camera", "camera", "Front porch"),
      d("Front door lock", "lock", "Front porch"),
      d("Kitchen lights", "light", "Kitchen"),
      d("Back door", "door", "  "),
    ]);
    expect(g.map((x) => x.room)).toEqual(["Front porch", "Kitchen", UNASSIGNED_ROOM]);
    expect(g[0]!.devices.map((x) => x.name)).toEqual(["Front door lock", "Porch light", "Front door camera"]);
    expect(g[2]!.devices.map((x) => x.name)).toEqual(["Back door", "Driveway camera"]);
  });
  it("empty input → no rooms; slugs are stable", () => {
    expect(groupByRoom([])).toEqual([]);
    expect(roomSlug("Living room / Den")).toBe("living-room-den");
    expect(roomSlug("—")).toBe("room");
  });
});

describe("A3 area colour setting", () => {
  it("accepts palette colours only", () => {
    expect(parseAreaSettings(JSON.stringify({ color: "ok" })).color).toBe("ok");
    expect(parseAreaSettings(JSON.stringify({ color: "#ff0000" })).color).toBeNull();
  });
});
