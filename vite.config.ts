import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Served from https://ajakate.github.io/singsing/ on GitHub Pages, so the
// production build needs base "/singsing/"; local dev stays at "/".
export default defineConfig(({ command }) => ({
  base: command === "build" ? "/singsing/" : "/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png"],
      manifest: {
        name: "singsing — sight-singing practice",
        short_name: "singsing",
        description: "Browser-based sight-singing trainer.",
        theme_color: "#111317",
        background_color: "#111317",
        display: "standalone",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
    }),
  ],
}));
