import Link from "next/link";
import { BrainPage as Shell } from "@/components/brain/shell";
import IngestionStatus from "@/components/brain/ingestion-status";
export const dynamic = "force-dynamic";
export default function Setup() {
  return <Shell><div className="page-head"><div><h2>Daily saved-reel analyser</h2><p>Connect your Mac once. New saves become source-linked Etsy, SaaS and project ideas each day.</p></div></div>
    <IngestionStatus />
    <div className="card note"><h3>1. Get the worker configuration on your Mac</h3>
      <p><a href="/api/brain/worker-config" className="btn-primary">Download private Mac configuration</a></p>
      <p>Save this file as <code>.env.brain</code> in the checked-out Autopilot repository. It contains the sync credential; keep it private. Set your Instagram username there.</p>
      <h3>2. Install and sign in locally</h3>
      <p>Follow <code>docs/BRAIN_DAILY.md</code> in the repository to install Python dependencies, FFmpeg and Ollama. Sign in through Instaloader on your Mac; passwords and two-factor codes stay there.</p>
      <h3>3. Check one run and start the daily job</h3>
      <pre><code>{`chmod 600 .env.brain\n.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --check\n.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --force\nbash deploy/brain/install-macos.sh "$PWD/.env.brain"`}</code></pre>
      <p>The installer creates a daily macOS LaunchAgent at the time in your configuration, default 07:20 in your Mac timezone. It also checks at login and catches up after sleep. Leave the Mac powered and logged in.</p>
      <h3>What the job does</h3>
      <p>Read your latest saved videos → download new items → transcribe audio and inspect frames locally → create evidence-linked ideas → sync to this dashboard. No cloud AI spend. Failed items retry, and saved analysis is reused if upload fails.</p>
      <p>Ideas are proposals. Artwork needs an original brief and approval; SaaS and other projects stay in the backlog. Creating an idea does not publish an Etsy listing or build a software product.</p>
      <Link href="/brain/reels">Open reels →</Link>
    </div></Shell>;
}
