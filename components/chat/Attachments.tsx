"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { CHAT_FILE_ACCEPT, formatBytes, validateBatch, type ChatFileKind, type ChatFileView } from "@/lib/chat-files";
import { Button, Dialog, cx, useToast } from "@/components/ui";

export type DraftFile = {
  localId: string;
  name: string;
  size: number;
  kind: ChatFileKind;
  /** Actual transport bytes only; null means unknown or server processing. */
  progress: number | null;
  status: "uploading" | "ready" | "error";
  error?: string;
  file?: ChatFileView;
  previewUrl?: string;
};

const fileUrl = (sessionId: string, id: string, thumb = false) =>
  `/api/hermes/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(id)}${thumb ? "?thumb=1" : ""}`;

function upload(sessionId: string, file: File, onProgress: (p: number | null) => void, signal: AbortSignal): Promise<ChatFileView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/hermes/sessions/${encodeURIComponent(sessionId)}/files`);
    xhr.setRequestHeader("x-jarvis-csrf", "1");
    xhr.responseType = "json";
    const abort = () => xhr.abort();
    signal.addEventListener("abort", abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener("abort", abort);
    xhr.onabort = () => reject(new DOMException("Upload cancelled", "AbortError"));
    xhr.upload.onprogress = (e) => onProgress(e.lengthComputable && e.total > 0 ? Math.round((e.loaded / e.total) * 100) : null);
    xhr.upload.onload = () => onProgress(null);
    xhr.onload = () => {
      const body = xhr.response as { file?: ChatFileView; error?: string } | null;
      if (xhr.status >= 200 && xhr.status < 300 && body?.file) resolve(body.file);
      else reject(new Error(body?.error ?? `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check your connection"));
    const form = new FormData();
    form.append("file", file, file.name || "pasted.png");
    xhr.send(form);
  });
}

/** Only object URLs we created are revoked (restored drafts preview through the thumbnail route). */
const revoke = (d: DraftFile) => d.previewUrl?.startsWith("blob:") && URL.revokeObjectURL(d.previewUrl);

/** Draft attachments for the next message: validate → upload with progress → ids for the run. */
export function useChatAttachments(sessionId: string) {
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const { toast } = useToast();
  const seq = useRef(0);
  const uploads = useRef(new Map<string, AbortController>());
  const originals = useRef(new Map<string, File>());
  const live = useRef(drafts);
  useEffect(() => {
    live.current = drafts;
  }, [drafts]);

  // #85: drafts uploaded before a reload come back into the composer (else they'd hold the
  // per-conversation draft quota with nothing visible to send or remove).
  useEffect(() => {
    let off = false;
    api
      .get<{ files: ChatFileView[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/files`)
      .then(({ files }) => {
        const unsent = files.filter((f) => !f.sentAt).reverse();
        if (off || !unsent.length) return;
        setDrafts((ds) => {
          const have = new Set(ds.map((d) => d.file?.id));
          const back: DraftFile[] = unsent
            .filter((f) => !have.has(f.id))
            .map((f) => ({
              localId: `r-${f.id}`,
              name: f.name,
              size: f.bytes,
              kind: f.kind,
              progress: 100,
              status: "ready",
              file: f,
              previewUrl: f.kind === "image" ? fileUrl(sessionId, f.id, true) : undefined,
            }));
          return back.length ? [...back, ...ds] : ds;
        });
      })
      .catch(() => undefined);
    return () => {
      off = true;
    };
  }, [sessionId]);

  useEffect(
    () => () => {
      for (const controller of uploads.current.values()) controller.abort();
      uploads.current.clear();
      originals.current.clear();
      for (const d of live.current) revoke(d);
    },
    [],
  );

  const patch = (localId: string, p: Partial<DraftFile>) => setDrafts((ds) => ds.map((d) => (d.localId === localId ? { ...d, ...p } : d)));

  const add = useCallback(
    (files: File[]) => {
      if (!files.length) return;
      const { accepted, errors } = validateBatch(files, live.current.filter((d) => d.status !== "error").length);
      for (const e of errors) toast(e, "danger");
      for (const { file, kind } of accepted) {
        const localId = `d${++seq.current}`;
        const name = file.name || (kind === "image" ? "pasted-image.png" : "file");
        const d: DraftFile = {
          localId,
          name,
          size: file.size,
          kind,
          progress: null,
          status: "uploading",
          previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
        };
        setDrafts((ds) => [...ds, d]);
        originals.current.set(localId, file);
        const controller = new AbortController();
        uploads.current.set(localId, controller);
        upload(sessionId, file, (p) => patch(localId, { progress: p }), controller.signal)
          .then(
            (f) => {
              if (!controller.signal.aborted) patch(localId, { status: "ready", progress: 100, file: f });
            },
            (err: Error) => {
              if (controller.signal.aborted) return;
              patch(localId, { status: "error", error: err.message });
              toast(err.message, "danger");
            },
          )
          .finally(() => uploads.current.delete(localId));
      }
    },
    [sessionId, toast],
  );

  const remove = useCallback(
    (localId: string) => {
      const d = live.current.find((x) => x.localId === localId);
      if (!d) return;
      uploads.current.get(localId)?.abort();
      originals.current.delete(localId);
      revoke(d);
      setDrafts((ds) => ds.filter((x) => x.localId !== localId));
      if (d.file && !d.file.sentAt) void api.del(fileUrl(sessionId, d.file.id)).catch(() => undefined);
    },
    [sessionId],
  );

  /** After a successful send: the files now belong to the message. */
  const clear = useCallback(() => {
    for (const controller of uploads.current.values()) controller.abort();
    uploads.current.clear();
    originals.current.clear();
    for (const d of live.current) revoke(d);
    setDrafts([]);
  }, []);

  const retry = useCallback(
    (localId: string) => {
      const file = originals.current.get(localId);
      if (!file || uploads.current.has(localId)) return;
      const controller = new AbortController();
      uploads.current.set(localId, controller);
      patch(localId, { status: "uploading", error: undefined, progress: null });
      upload(sessionId, file, (p) => patch(localId, { progress: p }), controller.signal)
        .then(
          (f) => {
            if (!controller.signal.aborted) patch(localId, { status: "ready", progress: 100, file: f });
          },
          (err: Error) => {
            if (!controller.signal.aborted) patch(localId, { status: "error", error: err.message });
          },
        )
        .finally(() => uploads.current.delete(localId));
    },
    [sessionId],
  );

  return {
    drafts,
    add,
    remove,
    retry,
    clear,
    uploading: drafts.some((d) => d.status === "uploading"),
    readyIds: drafts.filter((d) => d.status === "ready" && d.file).map((d) => d.file!.id),
  };
}

export type ChatAttachments = ReturnType<typeof useChatAttachments>;

/** Images from a paste event (screenshots, copied pictures); text pastes are left alone. */
export function pastedFiles(e: React.ClipboardEvent): File[] {
  const out: File[] = [];
  for (const item of e.clipboardData?.items ?? []) {
    if (item.kind !== "file") continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

type PickerButtonProps = {
  onFiles: (f: File[]) => void;
  disabled?: boolean;
  /** extra classes for the visible button (the hidden input always stays mounted) */
  buttonClassName?: string;
  /** lets another control (the phone "+" menu) open the same picker */
  inputRef?: { current: HTMLInputElement | null };
};

export function AttachButton({ onFiles, disabled, buttonClassName, inputRef }: PickerButtonProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => ref.current?.click()}
        aria-label="Attach files or pictures"
        disabled={disabled}
        className={cx("shrink-0 px-3", buttonClassName)}
      >
        <PaperclipIcon />
      </Button>
      <input
        ref={(el) => {
          ref.current = el;
          if (inputRef) inputRef.current = el;
        }}
        type="file"
        multiple
        accept={CHAT_FILE_ACCEPT}
        aria-label="Choose files or pictures to attach"
        data-testid="chat-file-input"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** Phones: camera straight away (`capture`), separate from the picker so the library stays reachable. */
export function CameraButton({ onFiles, disabled, buttonClassName, inputRef }: PickerButtonProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => ref.current?.click()}
        aria-label="Take a photo"
        disabled={disabled}
        className={cx("shrink-0 px-3 [@media(pointer:fine)]:hidden", buttonClassName)}
      >
        <CameraIcon />
      </Button>
      <input
        ref={(el) => {
          ref.current = el;
          if (inputRef) inputRef.current = el;
        }}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label="Take a photo to attach"
        data-testid="chat-camera-input"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          onFiles([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
}

const KIND_LABEL: Record<ChatFileKind, string> = { image: "Picture", pdf: "PDF", text: "Text" };

/** Chips above the composer: thumbnail/type, name, size, progress, remove. */
export function AttachmentChips({
  drafts,
  onRemove,
  onRetry,
}: {
  drafts: DraftFile[];
  onRemove: (localId: string) => void;
  onRetry?: (localId: string) => void;
}) {
  const [view, setView] = useState<{ name: string; url: string } | null>(null);
  if (!drafts.length) return null;
  const hasDocs = drafts.some((d) => d.kind !== "image");
  return (
    <div className="mb-1 min-w-0">
      <ul aria-label="Attachments" className="flex min-w-0 gap-1.5 overflow-x-auto pb-1">
        {drafts.map((d) => (
          <li
            key={d.localId}
            data-testid="attachment-chip"
            data-status={d.status}
            className={cx(
              "relative flex max-w-[15rem] shrink-0 items-center gap-2 rounded-lg border bg-surface py-1 pr-1 pl-1",
              d.status === "error" ? "border-danger" : "border-line",
            )}
          >
            {d.previewUrl ? (
              <button
                type="button"
                className="tap shrink-0 rounded"
                aria-label={`Open picture ${d.name}`}
                onClick={() => setView({ name: d.name, url: d.previewUrl! })}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- local or authorized thumbnail */}
                <img src={d.previewUrl} alt="" className="h-9 w-9 rounded object-cover" />
              </button>
            ) : (
              <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded bg-surface-2 text-[10px] font-semibold text-muted uppercase">
                {d.kind === "pdf" ? "PDF" : "TXT"}
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium" title={d.name}>
                {d.name}
              </span>
              <span className="block text-[11px] text-muted" data-dynamic>
                {d.status === "uploading"
                  ? d.progress === null
                    ? "Uploading / processing"
                    : `Uploading ${d.progress}%`
                  : d.status === "error"
                    ? (d.error ?? "Failed")
                    : `${KIND_LABEL[d.kind]} · ${formatBytes(d.size)}`}
              </span>
            </span>
            {d.status === "uploading" ? (
              <span
                role="progressbar"
                aria-label={`Uploading ${d.name}`}
                aria-valuenow={d.progress ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
                className="grid h-7 w-7 shrink-0 place-items-center"
              >
                <svg aria-hidden viewBox="0 0 32 32" className={cx("h-7 w-7 -rotate-90", d.progress === null && "motion-safe:animate-spin")}>
                  <circle cx="16" cy="16" r="12" fill="none" stroke="var(--line)" strokeWidth="3" />
                  <circle
                    cx="16"
                    cy="16"
                    r="12"
                    fill="none"
                    stroke="var(--accent)"
                    strokeWidth="3"
                    pathLength="100"
                    strokeDasharray={`${d.progress ?? 25} 100`}
                    strokeLinecap="round"
                  />
                </svg>
              </span>
            ) : null}
            {d.status === "error" && onRetry ? (
              <button type="button" className="tap text-xs text-accent" onClick={() => onRetry(d.localId)}>
                Retry
              </button>
            ) : null}
            <button
              type="button"
              className="tap grid shrink-0 place-items-center rounded text-muted hover:text-text"
              aria-label={`Remove ${d.name}`}
              onClick={() => onRemove(d.localId)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      {hasDocs ? <p className="text-[11px] text-muted">PDFs and text files are sent as extracted text; pictures are sent as images.</p> : null}
      {view ? <PhotoViewer name={view.name} src={view.url} onClose={() => setView(null)} /> : null}
    </div>
  );
}

/** Drop target over the whole conversation: highlights while a file is dragged over it. */
export function useFileDrop(onFiles: (f: File[]) => void, enabled: boolean) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hasFiles = (e: React.DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  return {
    over,
    props: enabled
      ? {
          onDragEnter: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current++;
            setOver(true);
          },
          onDragOver: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          },
          onDragLeave: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            depth.current = Math.max(0, depth.current - 1);
            if (!depth.current) setOver(false);
          },
          onDrop: (e: React.DragEvent) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth.current = 0;
            setOver(false);
            onFiles([...e.dataTransfer.files]);
          },
        }
      : {},
  };
}

export function DropOverlay({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-2 z-30 grid place-items-center rounded-xl border-2 border-dashed border-accent bg-bg/80 text-sm font-medium"
    >
      Drop files or pictures to attach
    </div>
  );
}

/** Files that went out in this conversation (Links panel, message bubbles). */
export function useConversationFiles(sessionId: string) {
  return useQuery({
    queryKey: ["chat-files", sessionId],
    queryFn: () => api.get<{ files: ChatFileView[] }>(`/api/hermes/sessions/${encodeURIComponent(sessionId)}/files`).then((r) => r.files),
    staleTime: 30_000,
  });
}

export function useRefreshFiles(sessionId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ["chat-files", sessionId] });
}

/** Inline in a sent bubble: picture thumbnails (open a lightbox) and file rows. */
export function MessageAttachments({ sessionId, ids, files }: { sessionId: string; ids: string[]; files: ChatFileView[] }) {
  const [open, setOpen] = useState<ChatFileView | null>(null);
  const list = ids.map((id) => files.find((f) => f.id === id)).filter((f): f is ChatFileView => Boolean(f));
  if (!list.length) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="message-attachments">
      {list.map((f) =>
        f.kind === "image" ? (
          <button
            key={f.id}
            type="button"
            className="overflow-hidden rounded-lg border border-line"
            aria-label={`Open picture ${f.name}`}
            onClick={() => setOpen(f)}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated thumbnail route */}
            <img src={fileUrl(sessionId, f.id, true)} alt={f.name} className="h-24 w-24 object-cover sm:h-28 sm:w-28" loading="lazy" />
          </button>
        ) : (
          <FileRow key={f.id} sessionId={sessionId} f={f} />
        ),
      )}
      {open ? <Lightbox sessionId={sessionId} file={open} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function FileRow({ sessionId, f }: { sessionId: string; f: ChatFileView }) {
  return (
    <a
      href={fileUrl(sessionId, f.id)}
      download={f.name}
      className="flex max-w-full min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1 text-xs"
    >
      <span aria-hidden className="font-semibold text-muted uppercase">
        {f.kind === "pdf" ? "PDF" : "TXT"}
      </span>
      <span className="min-w-0 truncate">{f.name}</span>
      <span className="shrink-0 text-muted">{formatBytes(f.bytes)}</span>
      {f.kind === "pdf" && f.textStatus === "none" ? <span className="shrink-0 text-muted">· text not extracted</span> : null}
    </a>
  );
}

export function Lightbox({ sessionId, file, onClose }: { sessionId: string; file: ChatFileView; onClose: () => void }) {
  return <PhotoViewer name={file.name} src={fileUrl(sessionId, file.id)} onClose={onClose} />;
}

function PhotoViewer({ name, src, onClose }: { name: string; src: string; onClose: () => void }) {
  const [zoom, setZoom] = useState(false);
  return (
    <Dialog open onClose={onClose} title={name} size="full">
      <Button type="button" variant="ghost" onClick={onClose}>
        Close picture
      </Button>
      <Button type="button" variant="ghost" aria-pressed={zoom} onClick={() => setZoom((v) => !v)}>
        {zoom ? "Fit picture" : "Zoom picture"}
      </Button>
      <div className="max-h-[75dvh] overflow-auto overscroll-contain">
        {/* eslint-disable-next-line @next/next/no-img-element -- same-origin authorized route or owned blob; never public */}
        <img src={src} alt={name} className={zoom ? "max-w-none" : "mx-auto max-h-[70dvh] w-auto max-w-full rounded"} />
      </div>
    </Dialog>
  );
}

/** Links panel → Files. */
export function FilesSection({ sessionId }: { sessionId: string }) {
  const q = useConversationFiles(sessionId);
  const [open, setOpen] = useState<ChatFileView | null>(null);
  const files = (q.data ?? []).filter((f) => f.sentAt);
  return (
    <section aria-labelledby="lp-files">
      <h3 id="lp-files" className="mb-1 text-[11px] font-semibold tracking-wide text-muted uppercase">
        Files{files.length ? ` (${files.length})` : ""}
      </h3>
      {files.length ? (
        <ul className="space-y-1.5" data-testid="files-panel">
          {files.map((f) => (
            <li key={f.id} className="flex min-w-0 items-center gap-2">
              {f.kind === "image" ? (
                <button
                  type="button"
                  className="shrink-0 overflow-hidden rounded border border-line"
                  aria-label={`Open picture ${f.name}`}
                  onClick={() => setOpen(f)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- authenticated thumbnail route */}
                  <img src={fileUrl(sessionId, f.id, true)} alt="" className="h-9 w-9 object-cover" loading="lazy" />
                </button>
              ) : (
                <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded bg-surface-2 text-[10px] font-semibold text-muted uppercase">
                  {f.kind === "pdf" ? "PDF" : "TXT"}
                </span>
              )}
              <a href={fileUrl(sessionId, f.id)} download={f.name} className="min-w-0 flex-1 text-sm">
                <span className="block truncate">{f.name}</span>
                <span className="block text-[11px] text-muted" data-dynamic>
                  {formatBytes(f.bytes)}
                  {f.kind === "pdf" && f.textStatus === "none" ? " · text not extracted" : ""}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">Files and pictures you attach will show here.</p>
      )}
      {open ? <Lightbox sessionId={sessionId} file={open} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

function PaperclipIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m21.4 11.1-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
    </svg>
  );
}

function CameraIcon() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" />
      <circle cx="12" cy="13.5" r="3.5" />
    </svg>
  );
}
