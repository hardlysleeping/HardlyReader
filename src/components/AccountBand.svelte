<!--
  One account, as Pane 1 draws it when there is more than one.

  The band is a row and a fold, the way a category is: the caret is the arrow, the
  label is whose rows these are, and what is under it is that account's categories
  and feeds. It exists because "the account" and "the app" were the same thing until
  there was a second one — at which point a feed list with no owner on it is a list
  you cannot trust, because `feed/12` is a different feed on every server.

  Two things it is careful about:

  - **The account on screen is not drawn twice.** Its tree is the sidebar's own, so
    its band folds that tree and nothing else. Expanding another account folds *its*
    copy out, read-only: pins, hidden categories and drag order are each account's
    own answers, and this window does not compose them for an account it is not
    reading.
  - **A row from another account is a way there.** Pressing it switches account and
    opens the stream, in that order, because the id belongs to the account and not to
    the window — asking the account on screen for it would find a different feed or
    nothing.
-->
<script lang="ts">
  import { reader } from "../state/reader.svelte";
  import type { ReaderProfile } from "../api/profile";

  let { account }: { account: ReaderProfile } = $props();

  const focused = $derived(reader.isFocused(account.slug));
  const open = $derived(reader.isAccountGroupOpen(account.slug));
  const sidebar = $derived(reader.accountSidebars[account.slug]);
  const feeds = $derived(reader.feedCountIn(account.slug));

  // Opening a band reads it, once. The copy is the reader's, so closing and
  // reopening the band costs nothing; a sync replaces the copies it has (`force`).
  $effect(() => {
    if (open && !focused && sidebar === undefined) void reader.loadAccountSidebar(account.slug);
  });

  function toggle(): void {
    // The focused account has no copy of its own to fold out — its tree is below —
    // so its band only ever opens or closes that tree.
    void reader.toggleAccountGroup(account.slug);
  }

  async function openFeed(id: string, title: string): Promise<void> {
    await reader.openInAccount(account.slug, id, title);
  }
</script>

<div class="acct" data-account={account.slug} class:merged={account.enabled !== false}>
  <button
    class="acct-row"
    class:active={focused}
    aria-expanded={open}
    aria-label={`${open ? "Collapse" : "Expand"} ${account.label}`}
    onclick={toggle}
  >
    <span class="acct-fold">
      <svg class:up={open} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </span>
    <span class="acct-name">{account.label}</span>
    {#if account.enabled === false}
      <!-- Said, not hidden: a merged view that silently leaves an account out is the
           reader's own list lying about what it holds. -->
      <span class="acct-off">not merged</span>
    {/if}
    <span class="acct-count">{feeds}</span>
  </button>

  {#if open && !focused}
    {#if sidebar === undefined}
      <p class="acct-note">Reading…</p>
    {:else if sidebar.error !== null}
      <p class="acct-note">{sidebar.error}</p>
    {:else if sidebar.categories.length === 0}
      <p class="acct-note">No feeds in this account.</p>
    {:else}
      {#each sidebar.categories as category (category.id)}
        <div class="acct-group">
          <span class="acct-cat">{category.label}</span>
          {#each category.feeds as feed (feed.id)}
            <button class="acct-feed" onclick={() => void openFeed(feed.id, feed.title)}>
              <span class="acct-feed-name">{feed.title}</span>
              {#if (sidebar.counts.get(feed.id) ?? 0) > 0}
                <span class="acct-count">{(sidebar.counts.get(feed.id) ?? 0)}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  /* Ink and spacing from the sidebar's own grammar: a band is a row that happens to
     hold a tree, not a panel with its own type. */
  .acct {
    border-bottom: 1px solid var(--line, rgba(128, 128, 128, 0.18));
  }

  .acct-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: var(--feed-row-h, 30px);
    padding: 0 8px;
    background: none;
    border: 0;
    color: var(--ink-soft, #999);
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
  }

  .acct-row.active {
    color: var(--ink, #eee);
  }

  /* Not merged is a state of the reader's list, so it is drawn in the list's ink and
     nothing louder. */
  .acct.merged .acct-off {
    display: none;
  }

  .acct-off {
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    opacity: 0.55;
  }

  .acct-fold svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 120ms ease;
    transform: rotate(-90deg);
  }

  .acct-fold svg.up {
    transform: rotate(0deg);
  }

  .acct-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acct-count {
    font-variant-numeric: tabular-nums;
    font-size: 11px;
    opacity: 0.65;
  }

  .acct-group {
    padding: 2px 0 6px;
  }

  .acct-cat {
    display: block;
    padding: 2px 8px 3px 27px;
    font-size: 11px;
    letter-spacing: 0.02em;
    text-transform: uppercase;
    opacity: 0.6;
  }

  .acct-feed {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    width: 100%;
    min-height: var(--feed-row-h, 30px);
    padding: 0 8px 0 27px;
    background: none;
    border: 0;
    color: var(--ink-soft, #999);
    font: inherit;
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }

  .acct-feed:hover,
  .acct-feed:focus-visible {
    color: var(--ink, #eee);
    background: var(--hover, rgba(128, 128, 128, 0.1));
  }

  .acct-feed-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .acct-note {
    margin: 0;
    padding: 4px 8px 8px 27px;
    font-size: 12px;
    opacity: 0.65;
  }
</style>
