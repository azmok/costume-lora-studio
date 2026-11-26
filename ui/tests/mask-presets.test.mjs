import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_MASK_PRESETS, DEFAULT_MASK_PRESET, DEFAULT_MASK_PRESET_NAME, findMaskPreset,
  normalizeMaskPresetName, readMaskPresetStore, removeMaskPreset, serializeMaskPresetStore, upsertMaskPreset
} from "../mask-presets.mjs";

test("built-in mask presets default to Buruma / Gym uniform with safe exclude prompt", () => {
  assert.equal(DEFAULT_MASK_PRESET.id, "buruma-gym-uniform");
  assert.match(DEFAULT_MASK_PRESET.name, /ブルマ体操服/);
  assert.equal(DEFAULT_MASK_PRESET.mask_prompt, "white shirt, t-shirt, shorts, underwear, swimsuit");
  assert.equal(DEFAULT_MASK_PRESET.exclude_prompt, "face, hair");
  assert.ok(BUILTIN_MASK_PRESETS.length >= 3);
  assert.equal(findMaskPreset("builtin:buruma-gym-uniform"), DEFAULT_MASK_PRESET);
});

test("custom mask presets can be added, overwritten, found, serialized and removed", () => {
  let store = upsertMaskPreset([], "Sailor Uniform", "sailor collar, pleated skirt, shirt", "face, hair");
  store = upsertMaskPreset(store, "Swimsuit", "one-piece swimsuit", "face, hair");
  store = upsertMaskPreset(store, "Sailor Uniform", "sailor shirt, pleated skirt", "face, hair");
  assert.equal(store.length, 2);
  assert.equal(findMaskPreset("custom:Sailor Uniform", store).mask_prompt, "sailor shirt, pleated skirt");
  const roundTripped = readMaskPresetStore(serializeMaskPresetStore(store));
  assert.deepEqual(roundTripped, store);
  assert.deepEqual(removeMaskPreset(store, "Sailor Uniform").map((p) => p.name), ["Swimsuit"]);
});

test("empty include, reserved or corrupted mask presets are rejected while empty exclude is allowed", () => {
  assert.equal(normalizeMaskPresetName("   "), DEFAULT_MASK_PRESET_NAME);
  assert.throws(() => normalizeMaskPresetName(DEFAULT_MASK_PRESET.name));
  assert.throws(() => normalizeMaskPresetName("x".repeat(61)));
  assert.throws(() => upsertMaskPreset([], "Bad", "   ", "face, hair"));
  const noExcl = upsertMaskPreset([], "No Exclude", "shirt, shorts", "   ");
  assert.equal(noExcl[0].exclude_prompt, "");
  assert.deepEqual(readMaskPresetStore("not json"), []);
  const mixed = JSON.stringify({
    schema_version: 1,
    presets: [
      { name: "Valid", mask_prompt: "dress", exclude_prompt: "face, hair" },
      { name: "Broken", mask_prompt: "", exclude_prompt: "face" }
    ]
  });
  assert.deepEqual(readMaskPresetStore(mixed).map((p) => p.name), ["Valid"]);
});
