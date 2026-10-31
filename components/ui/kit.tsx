"use client";

/**
 * Jarvis design system v1 component kit (docs/design-system.md §6).
 * Colours come only from tokens (app/globals.css); styles live in the `.k-*`
 * component layer there. Blue = you act, teal (`ai`) = an agent did/proposes it,
 * dashed teal = proposed. Showcased at /dev/kit.
 */
import Link from "next/link";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

// --- Buttons ---

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "agent";
type ButtonOwnProps = {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: ReactNode;
  iconOnly?: boolean;
  loading?: boolean;
};

function buttonClass({ variant = "secondary", size = "md", iconOnly }: ButtonOwnProps, className?: string) {
  return cx("k-btn", `k-btn-${variant}`, size === "sm" && "k-btn-sm", iconOnly && "k-btn-icon", className);
}

export function KSpinner({ label }: { label?: string }) {
  return <span className="k-spin" role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Button({
  variant,
  size,
  icon,
  iconOnly,
  loading,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & ButtonOwnProps & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      {...rest}
      type={type}
      aria-busy={loading || undefined}
      disabled={rest.disabled || loading}
      className={buttonClass({ variant, size, iconOnly }, className)}
    >
      {loading ? (
        <KSpinner />
      ) : icon ? (
        <span className="k-btn-glyph" aria-hidden>
          {icon}
        </span>
      ) : null}
      {iconOnly ? <span className="sr-only">{children}</span> : children}
    </button>
  );
}

export function ButtonLink({ href, variant, size, icon, className, children }: ButtonOwnProps & { href: string; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass({ variant, size }, className)}>
      {icon ? (
        <span className="k-btn-glyph" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
    </Link>
  );
}

// --- Menu ---

export type KMenuItem = {
  label: string;
  onSelect?: () => void;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  heading?: boolean;
};

/** A menu list with roving focus (arrows/Home/End), Esc to close. */
export function Menu({ items, onClose, label, className }: { items: KMenuItem[]; onClose?: () => void; label?: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not([disabled])")?.focus();
  }, []);
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not([disabled])") ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const go = (n: number) => btns[(n + btns.length) % btns.length]?.focus();
    const moves: Record<string, number> = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: btns.length - 1 };
    if (e.key in moves) {
      e.preventDefault();
      go(moves[e.key]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    }
  }
  return (
    <div ref={ref} role="menu" aria-label={label} className={cx("k-menu", className)} onKeyDown={onKey}>
      {items.map((it, i) =>
        it.heading ? (
          <div key={i} role="presentation" className="k-menu-h">
            {it.label}
          </div>
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            tabIndex={-1}
            disabled={it.disabled}
            className={cx("k-menu-i", it.danger && "k-menu-danger")}
            onClick={() => {
              it.onSelect?.();
              onClose?.();
            }}
          >
            <span>{it.label}</span>
            {it.hint ? <Kbd>{it.hint}</Kbd> : null}
          </button>
        ),
      )}
    </div>
  );
}

export function SplitButton({
  label,
  onClick,
  menu,
  variant = "primary",
  size,
  menuLabel = "More options",
}: {
  label: ReactNode;
  onClick: () => void;
  menu: KMenuItem[];
  variant?: ButtonVariant;
  size?: "md" | "sm";
  menuLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  return (
    <div className="k-split">
      <Button variant={variant} size={size} onClick={onClick} className="k-split-main">
        {label}
      </Button>
      <Button
        ref={toggle}
        variant={variant}
        size={size}
        iconOnly
        aria-haspopup="menu"
        aria-expanded={open}
        className="k-split-caret"
        icon={<Caret />}
        onClick={() => setOpen((o) => !o)}
      >
        {menuLabel}
      </Button>
      {open ? (
        <Menu
          className="k-split-menu"
          label={menuLabel}
          items={menu}
          onClose={() => {
            setOpen(false);
            toggle.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function Caret() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M3 4.5 6 7.5 9 4.5" />
    </svg>
  );
}

// --- Small status atoms ---

export type KTone = "neutral" | "ok" | "wn" | "bad" | "inf" | "ac" | "ai" | "prop" | "outline";

export function Pill({ tone = "neutral", children, className }: { tone?: KTone; children: ReactNode; className?: string }) {
  return <span className={cx("k-pill", `k-t-${tone}`, className)}>{children}</span>;
}

export function Dot({ tone = "neutral", live, label }: { tone?: KTone; live?: boolean; label?: string }) {
  return (
    <span
      className={cx("k-dot", `k-t-${tone}`, live && "k-dot-live")}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Chip({ selected, onRemove, onClick, children }: { selected?: boolean; onRemove?: () => void; onClick?: () => void; children: ReactNode }) {
  return (
    <span className={cx("k-chip", selected && "k-chip-on")}>
      {onClick ? (
        <button type="button" aria-pressed={!!selected} onClick={onClick} className="k-chip-b">
          {children}
        </button>
      ) : (
        <span className="k-chip-b">{children}</span>
      )}
      {onRemove ? (
        <button type="button" className="k-chip-x" aria-label={`Remove ${typeof children === "string" ? children : ""}`.trim()} onClick={onRemove}>
          ×
        </button>
      ) : null}
    </span>
  );
}

export type Status = "todo" | "prog" | "done" | "block" | "prop";
export function StatusCircle({ status, label }: { status: Status; label: string }) {
  return (
    <span className={cx("k-sc", `k-sc-${status}`)} role="img" aria-label={label}>
      {status === "done" ? (
        <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="m2.5 6.2 2.3 2.3 4.7-4.9" />
        </svg>
      ) : null}
    </span>
  );
}

export type Agent = "cos" | "mom" | "dev" | "lab" | "jar";
export const AGENT_NAMES: Record<Agent, string> = { cos: "Chief of staff", mom: "Mom", dev: "Dev", lab: "Lab", jar: "Jarvis" };

export function AgentMark({ agent, size = "md", label }: { agent: Agent; size?: "sm" | "md" | "lg"; label?: string }) {
  return (
    <span
      className={cx("k-agent", `k-agent-${size}`, agent === "jar" && "k-agent-round")}
      style={{ "--hue": `var(--ag-${agent})` } as CSSProperties}
      role="img"
      aria-label={label ?? AGENT_NAMES[agent]}
    >
      {AGENT_NAMES[agent][0]}
    </span>
  );
}

export function Avatar({ initials, size = "md" }: { initials: string; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={cx("k-avatar", `k-agent-${size}`)} aria-hidden>
      {initials.slice(0, 2).toUpperCase()}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx("k-kbd", className)}>{children}</kbd>;
}

// --- Form controls ---

export function Checkbox({
  checked,
  onChange,
  label,
  celebrate,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  celebrate?: boolean;
  disabled?: boolean;
}) {
  const [burst, setBurst] = useState(0);
  return (
    <label className={cx("k-check", checked && "k-check-on", disabled && "k-disabled")}>
      <input
        type="checkbox"
        className="k-check-in"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          if (celebrate && e.target.checked) setBurst((b) => b + 1);
          onChange(e.target.checked);
        }}
      />
      <span className={cx("k-check-box", celebrate && burst > 0 && checked && "k-pop")} key={burst} aria-hidden>
        {celebrate && burst > 0 && checked ? (
          <span className="k-spark">
            {Array.from({ length: 10 }, (_, i) => (
              <i key={i} style={{ "--a": `${i * 36}deg` } as CSSProperties} />
            ))}
          </span>
        ) : null}
      </span>
      <span className={cx("k-check-l", celebrate && checked && "k-strike")}>{label}</span>
    </label>
  );
}

export function Toggle({ checked, onChange, label, locked }: { checked: boolean; onChange: (v: boolean) => void; label: string; locked?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-disabled={locked || undefined}
      className={cx("k-toggle", checked && "k-toggle-on", locked && "k-toggle-locked")}
      onClick={() => !locked && onChange(!checked)}
    >
      <span className="k-toggle-t" aria-hidden>
        <span className="k-toggle-k" />
      </span>
      <span>{label}</span>
      {locked ? <span className="k-meta">Locked</span> : null}
    </button>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function onKey(e: KeyboardEvent) {
    const i = options.findIndex((o) => o.value === value);
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    onChange(options[n].value);
    ref.current?.querySelectorAll<HTMLButtonElement>("[role=radio]")[n]?.focus();
  }
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className="k-seg" onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className="k-seg-i"
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count != null ? <span className="k-count">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { id: string; label: string; count?: number; href?: string }[];
  value: string;
  onChange?: (id: string) => void;
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="k-tabs">
      {tabs.map((t) => {
        const inner = (
          <>
            {t.label}
            {t.count != null ? <span className="k-count">{t.count}</span> : null}
          </>
        );
        return t.href ? (
          <Link key={t.id} href={t.href} role="tab" aria-selected={t.id === value} className="k-tab">
            {inner}
          </Link>
        ) : (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === value} className="k-tab" onClick={() => onChange?.(t.id)}>
            {inner}
          </button>
        );
      })}
    </div>
  );
}

export function Input({ icon, invalid, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode; invalid?: boolean }) {
  return (
    <span className={cx("k-input", invalid && "k-input-bad", className)}>
      {icon ? (
        <span className="k-input-ic" aria-hidden>
          {icon}
        </span>
      ) : null}
      <input {...rest} aria-invalid={invalid || rest["aria-invalid"] || undefined} />
    </span>
  );
}

export function ProgressBar({ value, tone = "ac", label }: { value: number; tone?: "ac" | "ok" | "wn" | "bad" | "ai" | "orb"; label: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="k-prog" role="progressbar" aria-label={label} aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <span className={cx("k-prog-f", `k-prog-${tone}`)} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Skeleton({ w = "100%", h = 12, className }: { w?: number | string; h?: number | string; className?: string }) {
  return <span className={cx("k-skel", className)} style={{ width: w, height: h }} aria-hidden />;
}

export function Tooltip({ content, kbd, children }: { content: string; kbd?: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="k-tip-w" aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className="k-tip">
        {content}
        {kbd ? <Kbd>{kbd}</Kbd> : null}
      </span>
    </span>
  );
}

/** Presentational toast (the live stack is `ToastProvider`/`useToast` in ./legacy). */
export function Toast({
  message,
  action,
  tone = "neutral",
}: {
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  tone?: "neutral" | "ok" | "bad";
}) {
  return (
    <div role="status" className={cx("k-toast", tone !== "neutral" && `k-toast-${tone}`)}>
      <span>{message}</span>
      {action ? (
        <button type="button" className="k-toast-a" onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

// --- Rows, cards, sections ---

type RowProps = {
  leading?: ReactNode;
  title: ReactNode;
  sub?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  current?: boolean;
  onClick?: () => void;
  href?: string;
  className?: string;
};

function RowShell({ leading, title, sub, meta, trailing, selected, current, onClick, href, className, two }: RowProps & { two?: boolean }) {
  const cls = cx("k-row", two && "k-row2", selected && "k-row-sel", current && "k-row-cur", (onClick || href) && "k-row-act", className);
  const body = (
    <>
      {leading ? <span className="k-row-lead">{leading}</span> : null}
      <span className="k-row-main">
        <span className="k-row-t">{title}</span>
        {two && sub ? <span className="k-row-s">{sub}</span> : null}
      </span>
      {meta ? <span className="k-meta">{meta}</span> : null}
    </>
  );
  return (
    <div className={cls} aria-current={current ? "page" : undefined} data-selected={selected || undefined}>
      {href ? (
        <Link href={href} className="k-row-hit">
          {body}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className="k-row-hit">
          {body}
        </button>
      ) : (
        <span className="k-row-hit">{body}</span>
      )}
      {trailing ? <span className="k-row-trail">{trailing}</span> : null}
    </div>
  );
}

export function Row(p: RowProps) {
  return <RowShell {...p} />;
}
export function TwoLineRow(p: RowProps) {
  return <RowShell {...p} two />;
}

export function Card({
  title,
  meta,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("k-card", className)}>
      {title ? <CardHeader title={title} meta={meta} actions={actions} /> : null}
      {children != null ? <CardBody>{children}</CardBody> : null}
    </section>
  );
}
export function CardHeader({ title, meta, actions }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="k-card-h">
      <h3 className="k-card-t">{title}</h3>
      {meta ? <span className="k-meta">{meta}</span> : null}
      {actions ? <span className="k-card-a">{actions}</span> : null}
    </header>
  );
}
export function CardBody({ children }: { children: ReactNode }) {
  return <div className="k-card-b">{children}</div>;
}

export function SectionHeader({ label, count, action, id }: { label: string; count?: number; action?: ReactNode; id?: string }) {
  return (
    <div className="k-sh">
      <h2 id={id} className="k-sh-l">
        {label}
        {count != null ? <span className="k-count">{count}</span> : null}
      </h2>
      {action}
    </div>
  );
}

export function AttentionRow({
  icon,
  agent,
  tone = "neutral",
  title,
  why,
  meta,
  actions,
  proposed,
}: {
  icon?: ReactNode;
  agent?: Agent;
  tone?: KTone;
  title: ReactNode;
  why?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  proposed?: boolean;
}) {
  return (
    <div className={cx("k-att", proposed && "k-att-prop")}>
      <span className={cx("k-att-ic", `k-t-${tone}`)}>{agent ? <AgentMark agent={agent} size="sm" /> : icon}</span>
      <div className="k-att-main">
        <div className="k-att-t">
          {title}
          {proposed ? <Pill tone="prop">Proposed</Pill> : null}
        </div>
        {why ? <div className="k-att-why">{why}</div> : null}
        {meta ? <div className="k-meta">{meta}</div> : null}
      </div>
      {actions ? <div className="k-att-a">{actions}</div> : null}
    </div>
  );
}

export function ProposedBox({ label = "Proposed by an agent", children }: { label?: string; children: ReactNode }) {
  return (
    <div className="k-propbox" role="group" aria-label={label}>
      <div className="k-propbox-l">{label}</div>
      {children}
    </div>
  );
}

export function Banner({ tone = "inf", children, action }: { tone?: "wn" | "bad" | "inf"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={cx("k-banner", `k-t-${tone}`)} role={tone === "bad" ? "alert" : "status"}>
      <span className="k-banner-c">{children}</span>
      {action}
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="k-empty">
      {icon ? (
        <div className="k-empty-ic" aria-hidden>
          {icon}
        </div>
      ) : null}
      <p className="k-empty-t">{title}</p>
      {children ? <div className="k-empty-b">{children}</div> : null}
      {action}
    </div>
  );
}

export function Kpi({ label, value, delta, tone }: { label: string; value: ReactNode; delta?: string; tone?: "ok" | "wn" | "bad" | "ai" | "ac" }) {
  return (
    <div className="k-kpi">
      <div className="k-kpi-l">{label}</div>
      <div className={cx("k-kpi-v", tone && `k-fg-${tone}`)}>{value}</div>
      {delta ? <div className="k-meta">{delta}</div> : null}
    </div>
  );
}

/** Permission lock: says which capability is missing instead of a blank or generic "no access". */
export function PermissionLock({ capability, label }: { capability: string; label: string }) {
  return (
    <div className="k-lock" role="note" data-capability={capability}>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
      <span className="k-lock-t">
        Needs {label} access <span className="k-meta">({capability})</span> · ask the owner in Settings → People
      </span>
    </div>
  );
}

export function LockBar({ locked, onUnlock, label = "Finance" }: { locked: boolean; onUnlock: () => void; label?: string }) {
  return (
    <div className={cx("k-lock", !locked && "k-lock-open")}>
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d={locked ? "M5.5 7V5a2.5 2.5 0 0 1 5 0v2" : "M5.5 7V5a2.5 2.5 0 0 1 5 0"} />
      </svg>
      <span className="k-lock-t">{locked ? `${label} locked · unlock with passcode` : `${label} unlocked`}</span>
      {locked ? (
        <Button size="sm" onClick={onUnlock}>
          Unlock
        </Button>
      ) : null}
    </div>
  );
}

// --- Agent surfaces ---

export function Orb({
  expanded = false,
  onClick,
  size = 52,
  label = "Jarvis commands",
}: {
  expanded?: boolean;
  onClick?: () => void;
  size?: number;
  label?: string;
}) {
  return (
    <button
      type="button"
      className={cx("k-orb", expanded && "k-orb-open")}
      style={{ width: size, height: size }}
      aria-label={label}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <span className="k-orb-aura" aria-hidden />
      <svg className="k-orb-g" width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path d="M10 1.5 11.9 8.1 18.5 10 11.9 11.9 10 18.5 8.1 11.9 1.5 10 8.1 8.1Z" />
      </svg>
    </button>
  );
}

export function AgentCard({
  agent,
  title,
  status,
  live,
  children,
  actions,
}: {
  agent: Agent;
  title: ReactNode;
  status?: ReactNode;
  live?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <article className="k-agentcard">
      <span className="k-agentcard-glow" aria-hidden />
      <header className="k-agentcard-h">
        <AgentMark agent={agent} size="sm" />
        <h3 className="k-agentcard-t">{title}</h3>
        {status ? (
          <span className="k-agentcard-s">
            {live ? <Dot tone="ai" live /> : null}
            {status}
          </span>
        ) : null}
      </header>
      {children ? <div className="k-agentcard-b">{children}</div> : null}
      {actions ? <footer className="k-agentcard-a">{actions}</footer> : null}
    </article>
  );
}

export function SpendRing({ spent, budget, label = "AI spend", size = 32 }: { spent: number; budget: number; label?: string; size?: number }) {
  const pct = budget > 0 ? Math.min(1, spent / budget) : 0;
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  const text = `${label}: $${spent.toFixed(2)} of $${budget.toFixed(2)}`;
  return (
    <Tooltip content={text}>
      <span className="k-ring" role="img" aria-label={text} tabIndex={0}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--s4)" strokeWidth="3" />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--ai)"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${c * pct} ${c}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      </span>
    </Tooltip>
  );
}
