import { expect, it } from "vitest";
import { isSendShortcut } from "@/lib/coordinator/send-shortcut";

it("sends only Ctrl/Cmd+Enter, never plain Enter, Alt or IME composition", () => {
  const enter = { key: "Enter", ctrlKey: false, metaKey: false };
  expect(isSendShortcut(enter)).toBe(false);
  expect(isSendShortcut({ ...enter, ctrlKey: true })).toBe(true);
  expect(isSendShortcut({ ...enter, metaKey: true })).toBe(true);
  expect(isSendShortcut({ ...enter, ctrlKey: true, isComposing: true })).toBe(false);
  expect(isSendShortcut({ ...enter, ctrlKey: true, altKey: true })).toBe(false);
  expect(isSendShortcut({ ...enter, ctrlKey: true, key: "a" })).toBe(false);
});
