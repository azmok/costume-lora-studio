// The "try the LoRA" workflow for ComfyUI (API format), built from what the running ComfyUI offers.
// Pure functions, no DOM.

const baseName = (value) => String(value ?? "").replaceAll("\\", "/").split("/").at(-1).toLowerCase();
const normalized = (value) => String(value ?? "").replaceAll("\\", "/").toLowerCase();

// The choices of one input in /object_info: old style [[...names]], new style ["COMBO", { options: [...] }].
export function optionsOf(objectInfo, node, input) {
  const spec = objectInfo?.[node]?.input?.required?.[input];
  if (!Array.isArray(spec)) return [];
  if (Array.isArray(spec[0])) return spec[0].map(String);
  if (spec[0] === "COMBO" && Array.isArray(spec[1]?.options)) return spec[1].options.map(String);
  return [];
}

// The option that is the given file: same sub path if possible, else same file name. null if absent.
export function pickName(options, wanted, subfolder = "") {
  if (!wanted) return null;
  const file = baseName(wanted);
  const exact = subfolder ? normalized(subfolder + "/" + file) : null;
  return options.find((option) => exact && normalized(option) === exact)
    ?? options.find((option) => baseName(option) === file)
    ?? null;
}

// Nodes whose choices the workflow of each family needs: [node, input, component key].
export const NEEDS = {
  sd15: [["CheckpointLoaderSimple", "ckpt_name", "checkpoint"], ["LoraLoader", "lora_name", "lora"]],
  sdxl: [["CheckpointLoaderSimple", "ckpt_name", "checkpoint"], ["LoraLoader", "lora_name", "lora"]],
  flux: [["UNETLoader", "unet_name", "checkpoint"], ["DualCLIPLoader", "clip_name1", "clip_l"], ["DualCLIPLoader", "clip_name2", "t5xxl"],
    ["VAELoader", "vae_name", "ae"], ["LoraLoaderModelOnly", "lora_name", "lora"]]
};

export const supportsWorkflow = (family) => Object.hasOwn(NEEDS, family);

// ComfyUI model folders to add so it finds the files the LoRA was trained with.
export function folderFor(family, key) {
  if (key === "checkpoint") return family === "sd15" || family === "sdxl" ? "checkpoints" : "diffusion_models";
  if (key === "ae" || key === "vae") return "vae";
  return "text_encoders";
}

export function trialPrompt(trigger) {
  const lead = String(trigger ?? "").trim();
  return (lead ? lead + ", " : "") + "adult woman, mature, solo, standing, full body, looking at viewer, simple background, best quality";
}
// The test images always show an adult: young-looking results are pushed away by the negative prompt.
export const TRIAL_NEGATIVE = "child, loli, underage, young, petite, lowres, bad anatomy, bad hands, worst quality, low quality, jpeg artifacts, watermark, text";

const SIZES = { sd15: [512, 768], sdxl: [832, 1216], flux: [832, 1216] };

// Returns { workflow, missing } — missing lists the files ComfyUI does not offer (then workflow is null).
export function buildTrialWorkflow({ family, objectInfo, files, lora, prompt, negative = TRIAL_NEGATIVE, seed = 42, strength = 0.8 }) {
  if (!supportsWorkflow(family)) return { workflow: null, missing: [] };
  const names = {};
  const missing = [];
  for (const [node, input, key] of NEEDS[family]) {
    const options = optionsOf(objectInfo, node, input);
    const name = key === "lora" ? pickName(options, lora.file, lora.subfolder) : pickName(options, files[key]);
    if (name) names[key] = name; else missing.push(key === "lora" ? lora.file : (files[key] || key));
  }
  if (missing.length) return { workflow: null, missing };
  const [width, height] = SIZES[family];
  const text = (clip, value) => ({ class_type: "CLIPTextEncode", inputs: { text: value, clip } });
  const save = { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "lora-test/" + lora.name } };
  if (family === "flux") {
    return {
      missing,
      workflow: {
        1: { class_type: "UNETLoader", inputs: { unet_name: names.checkpoint, weight_dtype: "default" } },
        2: { class_type: "DualCLIPLoader", inputs: { clip_name1: names.clip_l, clip_name2: names.t5xxl, type: "flux" } },
        3: { class_type: "VAELoader", inputs: { vae_name: names.ae } },
        4: { class_type: "LoraLoaderModelOnly", inputs: { model: ["1", 0], lora_name: names.lora, strength_model: strength } },
        5: text(["2", 0], prompt),
        6: { class_type: "FluxGuidance", inputs: { conditioning: ["5", 0], guidance: 3.5 } },
        7: { class_type: "KSampler", inputs: { model: ["4", 0], positive: ["6", 0], negative: ["10", 0], latent_image: ["9", 0], seed, steps: 20, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
        8: { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
        9: { class_type: "EmptySD3LatentImage", inputs: { width, height, batch_size: 1 } },
        10: { class_type: "ConditioningZeroOut", inputs: { conditioning: ["5", 0] } },
        11: save
      }
    };
  }
  return {
    missing,
    workflow: {
      1: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: names.checkpoint } },
      2: { class_type: "LoraLoader", inputs: { model: ["1", 0], clip: ["1", 1], lora_name: names.lora, strength_model: strength, strength_clip: strength } },
      3: text(["2", 1], prompt),
      4: text(["2", 1], negative),
      5: { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: 1 } },
      6: { class_type: "KSampler", inputs: { model: ["2", 0], positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0], seed, steps: 25, cfg: 7, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1 } },
      8: { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
      11: save
    }
  };
}

// Script run inside the ComfyUI window: waits for its app object, then loads the workflow once per page.
export function loaderScript(workflow, title) {
  const data = JSON.stringify({ workflow, title, key: "costume-lora-loaded-" + Date.now() });
  return `(() => {
  const job = ${data};
  if (sessionStorage.getItem(job.key)) return;
  let tries = 0;
  const timer = setInterval(async () => {
    const app = window.app || window.comfyAPI?.app?.app;
    if (!app || !app.graph || ++tries > 600) { if (tries > 600) clearInterval(timer); return; }
    clearInterval(timer);
    sessionStorage.setItem(job.key, "1");
    try {
      if (typeof app.loadApiJson === "function") await app.loadApiJson(job.workflow, job.title);
      else await app.loadGraphData(job.workflow);
    } catch (error) { console.error("Costume LoRA Studio: could not load the workflow", error); }
  }, 250);
})();`;
}
