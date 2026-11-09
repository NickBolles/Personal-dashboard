/** Deep links that open the global coordinator (sheet on phones, rail on desktop) at a target. */
export type CoordTarget = { coord: "needs" | "running" | "chat"; d?: string; r?: string; f?: "interrupted" };

export function coordLink(t: CoordTarget, path = "/home"): string {
  const q = new URLSearchParams({ coord: t.coord });
  if (t.d && /^D-\d{1,9}$/.test(t.d)) q.set("d", t.d);
  if (t.r && /^R-\d{1,9}$/.test(t.r)) q.set("r", t.r);
  if (t.f === "interrupted") q.set("f", t.f);
  return `${path}?${q.toString()}`;
}
