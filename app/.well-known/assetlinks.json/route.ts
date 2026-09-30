import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Digital Asset Links for an optional Trusted Web Activity (Android APK wrapper).
 * JARVIS_TWA_ASSETLINKS="com.example.jarvis=AA:BB:...;com.other=CC:DD:..."
 */
export function GET() {
  const raw = process.env.JARVIS_TWA_ASSETLINKS ?? "";
  const statements = raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [pkg, fingerprints] = entry.split("=");
      return {
        relation: ["delegate_permission/common.handle_all_urls"],
        target: { namespace: "android_app", package_name: pkg!.trim(), sha256_cert_fingerprints: (fingerprints ?? "").split(",").map((f) => f.trim()).filter(Boolean) },
      };
    });
  return NextResponse.json(statements);
}
