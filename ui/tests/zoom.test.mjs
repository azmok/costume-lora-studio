import test from "node:test";
import assert from "node:assert/strict";
import { clampZoom, PIXEL_ZOOM, wheelFactor, ZOOM_MAX, ZOOM_MIN } from "../image-zoom.mjs";
import { PAGE_ZOOM_STEPS, readPageZoom, stepPageZoom } from "../page-zoom.mjs";

test("image zoom is clamped and wheel direction maps to in / out", () => {
  assert.equal(clampZoom(100), ZOOM_MAX);
  assert.equal(clampZoom(0.0001), ZOOM_MIN);
  assert.ok(wheelFactor(-100) > 1);
  assert.ok(wheelFactor(100) < 1);
  assert.equal(wheelFactor(0), 1);
  assert.ok(wheelFactor(-100000) <= wheelFactor(-100) + 1e-9);
});

test("images zoom in to 3200% like Photoshop and switch to crisp pixels from 300%", () => {
  assert.equal(ZOOM_MAX, 32);
  assert.equal(clampZoom(32), 32);
  assert.equal(clampZoom(33), 32);
  assert.equal(PIXEL_ZOOM, 3);
});

test("page zoom steps like a browser and stops at both ends", () => {
  assert.equal(stepPageZoom(1, 1), 1.1);
  assert.equal(stepPageZoom(1, -1), 0.9);
  assert.equal(stepPageZoom(1.5, 0), 1);
  assert.equal(stepPageZoom(2, 1), 2);
  assert.equal(stepPageZoom(0.5, -1), 0.5);
  let level = 1;
  for (let index = 0; index < 20; index++) level = stepPageZoom(level, 1);
  assert.equal(level, PAGE_ZOOM_STEPS.at(-1));
});

test("stored page zoom is validated and snapped to a known step", () => {
  assert.equal(readPageZoom(null), 1);
  assert.equal(readPageZoom("abc"), 1);
  assert.equal(readPageZoom("-3"), 1);
  assert.equal(readPageZoom("1.26"), 1.25);
  assert.equal(readPageZoom("99"), 2);
});
