# Real-ESRGAN upscaler worker

Separate Railway service (`upscaler`) so heavy upscales never share the web app's memory.

- Start: `npx tsx workers/upscaler/server.ts` (build step: `echo upscaler`; the Next build is not needed).
- Listens on `[::]:$PORT` so it is reachable at `http://upscaler.railway.internal:$PORT`.
- Env: `UPSCALER_SECRET` (≥16 chars, shared with the app), the app's S3 variables (by reference), optional `REALESRGAN_MODEL_URL`/`REALESRGAN_MODEL_SHA256` (default: pinned x4plus, SHA-256 verified).
- One job at a time; tiles 256 → 160 → 96 on memory errors.
- App side: set `UPSCALER_URL` and `UPSCALER_SECRET`; failures fall back to local tiled upscale, then Lanczos (POD stays held by the gates).
