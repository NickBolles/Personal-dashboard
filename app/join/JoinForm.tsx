"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { ROLE_LABELS, type Role } from "@/lib/modules";
import { Button, Field, inputCls } from "@/components/ui";

type Who = { name: string; username: string; role: Role };

/** Accept an invite from Settings → People: choose a passcode, then you're in. */
export function JoinForm({ initialCode }: { initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [who, setWho] = useState<Who>();
  const [passcode, setPasscode] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const check = async (c: string) => {
    setError(undefined);
    try {
      setWho(await api.get<Who>(`/api/auth/join?code=${encodeURIComponent(c)}`));
    } catch (err) {
      setWho(undefined);
      setError((err as Error).message);
    }
  };
  useEffect(() => {
    if (initialCode) void check(initialCode);
  }, [initialCode]);

  const min = who?.role === "household" ? 4 : 6;
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-4">
      <form
        className="card w-full max-w-sm space-y-4 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!who) return check(code);
          if (passcode !== confirm) return setError("The two passcodes don't match.");
          setBusy(true);
          setError(undefined);
          try {
            const r = await api.post<{ username?: string }>("/api/auth/join", { code, passcode });
            try {
              if (r.username) localStorage.setItem("jarvis.lastUsername", r.username);
            } catch {
              /* storage unavailable */
            }
            window.location.href = "/home";
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div>
          <p className="text-sm font-medium text-accent">Jarvis</p>
          <h1 className="text-2xl font-semibold">{who ? `Welcome, ${who.name}` : "Join your household"}</h1>
          {who ? (
            <p className="mt-1 text-sm text-muted">
              {ROLE_LABELS[who.role].label}. You’ll sign in as <strong>{who.username}</strong>.
            </p>
          ) : null}
        </div>
        {!who ? (
          <Field id="code" label="Invite code" error={error}>
            <input id="code" required autoFocus autoCapitalize="characters" className={inputCls} value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        ) : (
          <>
            <Field
              id="pass"
              label={who.role === "household" ? "Choose a PIN or passcode" : "Choose a passcode"}
              hint={`At least ${min} ${min === 4 ? "digits" : "characters"}.`}
            >
              <input
                id="pass"
                type="password"
                required
                autoFocus
                minLength={min}
                autoComplete="new-password"
                className={inputCls}
                value={passcode}
                onChange={(e) => setPasscode(e.target.value)}
              />
            </Field>
            <Field id="pass2" label="Type it again" error={error}>
              <input
                id="pass2"
                type="password"
                required
                minLength={min}
                autoComplete="new-password"
                className={inputCls}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>
          </>
        )}
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          {who ? "Join" : "Continue"}
        </Button>
      </form>
    </main>
  );
}
