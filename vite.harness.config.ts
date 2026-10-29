import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/** Throwaway: the repo's dev server, with the sibling worktrees unwatched. */
export default defineConfig({
  root: "/var/home/bazzite/apps/hardlyread",
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**", "**/.worktrees/**", "**/node_modules/**"] },
  },
});
