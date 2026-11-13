/**
 * The one composer: what its next message is about. Steer, Reply, Retry and "ask about this" do not get a text
 * box of their own; they put a reference chip in the Chief of staff composer, and the owner types and sends there.
 * Pure and client-safe; the lines produced are the same one-line commands the coordinator brief already knows
 * (lib/coordinator/control.ts, server/work/chat-context.ts).
 */
import { steerText } from "./control";

export type ComposeScope = {
  /** steer: direct work in flight. reply: answer work that waits or failed. retry: run it again. ask: a question about it. */
  kind: "steer" | "reply" | "retry" | "ask";
  /** D-n or R-n, when the thing has one. */
  ref?: string;
  title: string;
  /** A sub-agent's own handle: steering goes to it, not to the run that tracks it. */
  handle?: string;
  /** For retry: a failed run is retried, an interrupted or waiting one resumed. */
  verb?: "Retry" | "Resume";
};

const oneLine = (text: string, max = 2000) => text.trim().replace(/\s+/g, " ").slice(0, max);

/** The chip in the composer. */
export function scopeChip(scope: ComposeScope): string {
  if (scope.kind === "retry") return `${scope.verb ?? "Retry"} ${scope.ref ?? ""}`.trim();
  return scope.ref ?? (scope.title.length > 24 ? `${scope.title.slice(0, 23)}…` : scope.title);
}

/** What the composer asks for while the chip is in it. */
export function scopePlaceholder(scope: ComposeScope): string {
  const what = scope.ref ?? "this work";
  if (scope.kind === "steer") return `Steer ${what}…`;
  if (scope.kind === "reply") return `Reply to ${what}…`;
  if (scope.kind === "retry") return "Add a note, or just send";
  return scope.ref?.startsWith("D-") ? `Answer ${scope.ref} in your own words…` : `Ask about ${what}…`;
}

/** Retry can be sent as it is; everything else needs the owner's words. */
export const scopeSendsEmpty = (scope: ComposeScope) => scope.kind === "retry";

/** Commands go to the coordinator as a one-line instruction; a question is an ordinary message. */
export const scopeIsCommand = (scope: ComposeScope) => scope.kind !== "ask";

/** The message that is sent for this chip and what was typed. */
export function scopeMessage(scope: ComposeScope, text: string): string {
  const said = oneLine(text);
  const title = scope.title.replace(/\s+/g, " ").trim();
  if (scope.kind === "retry") return `${scope.verb ?? "Retry"} ${scope.ref} (${title}).${said ? ` ${said}` : ""}`;
  if (scope.kind === "ask") return scope.ref ? `About ${scope.ref} (${title.slice(0, 160)}): ${said}` : `About "${title}": ${said}`;
  if (scope.handle) return steerText(scope.handle, said);
  return scope.ref ? `Steer ${scope.ref} (${title.slice(0, 120)}): ${said}` : `About "${title}": ${said}`;
}

/** For screen readers: what the chip means. */
export function scopeLabel(scope: ComposeScope): string {
  const what = scope.ref ? `${scope.ref}: ${scope.title}` : scope.title;
  if (scope.kind === "steer") return `Steering ${what}`;
  if (scope.kind === "reply") return `Replying to ${what}`;
  if (scope.kind === "retry") return `${scope.verb ?? "Retry"} ${what}`;
  return `About ${what}`;
}
