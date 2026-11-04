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
    watch: {
      // `flatpak/build` and `.flatpak-builder` hold udev watch directories that
      // are symlink loops: the watcher throws ELOOP for dozens of them and the
      // server never finishes starting.
      ignored: [
        "**/src-tauri/**",
        "**/.worktrees/**",
        "**/node_modules/**",
        "**/flatpak/**",
        "**/.flatpak-builder/**",
      ],
    },
  },
});
