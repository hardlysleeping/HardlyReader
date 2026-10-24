import { mount } from "svelte";
import Harness from "./IndentHarness.svelte";

const params = new URLSearchParams(location.search);
const mode = params.get("write") ?? "ok";
// `?state=off` is a server with no Sidebar Feed Indent at all.
const indentAvailable = params.get("state") !== "off";
let stored = 8;

(globalThis as unknown as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  if (url.includes("/v1/state")) {
    return json({
      apiVersion: 1,
      hiddenCategories: { available: false },
      favorites: { available: false },
      sidebarIndent: { available: indentAvailable, px: stored, max: 60 },
    });
  }
  if (url.includes("/v1/indent")) {
    if (mode === "fail") return json({ error: "boom" }, 500);
    if (mode === "missing") return json({ error: "indent_unavailable" }, 409);
    const body = JSON.parse(String(init?.body ?? "{}")) as { px?: number };
    stored = typeof body.px === "number" ? body.px : stored;
    return json({ ok: true, changed: true, sidebarIndent: { available: true, px: stored, max: 60 } });
  }
  return json({ error: "unauthorised" }, 401);
};

mount(Harness, { target: document.getElementById("app")! });
