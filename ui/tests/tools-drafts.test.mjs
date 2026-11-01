import test from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "../tools-drafts.mjs";

test("drafts round-trip per image and are scoped to their folder", async () => {
  const store = createDraftStore(null);
  await store.put({ root: "D:/a", relative: "x.png", mask: "data:image/png;base64,AA", caption: null, guidance: [{ x: 1, y: 2, label: 1 }] });
  await store.put({ root: "D:/a", relative: "y.png", mask: null, caption: "hello", guidance: [] });
  await store.put({ root: "D:/b", relative: "x.png", mask: null, caption: "other", guidance: [] });
  assert.equal((await store.get("D:/a", "x.png")).guidance[0].x, 1);
  assert.deepEqual((await store.listByRoot("D:/a")).map((draft) => draft.relative).sort(), ["x.png", "y.png"]);
  await store.remove("D:/a", "x.png");
  assert.equal(await store.get("D:/a", "x.png"), null);
  assert.equal((await store.listByRoot("D:/b")).length, 1);
});

test("a broken IndexedDB falls back to memory instead of throwing", async () => {
  const broken = { open() { throw new Error("blocked"); } };
  const store = createDraftStore(broken);
  await store.put({ root: "r", relative: "a.png", mask: null, caption: "c", guidance: [] });
  assert.equal((await store.get("r", "a.png")).caption, "c");
});
