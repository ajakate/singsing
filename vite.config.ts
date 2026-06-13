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
      manifest: {
        name: "singsing — sight-singing practice",
        short_name: "singsing",
        description: "Browser-based sight-singing trainer.",
        theme_color: "#111317",
        background_color: "#111317",
        display: "standalone",
        // TODO: add icons (192px, 512px) for a polished install experience.
        icons: [],
      },
    }),
  ],
}));
