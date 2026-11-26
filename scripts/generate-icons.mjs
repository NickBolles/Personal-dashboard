// Original Atlas identity exports. One geometry source for React, SVG, PWA and Android.
// Run: npm run icons. No network, font downloads, external assets or signing changes.
import fs from "node:fs";
import sharp from "sharp";
import artwork from "../lib/brand-artwork.json" with { type: "json" };

const root = "public/brand";
fs.mkdirSync(root, { recursive: true });
const paths = artwork.paths
  .map((d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${artwork.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/>`)
  .join("");
const core = `<circle cx="${artwork.core.cx}" cy="${artwork.core.cy}" r="${artwork.core.r}" fill="currentColor"/>`;
const glyph = paths + core;
const svg = (body, viewBox = "0 0 24 24") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>\n`;
const mark = (colour) => svg(`<g color="${colour}">${glyph}</g>`);
const icon = (radius, scale = 18) =>
  svg(
    `<rect width="512" height="512" rx="${radius}" fill="#0c0d0f"/><g color="#4fd8c4" transform="translate(256 256) scale(${scale}) translate(-12 -12)">${glyph}</g>`,
    "0 0 512 512",
  );
const iconSvg = icon(112);
const maskable = icon(0, 16);
const adaptive = svg(`<g color="#4fd8c4" transform="translate(256 256) scale(13.5) translate(-12 -12)">${glyph}</g>`, "0 0 512 512");
const variants = {
  "atlas-mark.svg": mark("currentColor"),
  "atlas-mark-light.svg": mark("#14161a"),
  "atlas-mark-dark.svg": mark("#ebecee"),
  "atlas-app-icon.svg": iconSvg,
};
for (const [name, source] of Object.entries(variants)) fs.writeFileSync(`${root}/${name}`, source);
for (const [theme, colour] of [
  ["light", "#14161a"],
  ["dark", "#ebecee"],
]) {
  const wordmark = svg(
    `<g color="${colour}">${glyph}</g><text x="32" y="20" fill="${colour}" font-family="system-ui,sans-serif" font-size="23" font-weight="650" letter-spacing="-.65">Atlas</text>`,
    "0 0 100 28",
  );
  fs.writeFileSync(`${root}/atlas-wordmark-${theme}.svg`, wordmark);
  await sharp(Buffer.from(wordmark), { density: 384 }).resize(800, 224).png().toFile(`${root}/atlas-wordmark-${theme}.png`);
  await sharp(Buffer.from(mark(colour)), { density: 384 })
    .resize(512, 512)
    .png()
    .toFile(`${root}/atlas-mark-${theme}.png`);
}
fs.writeFileSync("public/icons/icon.svg", iconSvg);
const out = [
  ["icon-192.png", iconSvg, 192],
  ["icon-512.png", iconSvg, 512],
  ["maskable-192.png", maskable, 192],
  ["maskable-512.png", maskable, 512],
  ["apple-touch-icon.png", maskable, 180],
  ["badge-72.png", mark("#ffffff"), 72],
];
for (const [name, source, size] of out) {
  await sharp(Buffer.from(source), { density: 384 }).resize(size, size).png().toFile(`public/icons/${name}`);
  console.log("wrote", name, `${size}x${size}`);
}
await sharp(Buffer.from(iconSvg), { density: 384 }).resize(512, 512).png().toFile("app/icon.png");
// A PNG-backed ICO is supported by current browsers; keep a real 32px entry.
const png = await sharp(Buffer.from(iconSvg), { density: 384 }).resize(32, 32).png().toBuffer();
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico[6] = 32;
ico[7] = 32;
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
fs.writeFileSync("app/favicon.ico", Buffer.concat([ico, png]));
// Android legacy launcher PNGs + adaptive foreground, same package/signing/resources.
const res = "android/app/src/main/res";
for (const [density, factor] of Object.entries({ mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 })) {
  fs.mkdirSync(`${res}/mipmap-${density}`, { recursive: true });
  await sharp(Buffer.from(iconSvg), { density: 384 })
    .resize(48 * factor, 48 * factor)
    .png()
    .toFile(`${res}/mipmap-${density}/ic_launcher.png`);
  await sharp(Buffer.from(adaptive), { density: 384 })
    .resize(108 * factor, 108 * factor)
    .png()
    .toFile(`${res}/mipmap-${density}/ic_launcher_foreground.png`);
}
// A monochrome Android vector for themed icons; geometry follows the same paths.
const vectorPaths = artwork.paths
  .map(
    (d) =>
      `<path android:pathData="${d}" android:fillColor="@android:color/transparent" android:strokeColor="@android:color/white" android:strokeWidth="${artwork.strokeWidth}" android:strokeLineCap="round" android:strokeLineJoin="round"/>`,
  )
  .join("\n  ");
const circle = `M${artwork.core.cx - artwork.core.r},${artwork.core.cy}a${artwork.core.r},${artwork.core.r} 0,1 0,${2 * artwork.core.r},0a${artwork.core.r},${artwork.core.r} 0,1 0,-${2 * artwork.core.r},0`;
fs.writeFileSync(
  `${res}/drawable/ic_launcher_mono.xml`,
  `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="40" android:viewportHeight="40">\n<group android:translateX="8" android:translateY="8">\n${vectorPaths}\n<path android:pathData="${circle}" android:fillColor="@android:color/white"/>\n</group>\n</vector>\n`,
);
console.log("wrote original Atlas SVG/PNG/ICO and Android exports");
