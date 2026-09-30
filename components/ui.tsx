"use client";

import Link from "next/link";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { SOURCE_LABELS, type ActionSource } from "@/lib/contracts";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-contrast border-transparent hover:opacity-90",
  secondary: "bg-surface text-text border-line-strong hover:bg-surface-2",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface-2",
  danger: "bg-danger text-white border-transparent hover:opacity-90 dark:text-black",
};

export function Button({
  variant = "secondary",
  size = "md",
  busy,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean }) {
  return (
    <button
      {...rest}
      aria-busy={busy || undefined}
      disabled={rest.disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-[10px] border font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
        size === "md" ? "min-h-12 px-4 text-[0.95rem]" : "min-h-11 px-3 text-sm",
        VARIANTS[variant],
        className,
      )}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "secondary",
  className,
  children,
  external,
  ...rest
}: { href: string; variant?: Variant; className?: string; children: ReactNode; external?: boolean } & Record<string, unknown>) {
  const cls = cx(
    "inline-flex items-center justify-center gap-2 rounded-[10px] border font-medium min-h-12 px-4 text-[0.95rem] no-underline",
    VARIANTS[variant],
    className,
  );
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener" className={cls} {...rest}>
        {children}
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    );
  }
  return (
    <Link href={href} className={cls} {...rest}>
      {children}
    </Link>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role={label ? "status" : undefined} className="inline-flex items-center gap-2">
      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
        <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
      {label ? <span>{label}</span> : null}
    </span>
  );
}

export function Card({ children, className, as: As = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "article" | "div" | "li" } & Record<string, unknown>) {
  return (
    <As className={cx("card p-4", className)} {...rest}>
      {children}
    </As>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

const SOURCE_DOT: Record<string, string> = {
  hermes: "bg-[#6d4aff]",
  paperclip: "bg-[#0e8a74]",
  todos: "bg-[#2749d8]",
  skylight: "bg-[#d06b00]",
  daily_compass: "bg-[#a0287a]",
  home_assistant: "bg-[#0a7ea4]",
  jarvis: "bg-[#5b5f57]",
};

export function SourceBadge({ source }: { source: ActionSource | "jarvis" }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
      <span aria-hidden="true" className={cx("h-2 w-2 rounded-full", SOURCE_DOT[source])} />
      {source === "jarvis" ? "Jarvis" : SOURCE_LABELS[source]}
    </span>
  );
}

export type Tone = "neutral" | "ok" | "warn" | "danger" | "accent";
const TONES: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-line",
  ok: "bg-ok-soft text-ok border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  danger: "bg-danger-soft text-danger border-transparent",
  accent: "bg-accent-soft text-accent border-transparent",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium", TONES[tone], className)}>
      {children}
    </span>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius)] border border-dashed border-line-strong p-5 text-center">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-3 flex justify-center">{action}</div> : null}
    </div>
  );
}

export function ErrorNote({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error ?? "Something went wrong");
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-danger bg-danger-soft p-3 text-sm text-danger">
      <span>{msg}</span>
      {retry ? (
        <Button size="sm" variant="secondary" onClick={retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

// --- Dialog with focus trap + restoration ---

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const restore = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () =>
      Array.from(
        el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [],
      );
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables()[0];
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
      if (e.key === "Tab") {
        const list = focusables();
        if (!list.length) return;
        const f = list[0]!;
        const l = list[list.length - 1]!;
        if (e.shiftKey && document.activeElement === f) {
          e.preventDefault();
          l.focus();
        } else if (!e.shiftKey && document.activeElement === l) {
          e.preventDefault();
          f.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prevOverflow;
      restore.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="presentation">
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cx(
          "relative z-10 max-h-[90dvh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface p-5 shadow-xl sm:rounded-2xl",
          size === "lg" ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
      >
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        {description ? (
          <div id={descId} className="mt-1 text-sm text-muted">
            {description}
          </div>
        ) : null}
        <div className="mt-4">{children}</div>
        {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}

// --- Overflow menu (visible equivalent for any swipe/long-press action) ---

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean };

export function OverflowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    list.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? []);
    const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      buttons[(idx + 1) % buttons.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      buttons[(idx - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === "Escape" || e.key === "Tab") {
      setOpen(false);
      if (e.key === "Escape") btn.current?.focus();
    }
  };

  return (
    <div className="relative">
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="tap inline-flex items-center justify-center rounded-[10px] text-muted hover:bg-surface-2"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" fill="currentColor" />
          <circle cx="12" cy="12" r="1.8" fill="currentColor" />
          <circle cx="19" cy="12" r="1.8" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <ul
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          onKeyDown={onKey}
          className="absolute right-0 z-40 mt-1 min-w-48 overflow-hidden rounded-xl border border-line bg-surface py-1 shadow-lg"
        >
          {items.map((it) => (
            <li key={it.label} role="none">
              <button
                role="menuitem"
                type="button"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={cx(
                  "block min-h-11 w-full px-4 text-left text-sm hover:bg-surface-2 disabled:opacity-50",
                  it.danger && "text-danger",
                )}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// --- Announcements (polite live region) + toasts ---

type Toast = { id: number; text: string; tone: Tone };
const ToastCtx = createContext<{ toast: (text: string, tone?: Tone) => void; announce: (text: string) => void }>({
  toast: () => {},
  announce: () => {},
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const toast = useCallback((text: string, tone: Tone = "neutral") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  const announce = useCallback((text: string) => {
    setAnnouncement("");
    setTimeout(() => setAnnouncement(text), 50);
  }, []);
  return (
    <ToastCtx.Provider value={{ toast, announce }}>
      {children}
      <div aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(84px+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={cx("pointer-events-auto max-w-md rounded-xl border px-4 py-3 text-sm shadow-lg", TONES[t.tone], t.tone === "neutral" && "bg-surface text-text")}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}

// --- Online state ---

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

export function useOnline() {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Current time, refreshed on an interval (keeps render pure). */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function Field({
  label,
  hint,
  children,
  id,
  error,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
  id: string;
  error?: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputCls =
  "block w-full min-h-12 rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-base text-text placeholder:text-muted disabled:opacity-60";
