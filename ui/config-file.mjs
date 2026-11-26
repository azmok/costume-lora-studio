// Export / import training + sample configuration files (YAML or JSON). Pure functions, no DOM.
import { DEFAULT_PARAMS, validateParams } from "./training-params.mjs";
import { DEFAULT_FAMILY, familyById } from "./model-families.mjs";

export const CONFIG_SCHEMA_VERSION = 1;

export function deriveSiblingDirs(datasetDir) {
  const clean = String(datasetDir ?? "").trim().replaceAll("\\", "/").replace(/\/+$/, "");
  if (!clean) return { dataset_dir: "", mask_dir: "", output_dir: "" };
  const slash = clean.lastIndexOf("/");
  let base;
  if (slash > 0) base = clean.slice(0, slash);
  else if (slash === 0) base = "";
  else if (/^[A-Za-z]:$/.test(clean)) base = clean;
  else return { dataset_dir: clean, mask_dir: "mask", output_dir: "lora" };
  return {
    dataset_dir: clean,
    mask_dir: base + "/mask",
    output_dir: base + "/lora"
  };
}

function cleanOptionalPath(value, label) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.includes("\0")) throw new Error(label + " must be a valid path string");
  return value.trim().replaceAll("\\", "/").replace(/\/+$/, "");
}

function cleanOptionalName(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.includes("\0")) throw new Error("output_name must be a valid string");
  return value.trim().slice(0, 80);
}
export const SAMPLE_DEFAULTS = {
  every_n_epochs: 1,
  checkpoint: "",
  lora_strength: 0.8,
  width: 512,
  height: 680,
  steps: 20,
  cfg: 7,
  sampler: "dpmsolver++",
  clip_skip: 2,
  seed: 42,
  prompt: "1girl, solo, from front, knee level shot, standing, looking at viewer, simple background\n1girl, solo, from behind, full body, standing, looking back, simple background",
  negative: "worst quality, low quality, bad anatomy"
};
const ALLOWED_SAMPLERS = new Set(["dpmsolver++", "dpmsolver", "euler_a", "euler", "ddim", "dpm_2_a", "dpm_2", "heun", "pndm", "k_euler_a", "k_euler"]);

// Optional mapping for flat kohya_ss GUI JSON files so users can import them too.
const KOHYA_ALIASES = {
  max_resolution: "resolution",
  train_batch_size: "batch_size",
  epoch: "epochs",
  max_train_epochs: "epochs",
  max_train_steps: "steps",
  optimizer_type: "optimizer",
  unet_lr: "learning_rate",
  lr_warmup: "lr_warmup_percent",
  network_dim: "rank",
  network_alpha: "alpha",
  masked_loss: "use_masks"
};

function sanitizeSample(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const num = (key, min, max, integer = false) => {
    const val = raw[key];
    if (val === undefined || val === null || val === "") return SAMPLE_DEFAULTS[key];
    const parsed = Number(val);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max || (integer && !Number.isInteger(parsed))) {
      throw new Error("sample." + key + " is out of range");
    }
    return parsed;
  };
  const width = num("width", 256, 2048, true);
  const height = num("height", 256, 2048, true);
  if (width % 8 || height % 8) throw new Error("sample.width and sample.height must be multiples of 8");
  const sampler = raw.sampler === undefined || raw.sampler === "" ? SAMPLE_DEFAULTS.sampler : String(raw.sampler);
  if (!ALLOWED_SAMPLERS.has(sampler)) throw new Error("Invalid sample.sampler value");
  const clipSkip = num("clip_skip", 0, 2, true);
  const str = (key) => (raw[key] === undefined || raw[key] === null ? SAMPLE_DEFAULTS[key] : String(raw[key]));
  return {
    every_n_epochs: num("every_n_epochs", 0, 1000, true),
    checkpoint: str("checkpoint").trim().replaceAll("\\", "/"),
    lora_strength: num("lora_strength", 0, 2),
    width,
    height,
    steps: num("steps", 1, 100, true),
    cfg: num("cfg", 1, 30),
    sampler,
    clip_skip: clipSkip,
    seed: num("seed", 0, 2147483647, true),
    prompt: str("prompt"),
    negative: str("negative")
  };
}

export function buildConfigDocument({ name = "", model_family = DEFAULT_FAMILY, parameters = {}, sample = null, dataset_dir = "", output_name = "" } = {}) {
  const family = familyById(model_family)?.id ?? DEFAULT_FAMILY;
  const checked = validateParams({ ...DEFAULT_PARAMS, ...parameters });
  const cleanParams = Object.fromEntries(Object.keys(DEFAULT_PARAMS).map((key) => [key, checked[key]]));
  const cleanDataset = cleanOptionalPath(dataset_dir, "dataset_dir");
  const cleanOutputName = cleanOptionalName(output_name);
  const doc = {
    schema_version: CONFIG_SCHEMA_VERSION,
    ...(String(name ?? "").trim() ? { name: String(name).trim() } : {}),
    model_family: family,
    ...(cleanDataset ? { dataset_dir: cleanDataset } : {}),
    ...(cleanOutputName ? { output_name: cleanOutputName } : {}),
    parameters: cleanParams
  };
  if (sample) doc.sample = sanitizeSample(sample);
  return doc;
}

export function parseConfigDocument(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Config file must contain a YAML or JSON object");
  }
  const source = raw.parameters && typeof raw.parameters === "object" && !Array.isArray(raw.parameters) ? raw.parameters : raw;
  const normalized = {};
  for (const [key, value] of Object.entries(source)) {
    const mapped = KOHYA_ALIASES[key] ?? key;
    if (!Object.hasOwn(DEFAULT_PARAMS, mapped)) continue;
    if (mapped === "resolution" && typeof value === "string" && /^\d+\s*,\s*\d+$/.test(value)) {
      normalized[mapped] = Number(value.split(",")[0]);
    } else if (mapped === "optimizer_args" && Array.isArray(value)) {
      normalized[mapped] = value.join(" ");
    } else {
      normalized[mapped] = value;
    }
  }
  const folders = raw.folders && typeof raw.folders === "object" && !Array.isArray(raw.folders) ? raw.folders : {};
  const rawDataset = cleanOptionalPath(raw.dataset_dir ?? folders.dataset_dir, "dataset_dir");
  const explicitMask = cleanOptionalPath(raw.mask_dir ?? folders.mask_dir, "mask_dir");
  const explicitOutput = cleanOptionalPath(raw.output_dir ?? folders.output_dir, "output_dir");
  const output_name = cleanOptionalName(raw.output_name ?? folders.output_name);
  if (!Object.keys(normalized).length && !raw.sample && !rawDataset) {
    throw new Error("No recognized training parameters were found in this file");
  }
  const validated = validateParams({ ...DEFAULT_PARAMS, ...normalized });
  const parameters = Object.fromEntries(Object.keys(DEFAULT_PARAMS).map((key) => [key, validated[key]]));
  const family = typeof raw.model_family === "string" && familyById(raw.model_family) ? raw.model_family : null;
  const sample = raw.sample ? sanitizeSample(raw.sample) : null;
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 60) : "";
  const derived = deriveSiblingDirs(rawDataset);
  return {
    name,
    model_family: family,
    parameters,
    sample,
    dataset_dir: derived.dataset_dir,
    mask_dir: explicitMask || derived.mask_dir,
    output_dir: explicitOutput || derived.output_dir,
    output_name
  };
}
