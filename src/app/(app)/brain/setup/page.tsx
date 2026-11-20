import Link from "next/link";
import { BrainPage as Shell } from "@/components/brain/shell";
import IngestionStatus from "@/components/brain/ingestion-status";
export const dynamic = "force-dynamic";
export default function Setup() {
  return <Shell><div className="page-head"><div><h2>Saved-reel analyser</h2><p>Connect your always-on Linux worker. It checks for new saves twice a day and turns them into source-linked Etsy, SaaS and project ideas.</p></div></div>
    <IngestionStatus />
    <div className="card note"><h3>1. Get the worker configuration on your Linux host</h3>
      <p><a href="/api/brain/worker-config" className="btn-primary">Download private worker configuration</a></p>
      <p>Save this file as <code>.env.brain</code> in the checked-out Autopilot repository. Keep the sync credential private. <code>APP_URL</code> points the worker to this dashboard; check that it is your public deployment URL.</p>
      <h3>2. Install and sign in locally</h3>
      <p>Follow <code>docs/BRAIN_DAILY.md</code> to install Python dependencies, FFmpeg and local Ollama. Set <code>INSTAGRAM_USERNAME</code> and use a private <code>INSTAGRAM_SESSION_FILE</code>. If Chrome is already signed in on the worker host, <code>INSTAGRAM_COOKIES_FROM=chrome</code> (or <code>chrome:&lt;profile dir&gt;</code>) imports that session once. Passwords, two-factor codes and browser cookies stay off the dashboard.</p>
      <h3>3. Check one run and start the schedule</h3>
      <pre><code>{`chmod 600 .env.brain\n.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --check\n.venv-brain/bin/python scripts/brain/daily.py --env-file .env.brain --force\nbash deploy/brain/install-linux.sh "$PWD/.env.brain"`}</code></pre>
      <p>Set <code>BRAIN_RUN_TIMES</code> to change the two default checks, 07:20 and 19:20 Europe/Zurich. Leave the Linux host on. For macOS, use the LaunchAgent instructions in <code>docs/BRAIN_DAILY.md</code>.</p>
      <h3>What the job does</h3>
      <p>Read your latest saved videos → download new items → transcribe audio and inspect frames locally → create evidence-linked ideas → sync to this dashboard. No cloud AI spend. Failed items retry, and saved analysis is reused if upload fails.</p>
      <p>Ideas are proposals. Artwork needs an original brief and approval; SaaS and other projects stay in the backlog. Creating an idea does not publish an Etsy listing or build a software product.</p>
      <Link href="/brain/reels">Open reels →</Link>
    </div></Shell>;
}
