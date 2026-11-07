/**
 * Jarvis UI rules (docs/ui-library.md). UI is built from `@/components/ui` only:
 *  - no-native-controls: no raw <select>/<button>/<input>/<textarea> outside the library
 *  - no-legacy-imports: no imports of superseded primitives (`@/components/ui/legacy`) or
 *    non-canonical library paths (`@/components/ui/kit`, `/IconAction`, `/LoadingState`)
 *  - no-hex-colours: colours come from tokens (app/globals.css), never hex literals
 *  - no-arbitrary-values: no Tailwind arbitrary values (`text-[13px]`, `rounded-[9px]`);
 *    token references (`ring-[var(--surface)]`) are allowed
 *  - icon-button-label: `<Button iconOnly>` needs a text child or aria-label
 * Existing call sites live in eslint-suppressions.json (baseline being burned to zero);
 * after removing some, run `npm run lint:prune` so the baseline shrinks.
 */

const NATIVE = new Map([
  ["select", "Use SelectPicker (forms/settings) or ChipSelect (filters) from @/components/ui, not a native <select>."],
  ["button", "Use Button / IconButton / ChipButton / Menu from @/components/ui, not a raw <button>."],
  ["input", "Use Input (+ Field), Checkbox, Toggle, Segmented or DuePicker from @/components/ui, not a raw <input>."],
  ["textarea", "Use Textarea (+ Field) from @/components/ui, not a raw <textarea>."],
]);

const LEGACY_PATHS = new Map([
  [
    "@/components/ui/legacy",
    "Superseded legacy primitive: use the design-system replacement from @/components/ui (Button, Pill, EmptyState, Menu, Input/Field, SectionHeader, KSpinner/LoadingState) — see docs/ui-library.md.",
  ],
  ["@/components/ui/kit", "Import from the canonical barrel @/components/ui."],
  ["@/components/ui/IconAction", "Import IconButton from @/components/ui."],
  ["@/components/ui/LoadingState", "Import LoadingState from @/components/ui."],
]);

const HEX = /(?<![\w&/])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])/;
// Tailwind arbitrary value: `<utility>-[<value>]` with optional variants; var(--token) values are fine.
const ARBITRARY = /(?:^|[\s"'`])(?:[\w-]+:)*-?[a-z][\w-]*-\[([^\]\s]+)\]/g;

function stringParts(node) {
  if (node.type === "Literal" && typeof node.value === "string") return [node.value];
  if (node.type === "TemplateLiteral") return node.quasis.map((q) => q.value.cooked ?? q.value.raw);
  return [];
}

function badArbitrary(text) {
  for (const m of text.matchAll(ARBITRARY)) {
    const v = m[1];
    if (/^var\(--[\w-]+\)$/.test(v) || /^--[\w-]+$/.test(v)) continue;
    return m[0].trim();
  }
  return null;
}

function isImportOrDirective(node) {
  const p = node.parent;
  return (
    p &&
    (p.type === "ImportDeclaration" ||
      p.type === "ExportAllDeclaration" ||
      p.type === "ExportNamedDeclaration" ||
      p.type === "ImportExpression" ||
      (p.type === "ExpressionStatement" && p.directive))
  );
}

const noNativeControls = {
  meta: { type: "suggestion", docs: { description: "Use @/components/ui controls instead of native ones" }, schema: [] },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const msg = NATIVE.get(node.name.name);
        if (!msg) return;
        if (node.name.name === "input") {
          const type = node.attributes.find((a) => a.type === "JSXAttribute" && a.name?.name === "type");
          const v = type?.value?.type === "Literal" ? type.value.value : null;
          if (v === "file" || v === "hidden") return;
        }
        context.report({ node, message: msg });
      },
    };
  },
};

const noLegacyImports = {
  meta: { type: "suggestion", docs: { description: "Import UI from the canonical @/components/ui barrel" }, schema: [] },
  create(context) {
    const check = (node, source) => {
      const msg = LEGACY_PATHS.get(source);
      if (msg) context.report({ node, message: msg });
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
    };
  },
};

const noHexColours = {
  meta: { type: "suggestion", docs: { description: "Colours come from design tokens, not hex literals" }, schema: [] },
  create(context) {
    const visit = (node) => {
      if (isImportOrDirective(node)) return;
      for (const s of stringParts(node)) {
        const m = s.match(HEX);
        if (m) {
          context.report({ node, message: `Hex colour ${m[0]}: use a design token (var(--ac), text-muted, …) from app/globals.css.` });
          return;
        }
      }
    };
    return { Literal: visit, TemplateLiteral: visit };
  },
};

const noArbitraryValues = {
  meta: { type: "suggestion", docs: { description: "No Tailwind arbitrary values outside tokens" }, schema: [] },
  create(context) {
    const visit = (node) => {
      if (isImportOrDirective(node)) return;
      for (const s of stringParts(node)) {
        const bad = badArbitrary(s);
        if (bad) {
          context.report({ node, message: `Tailwind arbitrary value "${bad}": use the token scale or a .k-* class (var(--token) values are allowed).` });
          return;
        }
      }
    };
    return { Literal: visit, TemplateLiteral: visit };
  },
};

const iconButtonLabel = {
  meta: { type: "problem", docs: { description: "Icon-only buttons need an accessible name" }, schema: [] },
  create(context) {
    return {
      JSXElement(node) {
        const o = node.openingElement;
        if (o.name.type !== "JSXIdentifier" || o.name.name !== "Button") return;
        const attr = (n) => o.attributes.find((a) => a.type === "JSXAttribute" && a.name?.name === n);
        if (!attr("iconOnly")) return;
        if (attr("aria-label") || attr("aria-labelledby")) return;
        const hasText = node.children.some((c) => (c.type === "JSXText" && c.value.trim()) || c.type === "JSXExpressionContainer" || c.type === "JSXElement");
        if (!hasText) context.report({ node: o, message: "Button iconOnly needs a text child (rendered sr-only) or aria-label." });
      },
    };
  },
};

const plugin = {
  meta: { name: "jarvis-ui" },
  rules: {
    "no-native-controls": noNativeControls,
    "no-legacy-imports": noLegacyImports,
    "no-hex-colours": noHexColours,
    "no-arbitrary-values": noArbitraryValues,
    "icon-button-label": iconButtonLabel,
  },
};

export default plugin;
