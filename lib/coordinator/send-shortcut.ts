/** Enter remains a newline; IME composition must never send. */
export function isSendShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey?: boolean; isComposing?: boolean }): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.isComposing;
}
