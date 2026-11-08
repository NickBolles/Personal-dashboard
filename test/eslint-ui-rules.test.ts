import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import jarvisUi from "@/eslint-rules/jarvis-ui.mjs";

const linter = new Linter({ configType: "flat" });
const config = [
  {
    files: ["**/*.tsx"],
    languageOptions: { parser: tseslint.parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "jarvis-ui": jarvisUi },
    rules: {
      "jarvis-ui/no-native-controls": "error",
      "jarvis-ui/no-legacy-imports": "error",
      "jarvis-ui/no-hex-colours": "error",
      "jarvis-ui/no-arbitrary-values": "error",
      "jarvis-ui/icon-button-label": "error",
    },
  },
];
const lint = (code: string) => linter.verify(code, config as never, "x.tsx").map((m) => m.ruleId);

describe("jarvis-ui lint rules", () => {
  it("bans native controls but allows file/hidden inputs and library components", () => {
    expect(lint(`const a = <select><option /></select>;`)).toEqual(["jarvis-ui/no-native-controls"]);
    expect(lint(`const a = <button type="button">x</button>;`)).toEqual(["jarvis-ui/no-native-controls"]);
    expect(lint(`const a = <textarea />;`)).toEqual(["jarvis-ui/no-native-controls"]);
    expect(lint(`const a = <input type="checkbox" />;`)).toEqual(["jarvis-ui/no-native-controls"]);
    expect(lint(`const a = <input type="file" aria-label="Upload" />;`)).toEqual([]);
    expect(lint(`const a = <><Button>Save</Button><Input /><SelectPicker /></>;`)).toEqual([]);
  });

  it("bans legacy and non-canonical UI import paths", () => {
    expect(lint(`import { Badge } from "@/components/ui/legacy";`)).toEqual(["jarvis-ui/no-legacy-imports"]);
    expect(lint(`import { Pill } from "@/components/ui/kit";`)).toEqual(["jarvis-ui/no-legacy-imports"]);
    expect(lint(`import { Pill, Button } from "@/components/ui";`)).toEqual([]);
  });

  it("bans hex colours but not anchors or comments", () => {
    expect(lint(`const c = "#4fd8c4";`)).toEqual(["jarvis-ui/no-hex-colours"]);
    expect(lint("const c = `color: #fff`;")).toEqual(["jarvis-ui/no-hex-colours"]);
    expect(lint(`const c = "/areas#today-proof and #add-item"; // see #147;`)).toEqual([]);
  });

  it("bans Tailwind arbitrary values except token references", () => {
    expect(lint(`const c = "px-2 text-[13px]";`)).toEqual(["jarvis-ui/no-arbitrary-values"]);
    expect(lint(`const c = "dense:min-h-[30px]";`)).toEqual(["jarvis-ui/no-arbitrary-values"]);
    expect(lint(`const c = "ring-2 ring-[var(--surface)] bg-surface";`)).toEqual([]);
  });

  it("requires a name on icon-only Buttons", () => {
    expect(lint(`const a = <Button iconOnly icon={<I />} />;`)).toEqual(["jarvis-ui/icon-button-label"]);
    expect(lint(`const a = <Button iconOnly icon={<I />}>Close</Button>;`)).toEqual([]);
    expect(lint(`const a = <Button iconOnly aria-label="Close" icon={<I />} />;`)).toEqual([]);
  });
});
