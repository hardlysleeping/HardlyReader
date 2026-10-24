<script lang="ts">
  import Sidebar from "./components/Sidebar.svelte";
  import { reader } from "./state/reader.svelte";
  import { onMount } from "svelte";
  import { layout } from "./state/layout.svelte";

  const session = {
    serverUrl: "https://example.invalid",
    email: "stub@example.invalid",
    token: "stub",
  };

  // After mount: the reader restores its own session on start and would
  // overwrite anything set during init.
  onMount(() => {
    reader.session = session;
    layout.setMode(2);
    void reader.loadApiState();
  });
</script>

<div style="height: 100vh; display: flex">
  <div style="width: 300px; display: flex; flex-direction: column">
    <Sidebar />
  </div>
  <div style="flex: 1"></div>
</div>

<button id="open-indent" onclick={() => (window as any).__openIndent?.()}>open</button>
