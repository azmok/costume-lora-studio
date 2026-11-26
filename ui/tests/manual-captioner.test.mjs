import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateTags,
  appendCommonCaption,
  deleteTagInCaptions,
  deleteTargetText,
  findMatchingIndexes,
  insertAroundTarget,
  renameTagInCaptions,
  searchAndReplace
} from "../manual-captioner-ops.mjs";

const sampleItems = () => [
  { id: "1", caption: "burumaGymUniform, navy buruma, 1girl, standing, indoors" },
  { id: "2", caption: "burumaGymUniform, red buruma, 1girl, from behind, outdoors" },
  { id: "3", caption: "burumaGymUniform, navy buruma, 1girl, standing, x" }
];

test("aggregateTags counts unique tags per image, ignores 1-char tags, and sorts desc then alpha", () => {
  const { counts, sorted } = aggregateTags(sampleItems());
  assert.equal(counts.get("burumaGymUniform"), 3);
  assert.equal(counts.get("navy buruma"), 2);
  assert.equal(counts.get("x"), undefined);
  assert.deepEqual(sorted.slice(0, 4), [
    { tag: "1girl", count: 3 },
    { tag: "burumaGymUniform", count: 3 },
    { tag: "navy buruma", count: 2 },
    { tag: "standing", count: 2 }
  ]);
});

test("findMatchingIndexes matches exact comma-separated tags only", () => {
  assert.deepEqual(findMatchingIndexes(sampleItems(), "navy buruma"), [0, 2]);
  assert.deepEqual(findMatchingIndexes(sampleItems(), "buruma"), []);
  assert.deepEqual(findMatchingIndexes(sampleItems(), "   "), []);
});

test("renameTagInCaptions and deleteTagInCaptions update only matching captions", () => {
  const renamed = renameTagInCaptions(sampleItems(), "navy buruma", "dark blue buruma");
  assert.equal(renamed.length, 2);
  assert.equal(renamed[0].caption, "burumaGymUniform, dark blue buruma, 1girl, standing, indoors");
  assert.equal(renamed[1].index, 2);
  assert.deepEqual(renameTagInCaptions(sampleItems(), "navy buruma", "navy buruma"), []);

  const deleted = deleteTagInCaptions(sampleItems(), "standing");
  assert.equal(deleted.length, 2);
  assert.equal(deleted[0].caption, "burumaGymUniform, navy buruma, 1girl, indoors");
});

test("appendCommonCaption handles empty, trailing comma, and blank rejection", () => {
  assert.throws(() => appendCommonCaption(sampleItems(), "   "), /Enter a caption/);
  const items = [
    { id: "a", caption: "" },
    { id: "b", caption: "1girl," },
    { id: "c", caption: "1girl, solo" }
  ];
  const updates = appendCommonCaption(items, "realistic");
  assert.deepEqual(updates.map((u) => u.caption), [
    "realistic",
    "1girl, realistic",
    "1girl, solo, realistic"
  ]);
});

test("insertAroundTarget supports prepend/append in text and regex modes and validates inputs", () => {
  assert.throws(() => insertAroundTarget(sampleItems(), { target: "", insertion: "solo" }));
  assert.throws(() => insertAroundTarget(sampleItems(), { target: "[bad", insertion: "solo", useRegex: true }), /Invalid regular expression/);

  const prep = insertAroundTarget(sampleItems(), { target: "1girl", insertion: "solo,", position: "prepend" });
  assert.equal(prep.length, 3);
  assert.ok(prep[0].caption.includes("solo, 1girl"));

  const app = insertAroundTarget(sampleItems(), { target: "navy|red", insertion: "tight", useRegex: true, position: "append" });
  assert.equal(app.length, 3);
  assert.ok(app[1].caption.includes("red tight buruma"));
});

test("deleteTargetText cleans leftover commas in text word-boundary and regex modes", () => {
  assert.throws(() => deleteTargetText(sampleItems(), { target: "" }));
  assert.throws(() => deleteTargetText(sampleItems(), { target: "(unclosed", useRegex: true }), /Invalid regular expression/);

  const res = deleteTargetText(sampleItems(), { target: "standing", useRegex: false });
  assert.equal(res.length, 2);
  assert.equal(res[0].caption, "burumaGymUniform, navy buruma, 1girl, indoors");
  assert.equal(res[1].caption, "burumaGymUniform, navy buruma, 1girl, x");

  const trailing = deleteTargetText([{ id: "t", caption: "burumaGymUniform, red buruma, outdoors" }], { target: "outdoors", useRegex: false });
  assert.equal(trailing[0].caption, "burumaGymUniform, red buruma");
});

test("searchAndReplace supports case-sensitivity, regex, total replacement counts, and empty rejection", () => {
  assert.throws(() => searchAndReplace(sampleItems(), { search: "" }));
  assert.throws(() => searchAndReplace(sampleItems(), { search: "[bad", useRegex: true }), /Invalid regular expression/);

  const ci = searchAndReplace(sampleItems(), { search: "NAVY", replace: "dark navy", caseSensitive: false });
  assert.equal(ci.updates.length, 2);
  assert.equal(ci.totalReplacements, 2);
  assert.ok(ci.updates[0].caption.includes("dark navy buruma"));

  const cs = searchAndReplace(sampleItems(), { search: "NAVY", replace: "dark navy", caseSensitive: true });
  assert.equal(cs.updates.length, 0);
  assert.equal(cs.totalReplacements, 0);
});
