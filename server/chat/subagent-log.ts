import "server-only";
import fs from "node:fs";
import path from "node:path";
import { PROFILE_NAME_RE } from "@/lib/agents";
import { redactToolText } from "@/lib/tool-presentation";
import { maskSecrets } from "@/server/ai/rules";
import { HttpError } from "@/server/http/errors";

/**
 * Read-only access to a delegated sub-agent's live transcript log.
 *
 * Hermes writes `<HERMES_HOME>/profiles/<profile>/cache/delegation/live/<delegationId>/task-<n>.log`
 * (the default profile: `<HERMES_HOME>/cache/delegation/live/...`). The Jarvis container sees only those
 * `live` folders, mounted read-only per profile at `<root>/<profile>` (`<root>/default` for the default profile;
 * deploy.sh). Nothing else of the Hermes home is reachable from here.
 *
 * Every part of the path is validated against a strict pattern, the resolved file must stay inside the
 * profile's folder (no symlinks out), only the tail is read, and credentials are masked before it leaves.
 */
export const DELEGATION_ID_RE = /^deleg_[0-9a-f]{6,32}$/;
export const TASK_INDEX_MAX = 63;
export const LOG_TAIL_DEFAULT = 64 * 1024;
export const LOG_TAIL_MAX = 256 * 1024;
export const DEFAULT_PROFILE = "default";

export const delegationLogRoot = () => process.env.JARVIS_DELEGATION_LOG_ROOT || "/hermes-delegation";

export type SubagentLogRef = { profile: string; delegationId: string; task: number };
export type SubagentLog = SubagentLogRef & {
  /** Size of the whole file in bytes. */
  size: number;
  /** Bytes returned (after dropping a partial first line). */
  bytes: number;
  /** True when the start of the file was cut off (only the tail is returned). */
  truncated: boolean;
  modifiedAt: string;
  /** How many credential-shaped values were masked. */
  masked: number;
  text: string;
};

const TRANSCRIPT_RE = /^(?:(.*)\/)?cache\/delegation\/live\/(deleg_[0-9a-f]{6,32})\/task-(\d{1,2})\.log$/;

/** `transcriptPath` as Hermes reports it → its parts, or null when it isn't a delegation live log. */
export function parseTranscriptPath(p: string): SubagentLogRef | null {
  if (typeof p !== "string" || p.length > 1024 || p.includes("\0") || /(^|\/)\.\.?(\/|$)/.test(p)) return null;
  const m = TRANSCRIPT_RE.exec(p.trim());
  if (!m) return null;
  const prefix = m[1] ?? "";
  // `<home>/profiles/<profile>/cache/…` for a named profile; `<home>/cache/…` for the default one.
  const named = /(?:^|\/)profiles\/([^/]+)$/.exec(prefix);
  if (!named && /(?:^|\/)profiles(?:\/|$)/.test(prefix)) return null;
  if (named && !PROFILE_NAME_RE.test(named[1]!)) return null;
  try {
    return validRef({ profile: named?.[1] ?? DEFAULT_PROFILE, delegationId: m[2]!, task: Number(m[3]) });
  } catch {
    return null;
  }
}

export function validRef(ref: { profile: unknown; delegationId: unknown; task: unknown }): SubagentLogRef {
  const profile = typeof ref.profile === "string" ? ref.profile.trim().toLowerCase() : "";
  if (profile !== DEFAULT_PROFILE && !PROFILE_NAME_RE.test(profile)) throw new HttpError(400, "bad_profile", "Unknown Hermes profile");
  const delegationId = typeof ref.delegationId === "string" ? ref.delegationId.trim() : "";
  if (!DELEGATION_ID_RE.test(delegationId)) throw new HttpError(400, "bad_delegation", "A delegation id looks like deleg_1a2b3c4d");
  const task = typeof ref.task === "string" && /^\d{1,2}$/.test(ref.task) ? Number(ref.task) : ref.task;
  if (typeof task !== "number" || !Number.isInteger(task) || task < 0 || task > TASK_INDEX_MAX)
    throw new HttpError(400, "bad_task", `The task index is 0–${TASK_INDEX_MAX}`);
  return { profile, delegationId, task };
}

export function clampTail(v: unknown): number {
  if (v === undefined || v === null || v === "") return LOG_TAIL_DEFAULT;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 1) throw new HttpError(400, "bad_tail", "tail is a byte count");
  return Math.min(Math.floor(n), LOG_TAIL_MAX);
}

/** Mask credentials (assignment/token shapes, then key=value / bearer leftovers). */
export function redactLog(text: string): { text: string; masked: number } {
  const m = maskSecrets(text);
  const out = redactToolText(m.text);
  const count = (s: string) => s.split("[redacted]").length - 1;
  return { text: out, masked: m.masked.length + Math.max(0, count(out) - count(m.text)) };
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + path.sep);

export function readSubagentLog(input: { profile: unknown; delegationId: unknown; task: unknown }, tailBytes: unknown = LOG_TAIL_DEFAULT): SubagentLog {
  const ref = validRef(input);
  const tail = clampTail(tailBytes);
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(delegationLogRoot()));
  } catch {
    throw new HttpError(503, "logs_unavailable", "Sub-agent logs aren't available on this server");
  }
  const base = path.join(root, ref.profile);
  const file = path.join(base, ref.delegationId, `task-${ref.task}.log`);
  let real: string;
  let realBase: string;
  try {
    realBase = fs.realpathSync(base);
    real = fs.realpathSync(file);
  } catch {
    throw new HttpError(404, "not_found", "No log for that sub-agent");
  }
  // Symlinks must not lead out of the profile's own folder.
  if (!inside(root, realBase) || !inside(realBase, real)) throw new HttpError(404, "not_found", "No log for that sub-agent");
  const fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new HttpError(404, "not_found", "No log for that sub-agent");
    const size = st.size;
    const start = Math.max(0, size - tail);
    const buf = Buffer.alloc(size - start);
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString("utf8");
    if (start > 0) {
      // Drop the partial first line (and any split UTF-8 sequence with it). With no newline at all the whole tail is a
      // fragment without its context (e.g. the end of `password=…`), so the masking can't be trusted: return nothing.
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const red = redactLog(text);
    return {
      ...ref,
      size,
      bytes: Buffer.byteLength(red.text),
      truncated: start > 0,
      modifiedAt: st.mtime.toISOString(),
      masked: red.masked,
      text: red.text,
    };
  } finally {
    fs.closeSync(fd);
  }
}
