import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/home",
    name: "Jarvis",
    short_name: "Jarvis",
    description: "Hermes-first command center: next actions, alerts, and household systems.",
    start_url: "/home?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#f6f6f3",
    theme_color: "#2749d8",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Ask Hermes", short_name: "Hermes", url: "/chat?new=1", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Alerts", url: "/alerts", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Home controls", short_name: "Home", url: "/home-control", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
    share_target: {
      action: "/share",
      method: "GET",
      params: { title: "title", text: "text", url: "url" },
    },
  } as MetadataRoute.Manifest;
}
