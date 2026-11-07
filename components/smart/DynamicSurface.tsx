"use client";
import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Dialog } from "@/components/ui";
import type { DynamicCard } from "@/lib/jarvis-ui/dynamic";
import type { ControlView } from "@/integrations/home-assistant/controls";
import { SmartSurface } from "./SmartSurface";
import { TodayChores } from "@/components/skylight/TodayChores";

export function DynamicSurface({ card, onDismiss }: { card: DynamicCard; onDismiss: () => void }) {
  const [confirm, setConfirm] = useState<ControlView>();
  const [service, setService] = useState("close_cover");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [closed, setClosed] = useState(false);
  const prepare = async (next: string) => {
    setBusy(true);
    try {
      const data = await api.get<{ controls: ControlView[] }>("/api/home-assistant/controls");
      const control = data.controls.find((c) => c.entityId === card.garage?.entityId && c.services.some((s) => s.service === next));
      if (!control) throw new Error("That action is not allowlisted. Close from Home Assistant.");
      setService(next);
      setConfirm(control);
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
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
        {card.garage?.closeAllowed && !closed ? (
          <Button size="sm" variant="primary" busy={busy} onClick={() => void prepare("close_cover")}>
            Close garage…
          </Button>
        ) : null}
        {closed && card.garage?.undoAllowed ? (
          <Button size="sm" busy={busy} onClick={() => void prepare("open_cover")}>
            Undo · reopen…
          </Button>
        ) : null}
        {closed && !card.garage?.undoAllowed ? <span className="text-xs text-muted">Reopening is not allowlisted; no Undo is available.</span> : null}
      </footer>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
      {confirm ? (
        <Dialog
          open
          title={service === "close_cover" ? "Close the garage?" : "Reopen the garage?"}
          description={`${confirm.name} currently reports ${confirm.state}. This operates a physical door.`}
          onClose={() => setConfirm(undefined)}
          footer={
            <>
              <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
              <Button
                variant="primary"
                busy={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const result = await api.post<{ verified: boolean; message: string }>("/api/home-assistant/control", {
                      entityId: confirm.entityId,
                      service,
                      stateToken: confirm.stateToken,
                      confirmed: true,
                    });
                    setMessage(result.message);
                    if (result.verified) setClosed(service === "close_cover");
                    setConfirm(undefined);
                  } catch (e) {
                    setMessage((e as Error).message);
                    setConfirm(undefined);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Confirm {service === "close_cover" ? "close" : "reopen"}
              </Button>
            </>
          }
        />
      ) : null}
    </div>
  );
}
