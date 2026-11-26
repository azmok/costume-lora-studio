import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_DEFAULTS, TRAINING_DEFAULTS, required, validateTraining, applyJobEvent, makeTrainingProfile, readTrainingProfile } from "../state.mjs";

const defaults = {
  steps: 1000, batch_size: 1, rank: 16, alpha: 16,
  learning_rate: 0.0001, seed: 42, output_name: "my_costume"
};

test("empty and Enter-only values cannot start a job", () => {
  for (const value of ["", " ", "\n", null, undefined]) assert.throws(() => required(value, "入力"));
  assert.equal(required(" path ", "入力"), "path");
});

test("training boundaries and invalid numeric values", () => {
  assert.deepEqual(validateTraining(defaults), defaults);
  assert.equal(validateTraining({ ...defaults, rank: 8, alpha: 16 }).alpha, 16);
  for (const patch of [
    { steps: -1 }, { steps: 1.5 }, { steps: "" }, { rank: 513 },
    { alpha: 513 }, { learning_rate: NaN }, { batch_size: -1 }, { seed: Infinity },
    { output_name: "../file" }, { output_name: "" }
  ]) assert.throws(() => validateTraining({ ...defaults, ...patch }));
});

test("late events from another job cannot complete the running job", () => {
  const state = { jobId: "current", status: "running" };
  assert.equal(applyJobEvent(state, { jobId: "old", data: { status: "succeeded" } }), state);
  assert.equal(applyJobEvent(state, { jobId: "current", data: { status: "cancelled" } }).status, "cancelled");
});

test("configuration round trip preserves paths and converts numeric inputs", () => {
  const project = { ...PROJECT_DEFAULTS, dataset_dir: "C:/衣装/processed", output_name: "my_costume" };
  const profile = makeTrainingProfile(project, { ...TRAINING_DEFAULTS, steps: "1500", rank: "32" });
  const restored = readTrainingProfile(JSON.parse(JSON.stringify(profile)));
  assert.equal(restored.project.dataset_dir, "C:/衣装/processed");
  assert.equal(restored.parameters.steps, 1500);
  assert.equal(restored.parameters.rank, 32);
  assert.equal(restored.parameters.mixed_precision, "fp16");
});

test("invalid configurations cannot override current form values", () => {
  for (const profile of [
    null, {}, { schema_version: 99 }, { schema_version: 1, project: [], parameters: {} },
    { schema_version: 1, project: { output_name: "bad/name" }, parameters: {} },
    { schema_version: 1, project: PROJECT_DEFAULTS, parameters: { steps: -1 } },
    { schema_version: 1, project: PROJECT_DEFAULTS, parameters: { mixed_precision: "fp8" } }
  ]) assert.throws(() => readTrainingProfile(profile));
});
