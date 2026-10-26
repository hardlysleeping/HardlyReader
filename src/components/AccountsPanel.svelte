<script lang="ts">
  /**
   * The account in the bar, and the panel behind it.
   *
   * One account is in use; the others on this device are listed under it, one
   * press to switch to and one × to remove. Adding lives here too, because the
   * answer to "another account" is the login screen — the same form, opened
   * without touching the session already in use.
   *
   * The rows are `AccountsBody`, because the settings sheet draws the same list
   * in its own frame. This file is the frame the bar opens, and nothing else.
   *
   * The panel is `position: fixed` like the Reading and Settings panels: it is
   * opened from the name in the bar where there is room for one, and from the
   * compact menu when there is not, so it cannot be anchored to a trigger that a
   * narrow window hides.
   */
  import AccountsBody from "./AccountsBody.svelte";
  import { serverLabel } from "../lib/server-label";

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
    <AccountsBody onadd={add} onsignout={signOut} />
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
</style>
