"use client";

import { JarvisMark } from "@/components/brand/JarvisMark";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import { cx } from "@/components/ui";
import { OPEN_PALETTE_EVENT, useCommands, type Command } from "./commands";
import { useComposerTarget } from "@/components/agents/useComposerTarget";
import { shortcutLabel, useModKey } from "@/lib/client/platform";

/**
 * The command dock: one orb. Phones (design system §5): the Tide orb, lifted
 * out of the middle of the bottom bar. Tablets: a bottom-centre pill; desktop
 * (≥1024): the same pill in the top row (never floating over content).
 * Everywhere, a tap opens the command palette (Raycast-style: type to ask or
 * run an action). Press and hold (~320 ms) → radial action map: slide onto a
 * petal (pausing ~⅓ s opens its sub-menu), release to run, release on the orb
 * to cancel. ⌘/Ctrl+. (or ↑ on the focused orb) opens the map from the
 * keyboard (arrows choose, Tab/Enter opens a sub-menu, Enter runs, Esc
 * closes). Every action is also a palette command. Pointer events, no
 * dependencies; Work actions only appear with `work.use`.
 */

export const HOLD_MS = 320;
const DWELL_MS = 350;

type Petal = { id: string; icon: string; label: string; sub: { cmd: string; label?: string }[] };

const PETALS: Petal[] = [
  { id: "search", icon: "⌕", label: "Search", sub: [{ cmd: "search", label: "Everything" }] },
  { id: "capture", icon: "+", label: "Capture", sub: [{ cmd: "work.capture", label: "Quick note to Inbox" }] },
  {
    id: "goto",
    icon: "↗",
    label: "Go to",
    sub: [
      { cmd: "work.today", label: "Today" },
      { cmd: "work.inbox", label: "Inbox" },
      { cmd: "work.timeline", label: "Timeline" },
      { cmd: "work.dashboard", label: "Dashboard" },
      { cmd: "work.map", label: "Map" },
      { cmd: "go.home", label: "Today" },
      { cmd: "go.chat", label: "Hermes" },
      { cmd: "go.alerts", label: "Alerts" },
    ],
  },
  {
    id: "handoff",
    icon: "⇢",
    label: "Hand off",
    sub: [
      { cmd: "work.packet", label: "Start focused work" },
      { cmd: "work.continue", label: "Continue in conversation" },
    ],
  },
  {
    id: "validate",
    icon: "✓",
    label: "Validate",
    sub: [
      { cmd: "work.validate", label: "Record result" },
      { cmd: "work.today", label: "Proof due (Today)" },
    ],
  },
  {
    id: "inbox",
    icon: "✉",
    label: "Inbox",
    sub: [
      { cmd: "work.inbox", label: "Open inbox" },
      { cmd: "work.capture", label: "Capture" },
    ],
  },
];

type Resolved = { id: string; icon: string; label: string; sub: { cmd: Command; label: string }[] };
type Pt = { x: number; y: number };

/**
 * Where the radial map is centred. Normally on the orb; when the orb sits near
 * a screen edge (the desktop rail foot) the centre moves inwards so every petal
 * fits, and the orb stays a cancel zone. The petals sit on an upper arc, so a
 * top-row orb (desktop header) pushes the centre down until the arc fits.
 */
export function mapCentre(orb: Pt, vw: number, vh = Infinity, bottomInset = 0): Pt {
  const margin = 215; // max radius 165 + petal half-width + gutter
  const lo = Math.min(margin, vw / 2);
  const hi = Math.max(vw - margin, vw / 2);
  // The lowest petals sit ~0.2R above the centre plus their half-height (34): keep the centre
  // BOTTOM_CLEAR above the visible bottom (bottom bar, safe area, OS sheets) so none clip.
  const maxY = vh - bottomInset - BOTTOM_CLEAR;
  const y = Math.max(margin, orb.y);
  return { x: Math.max(lo, Math.min(hi, orb.x)), y: Math.max(Math.min(margin, maxY), Math.min(y, maxY)) };
}

/** Clearance between the map centre and the visible bottom edge (petal half-height + bar + gutter). */
export const BOTTOM_CLEAR = 96;

/** The visual viewport's bottom (pinch zoom / on-screen keyboard aware) and the safe-area inset. */
function viewportBottom(): { vh: number; inset: number } {
  const vv = window.visualViewport;
  const vh = vv ? vv.height + vv.offsetTop : window.innerHeight;
  let inset = 0;
  try {
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)";
    document.body.appendChild(probe);
    inset = parseFloat(getComputedStyle(probe).paddingBottom) || 0;
    probe.remove();
  } catch {
    /* no DOM */
  }
  return { vh, inset };
}

/** Drop any text selection the OS started (Android long-press) so no Copy/Search toolbar shows. */
function clearSelection() {
  try {
    window.getSelection()?.removeAllRanges();
  } catch {
    /* not supported */
  }
}

/** Petals the person can use: sub-entries map to commands they hold; empty petals disappear. */
export function resolvePetals(commands: Command[]): Resolved[] {
  const byId = new Map(commands.map((c) => [c.id, c]));
  return PETALS.map((p) => ({
    id: p.id,
    icon: p.icon,
    label: p.label,
    sub: p.sub.flatMap((s) => {
      const cmd = byId.get(s.cmd);
      return cmd ? [{ cmd, label: s.label ?? cmd.label }] : [];
    }),
  })).filter((p) => p.sub.length > 0);
}

function layout(center: Pt, n: number, phone = false) {
  const vw = window.innerWidth;
  // Phone bar: 6 × 62px actions on a 128px semicircle (§5); desktop keeps the wider arc.
  const R = phone ? 128 : Math.max(120, Math.min(165, center.x - 40, vw - center.x - 40, window.innerHeight * 0.3));
  const start = -168;
  const span = 156; // upper arc, clear of the dock
  return {
    R,
    petals: Array.from({ length: n }, (_, i) => {
      const a = ((start + (n > 1 ? (span * i) / (n - 1) : span / 2)) * Math.PI) / 180;
      return { a, x: Math.cos(a) * R, y: Math.sin(a) * R };
    }),
  };
}

function subLayout(center: Pt, R: number, petal: { x: number }, count: number) {
  const narrow = window.innerWidth < 600;
  return Array.from({ length: count }, (_, k) => {
    const x = narrow ? 0 : petal.x;
    const y = -(R + 70) - k * 46;
    return {
      x: Math.max(-center.x + 70, Math.min(window.innerWidth - center.x - 70, x)),
      y: Math.max(-center.y + 64, y),
    };
  });
}

export function CommandDock({ variant, compact = false }: { variant: "bar" | "dock"; compact?: boolean }) {
  const commands = useCommands();
  // Inside an area the orb asks that area's agent (the palette's Ask row and chip say so too).
  const target = useComposerTarget();
  const petals = useMemo(() => resolvePetals(commands), [commands]);
  const orb = useRef<HTMLButtonElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressing = useRef(false);
  const [charging, setCharging] = useState(false);
  const [map, setMap] = useState<null | { center: Pt; orb: Pt; via: "pointer" | "keyboard" }>(null);
  const [active, setActive] = useState(-1);
  const [subFor, setSubFor] = useState(-1);
  const [subActive, setSubActive] = useState(-1);
  // Mirrors for pointer/keyboard handlers (no re-subscribe per move); synced after each render.
  const st = useRef({ active, subFor, subActive, map });
  useLayoutEffect(() => {
    st.current = { active, subFor, subActive, map };
  });

  const phone = variant === "bar";
  const mod = useModKey();
  const palette = () => window.dispatchEvent(new Event(OPEN_PALETTE_EVENT));
  const vibrate = (ms: number) => {
    try {
      navigator.vibrate?.(ms);
    } catch {
      /* not supported */
    }
  };

  const close = useCallback((refocus = true) => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current);
    setMap(null);
    setActive(-1);
    setSubFor(-1);
    setSubActive(-1);
    if (refocus) orb.current?.focus({ preventScroll: true });
  }, []);

  const open = useCallback((via: "pointer" | "keyboard") => {
    const r = orb.current?.getBoundingClientRect();
    if (!r) return;
    // A hidden orb opens the map from the bottom centre.
    const at = r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight - 48 };
    const { vh, inset } = viewportBottom();
    clearSelection();
    setMap({ center: mapCentre(at, window.innerWidth, vh, inset), orb: at, via });
    setSubFor(-1);
    setSubActive(-1);
    setActive(via === "keyboard" ? 0 : -1);
  }, []);

  const run = useCallback(
    (cmd: Command | undefined) => {
      close(false);
      if (cmd) cmd.run();
      else orb.current?.focus({ preventScroll: true });
    },
    [close],
  );

  const commit = () => {
    const { active: a, subFor: s, subActive: k } = st.current;
    if (s >= 0 && k >= 0) return run(petals[s]?.sub[k]?.cmd);
    if (a >= 0) return run(petals[a]?.sub[0]?.cmd);
    run(undefined); // released on the orb (or nowhere): cancel
  };

  const track = (x: number, y: number) => {
    const m = st.current.map;
    if (!m) return;
    const { R, petals: pos } = layout(m.center, petals.length, phone);
    const rel = { x: x - m.center.x, y: y - m.center.y };
    const s = st.current.subFor;
    if (s >= 0) {
      const subs = subLayout(m.center, R, pos[s]!, petals[s]!.sub.length);
      let best = -1;
      let bd = Infinity;
      subs.forEach((p, j) => {
        const d = Math.hypot(rel.x - p.x, rel.y - p.y);
        if (d < bd) [bd, best] = [d, j];
      });
      if (bd < 60) {
        if (best !== st.current.subActive) {
          setSubActive(best);
          st.current = { ...st.current, subActive: best };
          vibrate(5);
        }
        return;
      }
    }
    if (Math.hypot(rel.x, rel.y) < 44 || Math.hypot(x - m.orb.x, y - m.orb.y) < 30) {
      setActive(-1);
      setSubActive(-1);
      st.current = { ...st.current, active: -1, subActive: -1 };
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
      return;
    }
    let best = -1;
    let bd = Infinity;
    pos.forEach((p, j) => {
      const d = Math.hypot(rel.x - p.x, rel.y - p.y);
      if (d < bd) [bd, best] = [d, j];
    });
    if (bd < 70 && best !== st.current.active) {
      setActive(best);
      setSubActive(-1);
      st.current = { ...st.current, active: best, subActive: -1 };
      vibrate(5);
      if (dwellTimer.current) clearTimeout(dwellTimer.current);
      dwellTimer.current = setTimeout(() => {
        if (st.current.map && st.current.active === best) setSubFor(best);
      }, DWELL_MS);
    }
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    pressing.current = true;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
    setCharging(true);
    holdTimer.current = setTimeout(() => {
      if (pressing.current) {
        vibrate(12);
        open("pointer");
      }
    }, HOLD_MS);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (st.current.map?.via === "pointer") track(e.clientX, e.clientY);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    clearSelection();
    setCharging(false);
    const was = pressing.current;
    pressing.current = false;
    if (!was) return;
    if (st.current.map) {
      track(e.clientX, e.clientY);
      commit();
    } else palette(); // tap → command palette (phone and desktop); hold → radial map
  };
  const onPointerCancel = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    pressing.current = false;
    setCharging(false);
  };

  // Android/Chrome: a long-press would select nearby text (Copy / Web search toolbar, Touch-to-Search
  // sheet) or open a context menu. Cancel the native touch default on the orb (taps and holds are
  // driven by pointer events, which still fire), and block selection/context menus while a hold or
  // the map is live.
  useEffect(() => {
    const el = orb.current;
    if (!el) return;
    const onTouchStart = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => el.removeEventListener("touchstart", onTouchStart);
  }, []);
  const live = charging || !!map;
  useEffect(() => {
    if (!live) return;
    const block = (e: Event) => {
      if (pressing.current || st.current.map) {
        e.preventDefault();
        if (e.type === "selectstart") clearSelection();
      }
    };
    document.addEventListener("selectstart", block, true);
    document.addEventListener("contextmenu", block, true);
    return () => {
      document.removeEventListener("selectstart", block, true);
      document.removeEventListener("contextmenu", block, true);
    };
  }, [live]);

  // ⌘/Ctrl+. toggles the map; while it's open, arrows/Tab/Enter/Esc drive it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Two docks are mounted (phone bar, tablet/desktop bottom dock); only the visible one owns the keyboard,
      // or the bar's when neither is visible.
      const mine = !!orb.current?.getClientRects().length;
      const anyVisible = Array.from(document.querySelectorAll('[data-testid="dock-orb"]')).some((el) => el.getClientRects().length > 0);
      if (!mine && (anyVisible || variant !== "bar")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === ".") {
        e.preventDefault();
        if (st.current.map) close();
        else open("keyboard");
        return;
      }
      const m = st.current.map;
      if (!m) return;
      const n = petals.length;
      const { active: a, subFor: s, subActive: k } = st.current;
      const subs = s >= 0 ? petals[s]!.sub.length : 0;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        e.preventDefault();
        if (subs) setSubActive((k + 1 + subs) % subs);
        else setActive((a + 1 + n) % n);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        e.preventDefault();
        if (subs) setSubActive((k - 1 + subs) % subs);
        else setActive((Math.max(a, 0) - 1 + n) % n);
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (subs) {
          setSubFor(-1);
          setSubActive(-1);
        } else if (a >= 0) {
          setSubFor(a);
          setSubActive(0);
        }
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!subs && a >= 0) {
          setSubFor(a);
          setSubActive(0);
        } else if (subs && k >= 0) run(petals[s]!.sub[k]!.cmd);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [petals, open, close, run, variant]);

  // Keyboard focus follows the active petal / sub-item, so screen readers hear it.
  useEffect(() => {
    if (map?.via !== "keyboard") return;
    const sel = subFor >= 0 && subActive >= 0 ? `[data-sub-index="${subActive}"]` : active >= 0 ? `[data-petal-index="${active}"]` : null;
    if (sel) document.querySelector<HTMLElement>(`#command-map ${sel}`)?.focus({ preventScroll: true });
  }, [map, active, subFor, subActive]);

  const geometry = map ? layout(map.center, petals.length, phone) : null;
  const subs = map && geometry && subFor >= 0 ? subLayout(map.center, geometry.R, geometry.petals[subFor]!, petals[subFor]!.sub.length) : [];
  const hint = !map
    ? ""
    : subFor >= 0
      ? `${petals[subFor]!.label} → ${subActive >= 0 ? petals[subFor]!.sub[subActive]!.label : "choose"}`
      : active >= 0
        ? `${petals[active]!.label}${map.via === "keyboard" ? " · Tab or Enter opens" : " · keep holding to open"}`
        : (target.node ? `Asking ${target.agent} · ${target.node.title} · ` : "") +
          (map.via === "pointer"
            ? "Slide to an action · release to run · release on the orb to cancel"
            : "Arrows to choose · Tab/Enter opens · Enter runs · Esc closes");

  return (
    <>
      <button
        ref={orb}
        type="button"
        data-testid="dock-orb"
        aria-label="Jarvis commands: tap for the command palette, hold for the action map (Ctrl+.)"
        aria-haspopup="menu"
        aria-expanded={!!map}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        onClick={(e) => {
          // Keyboard activation (Enter/Space) has detail 0; pointer taps are handled on pointerup.
          if (e.detail === 0) palette();
        }}
        onKeyDown={(e: ReactKeyboardEvent) => {
          if (e.key === "ArrowUp" && !map) {
            e.preventDefault();
            open("keyboard");
          }
        }}
        title={variant === "dock" && compact ? "Commands (tap) · action map (hold or Ctrl+.)" : undefined}
        className={cx(
          "dock-nosel relative inline-flex shrink-0 touch-none items-center select-none",
          variant === "bar"
            ? "k-orb dock-tide h-[52px] w-[52px] -translate-y-5 justify-center rounded-full text-lg font-bold text-white"
            : compact
              ? "h-11 w-11 justify-center rounded-[10px] hover:bg-surface"
              : "min-h-11 w-full gap-2.5 rounded-full border border-line bg-surface-2 py-1 pr-2 pl-1.5 text-[0.875rem] text-muted shadow-[var(--sh2,var(--shadow))] hover:border-line-strong hover:text-text",
          variant === "bar" && charging && "dock-charging",
        )}
      >
        {variant === "bar" ? (
          <>
            <span aria-hidden="true" className="k-orb-aura" />
            <span aria-hidden="true" className="dock-ring" />
            <JarvisMark className="h-7 w-7" />
          </>
        ) : (
          <>
            <span
              aria-hidden="true"
              className={cx(
                "dock-orb relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-white",
                charging && "dock-charging",
              )}
            >
              <span className="dock-ring" />
              <JarvisMark className="h-[18px] w-[18px]" />
            </span>
            {!compact ? (
              <span aria-hidden="true" className="flex min-w-0 flex-1 items-center justify-between gap-2 whitespace-nowrap">
                <span className="min-w-0 truncate" data-testid="dock-ask-target" data-agent={target.agent} data-routed={target.routed ? "1" : "0"}>
                  Ask <span className={cx(target.node && "font-semibold text-text")}>{target.agent}</span>
                  {target.node ? <span> · {target.node.title}</span> : null} or search…
                </span>
                <kbd className="kbd shrink-0">{shortcutLabel(mod, "K")}</kbd>
              </span>
            ) : null}
          </>
        )}
      </button>
      {map && geometry
        ? // Portalled to <body>: the phone bar's backdrop-filter would otherwise contain the fixed overlay.
          createPortal(
            <div
              className="dock-nosel fixed inset-0 z-[70] touch-none bg-[var(--scrim)] backdrop-blur-[6px]"
              data-testid="command-map-overlay"
              onContextMenu={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) close();
              }}
              onPointerMove={(e) => {
                if (map.via === "keyboard") track(e.clientX, e.clientY);
              }}
            >
              <p
                role="status"
                className="fixed top-6 left-1/2 max-w-[90vw] -translate-x-1/2 rounded-full border border-line bg-surface px-4 py-1.5 text-center text-sm shadow"
              >
                {hint}
              </p>
              <div id="command-map" role="menu" aria-label="Action map" className="fixed h-0 w-0" style={{ left: map.center.x, top: map.center.y }}>
                <span
                  aria-hidden="true"
                  className="dock-orb absolute -mt-7 -ml-7 inline-flex h-14 w-14 items-center justify-center overflow-hidden rounded-full px-1 text-center text-[10px] leading-tight font-bold break-all text-white"
                  data-testid="map-ask-target"
                >
                  {target.agent}
                </span>
                {petals.map((p, i) => (
                  <button
                    key={p.id}
                    type="button"
                    role="menuitem"
                    aria-haspopup="menu"
                    aria-expanded={subFor === i}
                    data-petal={p.id}
                    data-petal-index={i}
                    tabIndex={-1}
                    onClick={() => {
                      // One-action petals (Search, Capture) run on tap; others open their sub-menu.
                      if (p.sub.length === 1) return run(p.sub[0]!.cmd);
                      setActive(i);
                      setSubFor(i);
                      setSubActive(0);
                    }}
                    style={{ left: geometry.petals[i]!.x, top: geometry.petals[i]!.y, animationDelay: `${i * 18}ms` }}
                    className={cx(
                      "dock-petal absolute flex flex-col items-center justify-center gap-0.5 rounded-full border text-[11px] font-semibold shadow-lg",
                      phone ? "-mt-[31px] -ml-[31px] h-[62px] w-[62px]" : "-mt-[34px] -ml-[34px] h-[68px] w-[68px]",
                      active === i ? "border-transparent bg-accent text-accent-contrast" : "border-line bg-surface text-text",
                      subFor >= 0 && subFor !== i && "opacity-40",
                    )}
                  >
                    <span aria-hidden="true" className="text-lg leading-none">
                      {p.icon}
                    </span>
                    {p.label}
                  </button>
                ))}
                {subFor >= 0
                  ? petals[subFor]!.sub.map((s, k) => (
                      <button
                        key={`${s.cmd.id}-${k}`}
                        type="button"
                        role="menuitem"
                        data-sub={s.cmd.id}
                        data-sub-index={k}
                        tabIndex={-1}
                        onClick={() => run(s.cmd)}
                        style={{ left: subs[k]!.x, top: subs[k]!.y, animationDelay: `${k * 22}ms` }}
                        className={cx(
                          "dock-petal absolute -mt-[20px] flex h-10 min-w-[120px] -translate-x-1/2 items-center justify-center rounded-full border px-3 text-[13px] font-semibold whitespace-nowrap shadow-lg",
                          subActive === k ? "border-transparent bg-accent text-accent-contrast" : "border-line bg-surface text-text",
                        )}
                      >
                        {s.label}
                      </button>
                    ))
                  : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
