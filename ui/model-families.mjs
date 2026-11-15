// Model families the trainer can use (kohya sd-scripts). Pure data + helpers, no DOM.
// The Python side (desktop_backend.FAMILIES) holds the scripts and arguments; a unit test keeps both lists in step.
import { BUILTIN_PRESETS, DEFAULT_PARAMS, builtinPreset } from "./training-params.mjs";

// component key -> project field / payload key. Every family has a main model plus optional extra files.
export const COMPONENT_LABELS = {
  checkpoint: "Base model",
  clip_l: "CLIP-L text encoder", clip_g: "CLIP-G text encoder", t5xxl: "T5-XXL text encoder",
  ae: "AutoEncoder (ae.safetensors)", vae: "VAE", text_encoder: "Qwen2.5-VL text encoder", byt5: "byT5 text encoder",
  gemma2: "Gemma 2 text encoder", qwen3: "Qwen3 text encoder"
};
export const COMPONENT_KEYS = Object.keys(COMPONENT_LABELS);

const hf = (repo, path, key, gb, extra = {}) => ({ key, repo, path, name: path.split("/").at(-1), gb, ...extra });

// `base` = the kohya "clothing" starting values for the family (overlaid on the SD1.5 recommended preset).
export const FAMILIES = [
  {
    id: "sd15", short: "SD1.5", label: "Stable Diffusion 1.5", civitai: ["SD 1.5"], flow: false, fp8: true, swap: false, resolution: 512,
    components: [{ key: "checkpoint", label: "SD1.5 base model (.safetensors)", required: true }],
    base: {},
    downloads: [
      { id: "sd15-emaonly", label: "SD 1.5 — v1-5-pruned-emaonly (4.3 GB)", files: [hf("stable-diffusion-v1-5/stable-diffusion-v1-5", "v1-5-pruned-emaonly.safetensors", "checkpoint", 4.27)] }
    ]
  },
  {
    id: "sdxl", short: "SDXL", label: "SDXL 1.0 (also Pony / Illustrious / NoobAI)", civitai: ["SDXL", "Pony", "Illustrious", "NoobAI"], flow: false, fp8: true, swap: false, resolution: 1024,
    components: [{ key: "checkpoint", label: "SDXL base model (.safetensors)", required: true }],
    base: { resolution: 1024, batch_size: 1, mixed_precision: "bf16", text_encoder_lr: 0, rank: 32, alpha: 16 },
    downloads: [
      { id: "sdxl-base", label: "SDXL 1.0 base (6.9 GB)", files: [hf("stabilityai/stable-diffusion-xl-base-1.0", "sd_xl_base_1.0.safetensors", "checkpoint", 6.94)] }
    ]
  },
  {
    id: "sd3", short: "SD3.5", label: "Stable Diffusion 3.5", civitai: ["SD 3"], flow: true, fp8: true, swap: true, resolution: 1024,
    components: [
      { key: "checkpoint", label: "SD3.5 model (.safetensors)", required: true },
      { key: "clip_l", label: "CLIP-L", required: false, hint: "Leave the three text encoders empty only if your model file already contains them." },
      { key: "clip_g", label: "CLIP-G", required: false },
      { key: "t5xxl", label: "T5-XXL", required: false },
      { key: "vae", label: "VAE (optional)", required: false }
    ],
    base: { resolution: 1024, batch_size: 1, mixed_precision: "bf16", rank: 16, alpha: 16, repeats: 8, epochs: 10 },
    downloads: [
      {
        id: "sd35-medium", label: "SD 3.5 Medium + text encoders (gated: Hugging Face token needed)", gated: "stabilityai/stable-diffusion-3.5-medium",
        files: [
          hf("stabilityai/stable-diffusion-3.5-medium", "sd3.5_medium.safetensors", "checkpoint", 4.94),
          hf("stabilityai/stable-diffusion-3.5-medium", "text_encoders/clip_l.safetensors", "clip_l", 0.25),
          hf("stabilityai/stable-diffusion-3.5-medium", "text_encoders/clip_g.safetensors", "clip_g", 1.39),
          hf("stabilityai/stable-diffusion-3.5-medium", "text_encoders/t5xxl_fp16.safetensors", "t5xxl", 9.79)
        ]
      }
    ]
  },
  {
    id: "flux", short: "FLUX.1", label: "FLUX.1", civitai: ["Flux"], flow: true, fp8: true, swap: true, resolution: 1024,
    components: [
      { key: "checkpoint", label: "FLUX.1 model (.safetensors)", required: true },
      { key: "clip_l", label: "CLIP-L", required: true },
      { key: "t5xxl", label: "T5-XXL", required: true },
      { key: "ae", label: "AutoEncoder (ae.safetensors)", required: true }
    ],
    base: { resolution: 1024, batch_size: 1, mixed_precision: "bf16", rank: 16, alpha: 16, fp8_base: true },
    downloads: [
      {
        id: "flux-schnell", label: "FLUX.1 schnell + encoders (Apache-2.0, 34 GB)",
        files: [
          hf("black-forest-labs/FLUX.1-schnell", "flux1-schnell.safetensors", "checkpoint", 23.78),
          hf("black-forest-labs/FLUX.1-schnell", "ae.safetensors", "ae", 0.34),
          hf("comfyanonymous/flux_text_encoders", "clip_l.safetensors", "clip_l", 0.25),
          hf("comfyanonymous/flux_text_encoders", "t5xxl_fp16.safetensors", "t5xxl", 9.79)
        ]
      },
      {
        id: "flux-dev", label: "FLUX.1 dev + encoders (gated: Hugging Face token needed, 34 GB)", gated: "black-forest-labs/FLUX.1-dev",
        files: [
          hf("black-forest-labs/FLUX.1-dev", "flux1-dev.safetensors", "checkpoint", 23.8),
          hf("black-forest-labs/FLUX.1-dev", "ae.safetensors", "ae", 0.34),
          hf("comfyanonymous/flux_text_encoders", "clip_l.safetensors", "clip_l", 0.25),
          hf("comfyanonymous/flux_text_encoders", "t5xxl_fp16.safetensors", "t5xxl", 9.79)
        ]
      }
    ]
  },
  {
    id: "lumina", short: "Lumina 2", label: "Lumina Image 2.0", civitai: ["Lumina"], flow: true, fp8: true, swap: true, resolution: 1024,
    components: [
      { key: "checkpoint", label: "Lumina Image 2.0 model (.safetensors)", required: true },
      { key: "gemma2", label: "Gemma 2 text encoder", required: true },
      { key: "ae", label: "AutoEncoder (ae.safetensors)", required: true }
    ],
    base: { resolution: 1024, batch_size: 1, mixed_precision: "bf16", rank: 8, alpha: 8 },
    downloads: [
      {
        id: "lumina2", label: "Lumina Image 2.0 (ComfyUI repackaged, 10.8 GB)", note: "If the trainer reports missing keys, use the original Alpha-VLLM weights instead.",
        files: [
          hf("Comfy-Org/Lumina_Image_2.0_Repackaged", "split_files/diffusion_models/lumina_2_model_bf16.safetensors", "checkpoint", 5.22),
          hf("Comfy-Org/Lumina_Image_2.0_Repackaged", "split_files/text_encoders/gemma_2_2b_fp16.safetensors", "gemma2", 5.23),
          hf("Comfy-Org/Lumina_Image_2.0_Repackaged", "split_files/vae/ae.safetensors", "ae", 0.34)
        ]
      }
    ]
  },
  {
    id: "hunyuan", short: "HunyuanImage 2.1", label: "HunyuanImage 2.1", civitai: ["Hunyuan"], flow: true, fp8: true, swap: true, resolution: 1024,
    components: [
      { key: "checkpoint", label: "HunyuanImage 2.1 DiT (.safetensors)", required: true },
      { key: "text_encoder", label: "Qwen2.5-VL text encoder", required: true },
      { key: "byt5", label: "byT5 text encoder", required: true },
      { key: "vae", label: "HunyuanImage VAE", required: true }
    ],
    base: { resolution: 1024, batch_size: 1, mixed_precision: "bf16", rank: 16, alpha: 1, fp8_base: true, blocks_to_swap: 9 },
    downloads: [
      {
        id: "hunyuan21", label: "HunyuanImage 2.1 (ComfyUI repackaged, 52 GB)", note: "Very large. 24 GB VRAM needs fp8 and block swap (set in the Parameters).",
        files: [
          hf("Comfy-Org/HunyuanImage_2.1_ComfyUI", "split_files/diffusion_models/hunyuanimage2.1_bf16.safetensors", "checkpoint", 34.85),
          hf("Comfy-Org/HunyuanImage_2.1_ComfyUI", "split_files/text_encoders/qwen_2.5_vl_7b.safetensors", "text_encoder", 16.58),
          hf("Comfy-Org/HunyuanImage_2.1_ComfyUI", "split_files/text_encoders/byt5_small_glyphxl_fp16.safetensors", "byt5", 0.44),
          hf("Comfy-Org/HunyuanImage_2.1_ComfyUI", "split_files/vae/hunyuan_image_2.1_vae_fp16.safetensors", "vae", 0.81)
        ]
      }
    ]
  },
  {
    id: "anima", short: "Anima", label: "Anima", civitai: ["Anima"], flow: true, fp8: false, swap: true, resolution: 1024,
    components: [
      { key: "checkpoint", label: "Anima DiT (.safetensors)", required: true },
      { key: "qwen3", label: "Qwen3-0.6B text encoder", required: true },
      { key: "vae", label: "Qwen-Image VAE", required: true }
    ],
    base: { resolution: 1024, batch_size: 1, mixed_precision: "bf16", rank: 8, alpha: 1, fp8_base: false },
    downloads: [
      {
        id: "anima-base", label: "Anima base v1.0 (5.6 GB)",
        files: [
          hf("circlestone-labs/Anima", "split_files/diffusion_models/anima-base-v1.0.safetensors", "checkpoint", 4.18),
          hf("circlestone-labs/Anima", "split_files/text_encoders/qwen_3_06b_base.safetensors", "qwen3", 1.19),
          hf("circlestone-labs/Anima", "split_files/vae/qwen_image_vae.safetensors", "vae", 0.25)
        ]
      }
    ]
  }
];

export const DEFAULT_FAMILY = "sd15";

export function familyById(id) {
  return FAMILIES.find((family) => family.id === id) ?? null;
}

export function isFamily(id) {
  return familyById(id) !== null;
}

export function requiredComponents(family) {
  return family.components.filter((item) => item.required);
}

// Names of the components that still have no file, for the error message and the training button.
export function missingComponents(family, paths) {
  return requiredComponents(family).filter((item) => !String(paths?.[item.key] ?? "").trim()).map((item) => item.label);
}

export function downloadById(family, id) {
  return family.downloads.find((item) => item.id === id) ?? null;
}

export function downloadTotalGb(download) {
  return Math.round(download.files.reduce((sum, file) => sum + file.gb, 0) * 10) / 10;
}

// Payload for the "download" job. `existing` = component paths that are already set (they are skipped).
export function downloadItems(family, download, existing = {}) {
  return download.files
    .filter((file) => !String(existing[file.key] ?? "").trim())
    .map((file) => ({ key: file.key, url: "https://huggingface.co/" + file.repo + "/resolve/main/" + file.path, name: file.name, gb: file.gb, gated: download.gated ?? null }));
}

// Params for a family: the SD1.5 defaults with the family's own starting values on top. Flow-matching models
// ignore min-SNR, noise offset, clip skip and caption shuffling, so those start switched off.
export function familyParams(family, params = DEFAULT_PARAMS) {
  const result = { ...params, ...family.base };
  if (family.flow) Object.assign(result, { min_snr_gamma: 0, noise_offset: 0, clip_skip: 1, shuffle_caption: false, keep_tokens: 0, text_encoder_lr: 0 });
  return result;
}

// What a Civitai file's base model says about the chosen family ("" = looks fine).
export function civitaiMismatch(family, baseModel) {
  const text = String(baseModel ?? "").trim();
  if (!text) return "";
  if (family.civitai.some((prefix) => text.toLowerCase().startsWith(prefix.toLowerCase()))) return "";
  return "This Civitai model is “" + text + "”, but the selected type is " + family.label + ".";
}

// ---- built-in presets per family --------------------------------------------------------------
const half = (value) => Math.max(1, Math.round(value / 2));

// SD1.5 keeps the hand-tuned list (incl. community presets). Other families get the same four basics, derived from it.
export function presetsFor(familyId) {
  const family = familyById(familyId) ?? familyById(DEFAULT_FAMILY);
  if (family.id === "sd15") return BUILTIN_PRESETS;
  const group = "Recommended — " + family.label.replace(/ \(.*$/, "") + " clothing LoRA";
  const derive = (id, name, description, overrides) => {
    const source = builtinPreset(id);
    return { id: family.id + "-" + id, group, name, description, parameters: { ...familyParams(family, source.parameters), ...overrides } };
  };
  const rank = family.base.rank ?? 16;
  const alpha = family.base.alpha ?? rank;
  const lowSwap = family.flow ? Math.max(family.base.blocks_to_swap ?? 0, 18) : 0;
  const lowVram = { batch_size: 1, gradient_checkpointing: true, rank: half(rank), alpha: Math.min(half(rank), alpha), ...(family.flow ? { fp8_base: family.id !== "anima", blocks_to_swap: lowSwap } : {}) };
  return [
    derive("clothing-masked", "Clothing — with masks (recommended)",
      "Masked loss learns only the clothing. Rank " + rank + " / alpha " + alpha + ", AdamW8bit + cosine at 1e-4, " + family.label + " defaults for resolution and precision. A starting point: check the first samples and adjust.",
      { rank, alpha, use_masks: true }),
    derive("clothing-nomask", "Clothing — without masks",
      "For datasets without masks: a smaller network (rank " + half(rank) + ") and fewer repeats reduce face / body leakage. Describe everything that is NOT the clothing in the captions.",
      { rank: half(rank), alpha: Math.min(half(rank), alpha), repeats: 6, epochs: 8, use_masks: false }),
    derive("low-vram", "Low VRAM", "Batch 1, gradient checkpointing, a smaller network" + (family.flow ? ", fp8 base weights and block swap" : "") + ". Raise the values if you have VRAM to spare.", lowVram),
    derive("quick-test", "Quick test (checks the whole pipeline)", "A tiny run (2 epochs, rank 4, plain AdamW) to confirm files and the GPU work before a real run.",
      { optimizer: "AdamW", repeats: 2, epochs: 2, rank: 4, alpha: Math.min(4, alpha), use_masks: true })
  ];
}

export function presetById(familyId, id) {
  return presetsFor(familyId).find((item) => item.id === id) ?? null;
}

// What the "link" box accepts: a Civitai model ID, a Civitai / Hugging Face link. Hugging Face "blob" pages become file links.
export function normalizeDownloadLink(text) {
  const value = String(text ?? "").trim();
  if (/^\d{1,9}$/.test(value)) return "https://civitai.com/models/" + value;
  if (!/^https:\/\//i.test(value)) throw new Error("Enter an https:// link or a Civitai model ID");
  return value.replace(/^(https:\/\/huggingface\.co\/[^/]+\/[^/]+)\/blob\//i, "$1/resolve/");
}
