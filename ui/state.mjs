import { DEFAULT_PARAMS, validateParams } from "./training-params.mjs";

export const PROJECT_DEFAULTS = {
  raw_dir: "", mask_dir: "", caption_dir: "", dataset_dir: "", train_masks: "",
  training_dir: "", trigger_word: "", checkpoint: "", sample_checkpoint: "", output_name: "my_costume",
  model_family: "sd15",
  clip_l: "", clip_g: "", t5xxl: "", ae: "", vae: "", text_encoder: "", byt5: "", gemma2: "", qwen3: ""
};

export const TRAINING_DEFAULTS = { ...DEFAULT_PARAMS };

export function required(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " is required");
  return value.trim();
}

export function validateTraining(values) {
  const result = validateParams(values);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(values.output_name)) throw new Error("LoRA name may only use letters, digits, _ and -");
  return result;
}

export function makeTrainingProfile(project, parameters) {
  if (!project || !parameters || typeof project !== "object" || typeof parameters !== "object" || Array.isArray(project) || Array.isArray(parameters)) {
    throw new Error("Invalid settings data");
  }
  const paths = {};
  for (const [key, fallback] of Object.entries(PROJECT_DEFAULTS)) {
    if (project[key] !== undefined && typeof project[key] !== "string") throw new Error("Setting " + key + " is invalid");
    paths[key] = project[key] ?? fallback;
  }
  const validated = validateTraining({ ...TRAINING_DEFAULTS, ...parameters, output_name: paths.output_name });
  return {
    schema_version: 1,
    project: paths,
    parameters: Object.fromEntries(Object.keys(TRAINING_DEFAULTS).map((key) => [key, validated[key]]))
  };
}

export function readTrainingProfile(profile) {
  if (profile?.schema_version !== 1 || !profile.project || !profile.parameters) {
    throw new Error("Invalid saved-settings format");
  }
  return makeTrainingProfile(profile.project, profile.parameters);
}

export function applyJobEvent(state, event) {
  if (state.jobId && event.jobId !== state.jobId) return state;
  return { ...state, jobId: event.jobId, status: event.data.status || state.status, latest: event.data };
}

// ---- Named training presets (parameters only; folders are per-project, not per-preset) ----
export const BUILTIN_PRESET = { id: "standard", name: "SD1.5 Clothing LoRA — Default settings" };
export const DEFAULT_PRESET_NAME = "My preset";

export function normalizePresetName(name) {
  const value = String(name ?? "").trim().replace(/\s+/g, " ");
  if (value.length > 60) throw new Error("Preset name must be 60 characters or fewer");
  if (value === BUILTIN_PRESET.name) throw new Error("That name is reserved for the default preset");
  return value || DEFAULT_PRESET_NAME;
}

export function readPresetStore(raw) {
  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
  if (data?.schema_version !== 1 || !Array.isArray(data.presets)) return [];
  const presets = [];
  for (const item of data.presets) {
    try {
      const name = normalizePresetName(item?.name);
      const parameters = makeTrainingProfile({}, item?.parameters).parameters;
      if (!presets.some((preset) => preset.name === name)) presets.push({ name, parameters });
    } catch { /* skip a corrupted entry, keep the rest */ }
  }
  return presets;
}

export function upsertPreset(presets, name, parameters) {
  const cleanName = normalizePresetName(name);
  const entry = { name: cleanName, parameters: makeTrainingProfile({}, parameters).parameters };
  const index = presets.findIndex((preset) => preset.name === cleanName);
  const next = presets.slice();
  if (index >= 0) next[index] = entry; else next.push(entry);
  return next;
}

export function removePreset(presets, name) {
  return presets.filter((preset) => preset.name !== name);
}

export function serializePresetStore(presets) {
  return JSON.stringify({ schema_version: 1, presets });
}
