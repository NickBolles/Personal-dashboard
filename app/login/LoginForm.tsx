"use client";

import { useState } from "react";
import { api } from "@/lib/client/api";
import { Button, Field, inputCls } from "@/components/ui";

export function LoginForm({ next }: { next: string }) {
  const [passcode, setPasscode] = useState("");
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
            await api.post("/api/auth/login", { passcode });
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
        <Field id="passcode" label="Passcode" error={error}>
          <input
            id="passcode"
            type="password"
            autoComplete="current-password"
            required
            autoFocus
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
