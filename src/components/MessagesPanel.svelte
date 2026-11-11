<script lang="ts">
  /**
   * Messages, as the Settings section draws them.
   *
   * One list, newest first, and nothing to press: opening the section is what
   * marks it read, so there is no per-message control to miss and no badge to
   * clear by hand. A message is the app's author writing to an account — an
   * outage, a promotion, "your lifetime upgrade is on the account" — so the row
   * is title, date, then the words, and that is all.
   *
   * Two things it refuses to do:
   *
   * - **Never draw an empty list where the truth is "could not ask".** A failed
   *   fetch with no cached copy says why it failed; a cached copy is drawn with
   *   the sentence that says it is the last one this device saw.
   * - **Never draw "no messages" for a signed-out device.** The section is
   *   filtered out entirely in that case (`SettingsPanel`), because an inbox
   *   belongs to an account, and there is nothing to show without one.
   */
  import { inbox } from "../state/inbox.svelte";

  /** Whether the section this panel sits in is expanded. */
  let { open = false }: { open?: boolean } = $props();

  /**
   * The date, in the shape the post list uses: short, no time of day.
   *
   * Built in the script because a template-only helper is elided by the suite
   * that renders this component through Svelte's server target.
   */
  function when(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function isoOf(ms: number): string {
    return new Date(ms).toISOString();
  }

  /**
   * Opening the list is reading it.
   *
   * `load()` is awaited first so the ids marked read are the ones actually on
   * screen — and it is shared with the panel's own count fetch, so opening the
   * section costs one more request at most, never a second copy of the list.
   */
  $effect(() => {
    if (!open) return;
    void (async () => {
      await inbox.load();
      await inbox.readAll();
    })();
  });
</script>

{#if inbox.status === "loading" && inbox.messages.length === 0}
  <p class="note" role="status">Checking for messages…</p>
{:else if inbox.status === "failed"}
  <p class="note" role="status">{inbox.reason}</p>
{:else if inbox.messages.length === 0}
  <p class="note">
    No messages. Notes about HardlyReader, your account, or a promotion will appear here — nothing pops
    up on screen when one arrives.
  </p>
{:else}
  {#if inbox.reason !== null}
    <p class="note" role="status">{inbox.reason}</p>
  {/if}
  <ul class="msgs">
    {#each inbox.messages as message (message.id)}
      <li class="msg" class:unread={message.readAt === null}>
        <p class="head">
          {#if message.readAt === null}<span class="dot" aria-label="Unread"></span>{/if}
          <span class="title">{message.title}</span>
          <time class="when" datetime={isoOf(message.publishedAt)}>{when(message.publishedAt)}</time>
        </p>
        <p class="body">{message.body}</p>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .msgs {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .msg {
    padding: 6px 0 12px;
    border-bottom: 1px solid var(--border-soft);
    min-width: 0;
  }

  .msg:last-child {
    border-bottom: 0;
    padding-bottom: 2px;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0 0 4px 0;
    min-width: 0;
  }

  .dot {
    flex: 0 0 auto;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
    transform: translateY(-1px);
  }

  .title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
  }

  .when {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  .body {
    margin: 0;
    font-size: 12px;
    line-height: 1.6;
    color: var(--text-dim);
    /* A message is prose: a line break the author wrote is a line break. */
    white-space: pre-line;
    max-width: 62ch;
  }

  .note {
    margin: 0 0 8px 0;
    font-size: 11px;
    line-height: 1.6;
    color: var(--muted);
    max-width: 62ch;
  }
</style>
