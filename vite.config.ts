import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// base: "./" keeps asset paths relative so the build works on GitHub Pages
// (project subpath) without extra config. Swap to "/<repo>/" if you prefer.
export default defineConfig({
  base: "./",
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
});
