import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPONENT_KEYS, DEFAULT_FAMILY, FAMILIES, civitaiMismatch, downloadItems, downloadTotalGb, familyById, familyParams, isFamily,
  missingComponents, presetById, presetsFor, requiredComponents
} from "../model-families.mjs";
import { DEFAULT_PARAMS, validateParams } from "../training-params.mjs";

test("every family has a main model, known components, unique ids and a resolution that exists in the list", () => {
  const ids = new Set();
  for (const family of FAMILIES) {
    assert.ok(!ids.has(family.id));
    ids.add(family.id);
    assert.equal(family.components[0].key, "checkpoint", family.id);
    assert.ok(family.components[0].required);
    for (const item of family.components) assert.ok(COMPONENT_KEYS.includes(item.key), family.id + " " + item.key);
    assert.equal(new Set(family.components.map((item) => item.key)).size, family.components.length);
    assert.ok(family.downloads.length >= 1 && family.civitai.length >= 1);
    validateParams(familyParams(family), { required: Object.keys(DEFAULT_PARAMS) });
  }
  assert.ok(isFamily(DEFAULT_FAMILY));
  assert.equal(familyById("nope"), null);
  assert.deepEqual(FAMILIES.map((family) => family.id), ["sd15", "sdxl", "sd3", "flux", "lumina", "hunyuan", "anima"]);
});

test("every download file maps to a component of its family and stays on one https Hugging Face path", () => {
  for (const family of FAMILIES) {
    const keys = new Set(family.components.map((item) => item.key));
    for (const download of family.downloads) {
      for (const file of download.files) {
        assert.ok(keys.has(file.key), family.id + " " + file.key);
        assert.ok(file.gb > 0 && file.name && !file.path.startsWith("/") && !file.path.includes(".."));
      }
      // a bundle fills every required component
      const filled = new Set(download.files.map((file) => file.key));
      for (const item of requiredComponents(family)) assert.ok(filled.has(item.key), download.id + " lacks " + item.key);
      assert.ok(downloadTotalGb(download) > 0);
    }
  }
});

test("downloads skip files that are already set and name the gated repo", () => {
  const flux = familyById("flux");
  const dev = flux.downloads.find((item) => item.id === "flux-dev");
  const all = downloadItems(flux, dev);
  assert.equal(all.length, 4);
  assert.match(all[0].url, /^https:\/\/huggingface\.co\/black-forest-labs\/FLUX\.1-dev\/resolve\/main\/flux1-dev\.safetensors$/);
  assert.equal(all[0].gated, "black-forest-labs/FLUX.1-dev");
  const rest = downloadItems(flux, dev, { clip_l: "C:/m/clip_l.safetensors", t5xxl: "  " });
  assert.deepEqual(rest.map((item) => item.key), ["checkpoint", "ae", "t5xxl"]);
  assert.equal(flux.downloads.find((item) => item.id === "flux-schnell").gated, undefined);
});

test("missing required components are listed by label", () => {
  const flux = familyById("flux");
  assert.deepEqual(missingComponents(flux, { checkpoint: "a", clip_l: "b", t5xxl: "c", ae: "d" }), []);
  assert.deepEqual(missingComponents(flux, { checkpoint: "a" }), ["CLIP-L", "T5-XXL", "AutoEncoder (ae.safetensors)"]);
  assert.deepEqual(missingComponents(familyById("sd3"), { checkpoint: "a" }), []); // SD3 encoders are optional
});

test("flow-matching families start without min-SNR / noise offset / clip skip / caption shuffle", () => {
  const sdxl = familyParams(familyById("sdxl"));
  assert.equal(sdxl.resolution, 1024);
  assert.equal(sdxl.min_snr_gamma, DEFAULT_PARAMS.min_snr_gamma);
  const flux = familyParams(familyById("flux"));
  assert.deepEqual([flux.min_snr_gamma, flux.noise_offset, flux.clip_skip, flux.shuffle_caption, flux.text_encoder_lr, flux.fp8_base], [0, 0, 1, false, 0, true]);
});

test("each family offers the masked, unmasked, low-VRAM and quick-test presets, all valid", () => {
  for (const family of FAMILIES) {
    const presets = presetsFor(family.id);
    assert.ok(presets.length >= 4, family.id);
    const ids = new Set(presets.map((item) => item.id));
    assert.equal(ids.size, presets.length);
    for (const item of presets) {
      const checked = validateParams(item.parameters, { required: Object.keys(DEFAULT_PARAMS) });
      assert.ok(checked.alpha <= checked.rank, item.id);
      assert.ok(item.name && item.description && item.group, item.id);
    }
    if (family.id !== "sd15") {
      assert.equal(presetById(family.id, family.id + "-clothing-masked").parameters.use_masks, true);
      assert.equal(presetById(family.id, family.id + "-clothing-nomask").parameters.use_masks, false);
      assert.ok(presetById(family.id, family.id + "-clothing-nomask").parameters.rank <= presetById(family.id, family.id + "-clothing-masked").parameters.rank);
      assert.equal(presetById(family.id, family.id + "-clothing-masked").parameters.resolution, 1024);
    }
  }
  assert.ok(presetById("sd15", "community-edg"));
  assert.equal(presetById("sdxl", "community-edg"), null); // community presets are SD1.5 only
});

test("a Civitai model of another base model is flagged", () => {
  const sdxl = familyById("sdxl");
  assert.equal(civitaiMismatch(sdxl, "Illustrious"), "");
  assert.equal(civitaiMismatch(sdxl, "Pony"), "");
  assert.equal(civitaiMismatch(sdxl, ""), "");
  assert.match(civitaiMismatch(sdxl, "SD 1.5"), /SD 1\.5.*SDXL/);
  assert.equal(civitaiMismatch(familyById("flux"), "Flux.1 D"), "");
});

test("the link box accepts Civitai IDs and https links, and turns Hugging Face blob pages into file links", async () => {
  const { normalizeDownloadLink } = await import("../model-families.mjs");
  assert.equal(normalizeDownloadLink(" 12345 "), "https://civitai.com/models/12345");
  assert.equal(normalizeDownloadLink("https://civitai.com/models/9?modelVersionId=3"), "https://civitai.com/models/9?modelVersionId=3");
  assert.equal(normalizeDownloadLink("https://huggingface.co/a/b/blob/main/x.safetensors"), "https://huggingface.co/a/b/resolve/main/x.safetensors");
  for (const bad of ["", "ftp://x/y", "http://x/y", "abc", "1234567890123"]) assert.throws(() => normalizeDownloadLink(bad), /https|ID/);
});
