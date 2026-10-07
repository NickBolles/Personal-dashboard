"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Field, inputCls } from "@/components/ui";

const LAST_NAME = "jarvis.lastUsername";

export function LoginForm({ next, askName }: { next: string; askName: boolean }) {
  const [username, setUsername] = useState("");
  const [passcode, setPasscode] = useState("");
  useEffect(() => {
    try {
      setUsername(localStorage.getItem(LAST_NAME) ?? "");
    } catch {
      /* storage unavailable */
    }
  }, []);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-4">
      <form
        className="card w-full max-w-sm space-y-4 p-6"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await api.post("/api/auth/login", { passcode, ...(askName && username.trim() ? { username: username.trim() } : {}) });
            try {
              if (askName) localStorage.setItem(LAST_NAME, username.trim());
            } catch {
              /* storage unavailable */
            }
            window.location.href = next;
          } catch (err) {
            setError((err as Error).message);
            setBusy(false);
          }
        }}
      >
        <div>
          <p className="text-sm font-medium text-accent">Jarvis</p>
          <h1 className="text-2xl font-semibold">Welcome back</h1>
        </div>
        {askName && (
          <Field id="username" label="Your sign-in name" hint="Leave empty if you set up this Jarvis.">
            <input
              id="username"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              className={inputCls}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
        )}
        <Field id="passcode" label={askName ? "Passcode or PIN" : "Passcode"} error={error}>
          <input
            id="passcode"
            type="password"
            autoComplete="current-password"
            required
            autoFocus={!askName}
            className={inputCls}
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
          />
        </Field>
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
