"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/client/api";
import type { Person } from "@/lib/people";
import { defaultCapabilities, MODULES, ROLE_LABELS, ROLES, type Role } from "@/lib/modules";
import { relativeTime } from "@/lib/time";
import { Badge, Button, Card, Dialog, ErrorNote, Field, PageHeader, Spinner, inputCls, useToast } from "@/components/ui";

type Invite = { code: string; expiresAt: string };

function inviteLink(code: string) {
  return `${window.location.origin}/join?code=${encodeURIComponent(code)}`;
}

function InviteBox({ invite, name }: { invite: Invite; name: string }) {
  const { toast } = useToast();
  const link = inviteLink(invite.code);
  return (
    <div className="mt-3 space-y-2 rounded-xl border border-accent bg-accent-soft p-3 text-sm" role="status">
      <p>
        Send {name} this link. It works once and expires {relativeTime(invite.expiresAt)}. They choose their own passcode.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-surface px-2 py-1">{link}</code>
        <Button
          size="sm"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              toast("Invite link copied", "ok");
            } catch {
              toast("Copy failed. Select the link and copy it.", "danger");
            }
          }}
        >
          Copy link
        </Button>
      </div>
      <p className="text-muted">
        Code: <strong className="font-mono">{invite.code}</strong> (they can also open /join and type it)
      </p>
    </div>
  );
}

function AddPerson({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("adult");
  const [mode, setMode] = useState<"invite" | "pin">("invite");
  const [pin, setPin] = useState("");
  const [invite, setInvite] = useState<Invite>();
  const add = useMutation({
    mutationFn: () => api.post<{ invite?: Invite }>("/api/people", { name, username, role, ...(mode === "pin" ? { passcode: pin } : {}) }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["people"] });
      if (r.invite) setInvite(r.invite);
      else {
        toast(`${name} can sign in now`, "ok");
        onDone();
      }
    },
    onError: (e) => toast((e as Error).message, "danger"),
  });
  if (invite) {
    return (
      <Card>
        <h2 className="font-semibold">{name} added</h2>
        <InviteBox invite={invite} name={name} />
        <Button className="mt-3" onClick={onDone}>
          Done
        </Button>
      </Card>
    );
  }
  return (
    <Card>
      <h2 className="mb-3 font-semibold">Add someone</h2>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field id="np-name" label="Name">
          <input
            id="np-name"
            required
            className={inputCls}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!username || username === slug(name)) setUsername(slug(e.target.value));
            }}
          />
        </Field>
        <Field id="np-user" label="Sign-in name" hint="What they type to sign in. Lowercase letters and numbers.">
          <input
            id="np-user"
            required
            autoCapitalize="none"
            spellCheck={false}
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Role</legend>
          {ROLES.map((r) => (
            <label key={r} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent">
              <input type="radio" name="np-role" className="mt-1" checked={role === r} onChange={() => setRole(r)} />
              <span>
                <span className="block font-medium">{ROLE_LABELS[r].label}</span>
                <span className="text-sm text-muted">{ROLE_LABELS[r].description}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">How they sign in</legend>
          <label className="flex min-h-11 items-center gap-3">
            <input type="radio" name="np-mode" checked={mode === "invite"} onChange={() => setMode("invite")} />
            Send an invite link (they choose a passcode)
          </label>
          <label className="flex min-h-11 items-center gap-3">
            <input type="radio" name="np-mode" checked={mode === "pin"} onChange={() => setMode("pin")} />
            Set a {role === "household" ? "PIN" : "passcode"} now (e.g. on the kitchen tablet)
          </label>
        </fieldset>
        {mode === "pin" ? (
          <Field id="np-pin" label={role === "household" ? "PIN (4+ digits) or passcode" : "Passcode (6+ characters)"}>
            <input
              id="np-pin"
              type="password"
              autoComplete="new-password"
              inputMode={role === "household" ? "numeric" : undefined}
              required
              minLength={role === "household" ? 4 : 6}
              className={inputCls}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </Field>
        ) : null}
        <div className="flex gap-2">
          <Button type="submit" variant="primary" busy={add.isPending}>
            Add {name || "person"}
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function slug(v: string) {
  return v
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32);
}

function Capabilities({ person, onSave, busy }: { person: Person; onSave: (caps: Record<string, boolean>) => void; busy: boolean }) {
  const [caps, setCaps] = useState(() => new Set(person.capabilities));
  const admin = person.role === "admin";
  const defaults = new Set(defaultCapabilities(person.role));
  const changed = MODULES.flatMap((m) => m.capabilities).some((c) => caps.has(c.id) !== person.capabilities.includes(c.id));
  return (
    <div className="space-y-3">
      {admin ? <p className="text-sm text-muted">Admins can use everything.</p> : null}
      {MODULES.map((m) => (
        <fieldset key={m.id} className="rounded-xl border border-line p-3">
          <legend className="px-1 text-sm font-semibold">{m.label}</legend>
          <ul className="space-y-1">
            {m.capabilities.map((c) => (
              <li key={c.id}>
                <label className="flex min-h-11 items-center gap-3">
                  <input
                    type="checkbox"
                    disabled={admin}
                    checked={caps.has(c.id)}
                    onChange={(e) => {
                      const next = new Set(caps);
                      if (e.target.checked) next.add(c.id);
                      else next.delete(c.id);
                      setCaps(next);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block">{c.label}</span>
                    {c.description ? <span className="block text-xs text-muted">{c.description}</span> : null}
                  </span>
                  {!admin && caps.has(c.id) !== defaults.has(c.id) ? (
                    <Badge tone="accent" className="ml-auto shrink-0">
                      Changed from {ROLE_LABELS[person.role].label.toLowerCase()} default
                    </Badge>
                  ) : null}
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
      {!admin ? (
        <div className="flex gap-2">
          <Button
            variant="primary"
            disabled={!changed}
            busy={busy}
            onClick={() => onSave(Object.fromEntries(MODULES.flatMap((m) => m.capabilities).map((c) => [c.id, caps.has(c.id)])))}
          >
            Save access
          </Button>
          <Button variant="ghost" onClick={() => setCaps(defaults)}>
            Reset to {ROLE_LABELS[person.role].label.toLowerCase()} defaults
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function PersonCard({ person, me }: { person: Person; me?: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<Invite>();
  const [pinOpen, setPinOpen] = useState(false);
  const [pin, setPin] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const done = (msg: string) => {
    toast(msg, "ok");
    qc.invalidateQueries({ queryKey: ["people"] });
  };
  const fail = (e: unknown) => toast((e as Error).message, "danger");
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/people/${person.id}`, body), onError: fail });
  const newInvite = useMutation({
    mutationFn: () => api.post<{ invite: Invite }>(`/api/people/${person.id}/invite`),
    onSuccess: (r) => {
      setInvite(r.invite);
      qc.invalidateQueries({ queryKey: ["people"] });
    },
    onError: fail,
  });
  const remove = useMutation({ mutationFn: () => api.del(`/api/people/${person.id}`), onSuccess: () => done(`${person.name} removed`), onError: fail });
  const status = person.disabled ? (
    <Badge tone="danger">Disabled</Badge>
  ) : person.inviteExpiresAt ? (
    <Badge tone="warn">Invite pending</Badge>
  ) : !person.hasPasscode ? (
    <Badge tone="warn">Can’t sign in yet</Badge>
  ) : null;
  return (
    <li id={person.id} className="card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">
            {person.name}
            {person.id === me ? <span className="font-normal text-muted"> (you)</span> : null}
          </h2>
          <p className="text-sm text-muted">
            {ROLE_LABELS[person.role].label}
            {person.username ? ` · signs in as ${person.username}` : ""}
            {person.phones ? ` · ${person.phones} phone${person.phones === 1 ? "" : "s"}` : ""}
          </p>
        </div>
        {status}
        <Button size="sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Close" : "Edit"}
        </Button>
      </div>
      {invite ? <InviteBox invite={invite} name={person.name} /> : null}
      {open ? (
        <div className="mt-4 space-y-4">
          <Field id={`role-${person.id}`} label="Role" hint="Changing the role resets their access to that role's defaults.">
            <select
              id={`role-${person.id}`}
              className={inputCls}
              value={person.role}
              onChange={(e) => patch.mutate({ role: e.target.value }, { onSuccess: () => done("Role changed") })}
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r].label}
                </option>
              ))}
            </select>
          </Field>
          <Capabilities
            key={person.role + person.capabilities.join()}
            person={person}
            busy={patch.isPending}
            onSave={(capabilities) => patch.mutate({ capabilities }, { onSuccess: () => done("Access saved") })}
          />
          <div className="flex flex-wrap gap-2 border-t border-line pt-4">
            <Button size="sm" busy={newInvite.isPending} onClick={() => newInvite.mutate()}>
              {person.hasPasscode ? "New invite link" : "Invite link"}
            </Button>
            <Button size="sm" onClick={() => setPinOpen(true)}>
              Set {person.role === "household" ? "PIN" : "passcode"}
            </Button>
            {person.id !== me ? (
              <Button
                size="sm"
                onClick={() => patch.mutate({ disabled: !person.disabled }, { onSuccess: () => done(person.disabled ? "Enabled" : "Disabled and signed out") })}
              >
                {person.disabled ? "Enable" : "Disable"}
              </Button>
            ) : null}
            {!person.owner && person.id !== me ? (
              <Button size="sm" variant="danger" onClick={() => setConfirmRemove(true)}>
                Remove
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      <Dialog
        open={pinOpen}
        onClose={() => setPinOpen(false)}
        title={`New ${person.role === "household" ? "PIN" : "passcode"} for ${person.name}`}
        description="They'll be signed out everywhere, including phones' web sessions."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPinOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pin.length < (person.role === "household" ? 4 : 6)}
              busy={patch.isPending}
              onClick={() =>
                patch.mutate(
                  { passcode: pin },
                  {
                    onSuccess: () => {
                      setPin("");
                      setPinOpen(false);
                      done("Passcode set");
                    },
                  },
                )
              }
            >
              Save
            </Button>
          </>
        }
      >
        <Field id={`pin-${person.id}`} label={person.role === "household" ? "PIN (4+ digits) or passcode" : "Passcode (6+ characters)"}>
          <input
            id={`pin-${person.id}`}
            data-autofocus
            type="password"
            autoComplete="new-password"
            className={inputCls}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </Field>
      </Dialog>
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${person.name}?`}
        description="Their sign-in, phones, pins and alerts are deleted. Their Hermes conversations stay in Hermes."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
            <Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate()}>
              Remove
            </Button>
          </>
        }
      />
    </li>
  );
}

/** Settings → People: who can sign in and what each person can use. */
export function PeopleView() {
  const people = useQuery({ queryKey: ["people"], queryFn: () => api.get<{ people: Person[] }>("/api/people") });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ user: { id: string } }>("/api/auth/me") });
  const [adding, setAdding] = useState(false);
  return (
    <div className="mx-auto max-w-3xl space-y-4 px-4 py-5 sm:px-6">
      <PageHeader
        title="People"
        subtitle="Everyone has their own conversations, alerts and Home layout. Household things are shared by what you allow here."
        actions={
          !adding ? (
            <Button variant="primary" onClick={() => setAdding(true)}>
              Add someone
            </Button>
          ) : null
        }
      />
      {adding ? <AddPerson onDone={() => setAdding(false)} /> : null}
      {people.isPending ? <Spinner label="Loading people" /> : null}
      {people.error ? <ErrorNote error={people.error} retry={() => people.refetch()} /> : null}
      <ul className="space-y-3">
        {people.data?.people.map((p) => (
          <PersonCard key={p.id} person={p} me={me.data?.user.id} />
        ))}
      </ul>
    </div>
  );
}
