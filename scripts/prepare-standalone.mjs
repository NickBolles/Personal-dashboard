// Copies static assets, public files and migrations next to the standalone server.
import fs from "node:fs";

const root = ".next/standalone";
if (!fs.existsSync(`${root}/server.js`)) throw new Error("Run `next build` first (output: standalone)");
fs.cpSync("public", `${root}/public`, { recursive: true });
fs.cpSync(".next/static", `${root}/.next/static`, { recursive: true });
fs.cpSync("drizzle", `${root}/drizzle`, { recursive: true });
console.log("[prepare-standalone] ready:", root);
