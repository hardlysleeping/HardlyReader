import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scrollPagination } from '../../src/lib/scroll-pagination.ts';

let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS ${name}`); }
class Port extends EventTarget {
  scrollTop = 0;
  scrollHeight = 3000;
  clientHeight = 600;
  bottom = 600;
  getBoundingClientRect() { return { bottom: this.bottom }; }
}
globalThis.window = new EventTarget();
const event = (target, type, fields = {}) => {
  const e = new Event(type, { cancelable: true });
  Object.assign(e, fields); target.dispatchEvent(e); return e;
};
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function fixture({ nested = false } = {}) {
  const node = new Port(), port = nested ? new Port() : node;
  const state = { context: 'account/stream/cards', count: 50, hasMore: true, loading: false, blocked: false };
  let calls = 0, complete;
  const action = scrollPagination(node, { port, state: () => state, load: () => {
    calls++; return new Promise((resolve, reject) => { complete = { resolve, reject }; });
  } });
  const scroll = (top) => { port.scrollTop = top; event(port, 'scroll'); };
  const wheel = (dy = 40) => event(node, 'wheel', { deltaY: dy });
  return { node, port, state, action, scroll, wheel, get calls() { return calls; }, get complete() { return complete; } };
}
const f = fixture();
await settle();
check('mount never fetches', () => assert.equal(f.calls, 0));
f.scroll(2300); await settle();
check('programmatic restore near end never fetches', () => assert.equal(f.calls, 0));
f.wheel(-30); f.scroll(2200); await settle();
check('upward input and scroll never fetch', () => assert.equal(f.calls, 0));
f.wheel(); f.scroll(2200); await settle();
check('input without actual downward movement never fetches', () => assert.equal(f.calls, 0));
f.scroll(2250); await settle();
check('downward near-end scroll calls the supplied load path', () => assert.equal(f.calls, 1));
f.wheel(); f.scroll(2300); await settle();
check('in-flight scrolls do not duplicate requests', () => assert.equal(f.calls, 1));
f.complete.reject(new Error('offline')); await settle();
for (let i = 0; i < 10; i++) { f.wheel(); f.scroll(2301 + i); await settle(); }
check('failed page never retries automatically, even with more scroll input', () => assert.equal(f.calls, 1));
f.state.count += 50; // The unchanged Load more fallback successfully advances.
f.wheel(); f.scroll(2320); await settle();
check('manual recovery/growing page unlocks automatic pagination', () => assert.equal(f.calls, 2));
f.state.count += 50; f.complete.resolve(); await settle();
f.scroll(2330); await settle();
check('page completion/anchor movement cannot drain next page', () => assert.equal(f.calls, 2));
f.state.hasMore = false; f.wheel(); f.scroll(2340); await settle();
check('exhausted cursors stop paging', () => assert.equal(f.calls, 2));
f.state.hasMore = true; f.state.loading = true; f.wheel(); f.scroll(2350); await settle();
check('list/more loading prevents paging', () => assert.equal(f.calls, 2));
f.state.loading = false; f.state.blocked = true; f.wheel(); f.scroll(2360); await settle();
check('drag/restore/fit blocker prevents paging', () => assert.equal(f.calls, 2));
f.state.blocked = false; f.scroll(2370); await settle();
check('blocked input cannot trigger later without fresh intent', () => assert.equal(f.calls, 2));
f.state.context = 'other-account/stream/grid'; f.scroll(0); f.wheel(); f.scroll(2250); await settle();
check('new account/stream/view resets page latch', () => assert.equal(f.calls, 3));
f.complete.resolve(); await settle();
f.wheel(); f.scroll(2260); await settle();
check('non-growing page cannot loop', () => assert.equal(f.calls, 3));
f.action.destroy(); f.state.count++; f.wheel(); f.scroll(2270); await settle();
check('destroy detaches listeners', () => assert.equal(f.calls, 3));
const short = fixture(); short.port.scrollHeight = 300;
short.wheel(); short.scroll(0); await settle();
check('short list cannot drain pages without a scroll', () => assert.equal(short.calls, 0)); short.action.destroy();
const touch = fixture();
event(touch.node, 'pointerdown', { pointerId: 1, clientY: 500 });
event(window, 'pointermove', { pointerId: 1, clientY: 300 }); touch.scroll(2100); await settle();
check('touch/pointer upward travel plus downward scroll triggers', () => assert.equal(touch.calls, 1));
touch.complete.resolve(); await settle(); touch.action.destroy();
const n = fixture({ nested: true }); n.node.bottom = 2000;
n.wheel(); n.scroll(2200); await settle();
check('nested list measures its own end, not the outer footer', () => assert.equal(n.calls, 0));
n.node.bottom = 800; n.wheel(); n.scroll(2250); await settle();
check('nested outer-port downward scroll triggers at list end', () => assert.equal(n.calls, 1));
n.complete.resolve(); await settle(); n.action.destroy();
for (const view of ['regular', 'list', 'cards', 'grid']) {
  const v = fixture(); v.state.context = `account/stream/${view}`;
  v.scroll(0); v.wheel(); v.scroll(1000); await settle();
  check(`${view}: scrolling far from end does not fetch`, () => assert.equal(v.calls, 0));
  const e = v.wheel(); v.scroll(2200); await settle();
  check(`${view}: same passive trigger at end, no canceled input`, () => {
    assert.equal(v.calls, 1); assert.equal(e.defaultPrevented, false);
  });
  v.complete.resolve(); await settle(); v.action.destroy();
}
const keyboard = fixture(); event(keyboard.node, 'keydown', { key: 'PageDown', shiftKey: false });
keyboard.scroll(2200); await settle();
check('keyboard downward scroll triggers the same path', () => assert.equal(keyboard.calls, 1));
keyboard.complete.resolve(); await settle(); keyboard.action.destroy();
const source = readFileSync(new URL('../../src/components/ArticleList.svelte', import.meta.url), 'utf8');
check('real component wires action to existing loadMore and hasMore', () => {
  assert.match(source, /use:nextPageOnScroll/);
  assert.match(source, /load: \(\) => store\.loadMore\(\)/);
  assert.match(source, /hasMore: store\.hasMore/);
  assert.match(source, /class="more" onclick=\{\(\) => store\.loadMore\(\)\}/);
});
console.log(`${checks} checks, 0 failures`);
