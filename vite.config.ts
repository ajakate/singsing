import { defineConfig } from "vite";

// base: "./" keeps asset paths relative so the build works on GitHub Pages
// (project subpath) without extra config. Swap to "/<repo>/" if you prefer.
export default defineConfig({
  base: "./",
});
