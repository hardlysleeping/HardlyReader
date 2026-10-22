import { defineConfig } from 'vite'

// Built output goes into the extension's folder on the server so the app is
// served from the SAME ORIGIN as FreshRSS. That is what makes the extension
// API calls work with no token, no CORS and no CSRF shim: it is a normal
// same-origin browser session, exactly like hidden.js.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
  },
})
