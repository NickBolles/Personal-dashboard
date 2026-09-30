import "server-only";
import path from "node:path";

/**
 * Process-level configuration. Everything here comes from the environment so
 * that Docker secrets / env files remain the source of truth for deployment.
 * Integration credentials entered in the UI live (encrypted) in SQLite instead.
 */
export type AuthMode = "local" | "proxy";

function bool(v: string | undefined, fallback = false) {
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

export const config = {
  get dataDir() {
    return path.resolve(process.env.JARVIS_DATA_DIR ?? "./data");
  },
  get databasePath() {
    return process.env.JARVIS_DB_PATH ?? path.join(this.dataDir, "jarvis.db");
  },
  /** 32-byte key, base64. Falls back to a generated key file in the data dir. */
  get secretKey() {
    return process.env.JARVIS_SECRET_KEY;
  },
  get authMode(): AuthMode {
    return process.env.JARVIS_AUTH_MODE === "proxy" ? "proxy" : "local";
  },
  /** Header set by the authenticating reverse proxy (Authelia/Authentik/oauth2-proxy). */
  get authProxyHeader() {
    return (process.env.JARVIS_AUTH_PROXY_HEADER ?? "remote-user").toLowerCase();
  },
  /** Optional allowlist of usernames accepted from the proxy header. */
  get authProxyUsers() {
    return (process.env.JARVIS_AUTH_PROXY_USERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  },
  /** One-time code required to claim the instance during onboarding. */
  get setupCode() {
    return process.env.JARVIS_SETUP_CODE;
  },
  /** Public origin, e.g. https://jarvis.example.com. Used for CSRF + push deep links. */
  get publicOrigin() {
    return process.env.JARVIS_PUBLIC_ORIGIN?.replace(/\/$/, "");
  },
  get secureCookies() {
    return bool(process.env.JARVIS_SECURE_COOKIES, process.env.NODE_ENV === "production");
  },
  get sessionDays() {
    return Number(process.env.JARVIS_SESSION_DAYS ?? 30);
  },
  get workerEnabled() {
    return !bool(process.env.JARVIS_DISABLE_WORKER);
  },
  get workerIntervalMs() {
    return Number(process.env.JARVIS_WORKER_INTERVAL_MS ?? 60_000);
  },
  get vapidSubject() {
    return process.env.JARVIS_VAPID_SUBJECT ?? "mailto:admin@localhost";
  },
  get assetLinks() {
    // Optional Trusted Web Activity support: "com.example.app:AA:BB:..." pairs
    return process.env.JARVIS_TWA_ASSETLINKS;
  },
  get timezone() {
    return process.env.TZ || "America/Chicago";
  },
  /** Upper bound for concurrent Hermes SSE relays (kept below Hermes' own limit). */
  get maxStreams() {
    return Number(process.env.JARVIS_MAX_STREAMS ?? 8);
  },
  get maxBodyBytes() {
    return Number(process.env.JARVIS_MAX_BODY_BYTES ?? 256 * 1024);
  },
};
