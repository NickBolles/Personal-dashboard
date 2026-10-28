import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { AndroidWrapperMarker } from "@/components/AndroidWrapperMarker";
import { ThemeSync } from "@/components/ui/ThemeSync";

// Self-hosted at build time by next/font: no font CDN request at runtime.
const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Jarvis", template: "%s · Jarvis" },
  description: "Hermes-first command center: next actions, alerts, and household systems.",
  applicationName: "Jarvis",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Jarvis", statusBarStyle: "default" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f3f5" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0d0f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`h-full antialiased ${geist.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <body className="min-h-full">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100] focus:rounded-lg focus:bg-surface focus:px-4 focus:py-3"
        >
          Skip to content
        </a>
        <AndroidWrapperMarker />
        <ThemeSync />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
