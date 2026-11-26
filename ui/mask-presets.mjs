// Auto-mask segmentation prompt presets (built-in + user-saved custom presets, shared between Mask Creation and Tools).
// Pure functions, no DOM.

export const MASK_PRESET_KEY = "costume-mask-presets";
export const DEFAULT_MASK_PRESET_NAME = "My mask preset";

export const BUILTIN_MASK_PRESETS = [
  {
    id: "buruma-gym-uniform",
    name: "ブルマ体操服 (Buruma / Gym uniform)",
    mask_prompt: "white shirt, t-shirt, shorts, underwear, swimsuit",
    exclude_prompt: "face, hair"
  },
  {
    id: "buruma-only",
    name: "ブルマ単体 (Buruma / Shorts only)",
    mask_prompt: "shorts, underwear, swimsuit, bloomers",
    exclude_prompt: "face, hair, shirt, t-shirt"
  },
  {
    id: "general-clothing",
    name: "General clothing / Outfit",
    mask_prompt: "clothes, clothing, dress, jacket, pants, skirt, shirt, shorts",
    exclude_prompt: "face, hair"
  }
];

export const DEFAULT_MASK_PRESET = BUILTIN_MASK_PRESETS[0];

const reservedNames = () => BUILTIN_MASK_PRESETS.map((preset) => preset.name);

export function normalizeMaskPresetName(name) {
  const value = String(name ?? "").trim().replace(/\s+/g, " ");
  if (value.length > 60) throw new Error("Mask preset name must be 60 characters or fewer");
  if (reservedNames().includes(value)) throw new Error("That name is reserved for a built-in mask preset");
  return value || DEFAULT_MASK_PRESET_NAME;
}

function cleanPrompt(text, label, { allowEmpty = false } = {}) {
  const value = String(text ?? "");
  if (value.includes("\0")) throw new Error(label + " contains unsupported characters");
  if (value.length > 1000) throw new Error(label + " must be 1000 characters or fewer");
  const trimmed = value.trim();
  if (!trimmed && !allowEmpty) throw new Error(label + " is required");
  return trimmed;
}

export function upsertMaskPreset(presets, name, maskPrompt, excludePrompt = "") {
  const cleanName = normalizeMaskPresetName(name);
  const entry = {
    name: cleanName,
    mask_prompt: cleanPrompt(maskPrompt, "Include prompt"),
    exclude_prompt: cleanPrompt(excludePrompt, "Exclude prompt", { allowEmpty: true })
  };
  const index = presets.findIndex((preset) => preset.name === cleanName);
  const next = presets.slice();
  if (index >= 0) next[index] = entry;
  else next.push(entry);
  return next;
}

export function removeMaskPreset(presets, name) {
  return presets.filter((preset) => preset.name !== name);
}

export function readMaskPresetStore(raw) {
  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
  if (data?.schema_version !== 1 || !Array.isArray(data.presets)) return [];
  const result = [];
  for (const item of data.presets) {
    try {
      const [entry] = upsertMaskPreset([], item?.name, item?.mask_prompt, item?.exclude_prompt);
      if (!result.some((preset) => preset.name === entry.name)) result.push(entry);
    } catch { /* skip corrupted entry */ }
  }
  return result;
}

export function serializeMaskPresetStore(presets) {
  return JSON.stringify({ schema_version: 1, presets });
}

export function findMaskPreset(value, customPresets = []) {
  const key = String(value ?? "");
  if (key.startsWith("builtin:")) {
    return BUILTIN_MASK_PRESETS.find((preset) => "builtin:" + preset.id === key) ?? null;
  }
  if (key.startsWith("custom:")) {
    return customPresets.find((preset) => "custom:" + preset.name === key) ?? null;
  }
  return null;
}
