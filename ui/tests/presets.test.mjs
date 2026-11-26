import test from "node:test";
import assert from "node:assert/strict";
import { normalizePresetName, readPresetStore, upsertPreset, removePreset, serializePresetStore, TRAINING_DEFAULTS, DEFAULT_PRESET_NAME } from "../state.mjs";

test("presets are added, overwritten by name, and removed", () => {
  let presets = upsertPreset([], "A", { ...TRAINING_DEFAULTS, rank: "32", alpha: "16" });
  presets = upsertPreset(presets, "B", TRAINING_DEFAULTS);
  presets = upsertPreset(presets, "A", { ...TRAINING_DEFAULTS, steps: "2000" });
  assert.deepEqual(presets.map((p) => p.name), ["A", "B"]);
  assert.equal(presets[0].parameters.steps, 2000);
  assert.deepEqual(removePreset(presets, "A").map((p) => p.name), ["B"]);
});

test("names are trimmed, defaulted and the built-in name is reserved", () => {
  assert.equal(normalizePresetName("  my   run "), "my run");
  assert.equal(normalizePresetName(""), DEFAULT_PRESET_NAME);
  assert.throws(() => normalizePresetName("SD1.5 Clothing LoRA — Default settings"));
  assert.throws(() => normalizePresetName("x".repeat(61)));
});

test("invalid parameters are rejected and corrupted stored entries are skipped", () => {
  assert.throws(() => upsertPreset([], "bad", { ...TRAINING_DEFAULTS, rank: 8, alpha: 600 }));
  const raw = JSON.stringify({ schema_version: 1, presets: [{ name: "ok", parameters: TRAINING_DEFAULTS }, { name: "broken", parameters: { steps: -1 } }] });
  assert.deepEqual(readPresetStore(raw).map((p) => p.name), ["ok"]);
  assert.deepEqual(readPresetStore("not json"), []);
  assert.deepEqual(readPresetStore(serializePresetStore([])), []);
});
