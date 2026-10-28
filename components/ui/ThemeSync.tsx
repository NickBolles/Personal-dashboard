"use client";

import { useEffect } from "react";
import { applyAppearance, THEME_EVENT, THEME_KEY, DENSITY_KEY } from "@/lib/client/theme";

/** Applies the pinned theme/density (Settings › Appearance) and keeps tabs in sync. Renders nothing. */
export function ThemeSync() {
  useEffect(() => {
    applyAppearance();
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_KEY || e.key === DENSITY_KEY) applyAppearance();
    };
    const onLocal = () => applyAppearance();
    window.addEventListener("storage", onStorage);
    window.addEventListener(THEME_EVENT, onLocal);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(THEME_EVENT, onLocal);
    };
  }, []);
  return null;
}
