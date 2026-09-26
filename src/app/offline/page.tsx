export const metadata = { title: "Offline" };

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-lg font-semibold">You&apos;re offline</div>
      <p className="max-w-xs text-sm text-muted-foreground">
        Autopilot keeps running on the server. Reconnect to see live orders and the approval queue.
      </p>
    </main>
  );
}
