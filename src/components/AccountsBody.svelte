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
   *
   * It is also where a device gets paired, because that is the same question as
   * "who is signed in here": a phone with no way to answer the login captcha
   * asks for a code, and a person on *this* signed-in device reads it and presses
   * approve. The press is the human check — the captcha was answered when this
   * account signed in, and approving says "yes, that phone, that code". Nothing
   * here bypasses anything: the code is five minutes long, single use, and bound
   * to this account the moment it is approved.
   *
   * The reverse verb is here too: a device that signed in by pairing can withdraw
   * its own credential, which is the whole point of it being a credential and not
   * a password.
   */
  import { accounts } from "../state/accounts.svelte";
  import { transport } from "../api/transport";
  import {
    approvePairing,
    pendingPairings,
    revokePairing,
    type PendingPairing,
  } from "../api/pairing";
  import { deviceTokenOf, pairingCountdown, PAIRING_POLL_MS } from "../lib/pairing";

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

  /* -------------------------------------------------------------------------
   * Pairing
   * ---------------------------------------------------------------------- */

  /** True while the pairing block is unfolded: nothing is asked for otherwise. */
  let pairingOpen = $state(false);
  /** Codes a phone is holding up right now, newest first. */
  let pending = $state<PendingPairing[]>([]);
  /** False once the server has said it has no pairing routes. */
  let pairAvailable = $state(true);
  /** The code whose approve press is in flight, so the row can say so. */
  let approving = $state<string | null>(null);
  let pairingNote = $state<string | null>(null);
  let revoking = $state(false);
  /** Ticks while the block is open, for the countdown on each code. */
  let now = $state(Date.now());
  let loading = false;

  /** The session in use, which is who an approved code would bind to. */
  const session = $derived(accounts.active);

  /** The device token this device signs in with, when it signed in by pairing. */
  const deviceToken = $derived(session === null ? null : deviceTokenOf(session.token));

  async function loadPending(): Promise<void> {
    const current = accounts.active;
    if (current === null || loading) return;
    loading = true;
    try {
      const answer = await pendingPairings(transport, current);
      pairAvailable = answer.available;
      pending = answer.pairings;
    } catch {
      // A read that failed leaves the last list up: the codes it holds are still
      // real for as long as their countdown says, and blanking them would look
      // like they had been withdrawn.
    } finally {
      loading = false;
    }
  }

  /**
   * The poll, while the block is unfolded.
   *
   * Only then: a desktop with the settings sheet shut is not asking the server
   * anything, and a code is worthless until somebody goes looking for it. Two
   * seconds is the same cadence the waiting phone uses, so the two screens agree
   * about when a code appeared.
   */
  $effect(() => {
    if (!pairingOpen) return;
    now = Date.now();
    void loadPending();
    const timer = setInterval(() => {
      now = Date.now();
      void loadPending();
    }, PAIRING_POLL_MS);
    return () => clearInterval(timer);
  });

  function refusal(reason: string): string {
    switch (reason) {
      case "expired":
        return "That code expired. Ask the phone for a new one.";
      case "used":
        return "That code was already used.";
      case "revoked":
        return "That code was withdrawn.";
      case "wrong_account":
        return "That code is already bound to another account.";
      case "wrong_code":
        return "No code is waiting with those digits.";
      case "already_approved":
        return "That code is already approved.";
      default:
        return "That code could not be approved.";
    }
  }

  async function approve(code: string): Promise<void> {
    const current = accounts.active;
    if (current === null || approving !== null) return;
    approving = code;
    pairingNote = null;
    try {
      const answer = await approvePairing(transport, current, code);
      if (answer.kind === "approved") {
        pairingNote = `Approved. That device is now signed in as ${answer.account}.`;
      } else if (answer.kind === "refused") {
        pairingNote = refusal(answer.reason);
      } else if (answer.kind === "unavailable") {
        pairAvailable = false;
        pairingNote = "This server does not offer pairing.";
      } else {
        pairingNote = "That code could not be approved.";
      }
      await loadPending();
    } finally {
      approving = null;
    }
  }

  /** Withdraws this device's own credential: the phone can let itself out. */
  async function revokeThisDevice(): Promise<void> {
    const current = accounts.active;
    const token = current === null ? null : deviceTokenOf(current.token);
    if (current === null || token === null || revoking) return;
    revoking = true;
    pairingNote = null;
    try {
      // The whole credential, not the bare `hrd_…`: the request authenticates as
      // this device, and the account half is what names the login. The server
      // takes the token out of the credential it authenticated, so nothing in the
      // body could point the revocation at another device.
      const answer = await revokePairing(transport, { serverUrl: current.serverUrl, token: current.token });
      pairingNote =
        answer.kind === "revoked"
          ? "This device's sign-in was revoked. It stays in the account list until you remove it or sign in again."
          : answer.kind === "unavailable"
            ? "This server does not offer pairing, so there is nothing here to revoke."
            : "The server did not accept the revocation.";
    } finally {
      revoking = false;
    }
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

<!-- The way back out for a device that signed in by pairing. Only drawn when
     this session's token is one the extension minted: an API-password sign-in
     has nothing here to revoke, and offering it would be a button that lies. -->
{#if deviceToken !== null}
  <div class="row">
    <span class="ident">
      <span class="name">This device</span>
      <span class="row-server">signed in by pairing — withdraw it and it signs out</span>
    </span>
    <button class="action" disabled={revoking} onclick={() => void revokeThisDevice()}>
      {revoking ? "Revoking…" : "Revoke"}
    </button>
  </div>
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

<!-- Pairing a device that cannot answer the login captcha. Folded away, because
     it is a thing you go looking for when a phone is in your hand — and the list
     is only asked for while it is open, so a closed sheet costs the server
     nothing. -->
<details class="pair" bind:open={pairingOpen}>
  <summary class="pair-sum">
    <span class="pair-label">Pair a device</span>
    <span class="pair-state">
      {#if !pairAvailable}
        not offered here
      {:else if pending.length === 0}
        none waiting
      {:else}
        {pending.length} waiting
      {/if}
    </span>
  </summary>

  <div class="pair-body">
    {#if !pairAvailable}
      <p class="note">
        This server's HardlyRead extension has no pairing routes yet. Sign the other
        device in with its API password.
      </p>
    {:else if pending.length === 0}
      <p class="note">
        No device is waiting. On the phone, choose “Pair this phone” — its code appears
        here, and approving it is what signs the phone in.
      </p>
    {:else}
      <ul class="pair-list">
        {#each pending as entry (entry.code)}
          <li class="pair-row">
            <span class="pair-code">{entry.code}</span>
            <span class="pair-meta">
              {entry.label === "" ? "Device" : entry.label} · expires in
              {pairingCountdown(entry, now)}
            </span>
            <button
              class="action approve"
              disabled={approving !== null}
              onclick={() => void approve(entry.code)}
            >{approving === entry.code ? "Approving…" : "Approve"}</button>
          </li>
        {/each}
      </ul>
      <p class="note">
        Approve only if the digits here match the ones on the device asking. A code
        signs one device in once, and binds it to this account.
      </p>
    {/if}

    {#if pairingNote}
      <p class="notice" role="status">{pairingNote}</p>
    {/if}
  </div>
</details>

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

  /* One row's own verb: the same quiet control as the ones above, but sized to
     the row it sits in rather than split across the panel. */
  .action {
    flex: 0 0 auto;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .action:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .action:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* The pairing block: a summary that reads as a row of the section, and a body
     that is only drawn while it is open. */
  .pair {
    margin-top: 6px;
    border-top: 1px solid var(--border-soft);
  }

  .pair-sum {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 2px 4px;
    cursor: pointer;
    color: var(--text-dim);
    font-size: 11.5px;
    list-style: none;
  }

  .pair-sum::-webkit-details-marker {
    display: none;
  }

  .pair-sum::before {
    content: "›";
    padding-right: 4px;
    color: var(--muted);
    transform: rotate(0deg);
    transition: transform 120ms ease;
  }

  .pair[open] > .pair-sum::before {
    transform: rotate(90deg);
  }

  .pair-sum:hover {
    color: var(--text);
  }

  .pair-label {
    flex: 1 1 auto;
  }

  .pair-state {
    color: var(--muted);
    font-size: 10.5px;
  }

  .pair-body {
    padding: 2px 2px 4px;
  }

  .pair-list {
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
  }

  /* The code is the thing to read: figures that line up, wide enough to be read
     from arm's length, and the two groups already spaced by the formatter. */
  .pair-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
  }

  .pair-code {
    flex: 0 0 auto;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: 0.06em;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }

  .pair-meta {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pair-row .approve {
    color: var(--accent);
    border-color: var(--accent);
  }
</style>
