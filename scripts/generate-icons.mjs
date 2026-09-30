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
