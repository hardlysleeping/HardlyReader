<script lang="ts">
  const appName = "Hardly Read";
  const version = "0.1.0";
</script>

<main class="shell">
  <header>
    <h1>{appName}</h1>
    <span class="version">v{version}</span>
  </header>

  <section class="placeholder">
    <p>Application shell.</p>
    <p class="muted">FreshRSS connection and reader UI arrive in later commits.</p>
  </section>
</main>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  header {
    display: flex;
    align-items: baseline;
    gap: 0.6rem;
    padding: 0 1rem;
    height: 48px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-alt);
  }

  h1 {
    font-size: 1rem;
    font-weight: 600;
    margin: 0;
  }

  .version {
    color: var(--muted);
    font-size: 0.8rem;
  }

  .placeholder {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    text-align: center;
    padding: 1rem;
  }

  .placeholder p {
    margin: 0;
  }

  .muted {
    color: var(--muted);
    font-size: 0.875rem;
  }
</style>
