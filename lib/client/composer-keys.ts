/**
 * Chat composers: Enter always inserts a newline (phone and desktop); sending is the Send
 * button, or Ctrl/⌘ + Enter on a keyboard. IME composition never sends.
 */
export interface ComposerKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}

/** True when this keydown should send the message (Ctrl/⌘ + Enter, not while composing). */
export function isSendShortcut(e: ComposerKey): boolean {
  if (e.key !== "Enter") return false;
  // 229 = the key went to the IME (Safari reports composition this way).
  if (e.isComposing || e.keyCode === 229) return false;
  return Boolean(e.ctrlKey || e.metaKey) && !e.altKey;
}

/** The native keydown, for React keyboard events (isComposing lives on nativeEvent). */
export function composerKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; nativeEvent: KeyboardEvent }): ComposerKey {
  return { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode };
}

/** "⌘↵" on Apple, "Ctrl ↵" elsewhere: the send hint shown on Send buttons. */
export function sendHint(mod: "⌘" | "Ctrl"): string {
  return mod === "⌘" ? "⌘↵" : "Ctrl ↵";
}

/** aria-keyshortcuts value for Send buttons. */
export const SEND_KEYSHORTCUTS = "Control+Enter Meta+Enter";
