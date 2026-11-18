import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { installWebStore } from "./api/web-store";
import { hydrateSessions } from "./api/session";

// Drag-to-scroll lives in `App.svelte` now: it is a gesture with an off switch,
// and the switch has to take the listener away rather than make it do nothing.

// The token is not in the session record any more — it is in the OS's own store
// where there is one (see `lib/secrets`), so the record has to be joined to it
// before anything reads a session. `accounts` builds its rows from that store the
// moment it is imported, and a session whose token has moved reads as no session,
// so this runs first and is awaited: a launch that mounted before it would show
// the connect screen for an account that is signed in.
await hydrateSessions();

// The shop, before anything mounts. With a billing service configured, the Buy
// button opens Stripe Checkout in the system browser and a page that comes back
// with `?checkout=` turns sync on without a reload; with none, the capability
// keeps the store it was built with. `api/web-store.ts` is where the two halves
// of the purchase meet (the entitlement cannot import them itself).
installWebStore();

const target = document.getElementById("app");
if (!target) {
  throw new Error("missing #app mount point");
}

const app = mount(App, { target });

// A phone can install this page once it offers a service worker, so the browser
// version registers the empty one from `public/sw.js`. Never in the desktop
// shell: there is nothing to install, and a worker over the asset protocol is a
// second thing that can be stale.
if (!("__TAURI_INTERNALS__" in globalThis) && "serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {
    // A page served without https, or a browser with workers off: it still runs,
    // it just cannot be added to a home screen.
  });
}

export default app;
