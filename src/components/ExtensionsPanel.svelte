<script lang="ts">
  /**
   * Does this FreshRSS have the extensions HardlyReader leans on?
   *
   * The app is built so that every extension is optional: no pins, no hidden categories, no
   * indent, and the sidebar still works. That is the right behaviour and a terrible diagnosis —
   * a reader whose adapter is missing, disabled or older than the build sees features quietly
   * not working, with nothing that says which piece to fix.
   *
   * This screen is that sentence. It asks the one question the app already knows how to ask
   * (`probeCapabilities` — the same call the sidebar's own authority decision uses, so the screen
   * cannot disagree with the app) and prints the answer per piece, with the repository to grab
   * the one that is absent.
   *
   * It configures nothing: no toggles, no fields. Diagnose and link out.
   */
  import { onMount } from "svelte";

  import { probeCapabilities, supportsExtensionRoutes } from "../api/hardlyread";
  import { transport } from "../api/transport";
  import { extensionRows, isFixable, summarize, type ExtensionRow } from "../lib/extension-status";
  import { reader } from "../state/reader.svelte";

  const LINKS: Record<string, string> = {
    adapter: "https://github.com/hardlysleeping/xExtension-HardlyRead",
    hidden: "https://github.com/hardlysleeping/xExtension-HiddenCategories",
    pinned: "https://github.com/hardlysleeping/xExtension-FavoriteCategories",
    preferences: "https://github.com/hardlysleeping/xExtension-HardlyRead",
  };

  const NAMES: Record<string, string> = {
    adapter: "Hardly Read adapter",
    hidden: "Hidden Categories",
    pinned: "Pinned Categories",
    preferences: "Sidebar indent and preferences",
  };

  const ADDS: Record<string, string> = {
    adapter: "One request that carries the extension state the app reads.",
    hidden: "Categories kept out of the sidebar, the counts and screen readers, with the eye's three views.",
    pinned: "Categories pinned to the top of the sidebar, and the pin filter.",
    preferences: "Feed indent and the reading preferences a server can hold.",
  };

  let rows = $state<ExtensionRow[]>([]);
  let busy = $state(true);

  async function probe(): Promise<void> {
    busy = true;
    const session = reader.session;
    if (session === null) {
      rows = [];
      busy = false;
      return;
    }
    const answer = await probeCapabilities(transport, session);
    rows = extensionRows({
      freshRss: supportsExtensionRoutes(session),
      outcome: answer.outcome,
      report: answer.report as Record<string, string>,
    });
    busy = false;
  }

  onMount(() => {
    void probe();
  });

  function stateWord(row: ExtensionRow): string {
    switch (row.state) {
      case "working":
        return "Working";
      case "missing":
        return "Not installed";
      case "needs-adapter":
        return "Waiting on the adapter";
      case "unavailable":
        return "Not available on this server";
      default:
        return "Could not tell";
    }
  }
</script>

<div class="extensions">
  <div class="head">
    <span class="key">Extensions on this server</span>
    <button class="do" disabled={busy} title="Ask the server again" onclick={() => void probe()}>
      {busy ? "Checking…" : "Check again"}
    </button>
  </div>

  <p class="hint">
    Every one of these is optional: the app runs without them, and the features they add simply
    stay on this device. This is where you see which are answering.
  </p>

  {#if reader.session === null}
    <p class="hint">Extensions live on a FreshRSS server — this library is on the device.</p>
  {:else}
    <p class="hint" role="status">{busy ? "Checking…" : summarize(rows)}</p>

    {#each rows as row (row.id)}
      <div class="row">
        <span class="name">{NAMES[row.id]}</span>
        <span class="state" class:good={row.state === "working"} class:bad={row.state === "missing"}>
          {stateWord(row)}
        </span>
        <span class="adds">{ADDS[row.id]}</span>
        {#if isFixable(row)}
          <a class="link" href={LINKS[row.id]} target="_blank" rel="noreferrer noopener">
            Get {NAMES[row.id]}
          </a>
        {/if}
      </div>
    {/each}

    <p class="hint">
      "Not installed" also covers an extension that is installed but switched off in FreshRSS, and
      an adapter older than this build — the server reports those three the same way, so this
      screen does not pretend to tell them apart.
    </p>
  {/if}
</div>

<style>
  .extensions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .key {
    color: var(--text-dim);
  }

  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 2px 10px;
    padding: 7px 0;
    border-top: 1px solid var(--border-soft);
  }

  .name {
    color: var(--text);
  }

  .state {
    color: var(--text-dim);
    justify-self: end;
    font-variant-numeric: tabular-nums;
  }

  .state.good {
    color: var(--accent);
  }

  .state.bad {
    color: var(--bad, var(--accent));
  }

  .adds {
    grid-column: 1 / -1;
    color: var(--text-dim);
    font-size: 0.92em;
  }

  .link {
    grid-column: 1 / -1;
    color: var(--accent);
    width: fit-content;
  }

  .hint {
    color: var(--text-dim);
    margin: 0;
  }

  .do {
    flex: 0 0 auto;
  }
</style>
