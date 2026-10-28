"use client";

import { useEffect } from "react";
import { isAndroidWrapper } from "@/lib/client/wrapper";

/**
 * Mounted in the root layout so the first page the Android app opens (often /login)
 * records it before client navigation drops ?source=android. Marks <html data-android-app>.
 */
export function AndroidWrapperMarker() {
  useEffect(() => {
    if (isAndroidWrapper()) document.documentElement.dataset.androidApp = "1";
  }, []);
  return null;
}
