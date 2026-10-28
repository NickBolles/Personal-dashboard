/**
 * The Jarvis mark: an open ring (the assistant listening) around a core dot.
 * Replaces the "J" initial on the command orb so it no longer reads as an
 * account avatar (the avatar lives in Settings).
 */
export function JarvisMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      <path d="M17.6 5.2A8.5 8.5 0 1 0 20.5 12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M14.6 9.2A3.9 3.9 0 1 0 15.9 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.65" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" />
      <circle cx="20.3" cy="7.6" r="1.35" fill="currentColor" />
    </svg>
  );
}
