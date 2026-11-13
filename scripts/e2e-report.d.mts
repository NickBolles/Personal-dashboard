// Types for scripts/e2e-report.mjs (used by test/e2e-select.test.ts).
export const MARKER: string;
export type TestRow = {
  file: string;
  line: number;
  title: string;
  project: string;
  status: string;
  duration: number;
  retries: number;
  error: string;
  attachments: { name: string; path: string }[];
};
export type ShardTiming = { name: string; conclusion: string; wall?: number; tests?: number; url?: string };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
export function collectTests(report: Json): TestRow[];
export function shardTimings(jobs: Json): ShardTiming[];
export function renderSummary(input: { report: Json; jobs?: Json; reportUrl?: string; runUrl?: string; selection?: string; artifactNote?: string }): {
  markdown: string;
  ok: boolean;
  failed: number;
  flaky: number;
  total: number;
};
