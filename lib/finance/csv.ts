/** Small, strict CSV + money parsing for balance and transaction imports. */

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== "")) rows.push(row);
  return rows.map((r) => r.map((x) => x.trim()));
}

/** "1,234.56", "-12.30", "(12.30)", "$5" → cents. Throws on anything else. */
export function parseMoney(v: string): number {
  const s = v.replace(/[$,\s]/g, "");
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const body = s.replace(/^[-+(]+|\)$/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(body)) throw new Error(`“${v}” isn't an amount`);
  const [whole, frac = ""] = body.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return neg ? -cents : cents;
}

/** YYYY-MM-DD or M/D/YYYY → YYYY-MM-DD. */
export function parseDate(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const y = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
    return `${y}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  }
  throw new Error(`“${v}” isn't a date`);
}

/** Rows as objects keyed by lower-cased header. */
export function csvObjects(text: string) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  const keys = head.map((h) =>
    h
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, ""),
  );
  return rows.map((r, i) => ({ line: i + 2, ...Object.fromEntries(keys.map((k, j) => [k, r[j] ?? ""])) }) as { line: number } & Record<string, string>);
}
