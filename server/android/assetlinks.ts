/**
 * Digital Asset Links for the Jarvis Android app (a Trusted Web Activity).
 * Chrome fetches /.well-known/assetlinks.json to confirm the app may open this
 * site full screen; a mismatch shows a URL bar in the app. The certificate
 * fingerprint is public data (it's in every APK), not a secret.
 */

/** SHA-256 of the persistent CI signing certificate (published APKs since 1.0.45). */
export const DEFAULT_ANDROID_CERT_SHA256 = "8D:60:31:EB:78:47:EF:2E:70:02:99:2D:D2:71:02:22:97:8A:8B:A2:39:4C:5E:E2:EB:CB:F9:4A:0B:3E:0B:B1";
export const DEFAULT_ANDROID_PACKAGE = "com.nickbolles.jarvis";

/** "8d6031eb…" or "8D:60:31:…" → "8D:60:31:…"; null if it isn't 32 hex bytes. */
export function normalizeFingerprint(raw: string): string | null {
  const hex = raw.trim().replace(/[:\s]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/.{2}/g)!.join(":");
}

export type AssetStatement = {
  relation: string[];
  target: { namespace: "android_app"; package_name: string; sha256_cert_fingerprints: string[] };
};

const PACKAGE_RE = /^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/;

/**
 * JARVIS_ANDROID_CERT_SHA256: comma list of fingerprints for the Jarvis app (default: the CI key;
 * "none" drops it). JARVIS_ANDROID_PACKAGE: its package (default com.nickbolles.jarvis).
 * JARVIS_TWA_ASSETLINKS (older, still honoured): "pkg=AA:BB:…,CC:…;other.pkg=…" adds more apps.
 * Invalid fingerprints/packages are skipped, so a typo can't serve a malformed statement.
 */
export function assetLinks(env: Record<string, string | undefined> = process.env): AssetStatement[] {
  const byPackage = new Map<string, Set<string>>();
  const add = (pkg: string, certs: string[]) => {
    const name = pkg.trim();
    if (!PACKAGE_RE.test(name)) return;
    const valid = certs.map(normalizeFingerprint).filter((c): c is string => Boolean(c));
    if (!valid.length) return;
    const set = byPackage.get(name) ?? new Set<string>();
    valid.forEach((c) => set.add(c));
    byPackage.set(name, set);
  };
  const rawCerts = env.JARVIS_ANDROID_CERT_SHA256?.trim();
  if (rawCerts?.toLowerCase() !== "none") {
    add(env.JARVIS_ANDROID_PACKAGE?.trim() || DEFAULT_ANDROID_PACKAGE, rawCerts ? rawCerts.split(",") : [DEFAULT_ANDROID_CERT_SHA256]);
  }
  for (const entry of (env.JARVIS_TWA_ASSETLINKS ?? "").split(";")) {
    const eq = entry.indexOf("=");
    if (eq > 0) add(entry.slice(0, eq), entry.slice(eq + 1).split(","));
  }
  return [...byPackage].map(([pkg, certs]) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: { namespace: "android_app" as const, package_name: pkg, sha256_cert_fingerprints: [...certs] },
  }));
}
