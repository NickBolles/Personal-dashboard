"use client";
/**
 * "Show archived" for the Areas tree, shared by the in-page tree (phones/tablets) and the desktop
 * sidebar tree, so archived items stay reachable (to reopen/unarchive) at every width.
 */
import { useSyncExternalStore } from "react";

const KEY = "jarvis:areas:show-archived";
const EVENT = "jarvis:show-archived";

function read(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
}

export function setShowArchived(on: boolean) {
  try {
    if (on) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage blocked: the event still updates this tab */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useShowArchived(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  return [on, setShowArchived];
}
