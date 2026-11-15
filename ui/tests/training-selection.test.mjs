import test from "node:test";
import assert from "node:assert/strict";
import { getRecord, parseStore, rootKey, selectionSummary, setRecord } from "../training-selection.mjs";

test("source folders are matched ignoring slashes, trailing separators and case", () => {
  assert.equal(rootKey("D:\\BU\\Lora_Trained\\buru1_30\\img\\"), "d:/bu/lora_trained/buru1_30/img");
  assert.equal(rootKey("D:/BU/lora_trained/buru1_30/img"), rootKey("d:\\bu\\LORA_TRAINED\\buru1_30\\img"));
  assert.equal(rootKey(null), "");
});

test("an unknown folder uses every image; records are stored per folder and de-duplicated", () => {
  let store = {};
  assert.deepEqual(getRecord(store, "C:/raw"), { excluded: [], total: 0 });
  store = setRecord(store, "C:\\raw", { excluded: ["b.png", "b.png", "sub/c.png"], total: 10 });
  assert.deepEqual(getRecord(store, "c:/RAW/"), { excluded: ["b.png", "sub/c.png"], total: 10 });
  assert.deepEqual(getRecord(store, "C:/other").excluded, []);
  assert.equal(setRecord(store, "", { excluded: ["x"], total: 1 }), store);
});

test("a corrupted stored value is ignored instead of breaking the page", () => {
  assert.deepEqual(parseStore("not json"), {});
  assert.deepEqual(parseStore("[]"), {});
  const store = parseStore(JSON.stringify({ "c:/raw": { excluded: ["a.png", 5, null], total: -3 }, bad: { excluded: "x" } }));
  assert.deepEqual(store, { "c:/raw": { excluded: ["a.png"], total: 0 } });
});

test("the training tab explains how many images will be used", () => {
  assert.match(selectionSummary({ excluded: [], total: 45 }, true), /Every image will be used/);
  assert.equal(selectionSummary({ excluded: ["a", "b", "c", "d", "e", "f", "g"], total: 45 }, true), "Training will use 38 of 45 images — 7 unchecked in Tools.");
  assert.equal(selectionSummary({ excluded: ["a"], total: 0 }, true), "Training will skip 1 image — 1 unchecked in Tools.");
  assert.match(selectionSummary({ excluded: ["a"], total: 45 }, false), /ignored/);
});
