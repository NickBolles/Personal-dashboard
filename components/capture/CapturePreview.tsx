import { InboxIcon } from "@/components/icons";

export function CapturePreview({ text, url, fileCount }: { text: string; url: string; fileCount: number }) {
  let host = "";
  try {
    host = url ? new URL(url).hostname : "";
  } catch {
    /* An unfinished URL is not a promised destination. */
  }
  // Mirrors the capture API's title selection. Capture has no due-date parser or destination picker.
  const title = (text.split(/\r?\n/)[0]?.trim() || host || (fileCount ? "Screenshot" : "Capture")).slice(0, 200);
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-xs text-muted" data-testid="capture-preview" aria-live="polite">
      <InboxIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 [overflow-wrap:anywhere]">
        Will create: Capture · <strong className="font-medium text-text">{title}</strong> · Inbox
      </span>
    </p>
  );
}
