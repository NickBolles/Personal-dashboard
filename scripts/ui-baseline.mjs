// Prints the remaining legacy-UI baseline (eslint-suppressions.json, jarvis-ui/* rules).
// `npm run ui:baseline` — PR B/C burn these down to zero (docs/ui-library.md).
import fs from "node:fs";

const file = new URL("../eslint-suppressions.json", import.meta.url);
const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const rules = {};
for (const [path, byRule] of Object.entries(data)) {
  for (const [rule, { count }] of Object.entries(byRule)) {
    if (!rule.startsWith("jarvis-ui/")) continue;
    rules[rule] ??= { sites: 0, files: [] };
    rules[rule].sites += count;
    rules[rule].files.push([path, count]);
  }
}
let total = 0;
for (const [rule, v] of Object.entries(rules).sort()) {
  total += v.sites;
  console.log(`${rule.padEnd(30)} ${String(v.sites).padStart(5)} sites in ${v.files.length} files`);
  if (process.argv.includes("--files")) for (const [p, n] of v.files.sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${p}`);
}
console.log(`${"total".padEnd(30)} ${String(total).padStart(5)}`);
