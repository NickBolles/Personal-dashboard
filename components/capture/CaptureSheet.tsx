"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Field, cx, inputCls, useToast } from "@/components/ui";
import { useAccess } from "@/components/access";
import { useAskHermes } from "@/components/chat/useAskHermes";
import { CAPTURE_LIMITS } from "@/lib/ai";
import { QUEUE_EVENT, flushQueue, listQueue, newClientCaptureId, queueCapture, sendCapture } from "@/lib/client/capture-queue";

/**
 * The capture sheet (dock, palette, /capture, /share): text, a URL chip,
 * images (camera/gallery on Android), dictation where the browser has it, and
 * the Investigate toggle (work.ai). Offline, the capture waits on this phone
 * and is sent exactly once when it's back online.
 */

type Picked = { id: string; name: string; type: string; blob: Blob; url: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"']{3,2000}/i;
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

function useQueueCount() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () =>
      void listQueue()
        .then((l) => setN(l.filter((q) => !q.failed).length))
        .catch(() => undefined);
    load();
    window.addEventListener(QUEUE_EVENT, load);
    return () => window.removeEventListener(QUEUE_EVENT, load);
  }, []);
  return n;
}

const subscribeNoop = () => () => undefined;
function useSpeechAvailable() {
  return useSyncExternalStore(
    subscribeNoop,
    () => typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window),
    () => false,
  );
}

export function CaptureSheet({
  onDone,
  initial,
  autoFocus,
  channel = "web",
  askable,
}: {
  onDone?: (r: { queued: boolean }) => void;
  initial?: { text?: string; title?: string; url?: string; files?: { name: string; type: string; blob: Blob }[] };
  autoFocus?: boolean;
  channel?: "web" | "pwa_share";
  askable?: boolean;
}) {
  const id = useId();
  const access = useAccess();
  const canAi = access.can("work.ai");
  const userId = access.userId;
  const qc = useQueryClient();
  const { toast } = useToast();
  const { ask, busy: asking } = useAskHermes();
  const [text, setText] = useState(() => [initial?.title, initial?.text].filter(Boolean).join("\n"));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [files, setFiles] = useState<Picked[]>(() =>
    (initial?.files ?? []).map((f, i) => ({
      id: `i${i}`,
      name: f.name,
      type: f.type,
      blob: f.blob,
      url: typeof URL !== "undefined" ? URL.createObjectURL(f.blob) : "",
    })),
  );
  const [investigate, setInvestigate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const queued = useQueueCount();
  const speech = useSpeechAvailable();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void flushQueue();
    const on = () => void flushQueue();
    const vis = () => document.visibilityState === "visible" && void flushQueue();
    window.addEventListener("online", on);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("online", on);
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  const onText = (v: string) => {
    if (!url) {
      const m = URL_RE.exec(v);
      if (m) {
        setUrl(m[0]);
        v = v.replace(m[0], "").trim();
      }
    }
    setText(v);
  };

  const addFiles = (list: FileList | null) => {
    setError(null);
    const next = [...files];
    for (const f of Array.from(list ?? [])) {
      if (next.length >= CAPTURE_LIMITS.files) {
        setError(`At most ${CAPTURE_LIMITS.files} images`);
        break;
      }
      if (!ACCEPT.split(",").includes(f.type)) {
        setError(`${f.name}: only PNG, JPEG, WebP or GIF`);
        continue;
      }
      if (f.size > CAPTURE_LIMITS.fileBytes) {
        setError(`${f.name} is over 10 MB`);
        continue;
      }
      next.push({ id: `${Date.now()}-${next.length}`, name: f.name, type: f.type, blob: f, url: URL.createObjectURL(f) });
    }
    setFiles(next);
  };

  const dictate = () => {
    const W = window as unknown as { webkitSpeechRecognition?: new () => SpeechLike; SpeechRecognition?: new () => SpeechLike };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = navigator.language || "en-US";
    rec.interimResults = false;
    rec.onresult = (e) => onText(`${text}${text ? " " : ""}${e.results[0]?.[0]?.transcript ?? ""}`);
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const empty = !text.trim() && !url && !files.length;
  const submit = async () => {
    if (empty) return;
    setBusy(true);
    setError(null);
    const fields: Record<string, string> = {
      text: text.slice(0, CAPTURE_LIMITS.text),
      ...(url ? { url } : {}),
      channel,
      clientCaptureId: newClientCaptureId(),
      investigate: canAi && investigate ? "auto" : canAi ? "off" : "auto",
    };
    const payloadFiles = files.map((f) => ({ name: f.name, blob: f.blob }));
    const r = await sendCapture(fields, payloadFiles);
    setBusy(false);
    if (r.ok) {
      qc.invalidateQueries({ queryKey: ["work"] });
      const triage = (r.body as { triage?: string }).triage;
      toast(triage === "queued" ? "Captured · Jarvis is looking into it" : "Captured to the inbox", "ok");
      void flushQueue();
      onDone?.({ queued: false });
      return;
    }
    if (r.retry && r.status !== 401) {
      try {
        await queueCapture({
          clientCaptureId: fields.clientCaptureId!,
          fields,
          files: files.map((f) => ({ name: f.name, type: f.type, blob: f.blob })),
          createdAt: new Date().toISOString(),
          attempts: 0,
          userId,
        });
        toast("Saved on this phone · sends when online", "warn");
        onDone?.({ queued: true });
      } catch (e) {
        setError((e as Error).message);
      }
      return;
    }
    setError(r.error);
  };

  return (
    <form
      className="space-y-2"
      data-testid="capture-sheet"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field id="capture-sheet-text" label="Capture to inbox" hint="First line becomes the title. File it later.">
        <textarea
          id="capture-sheet-text"
          data-autofocus={autoFocus || undefined}
          className={`${inputCls} min-h-24 text-base`}
          value={text}
          maxLength={CAPTURE_LIMITS.text}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="What's on your mind?"
        />
      </Field>
      {url ? (
        <p className="flex min-w-0 items-center gap-2 text-[13px]">
          <span className="min-w-0 truncate rounded-full border border-line px-2 py-0.5" title={url}>
            🔗 {url}
          </span>
          <button type="button" className="tap text-xs underline" onClick={() => setUrl("")} aria-label="Remove link">
            Remove
          </button>
        </p>
      ) : null}
      {files.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Attached images">
          {files.map((f) => (
            <li key={f.id} className="relative">
              {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview */}
              <img src={f.url} alt={f.name} className="h-14 w-14 rounded-md border border-line object-cover" />
              <button
                type="button"
                className="tap absolute -top-2 -right-2 flex h-6 min-h-0 w-6 items-center justify-center rounded-full border border-line bg-surface text-xs"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles(files.filter((x) => x.id !== f.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={fileRef}
            id={`${id}-files`}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            aria-label="Attach images"
            tabIndex={-1}
            onChange={(e) => addFiles(e.target.files)}
          />
          <Button type="button" size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
            Attach
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={dictate}
            disabled={!speech || listening}
            title={speech ? "Dictate" : "Use your keyboard's mic"}
            aria-label={speech ? (listening ? "Listening…" : "Dictate") : "Dictation: use your keyboard's mic"}
          >
            {listening ? "Listening…" : "Mic"}
          </Button>
          {canAi ? (
            <label className="tap inline-flex items-center gap-1.5 text-[13px]">
              <input type="checkbox" checked={investigate} onChange={(e) => setInvestigate(e.target.checked)} />
              Investigate
            </label>
          ) : null}
          {queued ? (
            <span className={cx("rounded-full border border-warn px-2 text-xs")} data-testid="capture-queued" data-dynamic>
              {queued} waiting to send
            </span>
          ) : null}
        </div>
        <div className="flex gap-2">
          {askable ? (
            <Button
              type="button"
              disabled={!text.trim() || busy}
              busy={asking}
              onClick={async () => {
                if (await ask([text, url].filter(Boolean).join("\n"))) onDone?.({ queued: false });
              }}
            >
              Ask Hermes instead
            </Button>
          ) : null}
          <Button type="submit" variant="primary" disabled={empty || asking} busy={busy}>
            Capture
          </Button>
        </div>
      </div>
    </form>
  );
}

type SpeechLike = {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: { 0?: { transcript?: string } }[] }) => void;
  onend: () => void;
  start: () => void;
};
