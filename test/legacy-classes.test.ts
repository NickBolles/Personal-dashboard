import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Pre-design-system chat classes (replaced by components/markdown and the ds tokens) must not come back.
const LEGACY = /\b(prose-chat|typing-dot|pulse-dot)\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(tsx?|css)$/.test(n) ? [p] : [];
  });
}

describe("legacy classes", () => {
  it("app/ and components/ no longer use prose-chat, typing-dot or pulse-dot", () => {
    const hits = ["app", "components"].flatMap(files).filter((f) => LEGACY.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
