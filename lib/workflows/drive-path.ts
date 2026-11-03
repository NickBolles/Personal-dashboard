/**
 * #141 Google Drive export: pure helpers for the destination folder template
 * (`Teaching notes/{yyyy}`) and the file name, shared by the confirm sheet and
 * the server (the server recomputes both and rejects a save whose path differs
 * from what the owner confirmed).
 */

/** The only OAuth scope Jarvis ever asks for Drive: files Jarvis itself creates. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const DEFAULT_DRIVE_FOLDER = "Teaching notes/{yyyy}";
export const MAX_FOLDER_DEPTH = 5;
const MAX_SEGMENT = 80;

export type DrivePathResult = { ok: true; segments: string[]; display: string } | { ok: false; error: string };

/**
 * Expand `{yyyy}`, `{mm}`, `{dd}` from the run's local start date (`YYYY-MM-DD…`)
 * and split into folder names. Rejects empty/`.`/`..` segments, unknown
 * placeholders and paths deeper than MAX_FOLDER_DEPTH.
 */
export function resolveDriveFolder(template: string | null | undefined, startedAt: string): DrivePathResult {
  const t = (template ?? DEFAULT_DRIVE_FOLDER).trim() || DEFAULT_DRIVE_FOLDER;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(startedAt);
  if (!m) return { ok: false, error: "The session has no start date" };
  const [, yyyy, mm, dd] = m;
  const unknown = /\{(?!yyyy\}|mm\}|dd\})[^}]*\}/.exec(t);
  if (unknown) return { ok: false, error: `Unknown placeholder ${unknown[0]} in the Drive folder` };
  const expanded = t
    .replace(/\{yyyy\}/g, yyyy)
    .replace(/\{mm\}/g, mm)
    .replace(/\{dd\}/g, dd);
  const segments = expanded
    .split("/")
    .map((s) => s.replace(/[\u0000-\u001f\u007f\\]/g, "").trim())
    .filter((s) => s.length > 0);
  if (!segments.length) return { ok: false, error: "The Drive folder is empty" };
  if (segments.length > MAX_FOLDER_DEPTH) return { ok: false, error: `The Drive folder can be at most ${MAX_FOLDER_DEPTH} levels deep` };
  if (segments.some((s) => s === "." || s === "..")) return { ok: false, error: "The Drive folder can't contain . or .." };
  if (segments.some((s) => s.length > MAX_SEGMENT)) return { ok: false, error: `Folder names can be at most ${MAX_SEGMENT} characters` };
  return { ok: true, segments, display: segments.join(" › ") };
}

/** Drive file title: `Session: Heartland – Jake Fry (2026-11-01)`; no slashes, ≤120 chars. */
export function driveFileName(title: string, startedAt: string): string {
  const date = startedAt.slice(0, 10);
  const clean = title
    .replace(/[\u0000-\u001f\u007f/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
  return `${clean || "Session"} (${date})`;
}

/** Escape a value for a Drive `files.list` q string literal. */
export function driveQueryLiteral(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** Scopes requested by the Drive consent: exactly drive.file and nothing else. */
export function driveScopes(): string[] {
  return [DRIVE_FILE_SCOPE];
}
