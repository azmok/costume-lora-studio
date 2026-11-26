import test from "node:test";
import assert from "node:assert/strict";
import { imagePoint, imagePointUnclamped, MaskHistory } from "../tools-state.mjs";

test("paint coordinates remain in source pixels when fitted or zoomed", () => {
  assert.deepEqual(imagePoint({ left: 10, top: 20, width: 200, height: 100 }, 1000, 500, 110, 70), { x: 500, y: 250 });
  assert.deepEqual(imagePoint({ left: 0, top: 0, width: 2000, height: 1000 }, 1000, 500, 1000, 500), { x: 500, y: 250 });
  assert.deepEqual(imagePoint({ left: 10, top: 20, width: 200, height: 100 }, 1000, 500, -100, 5000), { x: 0, y: 499 });
  assert.deepEqual(imagePointUnclamped({ left: 10, top: 20, width: 200, height: 100 }, 1000, 500, 0, 130), { x: -50, y: 550 });
});

test("mask history undoes, redoes and discards stale redo states", () => {
  const history = new MaskHistory();
  history.reset(new Uint8Array([0, 0]));
  history.commit(new Uint8Array([255, 0]));
  history.commit(new Uint8Array([255, 255]));
  assert.deepEqual([...history.undo()], [255, 0]);
  assert.deepEqual([...history.redo()], [255, 255]);
  history.undo();
  history.commit(new Uint8Array([0, 255]));
  assert.equal(history.redo(), null);
  const restored = history.undo();
  restored[0] = 0;
  assert.deepEqual([...history.states[history.index]], [255, 0]);
});

test("mask history restores guidance points together with the mask", () => {
  const history = new MaskHistory();
  history.reset(new Uint8Array([0, 0]));
  history.commit(new Uint8Array([255, 0]), [{ x: 1, y: 2, label: 1 }]);
  history.commit(new Uint8Array([255, 255]), [{ x: 1, y: 2, label: 1 }, { x: 3, y: 4, label: 0 }]);
  history.undo();
  assert.deepEqual(history.extra, [{ x: 1, y: 2, label: 1 }]);
  history.undo();
  assert.deepEqual(history.extra, []);
  history.redo();
  history.redo();
  assert.equal(history.extra.length, 2);
});
