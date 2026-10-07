"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { parseMoney } from "@/lib/finance/csv";
import type { AccountKind, Cents } from "@/lib/finance/types";
import { cx } from "@/components/ui";

/**
 * Money display. Amounts are read with sign words ("owed 1,500.00",
 * "credit 25.00"), never colour alone, and can be hidden per device for
 * screen privacy.
 */
const HIDE_KEY = "jarvis.finance.hideAmounts";
const HideContext = createContext<{ hidden: boolean; setHidden: (v: boolean) => void }>({ hidden: false, setHidden: () => {} });

export function HideAmountsProvider({ children }: { children: ReactNode }) {
  const [hidden, setHiddenState] = useState(false);
  useEffect(() => {
    try {
      setHiddenState(localStorage.getItem(HIDE_KEY) === "1");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setHidden = (v: boolean) => {
    setHiddenState(v);
    try {
      localStorage.setItem(HIDE_KEY, v ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  };
  return <HideContext.Provider value={{ hidden, setHidden }}>{children}</HideContext.Provider>;
}

export const useHideAmounts = () => useContext(HideContext);

export function HideAmountsToggle() {
  const { hidden, setHidden } = useHideAmounts();
  return (
    <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
      Hide amounts on this device
    </label>
  );
}

export function fmt(c: Cents) {
  return (Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const LIABILITY: AccountKind[] = ["credit_card", "other_liability"];

/** How a balance reads aloud and on screen: "owed 1,500.00" for a card, "credit 25.00" for a card in credit. */
export function balanceWords(c: Cents, kind?: AccountKind) {
  if (kind && LIABILITY.includes(kind)) return c < 0 ? `owed ${fmt(c)}` : c > 0 ? `credit ${fmt(c)}` : "0.00";
  return c < 0 ? `negative ${fmt(c)}` : fmt(c);
}

/** A balance or total. */
export function Money({ value, kind, className, strong }: { value: Cents | null | undefined; kind?: AccountKind; className?: string; strong?: boolean }) {
  const { hidden } = useHideAmounts();
  if (value === null || value === undefined) return <span className={cx("text-muted", className)}>unknown</span>;
  const words = balanceWords(value, kind);
  if (hidden)
    return (
      <span aria-label="amount hidden" className={cx("tabular-nums text-muted", className)}>
        •••••
      </span>
    );
  return <span className={cx("tabular-nums", strong && "font-semibold", value < 0 && "text-danger", className)}>{words}</span>;
}

/** A change: "+1,500.00" / "−1,500.00" (read as "plus" / "minus"). */
export function Delta({ value, className }: { value: Cents; className?: string }) {
  const { hidden } = useHideAmounts();
  if (value === 0)
    return (
      <span className={cx("text-muted", className)} aria-label="no change">
        —
      </span>
    );
  if (hidden)
    return (
      <span aria-label="amount hidden" className={cx("tabular-nums text-muted", className)}>
        •••••
      </span>
    );
  return (
    <span className={cx("tabular-nums", className)} aria-label={`${value > 0 ? "plus" : "minus"} ${fmt(value)}`}>
      {value > 0 ? "+" : "−"}
      {fmt(value)}
    </span>
  );
}

/** Text → cents, or undefined when it isn't an amount. */
export function toCents(v: string): Cents | undefined {
  try {
    return v.trim() ? parseMoney(v) : undefined;
  } catch {
    return undefined;
  }
}

export const centsToInput = (c: Cents | null | undefined) => (c === null || c === undefined ? "" : (c / 100).toFixed(2));
