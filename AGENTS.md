<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

Demo mode needs no API keys or `DATABASE_URL`. Embedded Postgres is created in `.data/pglite` on the first request. Sign in at `http://localhost:4317` with password `autopilot` when `DASHBOARD_PASSWORD` is unset.

- Install: `npm install`, then `npx next typegen`. `npm run typecheck` needs those generated route helpers (`PageProps`, `LayoutProps`); `next-env.d.ts` is gitignored.
- Dev server: `npm run dev` (port 4317).
- Checks: `npm test`, `npm run lint`, `npm run typecheck`.
- Reset local data: stop the server, then `rm -rf .data`.
