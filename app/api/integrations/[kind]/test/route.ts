import { api } from "@/server/http/api";
import { HttpError } from "@/server/http/errors";
import { getAdapter } from "@/integrations";
import { recordTestResult } from "@/integrations/store";
import { refreshSource } from "@/server/sources";
import type { IntegrationKind, TestResult } from "@/integrations/registry";

export const dynamic = "force-dynamic";

/** Run live connection checks against the saved (server-side) configuration. */
export const POST = api<undefined, { kind: string }>(async ({ params }) => {
  const adapter = getAdapter(params.kind);
  if (!adapter) throw new HttpError(404, "unknown_integration", "Unknown integration");
  let result: TestResult;
  try {
    result = await adapter.test();
  } catch (err) {
    result = {
      ok: false,
      checkedAt: new Date().toISOString(),
      summary: (err as Error).message,
      checks: [{ name: "Test", ok: false, detail: (err as Error).message }],
    };
  }
  recordTestResult(params.kind as IntegrationKind, result);
  if (result.ok) {
    // Warm the snapshot so Home shows fresh data immediately after onboarding.
    await refreshSource(adapter.source).catch(() => undefined);
  }
  return result;
});
