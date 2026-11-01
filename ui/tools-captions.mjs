// Caption instruction templates and "insert tags after the trigger word" logic.

export const NO_TEMPLATE = { id: "none", name: "None (clear instruction)", prompt: "", excludeClothing: true };

// excludeClothing only affects the WD tagger models (it drops clothing tags); VLMs follow the prompt.
export const BUILTIN_TEMPLATES = [
  {
    id: "sd15-clothing-tags",
    name: "SD1.5 Clothing LoRA (masked) — Danbooru tags",
    excludeClothing: false,
    prompt: `You are an expert anime/manga image tagger specializing in Danbooru-style tags for SD 1.5 LoRA training.
Analyze the provided image and generate a concise, comma-separated list of Danbooru tags following these strict rules:

1. TARGET FOCUS:
- Only describe the visible CLOTHING/OUTFIT, CAMERA ANGLE/FRAMING, and BACKGROUND.

2. STRICT EXCLUSIONS (CRITICAL):
- Parts of the body, head, face, skin, or hair are masked, absent, or irrelevant.
- NEVER include tags for person, gender, face, facial features, hair, eyes, expressions, body parts, hands, or bare skin (e.g., DO NOT output: 1girl, face, hair, smile, cleavage, bare shoulders, navel, thighs).

3. CAMERA & ANGLE (MUST INCLUDE WHERE APPLICABLE):
- Viewpoint/Direction: from behind, from side, profile, straight-on, back
- Framing: full body, cowboy shot, upper body, close-up
- Angle: from above, from below, dutch angle

4. CLOTHING SPECIFICS:
- Identify clothing types, structure, and accessories (e.g., dress, long skirt, cape, pleated skirt, sleeves, apron, boots, ribbon, gloves).
- Describe clothing state if notable (e.g., fluttering, torn, loose).

5. BACKGROUND:
- Describe the visible background simply (e.g., simple background, white background, indoors, outdoors, nature). If plain or transparent/black due to masking, tag accordingly (e.g., simple background, monochrome background).

6. OUTPUT FORMAT:
- Output ONLY the lowercase, comma-separated tags.
- No commentary, no sentence descriptions, no markdown code blocks, just raw tags.`
  },
  {
    id: "sd15-clothing-sentence",
    name: "SD1.5 Clothing LoRA — Natural language (clothing, framing, background only)",
    excludeClothing: false,
    prompt: "Describe only the visible clothing and accessories (type, structure, notable state), the camera angle and framing (e.g. from behind, from side, close-up, full body), and the background, in one or two short English sentences. Do not mention the person, gender, face, hair, eyes, expression, body parts, hands, or bare skin. Output only the description, with no introduction or list."
  },
  {
    id: "sd15-character-tags",
    name: "SD1.5 Character LoRA — Danbooru tags",
    excludeClothing: false,
    prompt: `You are an expert anime/manga image tagger specializing in Danbooru-style tags for Stable Diffusion 1.5 character LoRA training.
Analyze the provided image and generate a concise, comma-separated list of Danbooru tags following these strict rules:

1. VARIABLE ELEMENTS (MUST TAG TO PREVENT OVERFITTING):
- Pose & Action: standing, sitting, arms behind back, peace sign, crossed arms, looking back, etc.
- Expression & Eyes: smile, open mouth, blushing, closed eyes, looking at viewer, looking away, etc.
- Framing & Camera: full body, cowboy shot, upper body, close-up, from behind, from side, profile, straight-on, from above, from below, dutch angle.
- Background & Lighting: simple background, white background, bedroom, outdoors, street, sunset, depth of field, etc.

2. CLOTHING (CONTEXT-DEPENDENT):
- Describe the current visible outfit, shoes, and accessories in detail (e.g., sailor uniform, pleated skirt, black thighhighs, loafers, ribbon, hair ornament). Tagging outfits allows swapping clothes later.

3. CHARACTER FEATURES:
- Include tags for hair color, hair style, eye color, and notable body features (e.g., long hair, twintails, blonde hair, blue eyes).

4. STRICT EXCLUSIONS:
- Do NOT output quality tags (e.g., masterpiece, best quality, highly detailed).
- Do NOT output artist names, copyright names, or meta tags.

5. OUTPUT FORMAT:
- Output ONLY lowercase, comma-separated tags.
- No conversational text, no markdown backticks, just raw comma-separated tags.`
  },
  {
    id: "modern-character-sentence",
    name: "Flux / SD3 Character LoRA — Natural language",
    excludeClothing: false,
    prompt: `You are an AI captioning specialist creating natural language training datasets for modern text-to-image diffusion models (such as Flux and SD3).
Analyze the provided image and write a concise, dense, and objective description of the character and scene.

Follow this structural flow:
1. Subject & Appearance: Gender/identity, hair color, hairstyle, eye color, and facial expression.
2. Pose & Action: Exact body posture, arm/leg placement, and direction the character is facing or looking.
3. Attire & Accessories: Detailed garments, fabrics, colors, footwear, and any worn accessories.
4. Environment & Lighting: Setting (interior/exterior), background elements, atmosphere, and light source/direction.
5. Framing & Camera: Shot distance (close-up, medium shot, full-body shot) and angle (eye-level, low angle, high angle, side profile).

Rules:
- Write in neutral, direct English prose (2 to 4 sentences).
- Avoid subjective praise, emotional adjectives, or quality fluff (e.g., DO NOT write "stunning artwork", "intricate details", "masterpiece").
- Describe only what is visually confirmed in the image.
- Output ONLY the raw caption text without introductory phrases, bullet points, quotes, or markdown code blocks.`
  },
  {
    id: "person-pose-no-clothing",
    name: "Person & pose (no clothing)",
    excludeClothing: true,
    prompt: "Describe the person's pose, expression, hairstyle, camera angle, and background in one or two short English sentences. Do not describe clothing or accessories."
  },
  {
    id: "generic-short",
    name: "Generic short description",
    excludeClothing: true,
    prompt: "Write a short, factual caption for this image. Describe only visible details in natural English."
  }
];

export const DEFAULT_TEMPLATE_NAME = "My template";
const reservedNames = () => [NO_TEMPLATE.name, ...BUILTIN_TEMPLATES.map((template) => template.name)];

export function normalizeTemplateName(name) {
  const value = String(name ?? "").trim().replace(/\s+/g, " ");
  if (value.length > 60) throw new Error("Template name must be 60 characters or fewer");
  if (reservedNames().includes(value)) throw new Error("That name is reserved for a built-in template");
  return value || DEFAULT_TEMPLATE_NAME;
}

function cleanPrompt(prompt) {
  const value = String(prompt ?? "");
  if (value.includes("\0")) throw new Error("The instruction contains unsupported characters");
  if (value.length > 4000) throw new Error("The instruction must be 4000 characters or fewer");
  return value.trim();
}

export function upsertTemplate(templates, name, prompt, excludeClothing = true) {
  const cleanName = normalizeTemplateName(name);
  const text = cleanPrompt(prompt);
  if (!text) throw new Error("An empty instruction cannot be saved as a template");
  const entry = { name: cleanName, prompt: text, excludeClothing: Boolean(excludeClothing) };
  const index = templates.findIndex((template) => template.name === cleanName);
  const next = templates.slice();
  if (index >= 0) next[index] = entry; else next.push(entry);
  return next;
}

export function removeTemplate(templates, name) {
  return templates.filter((template) => template.name !== name);
}

export function readTemplateStore(raw) {
  let data;
  try { data = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
  if (data?.schema_version !== 1 || !Array.isArray(data.templates)) return [];
  const result = [];
  for (const item of data.templates) {
    try {
      const [entry] = upsertTemplate([], item?.name, item?.prompt, item?.excludeClothing ?? true);
      if (!result.some((template) => template.name === entry.name)) result.push(entry);
    } catch { /* skip a corrupted entry */ }
  }
  return result;
}

export function serializeTemplateStore(templates) {
  return JSON.stringify({ schema_version: 1, templates });
}

export function splitTags(text) {
  const seen = new Set();
  const tags = [];
  for (const part of String(text ?? "").split(/[,、，\n]/)) {
    const tag = part.trim().replace(/\s+/g, " ");
    if (tag && !seen.has(tag.toLowerCase())) { seen.add(tag.toLowerCase()); tags.push(tag); }
  }
  return tags;
}

// Result: "<trigger>, <new tags not already present>, <existing tokens>".
// The trigger word is kept (or put) first; tags that already exist are not repeated.
export function insertTags(caption, trigger, tagsText) {
  const tags = splitTags(tagsText);
  const head = String(trigger ?? "").trim();
  const tokens = splitTags(caption);
  const rest = head && tokens.length && tokens[0].toLowerCase() === head.toLowerCase() ? tokens.slice(1) : tokens;
  const existing = new Set(rest.map((token) => token.toLowerCase()));
  if (head) existing.add(head.toLowerCase());
  const added = tags.filter((tag) => !existing.has(tag.toLowerCase()));
  const restWithoutTrigger = head ? rest.filter((token) => token.toLowerCase() !== head.toLowerCase()) : rest;
  return [...(head ? [head] : []), ...added, ...restWithoutTrigger].join(", ");
}

// Whole-tag operations used by the dataset check (tags are compared case-insensitively).
export function hasTag(caption, tag) {
  const key = String(tag ?? "").trim().toLowerCase();
  return Boolean(key) && splitTags(caption).some((item) => item.toLowerCase() === key);
}

export function removeTag(caption, tag) {
  const key = String(tag ?? "").trim().toLowerCase();
  return splitTags(caption).filter((item) => item.toLowerCase() !== key).join(", ");
}

// Keeps the first occurrence of every tag.
export function dedupeTags(caption) {
  return splitTags(caption).join(", ");
}

// Same separators as splitTags but WITHOUT removing repeats: used to tell whether an edit changed anything.
export function normalizeCaption(caption) {
  return String(caption ?? "").split(/[,、，\n]/).map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean).join(", ");
}
