import type { ActionSource, CalendarEvent, HomeException, NextAction, PrimaryActionKind } from "@/lib/contracts";
import type { TestResult } from "./registry";

export type AdapterContext = {
  now: Date;
  timezone: string;
  /** YYYY-MM-DD in the user's timezone */
  today: string;
  /** exclusive end of the user's local day */
  endOfToday: Date;
};

export type CompassState = {
  date: string;
  completed: boolean;
  completedAt?: string;
  inWindow: boolean;
  windowStart: string;
  windowEnd: string;
  sessionId?: string;
  url?: string;
};

export type SourceData = {
  actions: NextAction[];
  events?: CalendarEvent[];
  compass?: CompassState;
  homeExceptions?: HomeException[];
  /** extra, source-specific summary for its own page */
  extra?: Record<string, unknown>;
};

export type ActOptions = { until?: string; correlationId: string; actor: string };

export interface SourceAdapter {
  source: ActionSource;
  /** how long fetched data is considered fresh */
  staleAfterMs: number;
  fetch(ctx: AdapterContext): Promise<SourceData>;
  test(): Promise<TestResult>;
  /** perform a supported mutation; resolves only after upstream readback */
  act?(sourceId: string, kind: PrimaryActionKind, opts: ActOptions): Promise<{ ok: true; message: string }>;
}
