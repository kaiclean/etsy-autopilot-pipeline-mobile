import { config } from "@/lib/config";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : "/";
  const devHint = config.usingDevPassword && process.env.NODE_ENV !== "production";
  const misconfigured = !config.dashboardPassword || !config.authSecret;
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-6 pt-safe pb-safe">
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[620px] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icons/192" alt="" className="size-14 rounded-2xl shadow-lg shadow-primary/20" />
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Etsy Autopilot</h1>
            <p className="mt-1 text-sm text-muted-foreground">This dashboard controls a live shop. Sign in to continue.</p>
          </div>
        </div>
        <LoginForm next={next} disabled={misconfigured} />
        {devHint && (
          <p className="mt-4 rounded-lg border border-dashed border-border px-3 py-2 text-center text-xs text-muted-foreground">
            Local dev: no <code className="text-foreground">DASHBOARD_PASSWORD</code> set, so the password is{" "}
            <code className="font-semibold text-foreground">autopilot</code>
          </p>
        )}
        {misconfigured && (
          <p className="mt-4 text-center text-xs text-destructive">Set DASHBOARD_PASSWORD and AUTH_SECRET in the environment to enable sign-in.</p>
        )}
      </div>
    </main>
  );
}
