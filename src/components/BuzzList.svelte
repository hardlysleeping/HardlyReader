<script lang="ts">
/**
 * The stories, in the posts pane.
 *
 * One row per story: the headline one of the feeds wrote, how many feeds are
 * carrying it, and how long ago it moved. Pressing a row opens the coverage —
 * the same story as each feed told it — and pressing a line in that opens the
 * post itself, which is the reader's own selection and nothing Buzz invented.
 *
 * Buzz never writes a headline. The title is the representative article's own,
 * chosen by the engine as the one closest to everything else in the story, so
 * what you read in the row is something a feed actually published.
 */

import { buzz } from "../state/buzz.svelte";

/** "just now", "40m", "6h", "3d" — coarse on purpose: this is age, not a clock. */
function ageOf(at: number, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}


</script>

<section class="buzz" data-pane="posts" aria-label="Buzz">
  <header class="head">
    <h1>Buzz</h1>
    {#if buzz.topic !== null}
      <span class="where">{buzz.topic.name}</span>
    {/if}
    <span class="count">{buzz.count} {buzz.count === 1 ? "story" : "stories"}</span>
  </header>

  <div class="items" data-scroll-axis="y">
    {#if buzz.loading && buzz.stories.length === 0}
      <p class="note">Looking for stories more than one feed is telling…</p>
    {:else if buzz.error !== null}
      <p class="note bad">{buzz.error}</p>
    {:else if buzz.stories.length === 0}
      <p class="note">
        Nothing several feeds are carrying right now.
        {#if buzz.topic !== null}
          That is this topic's window, not every feed's — <button
            class="link"
            onclick={() => void buzz.selectTopic(null)}>show everything</button
          >.
        {:else}
          Buzz needs two different feeds telling the same story; a quiet hour has none.
        {/if}
      </p>
    {:else}
      {#each buzz.stories as story (story.id)}
        {@const open = buzz.storyId === story.id}
        <div class="story" class:open>
          <button
            class="line"
            aria-expanded={open}
            onclick={() => buzz.select(open ? null : story.id)}
          >
            <span class="title">{story.title}</span>
            <span class="meta">
              <b>{story.sourceCount} sources</b>
              {#if story.recentSources > 1}
                · {story.recentSources} recently
              {/if}
              · {ageOf(story.newest)}
            </span>
          </button>

          {#if open}
            <div class="coverage">
              {#each story.articles as article (article.id)}
                <button class="cover" onclick={() => buzz.openArticle(article)}>
                  <span class="feed">{article.origin?.title ?? "A feed"}</span>
                  <span class="age">{ageOf(article.published ?? story.newest)}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</section>

<style>
  .buzz {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    background: var(--bg);
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex-wrap: wrap;
    padding: 14px 16px 10px;
    border-bottom: 1px solid var(--edge-soft);
  }

  .head h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }

  .where {
    font-size: 12px;
    color: var(--text-dim);
  }

  .count {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
  }

  .items {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 12px 0 12px;
  }

  .note {
    margin: 0;
    padding: 16px;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--muted);
  }

  .note.bad {
    color: var(--danger, #d06a6a);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
  }

  .story {
    border-bottom: 1px solid var(--border-soft);
  }

  .story.open {
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .line {
    display: flex;
    flex-direction: column;
    gap: 5px;
    width: 100%;
    padding: 11px 16px;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .title {
    font-size: 13.5px;
    line-height: 1.35;
    color: var(--text);
  }

  .meta {
    font-size: 11px;
    color: var(--muted);
  }

  .meta b {
    color: var(--text-dim);
    font-weight: 600;
  }

  /* The coverage is the story as each feed told it: a feed name and an age,
     quiet enough that the difference between the lines is the point. */
  .coverage {
    display: flex;
    flex-direction: column;
    padding: 0 16px 8px 22px;
  }

  .cover {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 7px 0;
    border: 0;
    background: none;
    color: var(--text-dim);
    font: inherit;
    font-size: 12px;
    text-align: left;
    cursor: pointer;
  }

  .cover:hover {
    color: var(--text);
  }

  .cover .feed {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cover .age {
    flex: none;
    color: var(--muted);
    font-variant-numeric: tabular-nums;
  }
</style>
