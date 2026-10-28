/**
 * The picture viewer's arithmetic.
 *
 * Nothing here touches the DOM: the pane owns the pointers, this checks the
 * numbers they produce — that a pinch scales about the fingers, that a drag
 * cannot push the picture past the frame, and that a double-tap goes in and back
 * out again.
 */
import {
  DOUBLE_TAP_SCALE,
  MAX_SCALE,
  atRest,
  clampPan,
  doubleTap,
  drag,
  fitInto,
  midpoint,
  panRoom,
  pinch,
  restZoom,
  span,
  transformOf,
} from "../../src/lib/picture-zoom.ts";

let checks = 0;
let failures = 0;

function check(label, ok, detail) {
  checks += 1;
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

const frame = { width: 400, height: 800 };

{
  const rest = restZoom();
  check("rest is scale 1 and centred", rest.scale === 1 && rest.x === 0 && rest.y === 0);
  check("rest counts as at rest", atRest(rest));
  check("a zoomed picture is not at rest", !atRest({ scale: 2, x: 0, y: 0 }));
  check("the transform is translate-then-scale", transformOf({ scale: 2, x: 10, y: -4 }) === "translate(10px, -4px) scale(2)");
}

{
  const natural = { width: 2000, height: 1000 };
  const fit = fitInto(natural, frame);
  check("a big picture fits the frame's width", fit.width === 400 && fit.height === 200, fit);
  const small = fitInto({ width: 120, height: 90 }, frame);
  check("a small picture is never upscaled", small.width === 120 && small.height === 90, small);
  check("an unmeasured frame leaves the file's own size", fitInto(natural, { width: 0, height: 0 }).width === 2000);
}

{
  check("two points measure their distance", span({ x: 0, y: 0 }, { x: 3, y: 4 }) === 5);
  const mid = midpoint({ x: 0, y: 0 }, { x: 10, y: 20 });
  check("the midpoint is halfway", mid.x === 5 && mid.y === 10, mid);
}

{
  const fit = { width: 400, height: 800 };
  const room = panRoom(fit, frame, 1);
  check("at rest there is nothing to drag", room.x === 0 && room.y === 0, room);
  const zoomedRoom = panRoom(fit, frame, 2);
  check("at 2x a full-width picture may move 200px sideways", zoomedRoom.x === 200, zoomedRoom);
  const landscape = panRoom({ width: 400, height: 400 }, frame, 2);
  check("...and not at all vertically, because it does not overflow", landscape.y === 0, landscape);
}

{
  // A pinch outwards doubles the span, so the picture doubles.
  const start = restZoom();
  const next = pinch(start, 100, 200, { x: 200, y: 400 }, frame, { width: 400, height: 800 });
  check("a pinch doubles the scale", Math.abs(next.scale - 2) < 0.001, next.scale);
  check("a pinch centred in the frame keeps the picture centred", next.x === 0 && next.y === 0, next);

  const drifting = pinch(start, 100, 200, { x: 300, y: 400 }, frame, { width: 400, height: 800 });
  check("a pinch off-centre pulls the picture toward the fingers", drifting.x < 0, drifting);

  const over = pinch({ scale: 5, x: 0, y: 0 }, 100, 400, { x: 200, y: 400 }, { width: 400, height: 800 }, { width: 400, height: 800 });
  check("the scale stops at the ceiling", over.scale === MAX_SCALE, over.scale);

  const shrink = pinch({ scale: 2, x: 0, y: 0 }, 200, 50, { x: 200, y: 400 }, frame, { width: 400, height: 800 });
  check("a pinch inwards cannot go below rest", shrink.scale === 1 && shrink.x === 0, shrink);

  check("a pinch with no starting span is ignored", pinch(start, 0, 100, { x: 0, y: 0 }, frame, { width: 400, height: 800 }).scale === 1);

  // A hundredfold pinch must not escape the ceiling.
  const wild = pinch(start, 1, 1000, { x: 200, y: 400 }, frame, { width: 400, height: 800 });
  check("a runaway pinch is clamped", wild.scale <= MAX_SCALE, wild.scale);
}

{
  const fit = { width: 400, height: 800 };
  const atRestDrag = drag(restZoom(), { x: 50, y: 50 }, fit, frame);
  check("dragging at rest does nothing", atRestDrag.x === 0 && atRestDrag.y === 0, atRestDrag);

  const zoomed = drag({ scale: 2, x: 0, y: 0 }, { x: 30, y: 0 }, fit, frame);
  check("dragging a zoomed picture moves it", zoomed.x === 30, zoomed);

  const beyond = drag({ scale: 2, x: 0, y: 0 }, { x: 9999, y: 0 }, fit, frame);
  check("a drag stops at the frame's edge", beyond.x === panRoom(fit, frame, 2).x, beyond);

  const clamped = clampPan({ scale: 2, x: -9999, y: 9999 }, fit, frame);
  check("clamping pins both axes", clamped.x === -panRoom(fit, frame, 2).x && clamped.y === panRoom(fit, frame, 2).y, clamped);
}

{
  const fit = { width: 400, height: 800 };
  const inOnce = doubleTap(restZoom(), { x: 300, y: 400 }, frame, fit);
  check("a double-tap zooms in", Math.abs(inOnce.scale - DOUBLE_TAP_SCALE) < 0.001, inOnce.scale);
  check("...toward the finger, staying inside the frame", inOnce.x <= panRoom(fit, frame, inOnce.scale).x, inOnce);
  const back = doubleTap(inOnce, { x: 300, y: 400 }, frame, fit);
  check("a second double-tap returns to rest", back.scale === 1 && back.x === 0 && back.y === 0, back);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
