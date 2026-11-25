"use client";

import { useCallback, useEffect, useRef } from "react";

const KEY = "jarvisPalette";
function marked() {
  return Boolean(window.history.state?.[KEY]);
}

/** One same-URL entry per open, never one per nested palette view.
 * Close completes AFTER traversal, so a selected route cannot be undone by a late Back.
 * Keep all of Next's history state; do not prevent/redispatch popstate.
 */
export function usePaletteHistory(open: boolean, onClose: () => void) {
  const onCloseRef = useRef(onClose);
  const finish = useRef<(() => void) | null>(null);
  const closing = useRef<Promise<void> | null>(null);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  useEffect(() => {
    if (!open) {
      // Reloading while open restores the page, not an invisible extra Back stop.
      if (marked()) window.history.back();
      return;
    }
    const token = crypto.randomUUID();
    window.history.pushState({ ...window.history.state, [KEY]: token }, "");
    const onPop = () => {
      if (window.history.state?.[KEY] === token) return;
      onCloseRef.current();
      finish.current?.();
      finish.current = null;
      closing.current = null;
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (window.history.state?.[KEY] === token) window.history.back();
    };
  }, [open]);
  return useCallback((): Promise<void> => {
    if (closing.current) return closing.current;
    if (!marked()) {
      onCloseRef.current();
      return Promise.resolve();
    }
    closing.current = new Promise<void>((resolve) => {
      finish.current = resolve;
    });
    window.history.back();
    return closing.current;
  }, []);
}
