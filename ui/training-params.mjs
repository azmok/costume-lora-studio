// Training parameters (like bmaltais' kohya_ss GUI): the schema shared by the form, presets and validation,
// the built-in presets, and the "total steps / time" arithmetic. Pure functions, no DOM.
import { formatDuration } from "./job-progress.mjs";

// value = kohya --optimizer_type; package = Python module that must be importable in the training environment.
export const OPTIMIZERS = [
  { value: "AdamW", label: "AdamW — standard (no extra package)", package: null },
  { value: "AdamW8bit", label: "AdamW8bit — saves VRAM (needs bitsandbytes)", package: "bitsandbytes", pip: "bitsandbytes" },
  { value: "PagedAdamW8bit", label: "PagedAdamW8bit — saves VRAM (needs bitsandbytes)", package: "bitsandbytes", pip: "bitsandbytes" },
  { value: "Lion", label: "Lion (needs lion-pytorch)", package: "lion_pytorch", pip: "lion-pytorch" },
  { value: "SGDNesterov", label: "SGDNesterov (no extra package)", package: null },
  { value: "DAdaptAdam", label: "DAdaptAdam — adaptive LR, set LR to 1 (needs dadaptation)", package: "dadaptation", pip: "dadaptation" },
  { value: "DAdaptation", label: "DAdaptation — adaptive LR, set LR to 1 (needs dadaptation)", package: "dadaptation", pip: "dadaptation" },
  { value: "Prodigy", label: "Prodigy — adaptive LR, set LR to 1 (needs prodigyopt)", package: "prodigyopt", pip: "prodigyopt" },
  { value: "Adafactor", label: "Adafactor — low VRAM (no extra package)", package: null }
];

export const SCHEDULERS = [
  { value: "constant", label: "constant — fixed learning rate" },
  { value: "constant_with_warmup", label: "constant_with_warmup" },
  { value: "linear", label: "linear — decays to 0" },
  { value: "cosine", label: "cosine — smooth decay to 0" },
  { value: "cosine_with_restarts", label: "cosine_with_restarts — decays, then restarts" },
  { value: "polynomial", label: "polynomial" }
];

export const RESOLUTIONS = [512, 576, 640, 704, 768, 896, 1024, 1152, 1280, 1536];
const MIXED = ["fp16", "bf16", "no"];

const number = (key, id, fallback, min, max, integer = false) => ({ key, id, kind: "number", default: fallback, min, max, integer });
const choice = (key, id, fallback, options) => ({ key, id, kind: "choice", default: fallback, options });
const flag = (key, id, fallback) => ({ key, id, kind: "flag", default: fallback });

// key = payload / preset key, id = DOM id of the form control.
export const PARAM_SCHEMA = [
  choice("resolution", "train-resolution", 512, RESOLUTIONS),
  number("batch_size", "batch-size", 1, 1, 16, true),
  number("repeats", "repeats", 1, 1, 200, true),
  number("epochs", "epochs", 10, 1, 1000, true),
  number("steps", "steps", 1000, 0, 1000000, true), // 0 = derive from epochs
  number("save_every_n_epochs", "save-every-n-epochs", 1, 0, 1000, true), // 0 = save every 250 steps
  choice("optimizer", "optimizer", "AdamW", OPTIMIZERS.map((item) => item.value)),
  { key: "optimizer_args", id: "optimizer-args", kind: "text", default: "", max: 300 },
  number("learning_rate", "learning-rate", 0.0001, 0.0000001, 10),
  number("text_encoder_lr", "text-encoder-lr", 0, 0, 10), // 0 = train the UNet only
  choice("lr_scheduler", "scheduler", "constant", SCHEDULERS.map((item) => item.value)),
  number("lr_warmup_percent", "lr-warmup", 0, 0, 50),
  number("lr_scheduler_num_cycles", "lr-cycles", 1, 1, 20, true),
  number("rank", "rank", 16, 1, 512, true),
  number("alpha", "alpha", 16, 0.1, 512),
  choice("mixed_precision", "mixed-precision", "fp16", MIXED),
  number("seed", "seed", 42, 0, 2147483647, true),
  number("min_snr_gamma", "min-snr", 0, 0, 20),
  number("noise_offset", "noise-offset", 0, 0, 1),
  choice("clip_skip", "clip-skip", 1, [1, 2]),
  flag("shuffle_caption", "shuffle-caption", false),
  number("keep_tokens", "keep-tokens", 0, 0, 10, true),
  flag("use_masks", "use-masks", true),
  flag("alpha_mask", "alpha-mask", false),
  flag("gradient_checkpointing", "gradient-checkpointing", true),
  flag("fp8_base", "fp8-base", false),
  number("blocks_to_swap", "blocks-to-swap", 0, 0, 60, true)
];

export const DEFAULT_PARAMS = Object.fromEntries(PARAM_SCHEMA.map((item) => [item.key, item.default]));
export const PARAM_FIELDS = Object.fromEntries(PARAM_SCHEMA.map((item) => [item.key, item.id]));
const CORE_KEYS = ["steps", "batch_size", "rank", "alpha", "learning_rate", "seed"];

export function optimizerInfo(value) {
  return OPTIMIZERS.find((item) => item.value === value) ?? null;
}

// Validates the keys that are present (plus the core ones) and returns normalized values; unknown keys pass through.
export function validateParams(values, { required = CORE_KEYS } = {}) {
  const result = { ...values };
  for (const item of PARAM_SCHEMA) {
    const raw = values[item.key];
    const missing = raw === undefined || raw === null || raw === "";
    if (missing) {
      if (item.kind === "number" && required.includes(item.key)) throw new Error(item.key + " is required");
      continue;
    }
    if (item.kind === "number") {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < item.min || value > item.max || (item.integer && !Number.isInteger(value))) {
        throw new Error(item.key + " is out of range");
      }
      result[item.key] = value;
    } else if (item.kind === "choice") {
      const match = item.options.find((option) => String(option) === String(raw));
      if (match === undefined) throw new Error("Invalid " + item.key + " value");
      result[item.key] = match;
    } else if (item.kind === "flag") {
      if (typeof raw === "boolean") result[item.key] = raw;
      else if (raw === "true" || raw === "false") result[item.key] = raw === "true";
      else throw new Error("Invalid " + item.key + " value");
    } else {
      const text = String(raw).trim();
      if (text.length > item.max) throw new Error(item.key + " is too long");
      result[item.key] = text;
    }
  }
  if (result.optimizer_args) {
    for (const token of result.optimizer_args.split(/\s+/)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*=\S+$/.test(token)) throw new Error("Optimizer arguments must look like key=value key2=value2");
    }
  }
  return result;
}

// ---- built-in presets --------------------------------------------------------------------------
// Community values come from bmaltais/kohya_ss presets/lora (sd15 EDG_LoraOptiSettings, iA3-Prodigy-sd15,
// SDXL aitrepreneur clothing). The two "Clothing" presets are starting points for this app's masked workflow.
const preset = (id, group, name, description, overrides) => ({ id, group, name, description, parameters: { ...DEFAULT_PARAMS, ...overrides } });

export const BUILTIN_PRESETS = [
  preset("clothing-masked", "Recommended — SD1.5 clothing LoRA", "Clothing — with masks (recommended)",
    "Masked loss learns only the clothing. Rank 32 / alpha 16 keeps fabric detail, AdamW8bit + cosine at 1e-4 (text encoder 5e-5), min-SNR 5, noise offset 0.05, shuffled tags with the trigger word kept first. About 1,800 steps for 45 images. Use clip skip 2 for anime checkpoints.",
    { resolution: 512, batch_size: 2, repeats: 8, epochs: 10, steps: 0, save_every_n_epochs: 1, optimizer: "AdamW8bit", learning_rate: 0.0001, text_encoder_lr: 0.00005,
      lr_scheduler: "cosine", lr_warmup_percent: 5, rank: 32, alpha: 16, mixed_precision: "fp16", min_snr_gamma: 5, noise_offset: 0.05,
      clip_skip: 1, shuffle_caption: true, keep_tokens: 1, use_masks: true, gradient_checkpointing: true }),
  preset("oje-masked-clip2", "Recommended — SD1.5 clothing LoRA", "Oje recommended — Masked clothing (Clip skip 2)",
    "Tuned for masked clothing LoRAs used on merged/anime checkpoints (Clip skip 2): slightly stronger UNet LR (1.5e-4) to compensate for masked-loss gradient reduction, rank 32 / alpha 16, 12 epochs, saving every epoch to pick the sweetest epoch.",
    { resolution: 512, batch_size: 2, repeats: 8, epochs: 12, steps: 0, save_every_n_epochs: 1, optimizer: "AdamW8bit", learning_rate: 0.00015, text_encoder_lr: 0.00005,
      lr_scheduler: "cosine", lr_warmup_percent: 5, rank: 32, alpha: 16, mixed_precision: "fp16", min_snr_gamma: 5, noise_offset: 0.05,
      clip_skip: 2, shuffle_caption: true, keep_tokens: 1, use_masks: true, gradient_checkpointing: true }),
  preset("clothing-nomask", "Recommended — SD1.5 clothing LoRA", "Clothing — without masks",
    "For datasets without masks: the whole image is learned, so a smaller network (rank 16 / alpha 8) and fewer repeats reduce face / body leakage. Same optimizer and schedule as the masked preset. Describe everything that is NOT the clothing in the captions.",
    { resolution: 512, batch_size: 2, repeats: 6, epochs: 8, steps: 0, optimizer: "AdamW8bit", learning_rate: 0.0001, text_encoder_lr: 0.00005,
      lr_scheduler: "cosine", lr_warmup_percent: 5, rank: 16, alpha: 8, mixed_precision: "fp16", min_snr_gamma: 5, noise_offset: 0.05,
      clip_skip: 1, shuffle_caption: true, keep_tokens: 1, use_masks: false, gradient_checkpointing: true }),
  preset("community-edg", "Community (bmaltais kohya_ss presets)", "EDG LoRA Opti — SD1.5",
    "From bmaltais “sd15 - EDG_LoraOptiSettings”: AdamW8bit, constant 1e-4, text encoder 5e-5, rank/alpha 64, batch 3, bf16 (needs an RTX 30-series or newer GPU), noise offset 0.05, clip skip 2. Repeats / epochs are not part of the original, so they are set here.",
    { resolution: 512, batch_size: 3, repeats: 5, epochs: 10, steps: 0, optimizer: "AdamW8bit", learning_rate: 0.0001, text_encoder_lr: 0.00005,
      lr_scheduler: "constant", rank: 64, alpha: 64, mixed_precision: "bf16", seed: 1234, noise_offset: 0.05, clip_skip: 2, gradient_checkpointing: false }),
  preset("community-prodigy", "Community (bmaltais kohya_ss presets)", "Prodigy — adaptive learning rate",
    "Optimizer settings from bmaltais “iA3-Prodigy-sd15” (Prodigy, LR 1.0, d_coef 1.0, weight decay 0.01, min-SNR 5, noise offset 0.05, shuffled tags, keep 1 token) applied to a standard LoRA. Needs the prodigyopt package. No LR tuning needed.",
    { resolution: 512, batch_size: 2, repeats: 8, epochs: 10, steps: 0, optimizer: "Prodigy", optimizer_args: "d_coef=1.0 weight_decay=0.01 safeguard_warmup=False use_bias_correction=False",
      learning_rate: 1, text_encoder_lr: 1, lr_scheduler: "constant", rank: 32, alpha: 16, mixed_precision: "fp16", min_snr_gamma: 5, noise_offset: 0.05,
      shuffle_caption: true, keep_tokens: 1 }),
  preset("community-adafactor", "Community (bmaltais kohya_ss presets)", "Adafactor — clothing (aitrepreneur)",
    "From bmaltais “SDXL - LoRA aitrepreneur clothing”: Adafactor (scale_parameter=False relative_step=False warmup_init=False), constant 9e-4, rank 128 / alpha 1, 15 epochs, bf16 (RTX 30-series or newer). The original targets SDXL; here it is applied to SD1.5 at 512 px.",
    { resolution: 512, batch_size: 1, repeats: 5, epochs: 15, steps: 0, optimizer: "Adafactor", optimizer_args: "scale_parameter=False relative_step=False warmup_init=False",
      learning_rate: 0.0009, text_encoder_lr: 0.0009, lr_scheduler: "constant", rank: 128, alpha: 1, mixed_precision: "bf16", seed: 12345, gradient_checkpointing: true }),
  preset("low-vram", "Basic", "Low VRAM (6–8 GB)",
    "AdamW8bit, batch 1, gradient checkpointing, UNet only (text encoder not trained), rank 16 / alpha 8.",
    { resolution: 512, batch_size: 1, repeats: 8, epochs: 10, steps: 0, optimizer: "AdamW8bit", learning_rate: 0.0001, text_encoder_lr: 0,
      lr_scheduler: "cosine", lr_warmup_percent: 5, rank: 16, alpha: 8, shuffle_caption: true, keep_tokens: 1 }),
  preset("quick-test", "Basic", "Quick test (checks the whole pipeline)",
    "A tiny run (2 epochs, rank 8, plain AdamW with no extra package) to confirm files, masks and the GPU work before a real run.",
    { resolution: 512, batch_size: 2, repeats: 2, epochs: 2, steps: 0, optimizer: "AdamW", learning_rate: 0.0001, text_encoder_lr: 0,
      lr_scheduler: "constant", rank: 8, alpha: 4 })
];

export function builtinPreset(id) {
  return BUILTIN_PRESETS.find((item) => item.id === id) ?? null;
}

// ---- total steps and time ----------------------------------------------------------------------
export function computeTotals({ images, repeats, batchSize, epochs, maxSteps }) {
  if (!(images > 0) || !(repeats > 0) || !(batchSize > 0)) return null;
  const stepsPerEpoch = Math.ceil((images * repeats) / batchSize);
  const byMaxSteps = Number(maxSteps) > 0;
  const totalSteps = byMaxSteps ? Number(maxSteps) : stepsPerEpoch * Math.max(1, epochs);
  return { images, repeats, batchSize, stepsPerEpoch, epochs: byMaxSteps ? totalSteps / stepsPerEpoch : epochs, totalSteps, byMaxSteps };
}

export const DEFAULT_SECONDS_PER_IMAGE = 0.5; // rough SD1.5 / 512 px / mid-range GPU guess until a run has been measured
export const STARTUP_SECONDS = 60; // model loading

const scaleFor = (resolution) => (resolution / 512) ** 2;

export function estimateSeconds({ totalSteps, batchSize, resolution, secondsPerImage = DEFAULT_SECONDS_PER_IMAGE }) {
  return STARTUP_SECONDS + totalSteps * batchSize * secondsPerImage * scaleFor(resolution);
}

// "1.66it/s" -> 0.60 s per step; "2.5s/it" -> 2.5 s per step.
export function parseRate(text) {
  const match = /([\d.]+)\s*(it\/s|s\/it)/i.exec(String(text ?? ""));
  if (!match) return null;
  const value = Number(match[1]);
  if (!(value > 0)) return null;
  return match[2].toLowerCase() === "it/s" ? 1 / value : value;
}

// Keeps a smoothed seconds-per-image (normalized to 512 px) from the speed of the last training run.
export function updateSpeed(previous, { rateText, batchSize, resolution, now = Date.now() }) {
  const secondsPerStep = parseRate(rateText);
  if (!secondsPerStep || !(batchSize > 0)) return previous;
  const measured = secondsPerStep / batchSize / scaleFor(resolution);
  const blended = previous?.secondsPerImage ? previous.secondsPerImage * 0.7 + measured * 0.3 : measured;
  return { secondsPerImage: blended, measuredAt: now };
}

export function parseSpeed(raw) {
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    return value && value.secondsPerImage > 0 && value.secondsPerImage < 1000 ? { secondsPerImage: Number(value.secondsPerImage), measuredAt: Number(value.measuredAt) || 0 } : null;
  } catch { return null; }
}

export function formatEstimate(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 90) return "about 1 minute";
  const minutes = Math.round(total / 60);
  if (minutes < 90) return "about " + minutes + " min";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return "about " + hours + " h" + (rest ? " " + rest + " min" : "");
}

// The text shown at the bottom of the Training tab.
export function summaryModel(values, images, speed) {
  const totals = computeTotals({ images: images?.count, repeats: values.repeats, batchSize: values.batch_size, epochs: values.epochs, maxSteps: values.steps });
  if (!totals) return { ready: false };
  const measured = speed?.secondsPerImage > 0;
  const seconds = estimateSeconds({ totalSteps: totals.totalSteps, batchSize: values.batch_size, resolution: values.resolution, secondsPerImage: measured ? speed.secondsPerImage : DEFAULT_SECONDS_PER_IMAGE });
  return {
    ready: true, totals, seconds, estimate: formatEstimate(seconds), measured,
    speedNote: measured
      ? "based on the speed of your last training run (" + (1 / (speed.secondsPerImage * scaleFor(values.resolution) * values.batch_size)).toFixed(2) + " steps/s at this batch size)"
      : "rough guess (" + DEFAULT_SECONDS_PER_IMAGE + " s per image at 512 px) — it becomes accurate after your first training run",
    duration: formatDuration(seconds)
  };
}
