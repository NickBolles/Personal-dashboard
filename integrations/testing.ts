import type { TestCheck, TestResult } from "./registry";

/** Helper to build a TestResult from sequential named checks. */
export async function runChecks(
  steps: { name: string; run: () => Promise<string | void> }[],
  discovered?: () => TestResult["discovered"],
): Promise<TestResult> {
  const checks: TestCheck[] = [];
  let failed = false;
  for (const s of steps) {
    if (failed) {
      checks.push({ name: s.name, ok: false, detail: "Skipped (previous check failed)" });
      continue;
    }
    const t = Date.now();
    try {
      const detail = await s.run();
      checks.push({ name: s.name, ok: true, detail: detail || undefined, ms: Date.now() - t });
    } catch (err) {
      failed = true;
      checks.push({ name: s.name, ok: false, detail: (err as Error).message, ms: Date.now() - t });
    }
  }
  const ok = checks.every((c) => c.ok);
  return {
    ok,
    checkedAt: new Date().toISOString(),
    summary: ok ? "Connected" : (checks.find((c) => !c.ok)?.detail ?? "Failed"),
    checks,
    discovered: ok ? discovered?.() : undefined,
  };
}
