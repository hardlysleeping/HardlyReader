<script lang="ts">
  import { isRead, isStarred } from "../api/freshrss";
  import { absoluteTime } from "../lib/format";
  import { hardenLinks, isExternalHttp, sanitizeArticle } from "../lib/sanitize";
  import { reader } from "../state/reader.svelte";
  import { reading } from "../state/reading.svelte";

  let { onClose }: { onClose?: () => void } = $props();

  let scroller = $state<HTMLElement | null>(null);
  let lastAdvance = 0;

  function reduceMotion(): boolean {
    return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** Where the article is, so the key map and the wheel both know if it can move. */
  function onscroll(): void {
    const el = scroller;
    if (!el) return;
    reader.setArticleScroll(el.scrollTop <= 2, el.scrollTop + el.clientHeight >= el.scrollHeight - 2);
  }

  function atEnd(el: HTMLElement): boolean {
    return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
  }

  /**
   * Scrolling past the end of an article moves to the next one, and past the end
   * of a feed into the next feed. It only fires when the article itself cannot
   * scroll further, and it is debounced so one trackpad flick cannot skip three
   * articles.
   */
  function onwheel(event: WheelEvent): void {
    const el = scroller;
    if (!reading.advanceOnScroll || !el || event.deltaY <= 0 || !atEnd(el)) return;
    const now = Date.now();
    if (now - lastAdvance < 350) return;
    lastAdvance = now;
    void reader.advanceArticle(1);
  }

  // A new article starts at its top, and the scroll flags must not carry over
  // from the previous one or Space would immediately advance again.
  $effect(() => {
    const id = reader.selectedId;
    if (id === null) return;
    const el = scroller;
    if (!el) return;
    el.scrollTop = 0;
    reader.setArticleScroll(true, el.scrollHeight <= el.clientHeight + 2);
  });

  const item = $derived(reader.selected);

  const body = $derived(
    sanitizeArticle(item?.content?.content ?? item?.summary?.content ?? ""),
  );

  const link = $derived(item?.alternate?.[0]?.href ?? item?.canonical?.[0]?.href ?? "");

  async function openExternal(url: string): Promise<void> {
    if (!isExternalHttp(url)) return;
    if ("__TAURI_INTERNALS__" in globalThis) {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }

  /** Feed links must leave the app, not replace it. */
  function intercept(event: MouseEvent): void {
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    event.preventDefault();
    void openExternal(anchor.getAttribute("href") ?? "");
  }

  /**
   * `html` is always the output of `sanitizeArticle()` above, which runs the
   * feed markup through DOMPurify with scripts, frames, forms and inline styles
   * removed. Assigning it here is the only place sanitised feed HTML is written
   * to the DOM; nothing raw from the server reaches this node.
   */
  function attach(node: HTMLElement, html: string) {
    node.innerHTML = html;
    hardenLinks(node);
    // Delegated here rather than via an inline handler: the markup is feed HTML,
    // not Svelte-owned elements, and keyboard users activate the links directly.
    node.addEventListener("click", intercept);
    return {
      update(next: string) {
        node.innerHTML = next;
        hardenLinks(node);
      },
      destroy() {
        node.removeEventListener("click", intercept);
      },
    };
  }
</script>

<section class="reader" aria-label="Article">
  {#if item}
    <header class="toolbar">
      <button class="icon" onclick={() => onClose?.()} aria-label="Back to list">←</button>
      <button
        class="icon"
        aria-label="Previous article"
        title="Previous article — ↑ to change feed, these move through posts and into the previous feed"
        onclick={() => void reader.advanceArticle(-1)}
      >↑</button>
      <button
        class="icon"
        aria-label="Next article"
        title="Next article — continues into the next feed at the end of this one"
        onclick={() => void reader.advanceArticle(1)}
      >↓</button>
      <div class="spacer"></div>
      <button
        class="icon flow"
        class:on={reading.advanceOnScroll}
        aria-pressed={reading.advanceOnScroll}
        aria-label="Continue to the next article when scrolling past the end"
        title={reading.advanceOnScroll
          ? "Scrolling past the end continues to the next article — click to stop at the end of each article"
          : "Scrolling stops at the end of each article — click to continue into the next one"}
        onclick={() => reading.toggleAdvance()}
      >⇣</button>
      <button
        class="icon star"
        class:on={isStarred(item)}
        aria-pressed={isStarred(item)}
        aria-label={isStarred(item) ? "Remove star" : "Add star"}
        onclick={() => reader.toggleStar(item)}
        title={isStarred(item) ? "Starred" : "Star"}
      >★</button>
      <button
        class="icon"
        aria-label={isRead(item) ? "Mark unread" : "Mark read"}
        title={isRead(item) ? "Mark unread" : "Mark read"}
        onclick={() => reader.setRead(item, !isRead(item))}
      >{isRead(item) ? "◯" : "●"}</button>
      {#if link}
        <button class="icon" aria-label="Open original" title="Open original" onclick={() => openExternal(link)}>
          ↗
        </button>
      {/if}
    </header>

    <article bind:this={scroller} data-scroll="article" {onscroll} {onwheel}>
      <h1>{item.title || "(untitled)"}</h1>
      <p class="byline">
        <span>{item.origin?.title ?? ""}</span>
        {#if item.author}<span>· {item.author}</span>{/if}
        <span>· {absoluteTime(item.timestampUsec, item.published)}</span>
      </p>

      {#if body}
        <div class="content" use:attach={body}></div>
      {:else}
        <p class="no-content">This item has no content. <button class="inline" onclick={() => openExternal(link)}>Open the original</button>.</p>
      {/if}
    </article>
  {:else}
    <div class="placeholder">
      <p>Select an article.</p>
    </div>
  {/if}
</section>

<style>
  .reader {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    overflow: hidden;
    background: var(--bg);
  }

  .toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    height: 40px;
    padding: 0 10px;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }

  .spacer {
    flex: 1;
  }

  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border: 0;
    border-radius: 7px;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
  }

  .icon:hover {
    background: var(--hover);
    color: var(--text);
  }

  .star.on {
    color: var(--star);
  }

  .flow.on {
    color: var(--accent-text, #6cb0f5);
  }

  article {
    flex: 1;
    overflow-y: auto;
    padding: 22px clamp(16px, 5vw, 48px) 64px;
    max-width: 780px;
    width: 100%;
    margin: 0 auto;
  }

  h1 {
    margin: 0 0 8px;
    font-size: clamp(19px, 2.1vw, 24px);
    line-height: 1.25;
    letter-spacing: -0.015em;
  }

  .byline {
    margin: 0 0 22px;
    font-size: 12px;
    color: var(--muted);
  }

  .content {
    font-size: 15px;
    line-height: 1.65;
    color: var(--text);
    overflow-wrap: anywhere;
  }

  .content :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 4px;
  }

  .content :global(pre) {
    overflow-x: auto;
    padding: 12px;
    border-radius: 8px;
    background: var(--surface);
    font-size: 12.5px;
  }

  .content :global(code) {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.92em;
  }

  .content :global(blockquote) {
    margin: 0 0 1em;
    padding-left: 14px;
    border-left: 2px solid var(--border);
    color: var(--text-dim);
  }

  .content :global(a) {
    color: var(--accent-text);
  }

  .content :global(table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  .content :global(td),
  .content :global(th) {
    padding: 4px 8px;
    border: 1px solid var(--border);
  }

  .no-content,
  .placeholder {
    color: var(--muted);
    font-size: 13px;
  }

  .placeholder {
    display: grid;
    place-items: center;
    height: 100%;
  }

  .inline {
    border: 0;
    background: none;
    color: var(--accent-text);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
