import test from "node:test";
import assert from "node:assert/strict";
import { THRESHOLDS, analyzeCaption, classify, laplacianVariance, tagFrequency, toGray } from "../dataset-check.mjs";
import { SHORTCUT_SECTIONS } from "../shortcuts.mjs";
import { createProject, deleteProject, newStore, readStore, renameProject, setActive, uniqueName, updateProjectData } from "../projects.mjs";

test("caption analysis finds missing trigger, duplicates and empties", () => {
  assert.deepEqual(analyzeCaption("", "trig"), { empty: true, count: 0, duplicates: [], missingTrigger: false });
  const result = analyzeCaption("bloomer, trig, Bloomer, outdoors", "trig");
  assert.equal(result.missingTrigger, true);
  assert.deepEqual(result.duplicates, ["Bloomer"]);
  assert.equal(analyzeCaption("trig, a, b", "trig").missingTrigger, false);
});

test("images are classified with every problem and nothing for healthy ones", () => {
  const healthy = { width: 768, height: 768, hasMask: true, coverage: 0.3, blur: 200, caption: "trig, a, b, c" };
  assert.deepEqual(classify(healthy, "trig"), []);
  const bad = { width: 300, height: 900, hasMask: false, coverage: null, blur: 5, caption: null };
  assert.deepEqual(classify(bad, "trig").sort(), ["blurry", "low-resolution", "no-caption", "no-mask"]);
  assert.ok(classify({ ...healthy, coverage: 0.005 }, "trig").includes("mask-small"));
  assert.ok(classify({ ...healthy, coverage: 0.95 }, "trig").includes("mask-large"));
  assert.ok(classify({ ...healthy, caption: "a, b, trig" }, "trig").includes("no-trigger"));
  assert.ok(classify({ ...healthy, caption: "trig, a" }, "trig").includes("short-caption"));
  assert.equal(THRESHOLDS.minShortSide, 512);
});

test("sharp images score higher than flat ones", () => {
  const size = 16;
  const flat = new Float32Array(size * size).fill(120);
  const checker = new Float32Array(size * size).map((_, index) => ((index + Math.floor(index / size)) % 2 ? 255 : 0));
  assert.equal(laplacianVariance(flat, size, size), 0);
  assert.ok(laplacianVariance(checker, size, size) > 1000);
  assert.equal(laplacianVariance(flat, 2, 2), 0);
  assert.equal(toGray(Uint8Array.from([255, 255, 255, 255]), 1, 1)[0], 255);
});

test("tag frequency ignores the trigger and sorts by count", () => {
  const rows = tagFrequency(["trig, a, b", "trig, a, c", "trig, A"], "trig");
  assert.deepEqual(rows.map((row) => [row.tag.toLowerCase(), row.count]), [["a", 3], ["b", 1], ["c", 1]]);
});

test("shortcut sections are complete and key labels are unique per section", () => {
  assert.ok(SHORTCUT_SECTIONS.length >= 4);
  for (const section of SHORTCUT_SECTIONS) {
    assert.ok(section.title && section.items.length);
    assert.equal(new Set(section.items.map(([keys]) => keys)).size, section.items.length);
    assert.ok(section.items.every(([keys, description]) => keys && description));
  }
});

test("projects: create, unique names, rename, update, delete and switch", () => {
  let store = newStore("Main", { a: 1 });
  const first = store.activeId;
  ({ store } = createProject(store, "Main", { b: 2 }));
  assert.deepEqual(store.projects.map((p) => p.name), ["Main", "Main 2"]);
  assert.equal(uniqueName(store.projects, "main"), "main 3");
  store = updateProjectData(store, first, { a: 5 });
  assert.equal(store.projects[0].data.a, 5);
  store = renameProject(store, first, "Costume A");
  assert.throws(() => renameProject(store, first, "main 2"));
  assert.throws(() => renameProject(store, first, "   "));
  store = setActive(store, first);
  store = deleteProject(store, first);
  assert.equal(store.projects.length, 1);
  assert.equal(store.activeId, store.projects[0].id);
  assert.throws(() => deleteProject(store, store.activeId));
  assert.throws(() => setActive(store, "missing"));
});

test("a stored project list is validated and corrupt input is rejected", () => {
  const store = newStore("A", { x: "y" });
  assert.deepEqual(readStore(JSON.stringify(store)).projects[0].data, { x: "y" });
  assert.equal(readStore("not json"), null);
  assert.equal(readStore(JSON.stringify({ version: 2, projects: [] })), null);
  const withBad = JSON.stringify({ ...store, activeId: "nope", projects: [...store.projects, { id: 5 }, { ...store.projects[0] }] });
  const read = readStore(withBad);
  assert.equal(read.projects.length, 1);
  assert.equal(read.activeId, store.projects[0].id);
  assert.throws(() => createProject(store, "Big", { blob: "x".repeat(500_000) }));
});
