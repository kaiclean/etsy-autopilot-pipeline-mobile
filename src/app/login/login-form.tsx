"use client";

import { Loader2, LockKeyhole } from "lucide-react";
import { useActionState } from "react";
import { login } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function LoginForm({ next, disabled }: { next: string; disabled?: boolean }) {
  const [state, action, pending] = useActionState(login, undefined);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <div className="relative">
        <LockKeyhole className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Password"
          required
          autoFocus
          disabled={disabled}
          aria-invalid={Boolean(state?.error)}
          className="h-12 rounded-xl pl-10 text-base"
        />
      </div>
      {state?.error && <p className="text-sm text-destructive">{state.error}</p>}
      <Button type="submit" disabled={pending || disabled} className="h-12 w-full rounded-xl text-base font-semibold">
        {pending ? <Loader2 className="animate-spin" /> : "Unlock dashboard"}
      </Button>
    </form>
  );
}
