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

export default app;
