/** S0 of the Android wrapper: Digital Asset Links route and the "inside the app" detection. */
import { describe, expect, it } from "vitest";
import { assetLinks, DEFAULT_ANDROID_CERT_SHA256, normalizeFingerprint } from "@/server/android/assetlinks";
import { detectAndroidWrapper } from "@/lib/client/wrapper";
import * as route from "@/app/.well-known/assetlinks.json/route";

const CI_KEY = "8d6031eb7847ef2e7002992dd2710222978a8ba2394c5ee2ebcbf94a0b3e0bb1";

describe("assetlinks", () => {
  it("defaults to the Jarvis package and the persistent CI signing key", () => {
    expect(normalizeFingerprint(CI_KEY)).toBe(DEFAULT_ANDROID_CERT_SHA256);
    expect(assetLinks({})).toEqual([
      {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: "com.nickbolles.jarvis", sha256_cert_fingerprints: [DEFAULT_ANDROID_CERT_SHA256] },
      },
    ]);
  });

  it("reads fingerprints and package from env, normalising and skipping invalid ones", () => {
    const other = "AA".repeat(32);
    const out = assetLinks({ JARVIS_ANDROID_CERT_SHA256: ` ${CI_KEY} , nope, ${other.toLowerCase()}`, JARVIS_ANDROID_PACKAGE: "org.example.jarvis" });
    expect(out).toHaveLength(1);
    expect(out[0]!.target.package_name).toBe("org.example.jarvis");
    expect(out[0]!.target.sha256_cert_fingerprints).toEqual([DEFAULT_ANDROID_CERT_SHA256, normalizeFingerprint(other)]);
  });

  it("can be turned off, and a bad package or only bad fingerprints serve nothing", () => {
    expect(assetLinks({ JARVIS_ANDROID_CERT_SHA256: "none" })).toEqual([]);
    expect(assetLinks({ JARVIS_ANDROID_CERT_SHA256: "zz" })).toEqual([]);
    expect(assetLinks({ JARVIS_ANDROID_PACKAGE: "not a package" })).toEqual([]);
  });

  it("still honours the older JARVIS_TWA_ASSETLINKS list and merges by package", () => {
    const other = "BB".repeat(32);
    const out = assetLinks({ JARVIS_TWA_ASSETLINKS: `com.nickbolles.jarvis=${other};com.other.app=${CI_KEY};broken` });
    expect(out.map((s) => s.target.package_name)).toEqual(["com.nickbolles.jarvis", "com.other.app"]);
    expect(out[0]!.target.sha256_cert_fingerprints).toEqual([DEFAULT_ANDROID_CERT_SHA256, normalizeFingerprint(other)]);
  });

  it("route serves public JSON", async () => {
    const res = route.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as Array<{ target: { package_name: string } }>;
    expect(body[0]?.target.package_name).toBe("com.nickbolles.jarvis");
  });
});

describe("android wrapper detection", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it("detects ?source=android and the TWA referrer, and remembers it for the tab", () => {
    const store = mem();
    expect(detectAndroidWrapper({ search: "" }, "", store)).toBe(false);
    expect(detectAndroidWrapper({ search: "?item=x&source=android" }, "", store)).toBe(true);
    expect(detectAndroidWrapper({ search: "" }, "", store)).toBe(true);
    const fresh = mem();
    expect(detectAndroidWrapper({ search: "" }, "android-app://com.nickbolles.jarvis/", fresh)).toBe(true);
    expect(detectAndroidWrapper({ search: "" }, "", fresh)).toBe(true);
  });

  it("ignores other apps and the PWA source", () => {
    expect(detectAndroidWrapper({ search: "?source=pwa" }, "android-app://com.other.app/", mem())).toBe(false);
    expect(detectAndroidWrapper({ search: "" }, "android-app://com.nickbolles.jarvis.evil/", mem())).toBe(false);
    expect(detectAndroidWrapper({ search: "?source=android" }, "", null)).toBe(true);
  });
});
