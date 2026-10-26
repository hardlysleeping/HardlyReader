<script lang="ts">
  /**
   * The account, drawn once.
   *
   * It is a component because it is now offered in two places: the sheet that
   * drops from the name in the bar, and the Accounts section of the settings
   * panel. Two hand-written copies of "sign out" is how a bar ends up signing
   * out of one server while showing another's address.
   *
   * `floating` is the bar's sheet — anchored to the name it drops from, so it is
   * absolutely positioned and the header keeps the box that opens it. The plain
   * form is a block of rows for a panel that already has its own scroll and
   * edges.
   */
  let {
    name = "",
    server = "",
    onsignout,
    floating = false,
  }: {
    /** The account's display name: what the bar shows, and what sign out belongs to. */
    name?: string;
    /** The server this window is signed in to, exactly as it was entered. */
    server?: string;
    onsignout?: () => void;
    /** Anchored under the name, as a menu, or laid out as rows in a panel. */
    floating?: boolean;
  } = $props();
</script>

{#if floating}
  <div class="sheet" role="menu" aria-label="Account">
    <p class="name" title={name}>{name}</p>
    <!-- The address lives here too: the bar's copy is the first thing to go when
         the window narrows, and this is where you go looking for "which server
         is this". -->
    <p class="server">{server}</p>
    <button role="menuitem" onclick={() => onsignout?.()}>Sign out</button>
  </div>
{:else}
  <div class="rows" role="group" aria-label="Account">
    <div class="row">
      <span class="key">Signed in as</span>
      <span class="value" title={name}>{name}</span>
    </div>
    {#if server}
      <div class="row">
        <span class="key">Server</span>
        <span class="value mono">{server}</span>
      </div>
    {/if}
    <div class="row end">
      <span class="key">Leaves this account on this device.</span>
      <button class="out" onclick={() => onsignout?.()}>Sign out</button>
    </div>
  </div>
{/if}

<style>
  /* The bar's sheet: anchored under the name, over the panes rather than pushing
     them, because it is a list of what you can do with the account. */
  .sheet {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 70;
    min-width: 148px;
    max-width: 260px;
    padding: 5px;
    border: 1px solid var(--border);
    border-radius: 9px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    animation: sheet-in 120ms ease-out;
  }

  .name {
    margin: 0;
    padding: 4px 7px 6px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* In the sheet there is room for the whole thing, and it wraps rather than
     clipping: this is the copy you read when the bar's copy is gone. */
  .server {
    margin: 0;
    padding: 4px 7px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--text-dim);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }

  .sheet button {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 5px 7px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }

  .sheet button:hover {
    background: var(--hover);
    color: var(--text);
  }

  @keyframes sheet-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .sheet {
      animation: none;
    }
  }

  /* The plain form: rows in a panel that already has edges and a scroll. */
  .rows {
    display: block;
  }

  .row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 5px 0;
  }

  .row.end {
    margin-top: 4px;
    padding-top: 8px;
    border-top: 1px solid var(--border-soft);
  }

  .key {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--text-dim);
  }

  .value {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 60%;
    overflow: hidden;
    color: var(--text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }

  .out {
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .out:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
