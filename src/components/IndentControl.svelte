<script lang="ts">
  /**
   * The feed-name indent, as the slider itself.
   *
   * One control, mounted on whichever surface the device has for it: the
   * sidebar's `Indent` row on a window, and `Settings → Feeds` on a phone, where
   * the sidebar gives that row back so the feed tree starts a row higher. Both
   * mount this file, so there is one slider rather than two that can disagree,
   * and the number, the reason under the pointer and the write all stay the
   * reader's.
   *
   * The label, the number and the fold belong to the row around it — a settings
   * section has nothing to fold — so this component is the input and nothing
   * else.
   *
   * It is also the way back to that row. The row is drawn only while it is open,
   * so its own label can put it away and nothing in the sidebar can bring it
   * back; using the slider here does, because someone moving the indent is
   * someone who wants to see it. No second switch, and the panel stays a frame.
   */
  import { chrome } from "../state/chrome.svelte";
  import { reader } from "../state/reader.svelte";

  let {
    /** The id the sidebar's label points its `aria-controls` at. */
    id = "feed-indent-row",
  }: { id?: string } = $props();
</script>

<input
  {id}
  type="range"
  min="0"
  max={reader.sidebarIndent.max}
  step="1"
  value={reader.sidebarIndent.px}
  aria-label="Feed name indent"
  title={reader.indentError ??
    (reader.indentDeviceOnly
      ? "Feed name indent, kept on this device — Sidebar Feed Indent is not storing it on the server"
      : "Feed name indent, shared with the Sidebar Feed Indent extension")}
  oninput={(event) => reader.setSidebarIndentPx(Number(event.currentTarget.value))}
  onchange={(event) => {
    reader.setSidebarIndentPx(Number(event.currentTarget.value), true);
    chrome.setIndentOpen(true);
  }}
/>

<style>
  /* A 2px track and a 9px thumb: the native 14px trough was the loudest thing
     in the sidebar for a setting that is set once. */
  input[type="range"] {
    flex: 1 1 auto;
    min-width: 0;
    height: 12px;
    margin: 0;
    padding: 0;
    background: transparent;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  input[type="range"]:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }

  input[type="range"]::-webkit-slider-runnable-track {
    height: 2px;
    border-radius: 1px;
    background: var(--border);
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 9px;
    height: 9px;
    margin-top: -3.5px;
    border: 0;
    border-radius: 50%;
    background: var(--muted);
  }

  input[type="range"]:hover::-webkit-slider-thumb,
  input[type="range"]:focus-visible::-webkit-slider-thumb {
    background: var(--accent);
  }

  input[type="range"]::-moz-range-track {
    height: 2px;
    border-radius: 1px;
    background: var(--border);
  }

  input[type="range"]::-moz-range-thumb {
    width: 9px;
    height: 9px;
    border: 0;
    border-radius: 50%;
    background: var(--muted);
  }

  input[type="range"]:disabled {
    cursor: default;
    opacity: 0.4;
  }

  /* A finger is not a mouse. The 2px track and 9px thumb above are a fine mouse
     grip and a poor thumb grip: on a phone a touch that lands beside the thumb
     only jumps the value there, and the drag that follows never becomes a drag,
     so the slider could be tapped and not moved. On a coarse pointer the input
     gets real height, the thumb grows to something a thumb can hold, and
     `touch-action: none` stops the webview from claiming the gesture as a page
     scroll and cancelling the range input underneath it. */
  @media (pointer: coarse) {
    input[type="range"] {
      height: 34px;
      touch-action: none;
    }

    input[type="range"]::-webkit-slider-runnable-track {
      height: 3px;
    }

    input[type="range"]::-webkit-slider-thumb {
      width: 20px;
      height: 20px;
      /* (track 3px − thumb 20px) / 2, so the thumb stays centred on the track. */
      margin-top: -8.5px;
    }

    input[type="range"]::-moz-range-track {
      height: 3px;
    }

    input[type="range"]::-moz-range-thumb {
      width: 20px;
      height: 20px;
    }
  }
</style>
