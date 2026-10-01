"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      className="h-8 rounded-lg px-3 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          toast.success("Copied");
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          toast.error("Could not copy. Select the text instead.");
        }
      }}
    >
      {copied ? "Copied" : label}
    </Button>
  );
}
