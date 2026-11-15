import test from "node:test";
import assert from "node:assert/strict";
import { NEEDS, buildTrialWorkflow, folderFor, loaderScript, optionsOf, pickName, supportsWorkflow, trialPrompt } from "../comfy-workflow.mjs";

const info = (node, input, names, combo = false) => ({ [node]: { input: { required: { [input]: combo ? ["COMBO", { options: names }] : [names] } } } });

test("choices are read from old and new object_info formats", () => {
  assert.deepEqual(optionsOf(info("LoraLoader", "lora_name", ["a.safetensors"]), "LoraLoader", "lora_name"), ["a.safetensors"]);
  assert.deepEqual(optionsOf(info("LoraLoader", "lora_name", ["b.safetensors"], true), "LoraLoader", "lora_name"), ["b.safetensors"]);
  assert.deepEqual(optionsOf({}, "LoraLoader", "lora_name"), []);
});

test("files are matched by sub folder first, then by file name, ignoring slashes and case", () => {
  const options = ["old/look.safetensors", "look\\look.safetensors", "v1-5-pruned.safetensors"];
  assert.equal(pickName(options, "look.safetensors", "look"), "look\\look.safetensors");
  assert.equal(pickName(options, "G:/sd/sharedModels/checkpoints/V1-5-PRUNED.safetensors"), "v1-5-pruned.safetensors");
  assert.equal(pickName(options, "missing.safetensors"), null);
  assert.equal(pickName(options, ""), null);
});

test("an SD1.5 workflow loads the checkpoint, the new LoRA and the trigger-word prompt", () => {
  const objectInfo = { ...info("CheckpointLoaderSimple", "ckpt_name", ["v1-5-pruned.safetensors"]), ...info("LoraLoader", "lora_name", ["look/look.safetensors"]) };
  const lora = { name: "look", subfolder: "look", file: "look.safetensors" };
  const { workflow, missing } = buildTrialWorkflow({ family: "sd15", objectInfo, files: { checkpoint: "G:/c/v1-5-pruned.safetensors" }, lora, prompt: trialPrompt("trig") });
  assert.deepEqual(missing, []);
  assert.equal(workflow[1].inputs.ckpt_name, "v1-5-pruned.safetensors");
  assert.equal(workflow[2].inputs.lora_name, "look/look.safetensors");
  assert.match(workflow[3].inputs.text, /^trig, adult woman/);
  assert.match(workflow[4].inputs.text, /child, loli, underage/);
  assert.equal(workflow[11].inputs.filename_prefix, "lora-test/look");
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(workflow[value[0]], "link to " + value[0]);
  }
});

test("a FLUX workflow uses the separate model files and a model-only LoRA", () => {
  const objectInfo = {
    ...info("UNETLoader", "unet_name", ["flux1-dev.safetensors"]), ...info("VAELoader", "vae_name", ["ae.safetensors"]),
    DualCLIPLoader: { input: { required: { clip_name1: [["clip_l.safetensors", "t5xxl_fp16.safetensors"]], clip_name2: [["clip_l.safetensors", "t5xxl_fp16.safetensors"]] } } },
    ...info("LoraLoaderModelOnly", "lora_name", ["x/x.safetensors"])
  };
  const files = { checkpoint: "C:/m/flux1-dev.safetensors", clip_l: "C:/m/clip_l.safetensors", t5xxl: "C:/m/t5xxl_fp16.safetensors", ae: "C:/m/ae.safetensors" };
  const { workflow } = buildTrialWorkflow({ family: "flux", objectInfo, files, lora: { name: "x", subfolder: "x", file: "x.safetensors" }, prompt: "p" });
  assert.equal(workflow[2].inputs.clip_name2, "t5xxl_fp16.safetensors");
  assert.equal(workflow[4].class_type, "LoraLoaderModelOnly");
  assert.equal(workflow[7].inputs.cfg, 1);
  for (const node of Object.values(workflow)) {
    for (const value of Object.values(node.inputs)) if (Array.isArray(value)) assert.ok(workflow[value[0]], "link to " + value[0]);
  }
});

test("files ComfyUI does not offer are reported instead of building a broken workflow", () => {
  const objectInfo = info("CheckpointLoaderSimple", "ckpt_name", ["other.safetensors"]);
  const result = buildTrialWorkflow({ family: "sdxl", objectInfo, files: { checkpoint: "C:/m/sdxl.safetensors" }, lora: { name: "l", subfolder: "l", file: "l.safetensors" }, prompt: "p" });
  assert.equal(result.workflow, null);
  assert.deepEqual(result.missing, ["C:/m/sdxl.safetensors", "l.safetensors"]);
  assert.equal(supportsWorkflow("anima"), false);
  assert.deepEqual(buildTrialWorkflow({ family: "anima", objectInfo: {}, files: {}, lora: {}, prompt: "p" }), { workflow: null, missing: [] });
});

test("model folders follow the family", () => {
  assert.equal(folderFor("sd15", "checkpoint"), "checkpoints");
  assert.equal(folderFor("flux", "checkpoint"), "diffusion_models");
  assert.equal(folderFor("flux", "ae"), "vae");
  assert.equal(folderFor("flux", "t5xxl"), "text_encoders");
  assert.ok(NEEDS.sd15.length && NEEDS.flux.length);
});

test("the loader script carries the workflow and loads it only once per page", () => {
  const script = loaderScript({ 1: { class_type: "X", inputs: {} } }, "LoRA test");
  assert.match(script, /loadApiJson/);
  assert.match(script, /"class_type":"X"/);
  assert.match(script, /sessionStorage/);
  new Function(script); // valid JavaScript
});
