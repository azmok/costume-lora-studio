import assert from "node:assert/strict";
import test from "node:test";
import { filterUnlocked, getLocks, parseLockStore, setLock, setLocksForRoot } from "../tools-locks.mjs";

test("parseLockStore ignores corrupt payloads and deduplicates string entries", () => {
  assert.deepEqual(parseLockStore(""), {});
  assert.deepEqual(parseLockStore("{bad json"), {});
  assert.deepEqual(parseLockStore("[]"), {});
  assert.deepEqual(parseLockStore(null), {});
  const parsed = parseLockStore(JSON.stringify({
    "c:/raw": { caption: ["a.png", "a.png", 123, "", "b.png"], mask: ["c.png", null, "c.png"] },
    bad: "nope",
    arr: []
  }));
  assert.deepEqual(parsed, {
    "c:/raw": { caption: ["a.png", "b.png"], mask: ["c.png"] }
  });
});

test("setLock and getLocks normalize root paths and keep caption/mask locks independent", () => {
  let store = {};
  store = setLock(store, "C:\\Datasets\\Buruma\\", "caption", "001.png", true);
  store = setLock(store, "c:/datasets/buruma", "mask", "002.png", true);
  store = setLock(store, "C:/Datasets/Other", "mask", "001.png", true);

  assert.deepEqual(getLocks(store, "c:/datasets/buruma/"), {
    caption: ["001.png"],
    mask: ["002.png"]
  });
  assert.deepEqual(getLocks(store, "C:\\Datasets\\Other"), {
    caption: [],
    mask: ["001.png"]
  });

  // Unlocking caption does not affect mask lock on same or other files
  store = setLock(store, "c:/datasets/buruma", "caption", "001.png", false);
  assert.deepEqual(getLocks(store, "c:/datasets/buruma"), {
    caption: [],
    mask: ["002.png"]
  });
});

test("setLock rejects unknown kinds and ignores empty root/relative", () => {
  assert.throws(() => setLock({}, "C:/raw", "other", "a.png", true), /Unknown lock kind/);
  assert.deepEqual(setLock({}, "", "caption", "a.png", true), {});
  assert.deepEqual(setLock({}, "C:/raw", "caption", "", true), {});
  assert.deepEqual(setLocksForRoot({}, "   ", { caption: ["a.png"], mask: [] }), {});
});

test("filterUnlocked separates locked and unlocked entries preserving order", () => {
  const entries = [
    { relative: "a.png", image: "C:/raw/a.png" },
    { relative: "b.png", image: "C:/raw/b.png" },
    { relative: "c.png", image: "C:/raw/c.png" }
  ];
  const result = filterUnlocked(entries, new Set(["b.png"]));
  assert.deepEqual(result.unlocked.map((e) => e.relative), ["a.png", "c.png"]);
  assert.deepEqual(result.locked.map((e) => e.relative), ["b.png"]);
  assert.equal(result.lockedCount, 1);

  const allLocked = filterUnlocked(entries, new Set(["a.png", "b.png", "c.png"]));
  assert.equal(allLocked.unlocked.length, 0);
  assert.equal(allLocked.lockedCount, 3);

  const empty = filterUnlocked([], new Set(["a.png"]));
  assert.equal(empty.unlocked.length, 0);
  assert.equal(empty.lockedCount, 0);
});
