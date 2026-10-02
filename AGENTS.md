<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

- Demo mode needs no API keys and no `DATABASE_URL`. The first request creates an embedded PGlite database at `./.data/pglite` and seeds demo rows. To reset it, stop the server and delete `.data`.
- The dev server is `npm run dev` on port **4317**. Sign in with password `autopilot` when `DASHBOARD_PASSWORD` is unset. That fallback is disabled in production.
- `next-env.d.ts` and route types are gitignored. `npm run typecheck` needs them first: `npx next typegen`, or a prior `npm run dev` / `npm run build`.
- Canonical checks are `npm test`, `npm run lint`, `npm run typecheck`, and `npm run build`. There is no committed lockfile; install with `npm install`.
