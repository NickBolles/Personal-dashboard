import "server-only";
import { z } from "zod";
import { upstream } from "@/server/http/fetch";
import { UpstreamError } from "@/server/http/errors";
import { resolveIntegration } from "@/integrations/store";

export const haStateSchema = z
  .object({
    entity_id: z.string(),
    state: z.string(),
    attributes: z.record(z.string(), z.unknown()).default({}),
    last_changed: z.string().optional(),
    last_updated: z.string().optional(),
  })
  .passthrough();
export type HaState = z.infer<typeof haStateSchema>;

export const haTodoItemSchema = z
  .object({
    uid: z.string(),
    summary: z.string(),
    status: z.enum(["needs_action", "completed"]),
    due: z.string().optional(),
    description: z.string().optional(),
    completed: z.string().optional(),
  })
  .passthrough();

export const haCalendarEventSchema = z
  .object({
    start: z.object({ dateTime: z.string().optional(), date: z.string().optional() }),
    end: z.object({ dateTime: z.string().optional(), date: z.string().optional() }).optional(),
    summary: z.string().nullish(),
    location: z.string().nullish(),
    uid: z.string().nullish(),
    recurrence_id: z.string().nullish(),
  })
  .passthrough();

export const haConfigEntrySchema = z
  .object({
    entry_id: z.string(),
    domain: z.string(),
    state: z.string(),
    disabled_by: z.string().nullish(),
  })
  .passthrough();

export type HaConn = { baseUrl: string; token?: string };

export function haConn(): HaConn {
  const r = resolveIntegration("home_assistant");
  if (!r.config.baseUrl) throw new UpstreamError("Home Assistant", "unsupported", "Home Assistant is not configured");
  return { baseUrl: r.config.baseUrl, token: r.secrets.token };
}

function req<T>(c: HaConn, path: string, init: { method?: string; body?: unknown; query?: Record<string, string | boolean> } = {}) {
  return upstream<T>({
    source: "Home Assistant",
    baseUrl: c.baseUrl,
    path,
    method: init.method,
    body: init.body,
    query: init.query as Record<string, string>,
    headers: c.token ? { authorization: `Bearer ${c.token}` } : {},
    timeoutMs: 6000,
  });
}

export const HomeAssistantClient = {
  ping: (c: HaConn) => req<{ message: string }>(c, "/api/"),
  config: (c: HaConn) => req<{ version?: string; location_name?: string; time_zone?: string }>(c, "/api/config"),
  states: async (c: HaConn) => z.array(haStateSchema).parse(await req(c, "/api/states")),
  state: async (c: HaConn, entityId: string) => haStateSchema.parse(await req(c, `/api/states/${encodeURIComponent(entityId)}`)),
  callService: (c: HaConn, domain: string, service: string, body: Record<string, unknown>) =>
    req<unknown[]>(c, `/api/services/${domain}/${service}`, { method: "POST", body }),
  todoItems: async (c: HaConn, entityId: string, statuses?: ("needs_action" | "completed")[]) => {
    // return_response is a bare flag; upstream() stringifies it to "true", which HA accepts.
    const res = await req<{ service_response: Record<string, { items: unknown[] }> }>(c, "/api/services/todo/get_items", {
      method: "POST",
      body: { entity_id: entityId, ...(statuses ? { status: statuses } : {}) },
      query: { return_response: "true" },
    });
    return z.array(haTodoItemSchema).parse(res.service_response?.[entityId]?.items ?? []);
  },
  /** Admin-only REST view. Resolves undefined when this token can't read it (non-admin, older HA). */
  configEntries: async (c: HaConn) => {
    try {
      return z.array(haConfigEntrySchema).parse(await req(c, "/api/config/config_entries/entry"));
    } catch (err) {
      if (err instanceof UpstreamError && (err.kind === "unauthorized" || err.kind === "not_found" || err.status === 403)) return undefined;
      throw err;
    }
  },
  calendarEvents: async (c: HaConn, entityId: string, start: string, end: string) =>
    z.array(haCalendarEventSchema).parse(await req(c, `/api/calendars/${encodeURIComponent(entityId)}`, { query: { start, end } })),
};
