"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import { Button, Dialog } from "@/components/ui";
import { Toast } from "@/components/ui/kit";
import type { HaRisk, ServiceData } from "@/lib/ha-policy";

/** What the server returns from POST /api/home-assistant/control. */
export type HaControlResult = {
  verified: boolean;
  state: string;
  message: string;
  stateToken?: string;
  undo?: { service: string; data?: ServiceData; label: string; risk: HaRisk } | null;
};

/** One device action the person is about to take. */
export type HaAction = {
  entityId: string;
  name: string;
  state: string;
  stateToken: string;
  service: string;
  label: string;
  risk: HaRisk;
  data?: ServiceData;
  /** shown in the confirm card: "checked 10:42" */
  observedAt?: string;
};

/**
 * Confirm card for one Home Assistant action. Standard actions: one confirm.
 * High-risk (locks, alarm, opening a garage): names the device and its current
 * state and needs an explicit tick before the primary button enables.
 */
export function HaConfirmDialog({
  action,
  busy,
  onConfirm,
  onClose,
}: {
  action: HaAction | undefined;
  busy?: boolean;
  onConfirm: (a: HaAction, highRiskConfirmed: boolean) => void;
  onClose: () => void;
}) {
  // Remount per action so the explicit tick never carries over to another device.
  return action ? <ConfirmInner key={`${action.entityId}:${action.service}`} action={action} busy={busy} onConfirm={onConfirm} onClose={onClose} /> : null;
}

function ConfirmInner({
  action,
  busy,
  onConfirm,
  onClose,
}: {
  action: HaAction;
  busy?: boolean;
  onConfirm: (a: HaAction, highRiskConfirmed: boolean) => void;
  onClose: () => void;
}) {
  const [ack, setAck] = useState(false);
  const high = action.risk === "high";
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${action.label} ${action.name}?`}
      description={
        <>
          {action.data && Object.keys(action.data).length ? (
            <span className="block" data-ha-change>
              Change to:{" "}
              <strong>
                {Object.entries(action.data)
                  .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`)
                  .join(", ")}
              </strong>
            </span>
          ) : null}
          Current state: <strong>{action.state}</strong>
          {action.observedAt ? ` (checked ${new Date(action.observedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })})` : ""}. If it changed
          since then, Jarvis will stop and ask again.
        </>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose} data-autofocus>
            Cancel
          </Button>
          <Button variant="primary" busy={busy} disabled={high && !ack} onClick={() => onConfirm(action, high && ack)}>
            Yes, {action.label.toLowerCase()}
          </Button>
        </>
      }
    >
      {high ? (
        <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm" data-high-risk>
          <p className="font-medium">High-risk: this operates {action.name}.</p>
          <label className="mt-2 flex min-h-11 items-start gap-2 sm:min-h-10">
            <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            <span>
              I mean it: {action.label.toLowerCase()} <strong>{action.name}</strong> (now {action.state}).
            </span>
          </label>
        </div>
      ) : null}
    </Dialog>
  );
}

/**
 * Runs Home Assistant actions with the House rules: low-risk taps run at once
 * (the tap is the confirmation), standard and high-risk ones open the confirm
 * card first. Every result offers Undo when the server returned an inverse.
 */
export function useHaControl(opts: { onDone?: (r: HaControlResult, a: HaAction) => void } = {}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<HaAction>();
  const [last, setLast] = useState<{ action: HaAction; result: HaControlResult }>();
  const exec = useMutation({
    mutationFn: (v: { action: HaAction; highRiskConfirmed: boolean }) =>
      api.post<HaControlResult>("/api/home-assistant/control", {
        entityId: v.action.entityId,
        service: v.action.service,
        stateToken: v.action.stateToken,
        confirmed: true,
        ...(v.action.data && Object.keys(v.action.data).length ? { data: v.action.data } : {}),
        ...(v.highRiskConfirmed ? { highRiskConfirmed: true } : {}),
      }),
    onSuccess: (result, v) => {
      setLast({ action: v.action, result });
      opts.onDone?.(result, v.action);
    },
    onError: (e, v) => setLast({ action: v.action, result: { verified: false, state: v.action.state, message: (e as Error).message, undo: null } }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["ha"] });
      qc.invalidateQueries({ queryKey: ["source", "home_assistant"] });
      qc.invalidateQueries({ queryKey: ["home"] });
    },
  });
  /** Tap on a control: run low-risk now, ask first otherwise. */
  const request = (a: HaAction) => {
    if (a.risk === "low") exec.mutate({ action: a, highRiskConfirmed: false });
    else setConfirm(a);
  };
  const undo = () => {
    const u = last?.result.undo;
    if (!last || !u || !last.result.stateToken) return;
    request({
      entityId: last.action.entityId,
      name: last.action.name,
      state: last.result.state,
      stateToken: last.result.stateToken,
      service: u.service,
      label: u.label,
      risk: u.risk,
      data: u.data,
    });
    setLast(undefined);
  };
  const dialog = (
    <HaConfirmDialog
      action={confirm}
      busy={exec.isPending}
      onClose={() => setConfirm(undefined)}
      onConfirm={(a, high) => {
        exec.mutate({ action: a, highRiskConfirmed: high });
        setConfirm(undefined);
      }}
    />
  );
  const toast = last ? (
    <div className="mt-2" data-ha-result>
      <Toast
        tone={last.result.verified ? "ok" : "bad"}
        message={`${last.action.name}: ${last.result.message}`}
        action={last.result.verified && last.result.undo ? { label: "Undo", onClick: undo } : undefined}
      />
    </div>
  ) : null;
  return {
    request,
    pending: exec.isPending ? exec.variables?.action : undefined,
    dialog,
    toast,
    last,
    dismiss: () => setLast(undefined),
  };
}
