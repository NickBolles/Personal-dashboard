"use client";
import { useSyncExternalStore } from "react";
let owner: string | null = null;
const listeners = new Set<() => void>();
export function setPanelOwner(id: string | null) {
  if (owner === id) return;
  owner = id;
  listeners.forEach((listener) => listener());
}
export function usePanelOwner() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => owner,
    () => null,
  );
}
