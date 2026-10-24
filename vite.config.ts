import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // Vite options tailored for Tauri development, applied in `tauri dev` and `tauri build`.
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Development only. FreshRSS sends no CORS headers, so a plain browser
    // cannot call it cross-origin. Proxying through the dev server makes the
    // API same-origin for `pnpm dev`, so the real UI can be exercised without
    // the Tauri shell. In the packaged app the request goes through the http
    // plugin and this proxy plays no part.
    proxy: {
      "/freshrss": {
        target: process.env.HARDLYREAD_SERVER ?? "http://127.0.0.1:18080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/freshrss/, ""),
      },
    },
  },
});
