export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main id="main" className="mx-auto max-w-md p-6 text-center">
      <h1 className="text-2xl font-semibold">You’re offline</h1>
      <p className="mt-2 text-muted">
        This page hasn’t been saved on this device yet. Home and recent conversations are available offline once you’ve opened them.
      </p>
      <a href="/home" className="mt-4 inline-flex min-h-12 items-center rounded-[10px] border border-line-strong px-4">
        Go to Home
      </a>
    </main>
  );
}
