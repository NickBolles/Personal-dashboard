"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button } from "@/components/ui";
import type { DynamicCard } from "@/lib/jarvis-ui/dynamic";
import type { ControlView } from "@/integrations/home-assistant/controls";
import { useHaControl } from "@/components/home/HaControls";
import { SmartSurface } from "./SmartSurface";
import { TodayChores } from "@/components/skylight/TodayChores";

export function DynamicSurface({ card, onDismiss }: { card: DynamicCard; onDismiss: () => void }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // The garage's state as last confirmed here (cards only appear while it's open).
  const [state, setState] = useState<"open" | "closed">("open");
  const ctl = useHaControl({
    onDone: (r) => {
      if (r.verified && (r.state === "closed" || r.state === "closing")) setState("closed");
      if (r.verified && (r.state === "open" || r.state === "opening")) setState("open");
    },
  });
  // Always read live state first: the confirm card shows what Home Assistant reports right now.
  const prepare = async (next: "close_cover" | "open_cover") => {
    setBusy(true);
    setMessage("");
    try {
      const data = await api.get<{ controls: ControlView[] }>("/api/home-assistant/controls");
      const control = data.controls.find((c) => c.entityId === card.garage?.entityId);
      const svc = control?.services.find((s) => s.service === next);
      if (!control || !svc) throw new Error("That action is not allowed. Use Home Assistant.");
      ctl.request({
        entityId: control.entityId,
        name: control.name,
        state: control.state,
        stateToken: control.stateToken,
        service: next,
        label: svc.label,
        // A garage door always gets the confirm card; opening it is high-risk.
        risk: svc.risk === "low" ? "standard" : svc.risk,
        observedAt: control.observedAt,
      });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const g = card.garage;
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 pb-3" data-testid="dynamic-card">
      {card.kind === "chores" ? (
        // Live, completable rows (same row, grouping and motion as Today); the server's table is the fallback.
        <TodayChores
          id="tray-chores"
          variant="card"
          fallback={<SmartSurface key={card.id} spec={card.spec} sessionId={card.sessionId} blockIndex={card.blockIndex} dropped={0} />}
        />
      ) : (
        <SmartSurface key={card.id} spec={card.spec} sessionId={card.sessionId} blockIndex={card.blockIndex} dropped={0} />
      )}
      <footer className="flex flex-wrap items-center gap-2 border-t border-line py-2">
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          Not now
        </Button>
        {card.footer ? (
          <a href={card.footer.href} className="tap min-w-0 text-sm text-accent underline">
            {card.footer.label}
          </a>
        ) : null}
        {g?.closeAllowed && state === "open" ? (
          <Button size="sm" variant="primary" busy={busy || ctl.pending?.service === "close_cover"} onClick={() => void prepare("close_cover")}>
            Close garage…
          </Button>
        ) : null}
        {(g?.openAllowed ?? g?.undoAllowed) && state === "closed" ? (
          <Button size="sm" busy={busy || ctl.pending?.service === "open_cover"} onClick={() => void prepare("open_cover")}>
            Open garage…
          </Button>
        ) : null}
        {state === "closed" && !(g?.openAllowed ?? g?.undoAllowed) ? (
          <span className="text-xs text-muted">Opening is not allowed here; no Undo is available.</span>
        ) : null}
      </footer>
      {ctl.toast}
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {ctl.dialog}
    </div>
  );
}
