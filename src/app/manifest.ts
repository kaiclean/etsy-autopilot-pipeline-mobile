import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Etsy Autopilot",
    short_name: "Autopilot",
    description: "Run the Etsy digital + POD pipeline from your phone.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0b0c10",
    theme_color: "#0b0c10",
    categories: ["business", "productivity", "finance"],
    icons: [
      { src: "/icons/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/512?maskable=1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Approval queue", url: "/queue" },
      { name: "Orders", url: "/orders" },
      { name: "Pipeline", url: "/pipeline" },
    ],
  };
}
