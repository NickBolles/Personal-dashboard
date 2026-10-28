"use client";

/**
 * "Is this page running inside the Jarvis Android app (a Trusted Web Activity)?"
 * The app opens every URL with ?source=android, and Chrome sets the referrer to
 * android-app://com.nickbolles.jarvis on its first navigation. The answer is
 * kept in sessionStorage (per tab), not localStorage: the app shares storage
 * with ordinary Chrome tabs on the same phone.
 */
export const ANDROID_PACKAGE = "com.nickbolles.jarvis";
const KEY = "jarvis:android-wrapper";

export function detectAndroidWrapper(loc: { search: string }, referrer: string, store: Pick<Storage, "getItem" | "setItem"> | null): boolean {
  let hit = false;
  try {
    hit = new URLSearchParams(loc.search).get("source") === "android";
  } catch {
    hit = false;
  }
  if (!hit && (referrer === `android-app://${ANDROID_PACKAGE}` || referrer.startsWith(`android-app://${ANDROID_PACKAGE}/`))) hit = true;
  try {
    if (hit) store?.setItem(KEY, "1");
    else hit = store?.getItem(KEY) === "1";
  } catch {
    // storage blocked: fall back to this navigation's signals only
  }
  return hit;
}

export function isAndroidWrapper(): boolean {
  if (typeof window === "undefined") return false;
  let store: Storage | null = null;
  try {
    store = window.sessionStorage;
  } catch {
    store = null;
  }
  return detectAndroidWrapper(window.location, document.referrer || "", store);
}
