"use client";
import { Button } from "@/components/ui";
import { BrainIcon, SendIcon, StopIcon, TodoIcon } from "@/components/icons";
import { presentDelegate, type DelegateRow } from "@/lib/delegate-presentation";
import { redactToolText } from "@/lib/tool-presentation";

export function DelegateIcon({ action }: { action: string }) {
  const Icon = action === "steer" ? SendIcon : action === "stop" ? StopIcon : action === "list" ? TodoIcon : BrainIcon;
  return <Icon className="h-4 w-4 shrink-0" />;
}
function Readable({ text }: { text: string }) {
  if (text.length <= 280) return <p className="whitespace-pre-wrap break-all">{text}</p>;
  return (
    <details>
      <summary className="cursor-pointer break-all">
        {text.slice(0, 240)}… <span className="text-muted">Read more</span>
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-all">{text}</p>
    </details>
  );
}
function Rows({ rows }: { rows: DelegateRow[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r, i) => (
        <li key={i} className="min-w-0 space-y-1">
          {r.title ? <Readable text={r.title} /> : null}
          {r.input ? <Readable text={r.input} /> : null}
          {r.status || r.duration ? <p className="break-all text-muted">{[r.status, r.duration].filter(Boolean).join(" · ")}</p> : null}
          {r.result ? <Readable text={r.result} /> : null}
          {r.id ? <code className="block break-all text-muted">{r.id}</code> : null}
          {r.href ? (
            <a href={r.href} className="break-all text-accent underline" target="_blank" rel="noopener noreferrer">
              Open result
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
/** One presentation for live, persisted, chat and coordinator tool steps. No control mutations. */
export function DelegateDetails({ input, output, done }: { input?: string; output?: string; done: boolean }) {
  const d = presentDelegate(input, output);
  return (
    <div className="min-w-0 space-y-3" data-testid="delegate-details">
      <section aria-label="Delegation input" className="min-w-0">
        <h4 className="mb-1 font-semibold text-muted">Input</h4>
        {d.requested.length ? (
          <Rows rows={d.requested} />
        ) : (
          <p className="text-muted">{d.action === "list" ? "Check live agents in this conversation." : "See raw details for the original input."}</p>
        )}
        {d.requested.length > 1 ? <p className="mt-1 text-muted">{d.requested.length} requested tasks</p> : null}
      </section>
      <section aria-label="Delegation result" className="min-w-0">
        <h4 className="mb-1 font-semibold text-muted">Result{d.status ? ` · ${d.status}` : ""}</h4>
        {d.count !== undefined ? (
          <p className="mb-1 text-muted">
            {d.count} {d.action === "list" ? "live agents" : "dispatched tasks"}
          </p>
        ) : null}
        {d.result ? (
          <Readable text={d.result} />
        ) : !d.returned.length ? (
          <p className="text-muted">{done ? "No structured result available. See raw details." : "Waiting for output"}</p>
        ) : null}
        {d.returned.length ? <Rows rows={d.returned} /> : null}
        {d.id ? <code className="mt-1 block break-all text-muted">{d.id}</code> : null}
      </section>
      <details>
        <summary className="cursor-pointer text-muted">Raw details</summary>
        <Button variant="ghost" size="sm" onClick={() => void navigator.clipboard?.writeText([input, output].filter(Boolean).map(redactToolText).join("\n\n"))}>
          Copy raw details
        </Button>
        <p className="mt-1 font-semibold text-muted">Input</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{redactToolText(input ?? "No input available")}</pre>
        <p className="mt-1 font-semibold text-muted">Result</p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">
          {redactToolText(output ?? (done ? "No output available" : "Waiting for output"))}
        </pre>
      </details>
    </div>
  );
}
