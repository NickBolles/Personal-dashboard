import type { MetadataRoute } from "next";
import { BRAND_NAME, BRAND_INTRO } from "@/lib/brand";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/home",
    name: BRAND_NAME,
    short_name: BRAND_NAME,
    description: BRAND_INTRO,
    start_url: "/home?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "any",
    background_color: "#0c0d0f",
    theme_color: "#0c0d0f",
    categories: ["productivity", "utilities"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Capture", url: "/capture", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Inbox", url: "/inbox", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Ask Hermes", short_name: "Hermes", url: "/chat?new=1", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Alerts", url: "/alerts", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
    // POST with files: public/sw.js stages the share in IndexedDB and opens /share?staged=<id>.
    share_target: {
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "files", accept: ["image/png", "image/jpeg", "image/webp", "image/gif", ".png", ".jpg", ".jpeg", ".webp", "text/plain", ".txt"] }],
      },
    },
  } as MetadataRoute.Manifest;
}
