import { describe, expect, it } from "vitest";
import { isSendShortcut, sendHint } from "./composer-keys";

describe("composer keys", () => {
  it("plain Enter and Shift+Enter never send (newline)", () => {
    expect(isSendShortcut({ key: "Enter" })).toBe(false);
    expect(isSendShortcut({ key: "Enter", altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
  });

  it("Ctrl+Enter and Cmd+Enter send", () => {
    expect(isSendShortcut({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(isSendShortcut({ key: "Enter", metaKey: true })).toBe(true);
  });

  it("IME composition never sends", () => {
    expect(isSendShortcut({ key: "Enter", ctrlKey: true, isComposing: true })).toBe(false);
    expect(isSendShortcut({ key: "Enter", metaKey: true, keyCode: 229 })).toBe(false);
  });

  it("other keys and Alt combos do not send", () => {
    expect(isSendShortcut({ key: "a", ctrlKey: true })).toBe(false);
    expect(isSendShortcut({ key: "Enter", ctrlKey: true, altKey: true })).toBe(false);
  });

  it("hint matches the platform modifier", () => {
    expect(sendHint("⌘")).toBe("⌘↵");
    expect(sendHint("Ctrl")).toBe("Ctrl ↵");
  });
});
