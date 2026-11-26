import test from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_PRESETS, DEFAULT_PARAMS, OPTIMIZERS, PARAM_FIELDS, PARAM_SCHEMA, SCHEDULERS, builtinPreset, computeTotals, estimateSeconds,
  formatEstimate, parseRate, parseSpeed, summaryModel, updateSpeed, validateParams
} from "../training-params.mjs";

test("every built-in preset is valid, complete and uses a known optimizer and scheduler", () => {
  assert.ok(BUILTIN_PRESETS.length >= 6);
  const ids = new Set();
  for (const item of BUILTIN_PRESETS) {
    assert.ok(!ids.has(item.id), item.id);
    ids.add(item.id);
    assert.ok(item.name && item.description && item.group, item.id);
    assert.deepEqual(Object.keys(item.parameters).sort(), Object.keys(DEFAULT_PARAMS).sort(), item.id);
    const checked = validateParams(item.parameters, { required: Object.keys(DEFAULT_PARAMS) });
    assert.ok(OPTIMIZERS.some((entry) => entry.value === checked.optimizer), item.id);
    assert.ok(SCHEDULERS.some((entry) => entry.value === checked.lr_scheduler), item.id);
    assert.ok(checked.alpha <= checked.rank, item.id);
  }
});

test("the two clothing presets differ in masks, as asked, and are the recommended ones", () => {
  const masked = builtinPreset("clothing-masked").parameters;
  const plain = builtinPreset("clothing-nomask").parameters;
  const oje = builtinPreset("oje-masked-clip2").parameters;
  assert.equal(DEFAULT_PARAMS.save_every_n_epochs, 1);
  assert.equal(masked.save_every_n_epochs, 1);
  assert.equal(oje.save_every_n_epochs, 1);
  assert.equal(masked.use_masks, true);
  assert.equal(plain.use_masks, false);
  assert.ok(plain.rank < masked.rank);
  assert.equal(builtinPreset("clothing-masked").group, builtinPreset("clothing-nomask").group);
  assert.equal(builtinPreset("nope"), null);
});

test("community presets keep the values of the bmaltais presets they come from", () => {
  const edg = builtinPreset("community-edg").parameters;
  assert.deepEqual([edg.optimizer, edg.lr_scheduler, edg.learning_rate, edg.text_encoder_lr, edg.rank, edg.alpha, edg.batch_size, edg.clip_skip], ["AdamW8bit", "constant", 0.0001, 0.00005, 64, 64, 3, 2]);
  const prodigy = builtinPreset("community-prodigy").parameters;
  assert.equal(prodigy.optimizer, "Prodigy");
  assert.equal(prodigy.learning_rate, 1);
  assert.match(prodigy.optimizer_args, /d_coef=1\.0/);
  const adafactor = builtinPreset("community-adafactor").parameters;
  assert.deepEqual([adafactor.optimizer, adafactor.learning_rate, adafactor.rank, adafactor.alpha, adafactor.epochs], ["Adafactor", 0.0009, 128, 1, 15]);
});

test("form ids are unique and every control maps to one parameter", () => {
  assert.equal(new Set(Object.values(PARAM_FIELDS)).size, PARAM_SCHEMA.length);
  assert.equal(PARAM_FIELDS.lr_scheduler, "scheduler");
});

test("validation: ranges, choices, flags and optimizer arguments", () => {
  assert.equal(validateParams({ steps: 0, batch_size: 1, rank: 8, alpha: 4, learning_rate: 1, seed: 1 }).steps, 0);
  for (const patch of [{ repeats: 0 }, { epochs: 1.5 }, { save_every_n_epochs: -1 }, { save_every_n_epochs: 1.5 }, { batch_size: 17 }, { lr_warmup_percent: 51 }, { resolution: 513 }, { optimizer: "SGD" },
    { lr_scheduler: "step" }, { clip_skip: 3 }, { use_masks: "maybe" }, { optimizer_args: "decouple" }, { optimizer_args: "a=1 b" }, { alpha: 600 }, { noise_offset: 2 }]) {
    assert.throws(() => validateParams({ ...DEFAULT_PARAMS, ...patch }), undefined, JSON.stringify(patch));
  }
  const alphaAboveRank = validateParams({ ...DEFAULT_PARAMS, rank: 8, alpha: 16 });
  assert.deepEqual([alphaAboveRank.rank, alphaAboveRank.alpha], [8, 16]);
  const parsed = validateParams({ ...DEFAULT_PARAMS, resolution: "640", use_masks: "false", optimizer_args: " a=1   b=(0.9,0.99) " });
  assert.equal(parsed.resolution, 640);
  assert.equal(parsed.use_masks, false);
  assert.equal(parsed.optimizer_args, "a=1   b=(0.9,0.99)");
});

test("total steps follow images x repeats / batch x epochs, or the optional step limit", () => {
  const totals = computeTotals({ images: 45, repeats: 8, batchSize: 2, epochs: 10, maxSteps: 0 });
  assert.deepEqual([totals.stepsPerEpoch, totals.totalSteps, totals.byMaxSteps], [180, 1800, false]);
  assert.equal(computeTotals({ images: 45, repeats: 1, batchSize: 4, epochs: 3, maxSteps: 0 }).stepsPerEpoch, 12); // rounds up
  const limited = computeTotals({ images: 45, repeats: 8, batchSize: 2, epochs: 10, maxSteps: 500 });
  assert.deepEqual([limited.totalSteps, limited.byMaxSteps], [500, true]);
  assert.equal(computeTotals({ images: 0, repeats: 8, batchSize: 2, epochs: 10, maxSteps: 0 }), null);
});

test("time estimate scales with steps, batch and resolution and adds model loading", () => {
  const base = estimateSeconds({ totalSteps: 1000, batchSize: 1, resolution: 512, secondsPerImage: 0.5 });
  assert.equal(base, 60 + 500);
  assert.equal(estimateSeconds({ totalSteps: 1000, batchSize: 2, resolution: 512, secondsPerImage: 0.5 }), 60 + 1000);
  assert.equal(estimateSeconds({ totalSteps: 1000, batchSize: 1, resolution: 1024, secondsPerImage: 0.5 }), 60 + 2000);
  assert.equal(formatEstimate(30), "about 1 minute");
  assert.equal(formatEstimate(18 * 60), "about 18 min");
  assert.equal(formatEstimate(3 * 3600 + 20 * 60), "about 3 h 20 min");
});

test("training speed is read from tqdm, normalized to 512 px per image and smoothed", () => {
  assert.equal(parseRate("1.66it/s").toFixed(2), "0.60");
  assert.equal(parseRate("2.50s/it"), 2.5);
  assert.equal(parseRate("fast"), null);
  const first = updateSpeed(null, { rateText: "2.00it/s", batchSize: 2, resolution: 512, now: 1 });
  assert.equal(first.secondsPerImage, 0.25); // 0.5 s per step / batch 2
  const second = updateSpeed(first, { rateText: "1.00it/s", batchSize: 2, resolution: 512, now: 2 });
  assert.ok(second.secondsPerImage > 0.25 && second.secondsPerImage < 0.5);
  assert.equal(updateSpeed(first, { rateText: "n/a", batchSize: 2, resolution: 512 }), first);
  assert.equal(parseSpeed("not json"), null);
  assert.equal(parseSpeed(JSON.stringify(first)).secondsPerImage, 0.25);
});

test("the summary says how many steps and how long, and whether the speed was measured", () => {
  const values = { ...DEFAULT_PARAMS, repeats: 8, epochs: 10, batch_size: 2, steps: 0, resolution: 512 };
  assert.equal(summaryModel(values, null, null).ready, false);
  const guess = summaryModel(values, { count: 45 }, null);
  assert.equal(guess.totals.totalSteps, 1800);
  assert.equal(guess.measured, false);
  assert.match(guess.speedNote, /rough guess/);
  const measured = summaryModel(values, { count: 45 }, { secondsPerImage: 0.25 });
  assert.equal(measured.measured, true);
  assert.ok(measured.seconds < guess.seconds);
  assert.match(measured.speedNote, /last training run/);
});
