/**
 * Client-safe integration definitions: drives the onboarding wizard and the
 * Settings → Connections forms. No secrets or server imports here.
 */
import type { ActionSource } from "@/lib/contracts";

export type IntegrationKind = ActionSource;

export type FieldType = "url" | "text" | "secret" | "select" | "textarea" | "time" | "number" | "boolean";

export type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  default?: string | number | boolean;
  options?: { value: string; label: string }[];
  /** environment variable that overrides this field (field becomes read-only in UI) */
  env?: string;
  /** only show when another field has one of these values */
  showWhen?: { field: string; oneOf: string[] };
  advanced?: boolean;
};

export type IntegrationDef = {
  kind: IntegrationKind;
  label: string;
  tagline: string;
  /** what Jarvis does with it, shown during onboarding */
  uses: string[];
  /** onboarding treats required integrations as strongly recommended */
  recommended: boolean;
  /** false: set up from Settings → Connections only, not the onboarding wizard */
  onboarding?: boolean;
  fields: FieldDef[];
  docs?: string;
};

export const HA_DEFAULT_WATCH = [
  "alarm_control_panel.wausau_alarm",
  "lock.front_door_lock",
  "cover.garage_door",
  "cover.garage_door_2",
  "binary_sensor.front_door_sensor",
  "binary_sensor.back_door",
].join("\n");

/**
 * Safe direction only (lock, close). Unlocking or opening from a phone is an
 * explicit opt-in: add ", unlock" / ", open_cover" yourself if you want it.
 */
export const HA_DEFAULT_CONTROLS = ["lock.front_door_lock: lock", "cover.garage_door: close_cover", "cover.garage_door_2: close_cover"].join("\n");

/** Default structured requests Jarvis sends Hermes (Jarvis appends the JSON answer contract). */
export const SKYLIGHT_DEFAULT_PROMPT =
  "Read the Skylight family calendar from {from} through {to} (timezone {timezone}) and today's Skylight chores. Read only: do not create, change or complete anything.";
export const COMPASS_STATUS_PROMPT = "Read my Daily Compass check-in state for {date} (timezone {timezone}). Read only: do not change anything.";
export const COMPASS_COMPLETE_PROMPT =
  "Mark my Daily Compass check-in for {date} (timezone {timezone}) as complete, then read the state back and report what it says now.";

export const INTEGRATIONS: IntegrationDef[] = [
  {
    kind: "hermes",
    label: "Hermes",
    tagline: "Your agent. Conversations, runs, approvals and forks.",
    uses: [
      "Chat and quick capture",
      "Live run progress, tool activity and approvals",
      "Fork conversations and track lineage",
      "Alerts when Hermes needs you or finishes",
    ],
    recommended: true,
    docs: "https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server",
    fields: [
      {
        key: "baseUrl",
        label: "API server URL",
        type: "url",
        required: true,
        placeholder: "http://hermes:8642",
        help: "Hermes API Server, reachable from the Jarvis container. Keep it on the internal Docker network.",
        env: "HERMES_BASE_URL",
      },
      {
        key: "apiKey",
        label: "API key",
        type: "secret",
        help: "API_SERVER_KEY from the Hermes environment. Stays on the server; never sent to the browser.",
        env: "HERMES_API_KEY",
      },
      {
        key: "dashboardUrl",
        label: "Operator dashboard URL",
        type: "url",
        placeholder: "https://hermes.example.com",
        help: "Used for deep links to settings Jarvis does not manage.",
        env: "HERMES_DASHBOARD_URL",
      },
      {
        key: "sessionSource",
        label: "Session source label",
        type: "text",
        default: "jarvis",
        advanced: true,
        help: "Recorded on sessions created from Jarvis.",
      },
    ],
  },
  {
    kind: "todos",
    label: "Todos",
    tagline: "One canonical todo list: Google Tasks, a Home Assistant list, or Jarvis itself.",
    uses: ["Overdue and due-soon actions on Home", "Complete and snooze from Jarvis"],
    recommended: true,
    fields: [
      {
        key: "provider",
        label: "Provider",
        type: "select",
        required: true,
        default: "google_tasks",
        options: [
          { value: "google_tasks", label: "Google Tasks" },
          { value: "home_assistant", label: "Home Assistant to-do list" },
          { value: "jarvis", label: "Built into Jarvis" },
        ],
      },
      {
        key: "clientId",
        label: "Google OAuth client ID",
        type: "text",
        showWhen: { field: "provider", oneOf: ["google_tasks"] },
        env: "GOOGLE_CLIENT_ID",
        help: "Create a Web OAuth client in Google Cloud with redirect URI <your Jarvis URL>/api/integrations/todos/oauth/callback.",
      },
      {
        key: "clientSecret",
        label: "Google OAuth client secret",
        type: "secret",
        showWhen: { field: "provider", oneOf: ["google_tasks"] },
        env: "GOOGLE_CLIENT_SECRET",
      },
      {
        key: "refreshToken",
        label: "Refresh token",
        type: "secret",
        showWhen: { field: "provider", oneOf: ["google_tasks"] },
        help: "Filled in automatically by “Connect Google”, or paste one from the OAuth Playground.",
      },
      {
        key: "taskListId",
        label: "Task list ID",
        type: "text",
        default: "@default",
        showWhen: { field: "provider", oneOf: ["google_tasks"] },
        help: "@default is your primary list. “Test connection” lists the others.",
      },
      {
        key: "haEntityId",
        label: "To-do entity",
        type: "text",
        placeholder: "todo.shopping_list",
        showWhen: { field: "provider", oneOf: ["home_assistant"] },
        help: "Uses the Home Assistant connection below.",
      },
      {
        key: "apiBase",
        label: "Google Tasks API base",
        type: "url",
        default: "https://tasks.googleapis.com",
        showWhen: { field: "provider", oneOf: ["google_tasks"] },
        advanced: true,
      },
      {
        key: "tokenUrl",
        label: "Google token URL",
        type: "url",
        default: "https://oauth2.googleapis.com/token",
        showWhen: { field: "provider", oneOf: ["google_tasks"] },
        advanced: true,
      },
      {
        key: "authUrl",
        label: "Google authorization URL",
        type: "url",
        default: "https://accounts.google.com/o/oauth2/v2/auth",
        showWhen: { field: "provider", oneOf: ["google_tasks"] },
        advanced: true,
      },
    ],
  },
  {
    kind: "daily_compass",
    label: "Daily Compass",
    tagline: "Your daily check-in: today’s state, a reminder, and a one-tap start.",
    uses: ["Check-in action during your window", "Reminder notification", "Household glance status"],
    recommended: true,
    fields: [
      {
        key: "mode",
        label: "Where check-ins live",
        type: "select",
        default: "hermes",
        options: [
          { value: "hermes", label: "Hermes owns Daily Compass (Jarvis asks Hermes for today's state)" },
          { value: "jarvis", label: "Stored in Jarvis (check-in is a Hermes conversation)" },
          { value: "http", label: "External HTTP endpoint" },
        ],
      },
      { key: "windowStart", label: "Window opens", type: "time", default: "19:00" },
      { key: "windowEnd", label: "Window closes", type: "time", default: "22:00" },
      { key: "reminderTime", label: "Reminder", type: "time", default: "20:00" },
      {
        key: "prompt",
        label: "Hermes check-in prompt",
        type: "textarea",
        default: "Let's do my Daily Compass check-in. Ask me how today went, what mattered, and what tomorrow's one thing is.",
        showWhen: { field: "mode", oneOf: ["jarvis", "hermes"] },
      },
      {
        key: "syncMinutes",
        label: "Sync every (minutes)",
        type: "number",
        default: 15,
        showWhen: { field: "mode", oneOf: ["hermes"] },
        help: "How often Jarvis asks Hermes for today's check-in state.",
      },
      {
        key: "statusPrompt",
        label: "Status request sent to Hermes",
        type: "textarea",
        default: COMPASS_STATUS_PROMPT,
        advanced: true,
        showWhen: { field: "mode", oneOf: ["hermes"] },
        help: "Placeholders: {date}, {timezone}. Must be read-only; Jarvis appends a JSON answer contract.",
      },
      {
        key: "completePrompt",
        label: "Mark-complete request sent to Hermes",
        type: "textarea",
        default: COMPASS_COMPLETE_PROMPT,
        advanced: true,
        showWhen: { field: "mode", oneOf: ["hermes"] },
        help: "Placeholders: {date}, {timezone}. Hermes must read the state back; Jarvis only reports done when the answer says completed.",
      },
      {
        key: "url",
        label: "Endpoint base URL",
        type: "url",
        showWhen: { field: "mode", oneOf: ["http"] },
        help: "GET {url}/today → {date, completed, url?}; POST {url}/today/complete.",
      },
      { key: "token", label: "Bearer token", type: "secret", showWhen: { field: "mode", oneOf: ["http"] } },
    ],
  },
  {
    kind: "home_assistant",
    label: "Home Assistant",
    tagline: "Exceptional home state, calendars, and a small allowlisted control set.",
    uses: ["Critical alerts (alarm, doors, garage)", "Household glance and calendar", "Confirmed lock/garage controls"],
    recommended: true,
    docs: "https://developers.home-assistant.io/docs/api/rest/",
    fields: [
      {
        key: "baseUrl",
        label: "Home Assistant URL",
        type: "url",
        required: true,
        placeholder: "http://192.168.1.249:8123",
        env: "HA_BASE_URL",
      },
      {
        key: "token",
        label: "Long-lived access token",
        type: "secret",
        help: "Profile → Security → Long-lived access tokens.",
        env: "HA_TOKEN",
      },
      {
        key: "watchEntities",
        label: "Watched entities",
        type: "textarea",
        default: HA_DEFAULT_WATCH,
        help: "One entity per line. Only exceptional states (open, unlocked, triggered, unavailable) surface.",
      },
      {
        key: "controlAllowlist",
        label: "Allowed controls",
        type: "textarea",
        default: HA_DEFAULT_CONTROLS,
        help: "entity_id: service, service. Defaults are the safe direction only (lock, close_cover). Add unlock or open_cover only if you want them from your phone. Every control asks for confirmation against live state.",
      },
      {
        key: "lightControl",
        label: "Light switching",
        type: "select",
        default: "all",
        options: [
          { value: "all", label: "Any light (on/off, with readback)" },
          { value: "allowlist", label: "Only lights in the allowed controls" },
          { value: "none", label: "View only" },
        ],
        help: "Who can switch them is set per person in Settings → People.",
      },
      {
        key: "calendarEntities",
        label: "Calendars for the household glance",
        type: "textarea",
        default: "calendar.family_calendar",
        help: "Optional. One calendar entity per line.",
      },
    ],
  },
  {
    kind: "skylight",
    label: "Skylight",
    tagline: "Family calendar and chores from your Skylight frame (read-only).",
    uses: ["Next event in the household glance", "Today's chores as actions"],
    recommended: false,
    docs: "https://github.com/jwmoss/skycli",
    fields: [
      {
        key: "mode",
        label: "How Jarvis reads Skylight",
        type: "select",
        default: "hermes",
        options: [
          { value: "hermes", label: "Via Hermes (Hermes owns Skylight)" },
          { value: "direct", label: "Directly (unofficial API, refresh token)" },
        ],
        help: "Via Hermes: Jarvis sends Hermes a read-only structured request and caches the validated answer. Needs Hermes connected with its Skylight tools.",
      },
      {
        key: "syncMinutes",
        label: "Sync every (minutes)",
        type: "number",
        default: 30,
        showWhen: { field: "mode", oneOf: ["hermes"] },
        help: "Each sync is a short Hermes run. Data older than two intervals shows as stale.",
      },
      {
        key: "prompt",
        label: "Request sent to Hermes",
        type: "textarea",
        default: SKYLIGHT_DEFAULT_PROMPT,
        advanced: true,
        showWhen: { field: "mode", oneOf: ["hermes"] },
        help: "Placeholders: {from}, {to}, {timezone}. Jarvis appends a JSON answer contract; keep this read-only.",
      },
      {
        key: "refreshToken",
        label: "Refresh token",
        type: "secret",
        env: "SKYLIGHT_REFRESH_TOKEN",
        showWhen: { field: "mode", oneOf: ["direct"] },
        help: "Use “Sign in to Skylight” below, or paste one from `skycli auth login`. Skylight rotates it on every refresh; Jarvis stores the new one automatically.",
      },
      {
        key: "frameId",
        label: "Frame",
        type: "text",
        showWhen: { field: "mode", oneOf: ["direct"] },
        help: "Leave blank. “Test connection” lists your frames so you can pick one.",
      },
      {
        key: "deviceFingerprint",
        label: "Device fingerprint",
        type: "text",
        advanced: true,
        showWhen: { field: "mode", oneOf: ["direct"] },
        help: "Stable device UUID used with the refresh token. Generated at sign-in.",
      },
      { key: "apiVersion", label: "API version header", type: "text", default: "2026-06-01", advanced: true, showWhen: { field: "mode", oneOf: ["direct"] } },
      {
        key: "baseUrl",
        label: "API base",
        type: "url",
        default: "https://app.ourskylight.com",
        advanced: true,
        showWhen: { field: "mode", oneOf: ["direct"] },
      },
    ],
  },
  {
    kind: "paperclip",
    label: "Paperclip",
    tagline: "Durable initiatives and multi-step work, linked to conversations.",
    uses: ["Initiative cards with blockers and next child", "Track a conversation in Paperclip", "Related conversations"],
    recommended: false,
    fields: [
      {
        key: "baseUrl",
        label: "Paperclip URL",
        type: "url",
        required: true,
        placeholder: "http://paperclip:3100",
        env: "PAPERCLIP_BASE_URL",
      },
      { key: "apiKey", label: "API key", type: "secret", env: "PAPERCLIP_API_KEY" },
      {
        key: "companyId",
        label: "Company ID",
        type: "text",
        help: "Leave blank. “Test connection” lists companies.",
      },
      {
        key: "uiUrl",
        label: "Browser URL",
        type: "url",
        help: "Where you open Paperclip in a browser, for deep links. Defaults to the API URL.",
      },
      {
        key: "issuePrefix",
        label: "Issue prefix",
        type: "text",
        placeholder: "PAP",
        advanced: true,
        help: "Used in deep links (/<prefix>/issues/<identifier>). Detected automatically when possible.",
      },
    ],
  },
  {
    kind: "finance",
    label: "Finance",
    tagline: "Balances for the monthly check-in: Monarch, or manual entry and CSV.",
    uses: ["Monthly check-in: card payments, reserve, funds", "Finance items in your priorities", "Ready / needs attention notices (no amounts)"],
    recommended: false,
    onboarding: false,
    fields: [
      {
        key: "balanceSource",
        label: "Where balances come from",
        type: "select",
        default: "manual",
        options: [
          { value: "manual", label: "Manual entry and CSV import" },
          { value: "monarch", label: "Monarch (unofficial API; must be validated)" },
        ],
        help: "Manual and CSV always work. Monarch has no supported API: until a refresh works with your real account it's reported as a release blocker.",
      },
      {
        key: "monarchToken",
        label: "Monarch session token",
        type: "secret",
        env: "MONARCH_TOKEN",
        showWhen: { field: "balanceSource", oneOf: ["monarch"] },
        help: "From `monarch login` (or your browser session). Stored encrypted on the server; never sent to the browser or logged.",
      },
      {
        key: "monarchUrl",
        label: "Monarch API URL",
        type: "url",
        default: "https://api.monarchmoney.com",
        env: "MONARCH_API_URL",
        advanced: true,
        showWhen: { field: "balanceSource", oneOf: ["monarch"] },
      },
      {
        key: "refreshWaitSeconds",
        label: "Wait for Monarch's bank sync (seconds)",
        type: "number",
        default: 60,
        advanced: true,
        showWhen: { field: "balanceSource", oneOf: ["monarch"] },
        help: "After asking Monarch to sync, Jarvis waits this long for fresh balances before reading what's there (and saying so).",
      },
    ],
  },
];

/** The integrations the onboarding wizard walks through. */
export const ONBOARDING_INTEGRATIONS = INTEGRATIONS.filter((i) => i.onboarding !== false);

export function getIntegrationDef(kind: string) {
  return INTEGRATIONS.find((i) => i.kind === kind);
}

/** `values` should already include defaults (see withDefaults). */
export function isFieldVisible(field: FieldDef, values: Record<string, unknown>) {
  if (!field.showWhen) return true;
  return field.showWhen.oneOf.includes(String(values[field.showWhen.field] ?? ""));
}

export function withDefaults(def: IntegrationDef, values: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (f.type === "secret") continue;
    const v = values[f.key];
    out[f.key] = v === undefined || v === "" ? (f.default ?? "") : v;
  }
  return out;
}

export type TestCheck = { name: string; ok: boolean; detail?: string; ms?: number };
export type TestResult = {
  ok: boolean;
  checkedAt: string;
  summary: string;
  checks: TestCheck[];
  /** discovered choices, e.g. frames, companies, task lists */
  discovered?: { field: string; label: string; options: { value: string; label: string }[] }[];
};

export type PublicIntegration = {
  kind: IntegrationKind;
  enabled: boolean;
  config: Record<string, string | number | boolean>;
  secrets: Record<string, { set: boolean; fromEnv: boolean }>;
  envManaged: string[];
  lastTest?: TestResult;
};
