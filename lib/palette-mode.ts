/** Explicit prefixes complement (not replace) existing /workflow and typed actions. */
export type PaletteMode = "search" | "commands" | "chief";
export function paletteMode(input: string): { mode: PaletteMode; query: string } {
  if (input.startsWith(">")) return { mode: "commands", query: input.slice(1).trimStart() };
  if (input.startsWith("?")) return { mode: "chief", query: input.slice(1).trimStart() };
  return { mode: "search", query: input };
}
export function modeInput(mode: PaletteMode, query: string) {
  return `${mode === "commands" ? "> " : mode === "chief" ? "? " : ""}${query}`;
}
