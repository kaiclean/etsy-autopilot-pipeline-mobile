import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  devIndicators: false,
  serverExternalPackages: ["@electric-sql/pglite", "google-trends-api", "web-push"],
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
