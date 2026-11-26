import test from "node:test";
import assert from "node:assert/strict";
import { fitToolsPanels } from "../tools-layout.mjs";

test("uses the workspace width to choose a layout before squeezing any panel", () => {
  assert.deepEqual(fitToolsPanels(445), { columns: 1 });
  assert.deepEqual(fitToolsPanels(446), { columns: 2, left: 160, right: 0, sideBudget: 160 });
  assert.deepEqual(fitToolsPanels(721), { columns: 2, left: 190, right: 0, sideBudget: 435 });
  assert.deepEqual(fitToolsPanels(722), { columns: 3, left: 160, right: 260, sideBudget: 420 });
});

test("fits saved widths around the editor and restores them when there is space", () => {
  const preferred = { left: 360, right: 420 };
  const narrow = fitToolsPanels(820, preferred);
  assert.equal(narrow.left + narrow.right, narrow.sideBudget);
  assert.ok(narrow.left > 160);
  assert.ok(narrow.right > 260);
  assert.deepEqual(fitToolsPanels(1200, preferred), { columns: 3, ...preferred, sideBudget: 898 });
  assert.deepEqual(fitToolsPanels(1000, { left: "broken", right: -50 }), {
    columns: 3, left: 190, right: 260, sideBudget: 698,
  });
});
