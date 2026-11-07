import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jarvisUi from "./eslint-rules/jarvis-ui.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // We intentionally hydrate from browser-only APIs (IndexedDB, localStorage, Notification) after mount.
      "react-hooks/set-state-in-effect": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // UI rules (docs/ui-library.md): build UI from @/components/ui only. Existing call sites are
    // baselined in eslint-suppressions.json; new ones fail CI. `npm run lint:prune` after fixing some.
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    ignores: [
      "components/ui/**",
      // Library members that still live outside components/ui (re-exported from the barrel).
      "components/work/MetaPicker.tsx",
      // Owner-only gallery renders library internals on purpose.
      "app/(shell)/dev/**",
      "**/*.test.{ts,tsx}",
    ],
    plugins: { "jarvis-ui": jarvisUi },
    rules: {
      "jarvis-ui/no-native-controls": "error",
      "jarvis-ui/no-legacy-imports": "error",
      "jarvis-ui/no-hex-colours": "error",
      "jarvis-ui/no-arbitrary-values": "error",
      "jarvis-ui/icon-button-label": "error",
    },
  },
  {
    // Web manifest + document theme-color need literal colours (no CSS context there).
    files: ["app/manifest.ts", "app/layout.tsx"],
    rules: { "jarvis-ui/no-hex-colours": "off" },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    "playwright-report/**",
    "test-results/**",
    "data/**",
    "public/sw.js",
    "android/**",
  ]),
]);

export default eslintConfig;
