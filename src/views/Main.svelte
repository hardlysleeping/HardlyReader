<script lang="ts">
  import { onMount } from "svelte";

  import type { Session, UserInfo } from "../api/freshrss";
  import ArticleList from "../components/ArticleList.svelte";
  import Header from "../components/Header.svelte";
  import ReaderPane from "../components/ReaderPane.svelte";
  import Sidebar from "../components/Sidebar.svelte";
  import { reader } from "../state/reader.svelte";

  let {
    session,
    account,
    onsignout,
  }: { session: Session; account: UserInfo | null; onsignout?: () => void } = $props();

  let sidebarOpen = $state(false);

  const reading = $derived(reader.selectedId !== null);

  onMount(() => {
    void reader.start(session);
    return () => reader.stop();
  });

  function closeReader() {
    reader.closeReader();
  }
</script>

<div class="main">
  <Header
    subtitle={account?.userName ?? session.email}
    {onsignout}
    ontogglesidebar={() => (sidebarOpen = !sidebarOpen)}
  />

  {#if reader.error}
    <div class="error" role="alert">
      <span>{reader.error}</span>
      <button onclick={() => reader.dismissError()} aria-label="Dismiss">×</button>
    </div>
  {/if}

  <div class="panes" class:reading class:sidebar-open={sidebarOpen}>
    <Sidebar onNavigate={() => (sidebarOpen = false)} />
    <ArticleList />
    <ReaderPane onClose={closeReader} />
    <button
      class="scrim"
      aria-label="Close feeds"
      onclick={() => (sidebarOpen = false)}
    ></button>
  </div>
</div>

<style>
  .main {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .panes {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    /* Without an explicit capped row, the single auto row grows to the tallest
       pane's content and every child overflows the viewport. */
    grid-template-rows: minmax(0, 1fr);
    grid-template-columns: 280px minmax(0, 1fr);
    overflow: hidden;
  }

  .panes > :global(*) {
    min-height: 0;
  }

  /* Two panes: the reader replaces the list once something is selected. */
  @media (min-width: 840px) and (max-width: 1199px) {
    .panes.reading :global(.list) {
      display: none;
    }

    /* Unselected, the reader would otherwise be auto-placed into an implicit
       second row and appear as a sliver under the list. */
    .panes:not(.reading) :global(.reader) {
      display: none;
    }
  }

  /* Three panes. */
  @media (min-width: 1200px) {
    .panes {
      grid-template-columns: 300px minmax(320px, 400px) minmax(0, 1fr);
    }
  }

  /* Single pane with a drawer for the feed list. */
  @media (max-width: 839px) {
    .panes {
      grid-template-columns: minmax(0, 1fr);
    }

    .panes :global(.sidebar) {
      position: absolute;
      z-index: 20;
      top: 0;
      bottom: 0;
      left: 0;
      width: min(300px, 100vw - 56px);
      transform: translateX(-102%);
      transition: transform 0.16s ease;
      box-shadow: 4px 0 24px rgb(0 0 0 / 35%);
    }

    .panes.sidebar-open :global(.sidebar) {
      transform: none;
    }

    .panes :global(.reader) {
      position: absolute;
      z-index: 30;
      inset: 0;
      display: none;
    }

    .panes.reading :global(.reader) {
      display: flex;
    }

    .scrim {
      position: absolute;
      inset: 0;
      z-index: 10;
      display: none;
      border: 0;
      background: rgb(0 0 0 / 45%);
    }

    .panes.sidebar-open .scrim {
      display: block;
    }
  }

  .scrim {
    display: none;
  }

  .error {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 14px;
    font-size: 12.5px;
    color: #ffd9d9;
    background: #6b1d1d;
  }

  .error span {
    flex: 1;
    overflow-wrap: anywhere;
  }

  .error button {
    border: 0;
    background: none;
    color: inherit;
    font-size: 16px;
    cursor: pointer;
  }
</style>
