<script lang="ts">
  /**
   * One post, opened where it stands.
   *
   * The reader's other surface is a pane: the list gives way to a page that owns
   * the column, and coming back is a navigation. This one is the row itself
   * growing — the headline it already had, the text underneath, and a press that
   * folds it away again. Nothing moves: the list keeps its scroll and its place,
   * and the post being read is the one in front of you.
   *
   * The body is the article pane's own pipeline, deliberately: the feed's HTML,
   * the extraction preference when it is on, the per-article choice the pane
   * writes, and `bodyFor` deciding between them. Two surfaces that disagreed
   * about which text is the article would be two readers.
   */
  import { type StreamItem } from "../api/freshrss";
  import {
    bodyFor,
    extractFor,
    imageSources,
    rememberedExtraction,
    sameImage,
    type Extracted,
  } from "../lib/extract";
  import { ledger } from "../lib/extract-ledger";
  import { looksTruncated, wantsFullText } from "../lib/full-text";
  import { hardenLinks, isExternalHttp, prepareImages, sanitizeArticle } from "../lib/sanitize";
  import { thumbnailOf, type ThumbSource } from "../lib/thumb";
  import { reader } from "../state/reader.svelte";
  import { reading } from "../state/reading.svelte";

  let { item, oncollapse }: { item: StreamItem; oncollapse: () => void } = $props();

  const link = $derived(item.alternate?.[0]?.href ?? item.canonical?.[0]?.href ?? "");
  const source = $derived(isExternalHttp(link) ? link : null);

  /** The feed's own HTML: always there, and the fallback once a page is fetched. */
  const feedBody = $derived(sanitizeArticle(item.content?.content ?? item.summary?.content ?? ""));

  let extracted = $state<Extracted | null>(null);
  let extractedFor = $state<string | null>(null);

  /**
   * What the reader asked for on this post in the article pane, if anything.
   *
   * One post read in two places must not disagree about which text is the
   * article, so the row honours the pane's own per-article choice — including
   * "give me the feed's version", which is why it does not ask the network at
   * all.
   */
  const choice = $derived(ledger.choice(item.id));

  /** The feed's own answer, and Auto's verdict about it, are the feed's. */
  const feedId = $derived(item.origin?.streamId ?? null);

  $effect(() => {
    const id = item.id;
    const url = link;
    // The same rule the pane asks (`wantsFullText`), so a row opened in the
    // posts column and the same post in the article column cannot disagree
    // about which text the article is.
    const wanted = wantsFullText({
      post: choice,
      feed: reader.feedExtract(feedId),
      accountWide: reading.extract,
      remembered: reader.feedTruncated(feedId),
      html: feedBody,
    });

    // The row is the only surface on a phone reading in the list, so it writes
    // Auto's verdict too. Idempotent: the ledger keeps one per feed.
    if (wanted && reader.feedExtract(feedId) === "auto" && looksTruncated(feedBody)) {
      reader.noteFeedTruncated(feedId);
    }

    if (!wanted || url === "") {
      extracted = null;
      extractedFor = null;
      return;
    }

    const remembered = rememberedExtraction(id);
    if (remembered) {
      extracted = remembered;
      extractedFor = id;
      return;
    }

    extracted = null;
    extractedFor = null;
    let cancelled = false;
    void extractFor(id, url).then((result) => {
      // A page that lands after the post was folded away must not be pasted over
      // whatever is on screen now.
      if (cancelled || result === null) return;
      extracted = result;
      extractedFor = id;
    });
    return () => {
      cancelled = true;
    };
  });

  const body = $derived(
    sanitizeArticle(bodyFor(choice, extractedFor === item.id ? extracted : null, feedBody).html),
  );

  let brokenLead = $state(false);

  /** The feed's picture above the words, unless the words already carry it. */
  const lead = $derived.by(() => {
    if (!reading.articleImage || brokenLead) return null;
    const url = thumbnailOf(item as ThumbSource).url;
    if (!url) return null;
    if (imageSources(body).some((src) => sameImage(src, url))) return null;
    return url;
  });

  async function openExternal(url: string): Promise<void> {
    if (!isExternalHttp(url)) return;
    if ("__TAURI_INTERNALS__" in globalThis) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  /** A feed's link leaves the app rather than replacing the list it is in. */
  function intercept(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    event.preventDefault();
    void openExternal(anchor.getAttribute("href") ?? "");
  }

  /**
   * `html` is `sanitizeArticle()`'s output — the only place sanitised feed
   * markup reaches the DOM. The policy and the pictures are applied to the
   * parsed elements, not to the string: DOMPurify drops `referrerpolicy`, so
   * writing it into the markup achieves nothing.
   */
  function attach(node: HTMLElement, html: string) {
    node.innerHTML = html;
    hardenLinks(node);
    prepareImages(node);
    node.addEventListener("click", intercept);
    return {
      update(next: string) {
        node.innerHTML = next;
        hardenLinks(node);
        prepareImages(node);
      },
      destroy() {
        node.removeEventListener("click", intercept);
      },
    };
  }
</script>

<!-- The row grew, and this is the far side of it: the post itself, with the one
     press that folds it back. Clicks here are clicks on text, never on the row
     underneath it. -->
<div class="inline" data-inline={item.id}>
  <div class="bar">
    <span class="where">Reading here</span>
    <div class="spacer"></div>
    <button
      class="act fold"
      aria-label="Collapse this post"
      title="Collapse this post"
      onclick={(event) => {
        event.stopPropagation();
        oncollapse();
      }}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 10.5 8 6l4.5 4.5" /></svg>
    </button>
  </div>

  {#if lead}
    <img
      class="lead"
      src={lead}
      alt=""
      decoding="async"
      referrerpolicy="no-referrer"
      draggable="false"
      onerror={() => (brokenLead = true)}
    />
  {/if}

  {#if body}
    <div class="content" use:attach={body}></div>
  {:else}
    <p class="empty">
      This post has no text of its own.{#if source !== null}
        <button class="link" onclick={() => void openExternal(source)}>Open the original</button
        >.{/if}
    </p>
  {/if}
</div>

<style>
  .inline {
    /* The page, inside the row: the list's own surface gives way to the reading
       one, and the row's edges stay where they were. */
    flex: 1 0 100%;
    min-width: 0;
    padding: 10px 12px 18px;
    border-top: 1px solid var(--edge-soft);
    background: var(--bg);
    cursor: auto;
    user-select: text;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 8px;
  }

  .where {
    font-size: 10.5px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .spacer {
    flex: 1;
  }

  .act {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: none;
    color: var(--text-dim);
    cursor: pointer;
  }

  .act svg {
    width: 13px;
    height: 13px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .act:hover {
    background: var(--hover);
    color: var(--text);
  }

  .lead {
    display: block;
    width: auto;
    max-width: min(100%, 780px);
    height: auto;
    margin: 0 auto 16px;
    object-fit: contain;
    background: var(--hover);
  }

  /* Size, leading and alignment come from the same custom properties the
     article pane reads, so a step of A− / A+ is the same step here. */
  .content {
    /* The same readable measure as the article pane, so a wide window does not
       turn the post into a line across the whole column. */
    max-width: 780px;
    margin-inline: auto;
    font-size: calc(14.5px * var(--read-scale, 1));
    line-height: var(--read-leading, 1.65);
    text-align: var(--read-align, left);
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .content :global(img) {
    display: block;
    width: auto;
    max-width: 100%;
    height: auto;
    object-fit: contain;
    margin: 1em auto;
  }

  .content :global(pre) {
    overflow-x: auto;
    padding: 10px;
    border-radius: 8px;
    background: var(--surface);
    font-size: 12px;
  }

  .content :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
  }

  .content :global(blockquote) {
    margin: 0 0 1em;
    padding-left: 12px;
    border-left: 2px solid var(--border);
    color: var(--text-dim);
  }

  .content :global(a) {
    color: var(--accent-text);
  }

  .content :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 12.5px;
  }

  .content :global(td),
  .content :global(th) {
    padding: 4px 8px;
    border: 1px solid var(--border);
  }

  .empty {
    margin: 0;
    font-size: 12.5px;
    color: var(--muted);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    cursor: pointer;
  }
</style>
