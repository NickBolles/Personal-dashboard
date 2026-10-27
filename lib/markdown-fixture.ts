/**
 * One Markdown document that exercises every element the renderer supports.
 * Shared by the unit tests (test/markdown.test.tsx) and the visual snapshot
 * (e2e/visual.spec.ts → "visual: markdown").
 */
export const MARKDOWN_FIXTURE = [
  "# Rollout plan",
  "Short intro with **bold**, *italic*, ~~struck~~, `inline code` and a [safe link](https://example.com/docs).",
  "A second line in the same paragraph stays a line break.",
  "",
  "## Steps",
  "1. Audit compatibility",
  "2. Migrate config",
  "   - nested bullet",
  "   - another one",
  "     1. deep ordered",
  "3. Roll out",
  "",
  "- [x] Write the spec",
  "- [ ] Ship it",
  "",
  "> Quote: a merged PR is not proof.",
  "> > Nested quote",
  "",
  "```ts",
  "const total = items.reduce((n, i) => n + i.qty, 0); // <script>alert(1)</script>",
  "```",
  "",
  "| Metric | Baseline | Target |",
  "| :----- | -------: | :----: |",
  "| p95 hydration | 2.1 s | 1.2 s |",
  "| error rate | 3 % | < 1 % |",
  "",
  "---",
  "",
  "### Notes",
  "Autolink https://example.com/a, raw <b>html</b> stays text, and [bad](javascript:alert(1)) is not a link.",
].join("\n");
