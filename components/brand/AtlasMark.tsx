import artwork from "@/lib/brand-artwork.json";

/** Bearing: an open A with a curved support holding a small sky. Original Atlas artwork.
 * Single-colour, decorative; the containing link/button supplies its accessible name.
 * Geometry is shared with the local SVG/PNG export generator. No animation of its own.
 */
export function AtlasMark({ className }: { className?: string }) {
  return (
    <svg viewBox={artwork.viewBox} className={className} aria-hidden="true" focusable="false" data-atlas-mark="bearing">
      {artwork.paths.map((d) => (
        <path key={d} d={d} fill="none" stroke="currentColor" strokeWidth={artwork.strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
      ))}
      <circle {...artwork.core} fill="currentColor" />
    </svg>
  );
}
