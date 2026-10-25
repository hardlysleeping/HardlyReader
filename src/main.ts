import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { installDragScroll } from "./lib/drag-scroll";

// Drag the lists and the article with the mouse, like a finger on a phone.
// Installed once for the whole app: it finds the scroll container under the
// pointer itself, so no pane has to opt in.
installDragScroll();

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
