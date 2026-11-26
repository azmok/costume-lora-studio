import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildConfigDocument, parseConfigDocument, SAMPLE_DEFAULTS } from "../config-file.mjs";
import { DEFAULT_PARAMS } from "../training-params.mjs";

test("config document round-trips training parameters and sample settings", () => {
  const doc = buildConfigDocument({
    name: "Oje Masked Clothing",
    model_family: "sd15",
    parameters: { ...DEFAULT_PARAMS, rank: 8, alpha: 16, save_every_n_epochs: 2, clip_skip: 2 },
    sample: { ...SAMPLE_DEFAULTS, every_n_epochs: 2, lora_strength: 0.8, width: 512, height: 680, prompt: "costume, 1girl" }
  });
  const parsed = parseConfigDocument(doc);
  assert.equal(parsed.name, "Oje Masked Clothing");
  assert.equal(parsed.model_family, "sd15");
  assert.deepEqual([parsed.parameters.rank, parsed.parameters.alpha, parsed.parameters.save_every_n_epochs, parsed.parameters.clip_skip], [8, 16, 2, 2]);
  assert.deepEqual([parsed.sample.every_n_epochs, parsed.sample.lora_strength, parsed.sample.width, parsed.sample.height], [2, 0.8, 512, 680]);
  assert.equal(parsed.sample.prompt, "costume, 1girl");
});

test("flat kohya_ss style JSON configs are imported cleanly", () => {
  const parsed = parseConfigDocument({
    max_resolution: "512,512",
    train_batch_size: 2,
    max_train_epochs: 12,
    save_every_n_epochs: 2,
    optimizer_type: "AdamW8bit",
    unet_lr: 0.00015,
    text_encoder_lr: 0.00005,
    network_dim: 32,
    network_alpha: 16,
    masked_loss: true,
    clip_skip: 2
  });
  assert.equal(parsed.parameters.resolution, 512);
  assert.equal(parsed.parameters.epochs, 12);
  assert.equal(parsed.parameters.learning_rate, 0.00015);
  assert.equal(parsed.parameters.rank, 32);
  assert.equal(parsed.parameters.use_masks, true);
  assert.equal(parsed.sample, null);
});

test("invalid config files, empty objects and bad sample sizes are rejected", () => {
  for (const bad of [null, "", [], {}, { unknown_only: 1 }, { parameters: { rank: 999 } }, { sample: { width: 515 } }, { sample: { sampler: "invalid" } }]) {
    assert.throws(() => parseConfigDocument(bad), undefined, JSON.stringify(bad));
  }
});

test("the bundled Oje recommended YAML preset file exists and is UTF-8", () => {
  const yaml = readFileSync(new URL("../../presets/oje-recommended-sd15-masked-clothing.yaml", import.meta.url), "utf-8");
  assert.match(yaml, /save_every_n_epochs:\s*1/);
  assert.match(yaml, /every_n_epochs:\s*1/);
  assert.match(yaml, /learning_rate:\s*0\.00015/);
  assert.match(yaml, /clip_skip:\s*2/);
  assert.equal(SAMPLE_DEFAULTS.every_n_epochs, 1);
  assert.ok(SAMPLE_DEFAULTS.prompt.trim().length > 0);
});
