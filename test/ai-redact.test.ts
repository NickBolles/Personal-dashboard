import { describe, expect, it } from "vitest";
import { maskAccountNumbers } from "@/lib/ai-redact";
import { buildCatchUpPrompt } from "@/lib/catch-up";
import { buildRunInput } from "@/lib/chat-files";
import { builderPrompt } from "@/lib/workflows/proposal";

describe("outbound account number masking", () => {
  it.each([
    ["account 12345678", "account ••••5678"],
    ["account 123456789012.", "account ••••9012."],
    ["account 123456789012, then review", "account ••••9012, then review"],
    ["routing 021000021", "routing ••••0021"],
    ["card 4111 1111 1111 1111", "card ••••1111"],
    ["card 4111-1111-1111-1111", "card ••••1111"],
    ["IBAN GB82 WEST 1234 5698 7654 32", "IBAN ••••5432"],
    ["IBAN DE89370400440532013000", "IBAN ••••3000"],
    ["12345678 / 87654321", "••••5678 / ••••4321"],
    ["12345678, 87654321.", "••••5678, ••••4321."],
    ["2026-11-07 12345678", "2026-11-07 ••••5678"],
  ])("masks %s", (input, expected) => {
    expect(maskAccountNumbers(input)).toBe(expected);
    expect(maskAccountNumbers(expected)).toBe(expected);
  });

  it.each([
    "2026-11-07",
    "2026-11-07T12:34:56Z",
    "12:34",
    "1,234.56",
    "$1,234.56",
    "12345678.90",
    "1234",
    "1234567",
    "year 2026",
    "2026-11-07 12:34",
    "item:wi_1234567890 and session-abc1234567890",
    "12,345,678.90",
    "call 555-123-4567",
    "call +1 555 123 4567",
    "https://github.com/o/r/actions/runs/12345678901",
    "/areas?item=12345678",
    "id 12345678-1234-4abc-9def-123456789012",
  ])("preserves dates, times, amounts and short numbers: %s", (input) => {
    expect(maskAccountNumbers(input)).toBe(input);
  });

  it("masks catch-up, workflow and chat prompts before they leave", () => {
    const prompt = buildCatchUpPrompt({
      area: { id: "fin", title: "Finance" },
      items: [
        {
          id: "bill",
          title: "Check account 123456789012",
          status: "ready",
          decision: null,
          nextAction: "Review balance $1,234.56",
          kind: "thread",
          archived: false,
        },
      ],
      decisions: [],
      activity: [],
    })!;
    expect(prompt).toContain("••••9012");
    expect(prompt).toContain("$1,234.56");
    expect(prompt).not.toContain("123456789012");
    expect(builderPrompt({ kind: "describe", description: "Review account 123456789012" })).toContain("••••9012");
    expect(buildRunInput("Review 123456789012", [])).toBe("Review ••••9012");
  });
});
