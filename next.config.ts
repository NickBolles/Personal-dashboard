import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""),
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self'",
      "manifest-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      // GitHub: the "Create GitHub App" manifest form posts to github.com (docs/github-app.md).
      "form-action 'self' https://accounts.google.com https://github.com",
    ].join("; "),
  },
];

/** Release build id (Docker build arg); pages carry it so the PWA can tell an old cached shell from the live one. */
const BUILD = (process.env.JARVIS_VERSION ?? "dev").trim() || "dev";

const nextConfig: NextConfig = {
  output: "standalone",
  env: { NEXT_PUBLIC_JARVIS_BUILD: BUILD },
  serverExternalPackages: ["better-sqlite3", "web-push"],
  poweredByHeader: false,
  // The app never uses next/image. Turning the optimizer off means /_next/image
  // doesn't fetch or transform anything (it was the RCE/SSRF surface in the
  // Next 16.3.7 advisories).
  images: { unoptimized: true },
  outputFileTracingIncludes: {
    "/**": ["./drizzle/**/*"],
  },
  /** Work became Areas (phase 4): old links and bookmarks keep working (query strings carry over). */
  async redirects() {
    return [
      { source: "/work", destination: "/areas", permanent: false },
      { source: "/work/:path*", destination: "/areas/:path*", permanent: false },
    ];
  },
  async headers() {
    return [
      { source: "/:path*", headers: [...securityHeaders, { key: "x-jarvis-build", value: BUILD }] },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
