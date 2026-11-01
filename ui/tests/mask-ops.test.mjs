import test from "node:test";
import assert from "node:assert/strict";
import { binarize, coverage, fillHoles, growMask, invertMask, removeSpecks, shrinkMask } from "../mask-ops.mjs";

const grid = (rows) => Uint8Array.from(rows.flatMap((row) => [...row].map((char) => (char === "#" ? 255 : 0))));
const show = (mask, width) => Array.from({ length: mask.length / width }, (_, y) => [...mask.slice(y * width, (y + 1) * width)].map((v) => (v ? "#" : ".")).join(""));

test("invert, binarize and coverage use the 128 threshold", () => {
  const soft = Uint8Array.from([0, 127, 128, 255]);
  assert.deepEqual([...binarize(soft)], [0, 0, 255, 255]);
  assert.deepEqual([...invertMask(soft)], [255, 255, 0, 0]);
  assert.equal(coverage(soft), 0.5);
  assert.equal(coverage(new Uint8Array(0)), 0);
});

test("grow expands by a square of the radius and shrink undoes it", () => {
  const mask = grid([".....", ".....", "..#..", ".....", "....."]);
  assert.deepEqual(show(growMask(mask, 5, 5, 1), 5), [".....", ".###.", ".###.", ".###.", "....."]);
  const big = growMask(mask, 5, 5, 2);
  assert.equal(coverage(big), 1);
  const block = grid(["......", ".####.", ".####.", ".####.", ".####.", "......"]);
  assert.deepEqual(show(shrinkMask(block, 6, 6, 1), 6), ["......", "......", "..##..", "..##..", "......", "......"]);
  assert.deepEqual([...growMask(mask, 5, 5, 0)], [...mask]);
});

test("shrink does not erode from the image border", () => {
  const full = grid(["###", "###", "###"]);
  assert.equal(coverage(shrinkMask(full, 3, 3, 1)), 1);
});

test("fill holes fills enclosed black only", () => {
  const ring = grid(["#####", "#...#", "#.#.#", "#...#", "#####"]);
  assert.equal(coverage(fillHoles(ring, 5, 5)), 1);
  const open = grid(["#####", "#...#", "#...#", "#...#", "##.##"]);
  assert.deepEqual(show(fillHoles(open, 5, 5), 5), show(open, 5));
});

test("specks below the minimum area disappear but large regions stay", () => {
  const mask = grid(["#....", ".....", "..###", "..###", "....."]);
  assert.deepEqual(show(removeSpecks(mask, 5, 5, 3), 5), [".....", ".....", "..###", "..###", "....."]);
  assert.equal(coverage(removeSpecks(mask, 5, 5, 0)), 7 / 25);
});
