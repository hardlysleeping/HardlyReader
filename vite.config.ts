import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [svelte()],

  // A project page on GitHub Pages is served from /<repo>/, so the demo build needs its asset
  // URLs prefixed. `VITE_BASE` is the knob; every other build keeps "/".
  base: process.env.VITE_BASE ?? "/",

  // Vite only exposes `VITE_`-prefixed variables to the client by default. The
  // identity's two values are spelled `PUBLIC_SUPABASE_URL` / `PUBLIC_SUPABASE_ANON_KEY`
  // in `.env.example`, because "public" is the whole point of them: the anon key
  // ships in every bundle by design and row-level security is what protects the
  // data. The prefix is named here rather than renamed in the environment so the
  // name says the truth. Never add a variable with a secret in it to this list —
  // the service key must not reach a bundle at all (`src/api/identity.ts` refuses
  // one that does).
  envPrefix: ["VITE_", "PUBLIC_"],

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
    // Development only, and only a convenience: FreshRSS answers the GReader API
    // with `Access-Control-Allow-Origin: *` and allows the Authorization header,
    // so a browser build calls a server on another origin unaided. The proxy
    // exists so `pnpm dev` can point at a local instance by path alone, which is
    // handy when the address changes; it is not what makes the browser build
    // work, and in the packaged app the request goes through the http plugin anyway.
    proxy: {
      "/freshrss": {
        target: process.env.HARDLYREAD_SERVER ?? "http://127.0.0.1:18080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/freshrss/, ""),
      },
    },
  },
});
