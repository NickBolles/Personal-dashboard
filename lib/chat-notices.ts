/**
 * Hermes control frames that land in a transcript as plain text (usually role=user): async
 * delegation results, background-process notices, mid-run steers and context-compaction
 * handoffs. Parsed client-side so the chat shows them as compact cards, not as walls of
 * text in a user bubble. Formats come from Hermes `tools/process_registry_notifications.py`,
 * `agent/prompt_builder.py` (STEER_MARKER_*) and `agent/context_compressor.py`.
 * Never throws; anything it doesn't recognise returns null and renders as before.
 */

export type NoticeTask = {
  index: number;
  total?: number;
  goal?: string;
  status: string;
  ok: boolean;
  duration?: string;
  body: string;
  transcript?: string;
};

export type ChatNotice =
  | {
      kind: "delegation";
      title: string;
      id?: string;
      status: "completed" | "failed" | "partial";
      duration?: string;
      tasks: NoticeTask[];
      detail: string;
    }
  | { kind: "process"; title: string; id?: string; status: string; ok: boolean; command?: string; output?: string; detail: string }
  | { kind: "steer"; text: string }
  | { kind: "compaction"; summary: string };

const STEER_OPEN = "[OUT-OF-BAND USER MESSAGE";
const STEER_CLOSE = "[/OUT-OF-BAND USER MESSAGE]";
const COMPACTION = ["[CONTEXT COMPACTION", "[CONTEXT SUMMARY]:"];
const DONE = new Set(["completed", "complete", "success", "succeeded", "done", "ok"]);

/** True when the text starts with a Hermes control frame this module renders. */
export function isNoticeText(text: string) {
  const t = text.trimStart();
  return (
    t.startsWith("[ASYNC DELEGATION ") ||
    t.startsWith("[IMPORTANT: Background process ") ||
    /^\[IMPORTANT: \d+ background processes completed/.test(t) ||
    /^\[Background process \S+ heartbeat/.test(t) ||
    t.startsWith(STEER_OPEN) ||
    COMPACTION.some((p) => t.startsWith(p))
  );
}

export function parseNotice(text: string): ChatNotice | null {
  if (typeof text !== "string" || !isNoticeText(text)) return null;
  const t = text.trim();
  try {
    if (t.startsWith(STEER_OPEN)) return parseSteer(t);
    if (COMPACTION.some((p) => t.startsWith(p))) return { kind: "compaction", summary: stripCompactionHeader(t) };
    if (t.startsWith("[ASYNC DELEGATION ")) return parseDelegation(t);
    return parseProcess(t);
  } catch {
    return null;
  }
}

function parseSteer(t: string): ChatNotice {
  const headEnd = t.indexOf("]");
  let body = headEnd >= 0 ? t.slice(headEnd + 1) : t;
  const close = body.lastIndexOf(STEER_CLOSE);
  if (close >= 0) body = body.slice(0, close);
  return { kind: "steer", text: body.trim() };
}

function stripCompactionHeader(t: string) {
  // The handoff preamble is model instructions; the summary follows the first blank line.
  const firstBreak = t.search(/\n\s*\n/);
  const summary = firstBreak >= 0 ? t.slice(firstBreak).trim() : t.replace(/^\[[^\]]*\]:?/, "").trim();
  return summary;
}

const TASK_HEADER = /^--- (\S+) TASK (\d+)\/(\d+)(?::\s*(.*?))?\s+\(status=([^,)]+)([^)]*)\) ---$/;

function parseDelegation(t: string): ChatNotice {
  const lines = t.split("\n");
  const head = lines[0]!.trim();
  const m = head.match(/^\[(ASYNC DELEGATION [A-Z ]+?)\s+—\s+([^\],]+)(?:,\s*task (\d+)\/(\d+))?\]/);
  const label = m?.[1] ?? "ASYNC DELEGATION";
  const id = m?.[2]?.trim();
  const failedNotice = /TASK FAILED/.test(label);
  const total = t.match(/Total duration:\s*([\d.]+s|\?s)/)?.[1] ?? t.match(/Duration:\s*([\d.]+s)/)?.[1];
  const tasks: NoticeTask[] = [];
  let cur: NoticeTask | null = null;
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\s+$/, "");
    const h = line.match(TASK_HEADER);
    if (h) {
      if (cur) tasks.push(finishTask(cur));
      const status = h[5]!.trim();
      cur = {
        index: Number(h[2]),
        total: Number(h[3]),
        goal: h[4]?.trim() || undefined,
        status,
        ok: h[1] === "✓" || (DONE.has(status) && h[1] !== "⚠" && h[1] !== "✗"),
        duration: h[6]?.match(/([\d.]+)s/)?.[0],
        body: "",
      };
      continue;
    }
    if (!cur) continue;
    const tr = line.match(/^(?:Full live transcript[^:]*|Live transcript|Task index \d+ transcript[^:]*):\s*(\S.*)$/);
    if (tr) {
      cur.transcript = tr[1]!.trim();
      continue;
    }
    cur.body += `${line}\n`;
  }
  if (cur) tasks.push(finishTask(cur));
  // Single-task completion: one result with "Status: x   API calls: n   Duration: ns".
  if (!tasks.length && !failedNotice) {
    const st = t.match(/^Status:\s*(\S+)/m)?.[1];
    const goal = t.match(/^Original goal:\s*(.*)$/m)?.[1]?.trim();
    const transcript = t.match(/(?:Full live transcript[^:]*|Live transcript):\s*(\S.*)$/m)?.[1]?.trim();
    const after = st
      ? t
          .slice(t.search(/^Status:/m))
          .split("\n")
          .slice(1)
          .join("\n")
      : "";
    if (st)
      tasks.push(
        finishTask({
          index: 1,
          total: 1,
          goal,
          status: st,
          ok: DONE.has(st),
          duration: total,
          body: after.replace(/^(?:Full live transcript|Live transcript).*$/m, ""),
          transcript,
        }),
      );
  }
  if (failedNotice) {
    const goal = t.match(/^Task:\s*(.*)$/m)?.[1]?.trim();
    const st = t.match(/^Status:\s*(\S+)/m)?.[1] ?? "failed";
    const err = t.match(/^Error:\s*(.*)$/m)?.[1]?.trim();
    const transcript = t.match(/^Live transcript:\s*(\S.*)$/m)?.[1]?.trim();
    tasks.push({ index: Number(m?.[3] ?? 1), total: m?.[4] ? Number(m[4]) : undefined, goal, status: st, ok: false, body: err ?? "", transcript });
  }
  const anyFail = tasks.some((x) => !x.ok) || /--- ERROR ---/.test(t);
  const allFail = tasks.length > 0 && tasks.every((x) => !x.ok);
  const status = failedNotice || (anyFail && (allFail || !tasks.length)) ? "failed" : anyFail ? "partial" : "completed";
  const n = tasks.length;
  const title = failedNotice
    ? `Subagent task ${tasks[0]?.index ?? "?"}${tasks[0]?.total ? `/${tasks[0].total}` : ""} failed`
    : `${n > 1 ? `${n} subagents` : "Subagent"} finished${status === "failed" ? " with errors" : status === "partial" ? " (some failed)" : ""}`;
  return { kind: "delegation", title, id, status, duration: total, tasks, detail: t };
}

function finishTask(x: NoticeTask): NoticeTask {
  return { ...x, body: x.body.trim() };
}

function parseProcess(t: string): ChatNotice {
  const multi = t.match(/^\[IMPORTANT: (\d+) background processes completed/);
  if (multi) {
    const parts = t.split(/\n\n(?=\[IMPORTANT: Background process )/).slice(1);
    const parsed = parts.map((p) => parseProcess(p)).filter((p): p is Extract<ChatNotice, { kind: "process" }> => p?.kind === "process");
    const ok = parsed.every((p) => p.ok);
    return { kind: "process", title: `${multi[1]} background processes finished`, status: ok ? "done" : "failed", ok, detail: t };
  }
  const hb = t.match(/^\[Background process (\S+) heartbeat #(\S+)/);
  const watch = t.match(/^\[IMPORTANT: Background process (\S+) matched watch pattern "([^"]*)"/);
  const done = t.match(/^\[IMPORTANT: Background process (\S+) (.*?) \(exit code ([^),]+)/);
  const command = t.match(/^Command:\s*(.*)$/m)?.[1]?.trim();
  const outAt = t.search(/^(?:Output|Matched output|Output since last heartbeat):\s*$/m);
  const output =
    outAt >= 0
      ? t
          .slice(outAt)
          .split("\n")
          .slice(1)
          .join("\n")
          .replace(/\]\s*$/, "")
          .trim()
      : undefined;
  if (hb) return { kind: "process", title: "Background process still running", id: hb[1], status: "running", ok: true, command, output, detail: t };
  if (watch)
    return { kind: "process", title: `Background process matched “${watch[2]}”`, id: watch[1], status: "matched", ok: true, command, output, detail: t };
  if (done) {
    const exit = done[3]!.trim();
    const ok = exit === "0";
    return { kind: "process", title: `Background process ${ok ? "finished" : "failed"}`, id: done[1], status: `exit ${exit}`, ok, command, output, detail: t };
  }
  const id = t.match(/^\[IMPORTANT: Background process (\S+)/)?.[1];
  return { kind: "process", title: "Background process update", id, status: "update", ok: true, command, output, detail: t };
}
