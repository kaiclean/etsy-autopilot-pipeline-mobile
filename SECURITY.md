# Security policy

## Supported version

Only the current `main` branch is supported.

## Reporting a problem

Please report vulnerabilities privately through GitHub: Security tab, "Report a vulnerability" (private vulnerability reporting), or contact the maintainer through the GitHub profile. Do not open a public issue for security problems, and do not include real credentials in a report.

## Threat model

- The dashboard is a single-operator tool. Every page and API route requires a signed, httpOnly session cookie, apart from a short public list in `src/proxy.ts`.
- Cron routes require `CRON_SECRET`. The Printify webhook checks its signature when `PRINTIFY_WEBHOOK_SECRET` is set, and production refuses the call when it is missing.
- Nothing is published to Etsy without a recorded human approval. Live writes need the host variable and an explicit go-live confirmation in the dashboard.
- AI spend is limited by daily and monthly caps, and a kill switch pauses all automation.
- Secrets belong in environment variables or deployment secrets, never in source control. `.env*` files are git-ignored except the examples.

## Out of scope

- Vulnerabilities in third-party services (Etsy, Printify, hosting and storage providers) or in dependencies without a demonstrated impact on this project.
- Findings that require physical access to the operator's machine or already-compromised credentials.
- The local demo mode and its documented development password, which is disabled in production.
