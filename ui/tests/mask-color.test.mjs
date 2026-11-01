import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MASK_COLOR, getMaskColor, hexToRgb, isHexColor, readMaskColor, setMaskColor } from "../mask-color.mjs";

test("only #rrggbb colours are accepted; anything else falls back to the default", () => {
  assert.ok(isHexColor("#FFaa00"));
  for (const bad of ["red", "#fff", "#ggg000", "", null, 5]) assert.equal(isHexColor(bad), false);
  assert.equal(readMaskColor("#ABCDEF"), "#abcdef");
  assert.equal(readMaskColor("nope"), DEFAULT_MASK_COLOR);
  assert.deepEqual(hexToRgb("#ff8000"), [255, 128, 0]);
  assert.deepEqual(hexToRgb("bad"), hexToRgb(DEFAULT_MASK_COLOR));
});

test("setting an invalid colour keeps the current one; a valid one is stored lowercase", () => {
  setMaskColor("#112233");
  assert.equal(getMaskColor(), "#112233");
  setMaskColor("not-a-colour");
  assert.equal(getMaskColor(), "#112233");
  setMaskColor("#AABBCC");
  assert.equal(getMaskColor(), "#aabbcc");
});
