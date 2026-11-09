import { DECISION_REF } from "@/lib/cw-decisions";

/** Route param → "D-n" (Next may hand it over percent-encoded); null when it isn't one. */
export function refParam(raw: string): string | null {
  let v = raw;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return DECISION_REF.test(v) ? v : null;
}
