import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PARAMS, validateParams } from "../training-params.mjs";
import { makeTrainingProfile, readTrainingProfile } from "../state.mjs";

test("alpha mask survives saved profiles without changing legacy defaults", () => {
  assert.equal(DEFAULT_PARAMS.alpha_mask, false);
  const profile = makeTrainingProfile({}, { ...DEFAULT_PARAMS, alpha_mask: true });
  assert.equal(readTrainingProfile(JSON.parse(JSON.stringify(profile))).parameters.alpha_mask, true);
  assert.throws(() => validateParams({ ...DEFAULT_PARAMS, alpha_mask: "\n" }), /alpha_mask/);
});
