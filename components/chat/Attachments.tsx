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
  /** 0–100 while uploading */
  progress: number;
  status: "uploading" | "ready" | "error";
  error?: string;
  file?: ChatFileView;
  previewUrl?: string;
};

const fileUrl = (sessionId: string, id: string, thumb = false) =>
  `/api/hermes/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(id)}${thumb ? "?thumb=1" : ""}`;

function upload(sessionId: string, file: File, onProgress: (p: number) => void): Promise<ChatFileView> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/hermes/sessions/${encodeURIComponent(sessionId)}/files`);
    xhr.setRequestHeader("x-jarvis-csrf", "1");
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100));
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

/** Draft attachments for the next message: validate → upload with progress → ids for the run. */
export function useChatAttachments(sessionId: string) {
  const [drafts, setDrafts] = useState<DraftFile[]>([]);
  const { toast } = useToast();
  const seq = useRef(0);
  const live = useRef(drafts);
  useEffect(() => {
    live.current = drafts;
  }, [drafts]);

  useEffect(
    () => () => {
      for (const d of live.current) if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
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
          progress: 0,
          status: "uploading",
          previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
        };
        setDrafts((ds) => [...ds, d]);
        upload(sessionId, file, (p) => patch(localId, { progress: p })).then(
          (f) => patch(localId, { status: "ready", progress: 100, file: f }),
          (err: Error) => {
            patch(localId, { status: "error", error: err.message });
            toast(err.message, "danger");
          },
        );
      }
    },
    [sessionId, toast],
  );

  const remove = useCallback(
    (localId: string) => {
      const d = live.current.find((x) => x.localId === localId);
      if (!d) return;
      if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
      setDrafts((ds) => ds.filter((x) => x.localId !== localId));
      if (d.file && !d.file.sentAt) void api.del(fileUrl(sessionId, d.file.id)).catch(() => undefined);
    },
    [sessionId],
  );

  /** After a successful send: the files now belong to the message. */
  const clear = useCallback(() => {
    for (const d of live.current) if (d.previewUrl) URL.revokeObjectURL(d.previewUrl);
    setDrafts([]);
  }, []);

  return {
    drafts,
    add,
    remove,
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

export function AttachButton({ onFiles, disabled }: { onFiles: (f: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => ref.current?.click()}
        aria-label="Attach files or pictures"
        disabled={disabled}
        className="shrink-0 px-3"
      >
        <PaperclipIcon />
      </Button>
      <input
        ref={ref}
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
export function CameraButton({ onFiles, disabled }: { onFiles: (f: File[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        onClick={() => ref.current?.click()}
        aria-label="Take a photo"
        disabled={disabled}
        className="shrink-0 px-3 [@media(pointer:fine)]:hidden"
      >
        <CameraIcon />
      </Button>
      <input
        ref={ref}
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
export function AttachmentChips({ drafts, onRemove }: { drafts: DraftFile[]; onRemove: (localId: string) => void }) {
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
              // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
              <img src={d.previewUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" />
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
                  ? `Uploading ${d.progress}%`
                  : d.status === "error"
                    ? (d.error ?? "Failed")
                    : `${KIND_LABEL[d.kind]} · ${formatBytes(d.size)}`}
              </span>
            </span>
            {d.status === "uploading" ? (
              <span
                role="progressbar"
                aria-label={`Uploading ${d.name}`}
                aria-valuenow={d.progress}
                aria-valuemin={0}
                aria-valuemax={100}
                className="absolute inset-x-1 bottom-0.5 h-0.5 rounded bg-line"
              >
                <span className="block h-full rounded bg-accent" style={{ width: `${d.progress}%` }} />
              </span>
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
  return (
    <Dialog open onClose={onClose} title={file.name}>
      {/* eslint-disable-next-line @next/next/no-img-element -- authenticated file route */}
      <img src={fileUrl(sessionId, file.id)} alt={file.name} className="mx-auto max-h-[70vh] w-auto max-w-full rounded" />
      <p className="mt-2 text-xs text-muted">
        {formatBytes(file.bytes)}
        {file.width && file.height ? ` · ${file.width}×${file.height}` : ""}
        {file.locationRemoved ? " · location removed" : ""} ·{" "}
        <a className="text-accent underline" href={fileUrl(sessionId, file.id)} download={file.name}>
          Download
        </a>
      </p>
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
