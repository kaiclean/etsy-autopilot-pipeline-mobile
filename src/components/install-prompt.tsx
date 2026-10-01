"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "autopilot-install-dismissed";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallPrompt() {
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (window.matchMedia("(display-mode: standalone)").matches) return;
    if (window.localStorage.getItem(DISMISS_KEY) === "1") return;
    const onPrompt = (event: Event) => {
      event.preventDefault();
      setPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (!prompt) return null;

  const dismiss = () => {
    window.localStorage.setItem(DISMISS_KEY, "1");
    setPrompt(null);
  };

  return (
    <div className="border-b border-border bg-card">
      <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-2 md:px-8">
        <Download className="size-4 shrink-0 text-primary" />
        <p className="min-w-0 flex-1 text-xs leading-snug">Install Autopilot for a home-screen command center. Publishing stays dry-run.</p>
        <Button
          className="h-8 rounded-lg px-3 text-xs"
          onClick={() => {
            void prompt.prompt().then(() => dismiss());
          }}
        >
          Install
        </Button>
        <Button variant="ghost" className="h-8 rounded-lg px-2 text-xs" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}
