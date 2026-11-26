import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import manifest from "@/app/manifest";
import { AtlasMark } from "@/components/brand/AtlasMark";
import { BrandLockup } from "@/components/brand/BrandLockup";
import { BRAND_NAME, BRAND_EXPANSION, BRAND_INTRO, BRAND_TAGLINE } from "@/lib/brand";
import artwork from "@/lib/brand-artwork.json";
const read = (p: string) => readFileSync(p, "utf8");

describe("Atlas product identity, not a runtime migration", () => {
  it("uses the approved name, recursive expansion and restrained introduction", () => {
    expect([BRAND_NAME, BRAND_EXPANSION, BRAND_INTRO, BRAND_TAGLINE]).toEqual([
      "Atlas",
      "Atlas: Thoughtful Life Assistant & Steward",
      "Atlas is a Thoughtful Life Assistant and Steward",
      "Carry less. Keep what matters.",
    ]);
    const html = renderToStaticMarkup(<BrandLockup />);
    expect(html).toContain("Atlas</span>");
    expect(html).not.toContain(BRAND_TAGLINE);
  });
  it("shares original geometry across inherited-colour mark and SVG exports", () => {
    const markup = renderToStaticMarkup(<AtlasMark className="brand-mark" />);
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('focusable="false"');
    expect(markup).toContain('stroke="currentColor"');
    for (const d of artwork.paths) {
      expect(markup).toContain(d);
      expect(read("public/brand/atlas-mark.svg")).toContain(d);
      expect(read("public/icons/icon.svg")).toContain(d);
    }
    expect(markup).not.toContain("gradient");
    expect(markup).not.toContain("animate");
  });
  it("keeps the installed PWA identity, launch routes and share contract", () => {
    const m = manifest();
    expect(m.name).toBe("Atlas");
    expect(m.short_name).toBe("Atlas");
    expect(m.id).toBe("/home");
    expect(m.start_url).toBe("/home?source=pwa");
    expect(m.scope).toBe("/");
    expect(m.shortcuts?.map((s) => s.url)).toEqual(["/capture", "/inbox", "/chat?new=1", "/alerts"]);
    expect(m.shortcuts?.[2].name).toBe("Ask Hermes");
    expect(m.share_target).toEqual({
      action: "/share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        title: "title",
        text: "text",
        url: "url",
        files: [{ name: "files", accept: ["image/png", "image/jpeg", "image/webp", "image/gif", ".png", ".jpg", ".jpeg", ".webp", "text/plain", ".txt"] }],
      },
    });
  });
  it("keeps legacy protocol and application identifiers, without clearing data", () => {
    expect(read("app/login/LoginForm.tsx")).toContain('"jarvis.lastUsername"');
    expect(read("components/chat/Timeline.tsx")).toContain("Context from Jarvis:");
    expect(read("public/sw.js")).toContain('"jarvis');
    expect(read("android/app/build.gradle.kts")).toContain('applicationId = "com.nickbolles.jarvis"');
    expect(read("lib/jarvis-ui/types.ts")).toContain("jarvis-ui@1");
    expect(read("server/auth/index.ts")).toContain("jarvis_session");
  });
  it("exports valid, correctly sized local launcher assets and transparent push badge", async () => {
    for (const [name, size] of [
      ["icon-192.png", 192],
      ["icon-512.png", 512],
      ["maskable-192.png", 192],
      ["maskable-512.png", 512],
      ["apple-touch-icon.png", 180],
      ["badge-72.png", 72],
    ] as const) {
      const meta = await sharp(`public/icons/${name}`).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(["png", size, size]);
    }
    const { data, info } = await sharp("public/icons/maskable-512.png").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    // Only the solid background may lie outside the PWA's central circular safe zone (radius40%).
    let outsideGlyph = 0;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 4;
        if (Math.hypot(x - 255.5, y - 255.5) > 204.8 && (data[i] !== 12 || data[i + 1] !== 13 || data[i + 2] !== 15)) outsideGlyph++;
      }
    expect(outsideGlyph).toBe(0);
    const badge = await sharp("public/icons/badge-72.png").ensureAlpha().raw().toBuffer();
    expect(badge[3]).toBe(0);
    expect((await sharp("app/icon.png").metadata()).width).toBe(512);
    const ico = readFileSync("app/favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico[6]).toBe(32);
    expect(readdirSync("public/brand").filter((p) => p.endsWith(".svg")).length).toBe(6);
  });
});
