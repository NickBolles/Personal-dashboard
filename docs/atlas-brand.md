# Atlas product identity

Atlas is a Thoughtful Life Assistant and Steward.

**Atlas: Thoughtful Life Assistant & Steward**  
**Carry less. Keep what matters.**

This is a product-facing identity change, not a runtime migration. Chief of staff remains the coordinator role; Hermes remains the agent runtime. The compact Command Center, pine-to-sea Tide orb and Lagoon agent colour roles stay intact. Original mark directions and implementation evidence are being collected on a private authenticated board; no public launch, domain purchase, merge or production deployment is included.

## Compatibility boundary

Keep existing manifest id `/home`, start URL `/home?source=pwa`, scope `/`, all shortcut and share-target routes. Keep the host `jarvis.nickbolles.com`, Android package `com.nickbolles.jarvis`, signing identity and assetlinks, auth cookies, localStorage and IndexedDB keys, service-worker cache keys, API/MCP namespaces, `jarvis-ui` fenced language and schema identifiers, environment variables, repository/container/profile IDs and historical records. No storage clearing or data migration is needed for this change.

Existing external OAuth grants/GitHub App registrations may still display their registered name; this PR does not rename third-party registrations. Installed PWA launchers can retain cached labels/icons until the browser refreshes the manifest; report owner refresh steps after release, not an instant-name-change guarantee.

## Delivery status

WIP: source and original identity exports in progress. Verification, private board URL and PR checks will be recorded here and in `/opt/data/worktrees/atlas-rebrand-HANDOFF.md`. Do not interpret this document as a release-readiness claim.

## Original artwork and reuse

The selected **Bearing** mark is an open A with a curved support carrying a small sky. Two alternatives (Canopy and Skyward) are retained on the [private identity board](https://artifacts.ai.nickbolles.com/v/atlas-brand-20261125/). These are original SVG paths, not stock art or a font glyph. `lib/brand-artwork.json` is the geometry source for `AtlasMark` and `npm run icons`; `BrandLockup` pairs it with the approved name using the existing system typography. Standalone marks inherit colour; the light/dark exports specify monochrome fills. Launcher icons are flat, with a transparent monochrome push badge. The existing Tide gradient and reduced-motion behaviour stay on interactive orbs only.

Local exports are in `public/brand/` and `public/icons/`, browser metadata in `app/layout.tsx` and `app/manifest.ts`, browser favicon in `app/favicon.ico`, and Android launcher exports in the existing resource paths. Android resource, package and signing identities remain unchanged.

## Compatibility appendix: intentional legacy names

- All lowercase protocol/storage namespaces remain, including `jarvis_session`, `jarvis.lastUsername`, service-worker cache and IndexedDB names, DOM custom events, `jarvis.work.snapshot`, MCP `jarvis_*` tool names, `jarvis-proposals`, and `jarvis-ui@1` fenced/schema identifiers. No storage clearing or key migration.
- The exact historical `Context from Jarvis:` delimiter is an internal transcript format and stays readable and emitted. Only its visible explanatory label changes to Atlas.
- The GitHub token setup URL, GitHub App default registration name and all integration redirect/webhook URLs are unchanged. Existing registrations and OAuth grants are not renamed by this PR; display copy refers to the existing grant instead of inventing an Atlas grant.
- `Jarvis` remains the actual container name and appears where an instruction specifically refers to that container. The repository/package identifiers and environment names remain legacy. Hermes, Claude and other providers retain their actual names.
- Existing projects/areas/chat titles such as `General Dev / Jarvis`, imported board aliases, fixture records and historical release/design documents remain unchanged. The daily brief's existing area lookup still finds the legacy Jarvis area. No automatic record move/rename or association backfill.
- Code symbols (`JarvisNotification`, `JarvisSpec`, `JARVIS_TARGET`, `JarvisMark` compatibility export) and comments about historical systems remain internal. UI labels in the fenced-block renderer may say Atlas without changing its wire language or closed catalog.

The pre-edit candidate inventory is `docs/atlas-copy-inventory.md`. Its broad candidate section includes comments and symbols (for example `Theme.Jarvis`) that are **not** instructions to rename those identifiers; the classification above takes precedence. A read-only before/after scan of changed source confirms that the legacy lowercase tokens and uppercase `JARVIS_*` environment identifiers have no removed/renamed occurrences (audit evidence is on the private board workspace).
