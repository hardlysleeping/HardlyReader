<script lang="ts">
  /**
   * The HardlyReader account, in the settings sheet.
   *
   * Three states and one rule each, and the rule is the reason the state exists:
   *
   * - **signed out** — the three doors, one button each. An account is only ever
   *   for HardlyReader Sync; the library on this device works without one, and the
   *   lead sentence says so before any button is pressed.
   * - **signed in** — which door, plus **Add Google / Add Apple** for the doors the
   *   account does *not* have. Those call `link()`, never `signIn()`: a second
   *   sign-in is how one person ends up with two `auth.users` rows and a purchase
   *   attached to the other one. The seam refuses it, and this sheet never offers it.
   * - **deleting** — two presses, and the second may be refused while Stripe is
   *   still charging. That refusal is a sentence with somewhere to go (the payment
   *   portal), not a dead end.
   *
   * What is *not* drawn here is as deliberate as what is: no "also delete my cloud
   * files" checkbox. That is a separate action (`PROVIDER_FILES_ACTION`), it has no
   * implementation until the first provider exists, and a deletion must never be
   * read as permission to empty a reader's folder.
   *
   * Every decision is `state/cloud-account.svelte.ts`; this file draws it. The
   * default is the app's one surface, and the prop exists so a suite can hand it
   * another.
   */
  import { onMount } from "svelte";
  import { PROVIDER_LABEL, type IdentityProvider } from "../api/identity";
  import { cloudAccount, type CloudAccount } from "../state/cloud-account.svelte";

  let { account = cloudAccount }: { account?: CloudAccount } = $props();

  /** The address typed into the email door. */
  let address = $state("");
  /** The address typed into a change of address. */
  let newAddress = $state("");

  /**
   * Asked once, when the sheet is opened — not at launch.
   *
   * `opened()` is where a session that came back through a provider's redirect is
   * picked up (the provider's client wrote it after this app read its storage), and
   * where the device list is read. Nothing awaits it: a list that is slow, or a
   * server that does not answer, must not hold up a reader who opened Settings.
   */
  onMount(() => {
    void account.opened();
  });

  async function signInWith(provider: IdentityProvider): Promise<void> {
    await account.signIn(provider, provider === "email" ? address.trim() : undefined);
  }

  async function addDoor(provider: IdentityProvider): Promise<void> {
    await account.link(provider);
  }

  async function changeAddress(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await account.link("email", newAddress.trim());
  }
</script>

{#if !account.signedIn}
  <!-- Signed out: the three doors. The lead sentence is the promise the rest of
       the app keeps — nothing is asked for until Sync is asked for. -->
  <p class="lead">
    An account is only for HardlyReader Sync. Your library on this device works without one.
  </p>

  <div class="doors">
    <button class="door" disabled={account.busy !== null} onclick={() => void signInWith("google")}>
      {account.busy === "signIn" ? "Opening…" : "Continue with Google"}
    </button>
    <button class="door" disabled={account.busy !== null} onclick={() => void signInWith("apple")}>
      Continue with Apple
    </button>
  </div>

  <form class="address" onsubmit={(event) => changeAddress(event)}>
    <input
      type="email"
      class="field"
      bind:value={address}
      placeholder="you@example.com"
      aria-label="Email address for a sign-in link"
      autocomplete="email"
    />
    <button class="door" type="submit" disabled={account.busy !== null}>Email me a link</button>
  </form>
{:else}
  <!-- Signed in: which door, and then only the doors this account does not have. -->
  <p class="who">
    Signed in with <strong>{account.providerLabel}</strong>
    {#if account.email}<span class="address-line" title={account.email}>{account.email}</span>{/if}
  </p>

  {#if account.doorsToAdd.length > 0}
    <div class="doors">
      {#each account.doorsToAdd as door (door)}
        <button class="door" disabled={account.busy !== null} onclick={() => void addDoor(door)}>
          {account.busy === "link" ? "Adding…" : `Add ${PROVIDER_LABEL[door]}`}
        </button>
      {/each}
    </div>
    <p class="note">
      Adding a door keeps this the same account, so the subscription stays where it is.
      Signing in a second time would not.
    </p>
  {/if}

  <details class="change">
    <summary class="change-sum">Change the email address</summary>
    <form class="address" onsubmit={(event) => changeAddress(event)}>
      <input
        type="email"
        class="field"
        bind:value={newAddress}
        placeholder={account.email ?? "you@example.com"}
        aria-label="New email address"
        autocomplete="email"
      />
      <button class="door" type="submit" disabled={account.busy !== null}>Send the confirmation</button>
    </form>
  </details>

  <!-- The devices, as the server lists them: one row per session, newest first,
       and this one marked. Revoking this device is the reader signing out here. -->
  <p class="title">
    Devices
    {#if account.devicesState === "loading"}<span class="checking">checking…</span>{/if}
  </p>

  {#each account.deviceRows as device (device.id)}
    <div class="device" class:here={device.current}>
      <span class="ident">
        <span class="label">
          {device.label || "Device"}
          {#if device.current}<span class="mark">This device</span>{/if}
        </span>
        <span class="meta">
          {device.platform === "" ? "signed in" : device.platform} · seen {account.lastSeen(device.lastSeenAt)}
        </span>
      </span>
      <button
        class="verb"
        disabled={account.busy !== null}
        title={device.current ? "Revoking this device signs this one out" : `Revoke ${device.label || "this device"}`}
        onclick={() => void account.revoke(device)}
      >Revoke</button>
    </div>
  {:else}
    {#if account.devicesState !== "loading"}
      <p class="note">No device is listed yet. This one appears once its sign-in has been registered.</p>
    {/if}
  {/each}
{/if}

{#if account.notice}
  <p class="notice" role="status">{account.notice}</p>
{/if}
{#if account.note}
  <p class="notice" role="status">{account.note}</p>
{/if}

{#if account.signedIn}
  <!-- The two presses. The first one sends nothing, and says what the second one
       will and will not touch. -->
  <div class="end">
    {#if !account.confirmingDelete}
      <button class="verb danger" onclick={() => account.askDelete()}>Delete my account</button>
    {:else}
      <p class="warn">
        Deleting removes your HardlyReader account and its subscription record. Your library on
        this device is not touched, and neither is your own cloud folder.
      </p>
      <div class="verbs">
        <button class="verb danger" disabled={account.busy !== null} onclick={() => void account.confirmDelete()}>
          {account.busy === "delete" ? "Deleting…" : "Delete my account"}
        </button>
        <button class="verb" disabled={account.busy !== null} onclick={() => account.cancelDelete()}>
          Keep it
        </button>
      </div>
    {/if}

    <!-- The way out of a refused deletion. Drawn only when the refusal was
         `cancel_first`: an account still being charged cannot be deleted, and
         cancelling is the reader's own action at the payment provider. -->
    {#if account.needsCancel}
      <button class="verb" disabled={account.busy !== null} onclick={() => void account.manageSubscription()}>
        {account.busy === "portal" ? "Opening…" : "Manage subscription"}
      </button>
    {/if}
  </div>
{/if}

<style>
  .lead {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 11.5px;
    line-height: 1.4;
  }

  /* The doors, as a row of two: equal width, a thumb tall, and the same quiet
     border the rest of the sheet's buttons have. */
  .doors {
    display: flex;
    gap: 6px;
    padding: 2px 0 4px;
  }

  .door {
    flex: 1 1 0;
    min-height: 32px;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .door:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .door:disabled {
    opacity: 0.5;
    cursor: default;
  }

  /* The email door: the address takes the width, the button is the press. */
  .address {
    display: flex;
    gap: 6px;
    padding: 2px 0 4px;
  }

  .field {
    flex: 1 1 auto;
    min-width: 0;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-alt);
    color: var(--text);
    font: inherit;
    font-size: 12px;
  }

  .field:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 55%, transparent);
    outline-offset: 1px;
  }

  .address .door {
    flex: 0 0 auto;
  }

  /* Who, and through which door. The address is a second line, because it is the
     long string and the door is the one being checked. */
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    margin: 0 0 6px;
    color: var(--text);
    font-size: 12.5px;
  }

  .who strong {
    font-weight: 650;
  }

  .address-line {
    min-width: 0;
    color: var(--muted);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A section's own heading, quieter than the section's name above it. */
  .title {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 6px;
    margin: 10px 0 2px;
    padding: 2px 2px 5px;
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
  }

  /* One device: its name and its age on the left, one action on the right. */
  .device {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 0;
  }

  .ident {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-width: 0;
  }

  .label {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    color: var(--text);
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The row this window is reading in, marked rather than hidden: revoking it is
     allowed, and it is the reader signing out here. */
  .mark {
    flex: 0 0 auto;
    color: var(--accent);
    font-size: 10.5px;
  }

  .meta {
    color: var(--muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .change {
    margin-top: 6px;
    border-top: 1px solid var(--border-soft);
  }

  .change-sum {
    padding: 6px 2px 4px;
    cursor: pointer;
    color: var(--text-dim);
    font-size: 11.5px;
    list-style: none;
  }

  .change-sum::-webkit-details-marker {
    display: none;
  }

  .change-sum::before {
    content: "›";
    padding-right: 4px;
    color: var(--muted);
  }

  .change[open] > .change-sum::before {
    content: "⌄";
  }

  .change-sum:hover {
    color: var(--text);
  }

  .end {
    margin-top: 10px;
    padding-top: 6px;
    border-top: 1px solid var(--border-soft);
  }

  .verbs {
    display: flex;
    gap: 6px;
    padding: 2px 0;
  }

  .verbs .verb {
    flex: 1 1 0;
  }

  .verb {
    flex: 0 0 auto;
    padding: 4px 9px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 11.5px;
    cursor: pointer;
  }

  .verb:hover:not(:disabled) {
    background: var(--hover);
    color: var(--text);
  }

  .verb:disabled {
    opacity: 0.45;
    cursor: default;
  }

  /* Deleting is the one thing here that cannot be undone, so its press is the one
     that does not look like the others. */
  .danger {
    color: var(--danger, #d9534f);
    border-color: color-mix(in srgb, var(--danger, #d9534f) 45%, transparent);
  }

  .warn {
    margin: 2px 0 6px;
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.4;
  }

  .note {
    margin: 4px 2px 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.35;
  }

  /* A refusal, or what just happened: worth reading, and it says what to do next. */
  .notice {
    margin: 6px 0 0;
    padding: 5px 6px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-alt);
    color: var(--text-dim);
    font-size: 11px;
    line-height: 1.4;
  }
</style>
