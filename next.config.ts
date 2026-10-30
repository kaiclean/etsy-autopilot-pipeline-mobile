import type { NextConfig } from "next";

const boxDashboard = process.env.AUTOPILOT_EXECUTION === "box" && process.env.AUTOPILOT_BOX_WORKER !== "1";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  serverExternalPackages: ["@electric-sql/pglite", "google-trends-api", "web-push", "onnxruntime-node"],
  // Bake public, non-secret role switches into the web build. Build-only hosting
  // variables must not accidentally fall back to inline execution at runtime.
  ...(boxDashboard ? { env: {
    AUTOPILOT_EXECUTION: "box",
    AUTOPILOT_BOX_WORKER: "0",
    FREE_ONLY_MODE: "true",
    UPSCALER_PULL: "on",
  } } : {}),
  // The web process is forbidden from running ORT. Keep native model binaries on the Mac only.
  ...(boxDashboard ? { outputFileTracingExcludes: { "/*": ["./node_modules/onnxruntime-node/**"] } } : {}),
  outputFileTracingIncludes: {
    "/**": ["./drizzle/**"],
    "/catalog-draft": ["./docs/omnishop-catalog-diff-2026-10-05.md"],
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
