/**
 * Pure outbound-text redaction (owner rule 2026-11-07: Finance may go to AI,
 * but full account/card numbers never do). Account-like digit runs (8+ digits,
 * optionally grouped with spaces/dashes) and IBANs become `••••1234`. Dates,
 * times, money amounts, short numbers, phone numbers and anything inside a
 * URL/path (GitHub run ids, deep links) stay intact.
 */
const PHONE = /^\+?1?[ -]?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}$/;

/** The whitespace-delimited token around [start, end) — used to leave URLs and paths alone. */
function tokenAround(source: string, start: number, end: number) {
  let a = start;
  let b = end;
  while (a > 0 && !/\s/.test(source[a - 1]!)) a--;
  while (b < source.length && !/\s/.test(source[b]!)) b++;
  return source.slice(a, b);
}

/**
 * Only real URLs, absolute/relative paths, e-mail addresses and UUIDs are
 * exempt. Bare `#`, `=`, `?`, `&` or `@` are NOT: "Account #123456789012" and
 * "account=123456789012" are ordinary financial text and must be masked.
 */
const inUrlOrPath = (token: string) => /:\/\/|^\/|\w\/\S|[\w.+-]+@[\w-]+\.[a-z]|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(token);

export function maskAccountNumbers(text: string): string {
  // IBANs may contain letters as well as digits, and may be grouped with spaces.
  const ibanMasked = text.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]){11,30}\b/g, (value, offset: number, source: string) => {
    if (inUrlOrPath(tokenAround(source, offset, offset + value.length))) return value;
    const digits = value.replace(/\D/g, "");
    return digits.length >= 4 ? `••••${digits.slice(-4)}` : "••••";
  });
  return ibanMasked.replace(/(?<!\w)\d+(?:[ -]\d+)*(?!\w)/g, (value, offset: number, source: string) => {
    // Do not mistake parts of decimal or comma-grouped money amounts for accounts.
    // Sentence punctuation after an account ("12345678.") must not bypass masking.
    if (/[\d][.,]$/.test(source.slice(0, offset)) || /^[.,]\d/.test(source.slice(offset + value.length))) return value;
    if (inUrlOrPath(tokenAround(source, offset, offset + value.length))) return value;
    if (PHONE.test(value)) return value;
    // Protect ISO dates, including when adjacent to another short number.
    if (/\b\d{4}-\d{2}-\d{2}\b/.test(value)) {
      return value
        .split(/(\b\d{4}-\d{2}-\d{2}\b)/)
        .map((part) => (/^\d{4}-\d{2}-\d{2}$/.test(part) ? part : maskAccountNumbers(part)))
        .join("");
    }
    const digits = value.replace(/\D/g, "");
    return digits.length >= 8 ? `••••${digits.slice(-4)}` : value;
  });
}
