<script lang="ts">
  /**
   * A number pad for the passcode: twelve keys, six dots, nothing to type.
   *
   * Built for a thumb first. The buttons are laid out in the order a phone
   * dials — 1 to 9, then backspace, 0, go — because that arrangement is already
   * in the reader's hands, and a pad that invents a new one is a pad people
   * press wrong. A mouse can tap it just as well, which is why it is allowed on
   * a desktop at all; it is off by default there, because a keyboard is faster.
   *
   * The digits themselves are never shown: the dots say how many, not which.
   */
  import { canSubmit, PIN_MAX, slots } from "../lib/pinpad";

  let {
    value,
    label,
    tone = "var(--accent)",
    submitLabel = "Unlock",
    busy = false,
    onDigit,
    onBackspace,
    onSubmit,
  }: {
    value: string;
    /** Spoken name for the pad as a whole; each key is labelled by its digit. */
    label: string;
    /** Colour of the ready state — red for the lock, accent when setting one. */
    tone?: string;
    submitLabel?: string;
    busy?: boolean;
    onDigit: (digit: string) => void;
    onBackspace: () => void;
    onSubmit: () => void;
  } = $props();

  const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

  let pad = $state<HTMLElement>();

  /**
   * Focus on mount so a physical keyboard keeps working with the pad showing:
   * the pad takes the keystrokes, and no input element means no soft keyboard
   * sliding up over it on a phone.
   */
  $effect(() => {
    pad?.focus();
  });

  const filled = $derived(slots(value, PIN_MAX));
  const ready = $derived(canSubmit(value) && !busy);

  function key(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      if (ready) onSubmit();
      return;
    }
    if (event.key === "Backspace") {
      event.preventDefault();
      onBackspace();
      return;
    }
    if (/^[0-9]$/.test(event.key)) {
      event.preventDefault();
      onDigit(event.key);
    }
  }
</script>

<!-- tabindex -1: focusable for keystrokes, never a tab stop of its own — the
     keys inside it are the tab stops. The key handler is on this container for
     the same reason PaneGutter's is on its own: the digits are pressed on the
     keys, and a physical keyboard's digits are caught here rather than by a
     hidden input that would summon a soft keyboard on a phone. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="pad"
  bind:this={pad}
  tabindex="-1"
  role="group"
  aria-label={label}
  onkeydown={key}
  style="--pad-tone: {tone}"
>
  <div class="dots" aria-hidden="true">
    {#each filled as filledSlot, index (index)}
      <span class="dot" class:on={filledSlot}></span>
    {/each}
  </div>

  <div class="keys">
    {#each DIGITS as digit (digit)}
      <button type="button" class="key" onclick={() => onDigit(digit)}>{digit}</button>
    {/each}

    <button
      type="button"
      class="key soft"
      onclick={onBackspace}
      disabled={value === ""}
      aria-label="Backspace"
      title="Backspace"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9L3 12l6-7z" />
        <path d="M12 9.5l5 5M17 9.5l-5 5" />
      </svg>
    </button>

    <button type="button" class="key" onclick={() => onDigit("0")}>0</button>

    <button
      type="button"
      class="key go"
      onclick={onSubmit}
      disabled={!ready}
      aria-label={submitLabel}
      title={submitLabel}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      </svg>
    </button>
  </div>
</div>

<style>
  /* The pad is a block inside whatever asks for a passcode: the locked band and
     the set-a-passcode panel both hand it their own tone. */
  .pad {
    display: flex;
    flex-direction: column;
    gap: 7px;
    width: 100%;
    outline: none;
  }

  .dots {
    display: flex;
    justify-content: center;
    gap: 9px;
    padding: 3px 0 5px;
  }

  .dot {
    width: 9px;
    height: 9px;
    border: 1px solid color-mix(in srgb, var(--pad-tone) 40%, transparent);
    border-radius: 50%;
    transition:
      background-color 0.12s ease,
      box-shadow 0.12s ease,
      border-color 0.12s ease;
  }

  /* Filled dots take the tone and a little light, so the count reads at a
     glance without the digits ever being on screen. */
  .dot.on {
    border-color: var(--pad-tone);
    background: var(--pad-tone);
    box-shadow: 0 0 7px color-mix(in srgb, var(--pad-tone) 45%, transparent);
  }

  .keys {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 6px;
  }

  /* 42px standing, 52px on a phone: a thumb needs the bigger one, a mouse does
     not, and the grid is the same either way. */
  .key {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 42px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--sunken, #171717);
    color: var(--text, inherit);
    font: inherit;
    font-size: 15px;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
    transition:
      background-color 0.12s ease,
      border-color 0.12s ease,
      transform 0.08s ease;
    -webkit-tap-highlight-color: transparent;
  }

  .key:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--pad-tone) 55%, transparent);
    background: color-mix(in srgb, var(--pad-tone) 12%, var(--sunken, #171717));
  }

  /* The press is answered on the same frame as the pointer, as the band's own
     controls do. */
  .key:active:not(:disabled) {
    transform: scale(0.95);
    background: color-mix(in srgb, var(--pad-tone) 22%, var(--sunken, #171717));
  }

  .key:focus-visible {
    outline: 2px solid var(--pad-tone);
    outline-offset: 1px;
  }

  .key:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .key svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The way out of the lock: the only key that carries the tone while it is
     usable, so it is the one the eye lands on. */
  .key.go {
    border-color: color-mix(in srgb, var(--pad-tone) 60%, transparent);
    color: var(--pad-tone);
  }

  .key.go:not(:disabled):hover {
    background: color-mix(in srgb, var(--pad-tone) 18%, transparent);
  }

  @media (max-width: 640px) {
    .keys {
      gap: 8px;
    }

    /* A keypad's numerals are read at arm's length, not squinted at: 19px is
       the size that looks like a dialled number rather than a small caption. */
    .key {
      min-height: 52px;
      font-size: 19px;
    }

    .key svg {
      width: 19px;
      height: 19px;
    }

    /* Home-bar room on an iPhone, and the same measure on anything else. The
       number comes from `app.css` with every other inset. */
    .pad {
      padding-bottom: var(--safe-bottom);
    }

    .dot {
      width: 10px;
      height: 10px;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .dot,
    .key {
      transition: none;
    }

    .key:active:not(:disabled) {
      transform: none;
    }
  }
</style>
