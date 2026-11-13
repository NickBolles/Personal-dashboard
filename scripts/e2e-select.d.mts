// Types for scripts/e2e-select.mjs (used by test/e2e-select.test.ts).
export type Unit = { spec: string; grep: string; files: Set<string>; tests: "all" | number; titles?: string[] };
export type Rule = { why: string; files: string[]; specs?: string[]; titles?: Record<string, string>; replaceGraph?: boolean };
export type SelectionMap = {
  maxFraction: number;
  fullSuite: { why: string; files: string[] };
  ignore: { why: string; files: string[] };
  rules: Rule[];
  smoke: { why: string; grep: string[] };
};
export type Selection = { mode: "full" | "subset"; reasons: string[]; specs: string[]; fraction: number; grep?: string; units?: number };
export type PathLiteral = { path: string; cut: boolean };
export type Graph = { files: Set<string>; shell: Set<string> };

export function globToRegExp(glob: string): RegExp;
export function importsOf(text: string): string[];
export function pathLiterals(text: string): PathLiteral[];
export function routeMatches(segs: string[], literal: PathLiteral): boolean;
export function splitTopLevel(text: string): { kind: "test" | "hook" | "shared"; text: string }[];
export function titlesOf(text: string): string[];
export function buildGraph(root?: string, fileList?: string[]): Graph;
export function specUnits(graph: Graph, specDir?: string): Unit[];
export function ruleUnits(rule: Rule, units: Unit[]): Unit[];
export function loadMap(root?: string): SelectionMap;
export function select(input: {
  changed: string[] | undefined;
  event?: string;
  labels?: string[];
  map: SelectionMap;
  units: Unit[];
  shell?: Set<string>;
}): Selection;
export function shardCount(result: Pick<Selection, "mode" | "fraction">, full?: number): number;
export function summaryMarkdown(result: Selection): string;
