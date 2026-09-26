"use client";

import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-destructive/30 bg-destructive/5 px-6 py-14 text-center">
      <TriangleAlert className="mb-3 size-8 text-destructive" />
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        {error.message || "The dashboard couldn't load this view."} Automation keeps running on the server.
      </p>
      <Button onClick={reset} className="mt-5 h-10 rounded-xl">
        <RotateCcw className="size-4" /> Try again
      </Button>
    </div>
  );
}
