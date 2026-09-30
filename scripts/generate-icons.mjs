// Renders PWA icons from public/icons/icon.svg (run: npm run icons).
import fs from "node:fs";
import sharp from "sharp";

const svg = fs.readFileSync("public/icons/icon.svg");
// Maskable icons need the glyph inside the 80% safe zone: pad on a full-bleed background.
const maskable = Buffer.from(
  svg
    .toString()
    .replace('rx="112"', 'rx="0"')
    .replace('<circle cx="256"', '<g transform="translate(51.2 51.2) scale(0.8)"><circle cx="256"')
    .replace("</svg>", "</g></svg>"),
);
const out = [
  ["icon-192.png", svg, 192],
  ["icon-512.png", svg, 512],
  ["maskable-192.png", maskable, 192],
  ["maskable-512.png", maskable, 512],
  ["apple-touch-icon.png", maskable, 180],
  ["badge-72.png", svg, 72],
];
for (const [name, src, size] of out) {
  await sharp(src, { density: 384 }).resize(size, size).png().toFile(`public/icons/${name}`);
  console.log("wrote", name);
}

// Android (TWA wrapper in android/): legacy launcher PNGs + adaptive/monochrome foreground.
// The glyph layer (no background) is scaled into the adaptive icon's 66/108 safe zone.
const res = "android/app/src/main/res";
const glyph = Buffer.from(
  svg
    .toString()
    .replace(/<rect[^>]*\/>/, "")
    .replace('<circle cx="256"', '<g transform="translate(256 256) scale(0.62) translate(-256 -256)"><circle cx="256"')
    .replace("</svg>", "</g></svg>"),
);
const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(densities)) {
  fs.mkdirSync(`${res}/mipmap-${d}`, { recursive: true });
  await sharp(svg, { density: 384 })
    .resize(48 * k, 48 * k)
    .png()
    .toFile(`${res}/mipmap-${d}/ic_launcher.png`);
  await sharp(glyph, { density: 384 })
    .resize(108 * k, 108 * k)
    .png()
    .toFile(`${res}/mipmap-${d}/ic_launcher_foreground.png`);
}
console.log("wrote android launcher icons");
