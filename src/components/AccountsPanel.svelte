<script lang="ts">
  /**
   * The account in the bar, and the panel behind it.
   *
   * One account is in use; the others on this device are listed under it, one
   * press to switch to and one × to remove. Adding lives here too, because the
   * answer to "another account" is the login screen — the same form, opened
   * without touching the session already in use.
   *
   * The panel is `position: fixed` like the Reading and Settings panels: it is
   * opened from the name in the bar where there is room for one, and from the
   * compact menu when there is not, so it cannot be anchored to a trigger that a
   * narrow window hides.
   */
  import { serverLabel } from "../lib/server-label";
  import { accounts } from "../state/accounts.svelte";

  let {
    subtitle = "",
    server = "",
    onaddaccount,
    onsignout,
  }: {
    /** The account in use, as the bar labels it. */
    subtitle?: string;
    /** The server it is on, exactly as it was entered. */
    server?: string;
    onaddaccount?: () => void;
    onsignout?: () => void;
  } = $props();

  let open = $state(false);
  let panelEl = $state<HTMLElement | null>(null);
  let whoEl = $state<HTMLElement | null>(null);

  /** The bar's copy of the address: the same label the server line has always had. */
  const address = $derived(serverLabel(server));

  /** Opened from the compact menu, where the name has no room to sit. */
  export function openAccounts(): void {
    open = true;
  }

  async function switchAccount(slug: string): Promise<void> {
    await accounts.switchTo(slug);
  }

  function add(): void {
    open = false;
    onaddaccount?.();
  }

  function signOut(): void {
    open = false;
    onsignout?.();
  }

  /**
   * A press anywhere else closes it, and so does Escape.
   *
   * The name itself is exempt: pressing it is how the panel is toggled, and
   * closing on the way to the trigger would make it open twice.
   */
  $effect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (panelEl?.contains(target) || whoEl?.contains(target)) return;
      open = false;
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") open = false;
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  });
</script>

<div class="account" bind:this={whoEl}>
  <button
    class="who"
    aria-haspopup="dialog"
    aria-expanded={open}
    title={subtitle}
    onclick={() => (open = !open)}
  >{subtitle}</button>
  {#if address}
    <span class="server" title={server}>{address}</span>
  {/if}
</div>

{#if open}
  <div class="panel" bind:this={panelEl} role="dialog" aria-label="Accounts">
    <p class="title">
      Accounts
      {#if accounts.busy}
        <span class="checking">checking…</span>
      {/if}
    </p>

    {#each accounts.rows as row (row.slug)}
      <div class="row" class:current={row.active}>
        <span class="ident">
          {#if row.active}
            <!-- The account in use is a statement, not a button: pressing it
                 would do nothing. -->
            <span class="name" title={row.email}>{row.email}</span>
          {:else}
            <button
              class="name pick"
              disabled={accounts.busy !== null}
              title={`Switch to ${row.email}`}
              onclick={() => void switchAccount(row.slug)}
            >{row.email}</button>
          {/if}
          <span class="row-server" title={row.serverUrl}>{row.serverUrl}</span>
        </span>
        {#if row.active}
          <span class="mark" aria-label="In use" title="In use">✓</span>
        {/if}
        <!-- Every row can be removed, the one in use included: the alternative
             was signing out of everything to drop one sign-in. -->
        <button
          class="remove"
          aria-label={`Remove ${row.email}`}
          title={`Remove ${row.email}`}
          disabled={accounts.busy !== null}
          onclick={() => void accounts.remove(row.slug)}
        >×</button>
      </div>
    {/each}

    {#if accounts.rows.length === 0}
      <p class="empty">No account is signed in.</p>
    {/if}

    {#if accounts.notice}
      <p class="notice" role="status">{accounts.notice}</p>
    {/if}

    <div class="verbs">
      <button class="verb" onclick={add}>Add account</button>
      <button class="verb" onclick={signOut}>
        {accounts.rows.length > 1 ? "Sign out of all" : "Sign out"}
      </button>
    </div>

    <!-- Said every time the panel is open, not on a hover: removing an account
         is the one thing here that cannot be undone without the API password. -->
    <p class="note">
      Removing an account forgets its sign-in on this device. Its layout and
      reading settings are kept, so signing back in finds them. Removing the one
      in use moves the reader to the next account first.
    </p>
  </div>
{/if}

<style>
  .account {
    display: flex;
    align-items: center;
    flex: 0 1 auto;
    min-width: 0;
  }

  /* The account leaves the bar long before the rest of it does: measured on this
     bar the name and the address come to ~218px, so with the brand, the layout
     switch, the reading and theme triggers and the sync button around it, nothing
     is cut from about 650 upward and everything is cut below it. The panel is a
     sibling of this block and stays open at those widths — it is opened from the
     compact menu, and a fixed panel inside a hidden element would open onto
     nothing. */
  @media (max-width: 660px) {
    .account {
      display: none;
    }
  }

  /* Shrinks before anything else in the bar: the name identifies, it does not
     inform, and it already has a tooltip with its full text. */
  .who {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 150px;
    padding: 2px 6px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .who:hover,
  .who[aria-expanded="true"] {
    background: var(--hover);
    color: var(--text);
  }

  /* The address sits beside the name and takes the slack: when the bar runs
     tight it is the first thing to lose characters, because a truncated address
     still says which box you are on while a truncated name says nothing. */
  .server {
    flex: 1 1 auto;
    min-width: 0;
    max-width: 30ch;
    padding: 2px 2px 2px 5px;
    color: var(--muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: default;
  }

  /* Fixed, like the Reading and Settings panels: the compact menu opens this
     one at widths where the name is not drawn, and a box anchored to a hidden
     trigger is a panel nobody can see. */
  .panel {
    position: fixed;
    top: 52px;
    left: 12px;
    z-index: 70;
    width: 296px;
    max-height: calc(100vh - 68px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px 10px 10px;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
    font-size: 12px;
    color: var(--text-dim);
  }

  .title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    margin: 0 0 4px;
    padding: 2px 2px 6px;
    border-bottom: 1px solid var(--border-soft);
    color: var(--muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .checking {
    font-weight: 400;
    text-transform: none;
    letter-spacing: 0;
    color: var(--muted);
  }

  /* One account: the name on the first line, the server under it, and one action
     at the right. The row for the account in use adds the tick in front of that
     action; it does not lose the action. */
  .row {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
  }

  .ident {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .name {
    min-width: 0;
    padding: 2px 5px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12px;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pick {
    cursor: pointer;
    color: var(--text-dim);
  }

  .pick:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .pick:disabled {
    opacity: 0.55;
    cursor: default;
  }

  .row-server {
    padding: 0 5px 2px;
    color: var(--muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mark {
    flex: 0 0 auto;
    padding: 0 6px;
    color: var(--accent);
    font-size: 12px;
  }

  .remove {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
  }

  .remove:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .remove:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .empty,
  .notice,
  .note {
    margin: 6px 2px 0;
    font-size: 11px;
    line-height: 1.35;
  }

  .empty,
  .note {
    color: var(--muted);
  }

  /* A refusal is worth reading: it says what to do next, not only that
     something failed. */
  .notice {
    padding: 5px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-alt);
    color: var(--text-dim);
  }

  .verbs {
    display: flex;
    gap: 4px;
    margin-top: 8px;
  }

  .verb {
    flex: 1 1 0;
    padding: 5px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .verb:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
