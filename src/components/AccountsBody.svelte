<script lang="ts">
  /**
   * The account list itself: who is in use, who else is on this device, and the
   * two verbs that change that.
   *
   * It is a separate file because it is drawn in two frames — the panel behind
   * the name in the bar, and the Accounts section of the settings sheet — and a
   * second copy of these rows is how "add", "switch" and "remove" end up
   * disagreeing about what they do. The frame decides where it sits and what
   * closes it; this file owns the rows.
   */
  import { accounts } from "../state/accounts.svelte";

  let {
    onadd,
    onsignout,
  }: {
    onadd?: () => void;
    onsignout?: () => void;
  } = $props();

  async function switchAccount(slug: string): Promise<void> {
    await accounts.switchTo(slug);
  }
</script>

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
  <button class="verb" onclick={() => onadd?.()}>Add account</button>
  <button class="verb" onclick={() => onsignout?.()}>
    {accounts.rows.length > 1 ? "Sign out of all" : "Sign out"}
  </button>
</div>

<!-- Said every time this is drawn, not on a hover: removing an account is the
     one thing here that cannot be undone without the API password. -->
<p class="note">
  Removing an account forgets its sign-in on this device. Its layout and reading
  settings are kept, so signing back in finds them. Removing the one in use moves
  the reader to the next account first.
</p>

<style>
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
