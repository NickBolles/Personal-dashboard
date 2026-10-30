"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/** True on Apple platforms, where shortcuts read ⌘ instead of Ctrl. */
export function isApple(): boolean {
  if (typeof navigator === "undefined") return false;
  const p = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? "";
  return /mac|iphone|ipad|ipod/i.test(p);
}

/**
 * The modifier glyph for keyboard hints: "⌘" on Apple platforms, "Ctrl"
 * elsewhere. Server render (and hydration) uses "Ctrl", then the client swaps.
 */
export function useModKey(): "⌘" | "Ctrl" {
  return useSyncExternalStore(
    noop,
    () => (isApple() ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
}

/** "⌘K" / "Ctrl K" style label for a modifier shortcut. */
export function shortcutLabel(mod: "⌘" | "Ctrl", key: string): string {
  return mod === "⌘" ? `⌘${key}` : `Ctrl ${key}`;
}
