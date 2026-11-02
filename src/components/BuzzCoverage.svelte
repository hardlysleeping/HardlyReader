<script lang="ts">
  /**
   * One story, as each feed told it.
   *
   * This is the third pane while a story is open in Buzz and no post has been
   * chosen yet. It is the answer to "why is this one story" — the same event,
   * written four ways — and it is the only honest way to show coverage: a list of
   * headlines side by side, each one a thing a feed really published.
   *
   * No synthetic read state, no synthetic headline, no summary of our own: a line
   * here is one feed's post, and pressing it opens that post through the reader's
   * own selection — which is what makes Back land here again rather than
   * somewhere this component invented.
   */
  import { buzz } from "../state/buzz.svelte";

  /** "just now", "40m", "6h", "3d" — age, not a clock. */
  function ageOf(at: number, now: number = Date.now()): string {
    const minutes = Math.max(0, Math.round((now - at) / 60000));
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  const story = $derived(buzz.story);
</script>

{#if story !== null}
  <section class="coverage" aria-label={story.title}>
    <header class="head">
      <p class="count">
        {story.sourceCount} {story.sourceCount === 1 ? "feed" : "feeds"} · {ageOf(story.newest)}
      </p>
      <h1>{story.title}</h1>
      {#if buzz.topic !== null}
        <p class="topic">In {buzz.topic.name}</p>
      {/if}
    </header>

    <div class="lines">
      {#each story.articles as article (article.id)}
        <button class="line" onclick={() => buzz.openArticle(article)}>
          <span class="feed">{article.origin?.title ?? "A feed"}</span>
          <span class="title">{article.title}</span>
          <span class="age">{ageOf(article.published ?? story.newest)}</span>
        </button>
      {/each}
    </div>

    <p class="note">
      Every line is a post a feed published. Opening one is the same as opening it
      from a list — leaving it puts this back.
    </p>
  </section>
{:else}
  <div class="coverage empty"></div>
{/if}

<style>
  .coverage {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--bg);
  }

  .head {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 16px 18px 12px;
    border-bottom: 1px solid var(--edge-soft);
  }

  .head h1 {
    margin: 0;
    font-size: 16px;
    line-height: 1.3;
    font-weight: 600;
    color: var(--text);
  }

  .count,
  .topic {
    margin: 0;
    font-size: 11.5px;
    color: var(--muted);
  }

  .lines {
    display: flex;
    flex-direction: column;
  }

  /* One telling per line: who said it, what they called it, when. The feed name
     keeps a fixed column so the headlines line up and the difference between
     them is what the eye compares. */
  .line {
    display: grid;
    grid-template-columns: minmax(72px, 26%) 1fr auto;
    gap: 10px;
    align-items: baseline;
    padding: 11px 18px;
    border: 0;
    border-bottom: 1px solid var(--border-soft);
    background: none;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .line:hover {
    background: var(--hover);
  }

  .feed {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
    color: var(--text-dim);
  }

  .title {
    font-size: 13px;
    line-height: 1.35;
    color: var(--text);
  }

  .age {
    font-size: 11px;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }

  .note {
    margin: 0;
    padding: 12px 18px 18px;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--muted);
  }
</style>
