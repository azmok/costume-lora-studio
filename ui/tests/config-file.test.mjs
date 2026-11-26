import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildConfigDocument, deriveSiblingDirs, parseConfigDocument, SAMPLE_DEFAULTS } from "../config-file.mjs";
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

test("deriveSiblingDirs resolves sibling mask and lora folders from dataset_dir", () => {
  assert.deepEqual(deriveSiblingDirs("D:\\BU\\lora_trained\\buru4-2\\img\\"), {
    dataset_dir: "D:/BU/lora_trained/buru4-2/img",
    mask_dir: "D:/BU/lora_trained/buru4-2/mask",
    output_dir: "D:/BU/lora_trained/buru4-2/lora"
  });
  assert.deepEqual(deriveSiblingDirs("C:/datasets/my-costume/processed"), {
    dataset_dir: "C:/datasets/my-costume/processed",
    mask_dir: "C:/datasets/my-costume/mask",
    output_dir: "C:/datasets/my-costume/lora"
  });
  assert.deepEqual(deriveSiblingDirs("   "), { dataset_dir: "", mask_dir: "", output_dir: "" });
});

test("config document supports dataset_dir + output_name and auto-derives sibling mask/lora dirs", () => {
  const doc = buildConfigDocument({
    name: "buru4-2",
    model_family: "sd15",
    dataset_dir: "D:\\BU\\lora_trained\\buru4-2\\img",
    output_name: "buruma-04-2",
    parameters: { ...DEFAULT_PARAMS, use_masks: true }
  });
  assert.equal(doc.dataset_dir, "D:/BU/lora_trained/buru4-2/img");
  assert.equal(doc.output_name, "buruma-04-2");
  const parsed = parseConfigDocument(doc);
  assert.equal(parsed.dataset_dir, "D:/BU/lora_trained/buru4-2/img");
  assert.equal(parsed.mask_dir, "D:/BU/lora_trained/buru4-2/mask");
  assert.equal(parsed.output_dir, "D:/BU/lora_trained/buru4-2/lora");
  assert.equal(parsed.output_name, "buruma-04-2");

  // Without dataset_dir, folder fields stay blank so existing UI folders remain unchanged
  const generic = parseConfigDocument({ parameters: { rank: 32 } });
  assert.deepEqual([generic.dataset_dir, generic.mask_dir, generic.output_dir], ["", "", ""]);

  // Explicit mask_dir / output_dir override sibling defaults if supplied
  const explicit = parseConfigDocument({
    dataset_dir: "D:/data/set1/img",
    mask_dir: "D:/custom/masks",
    output_dir: "D:/custom/out",
    parameters: { rank: 16 }
  });
  assert.equal(explicit.mask_dir, "D:/custom/masks");
  assert.equal(explicit.output_dir, "D:/custom/out");
});
