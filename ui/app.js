import { BUILTIN_PRESETS, DEFAULT_PARAMS, OPTIMIZERS, PARAM_FIELDS, PARAM_SCHEMA, SCHEDULERS, builtinPreset, optimizerInfo, parseSpeed, summaryModel, updateSpeed } from "./training-params.mjs";
import { buildConfigDocument, parseConfigDocument } from "./config-file.mjs";
import { buildTrialWorkflow, folderFor, loaderScript, NEEDS, supportsWorkflow, trialPrompt } from "./comfy-workflow.mjs";
import { COMPONENT_KEYS, DEFAULT_FAMILY, FAMILIES, civitaiMismatch, downloadById, downloadItems, familyById, familyParams, normalizeDownloadLink, presetById, presetsFor } from "./model-families.mjs";
import { PROJECT_DEFAULTS, TRAINING_DEFAULTS, required, validateTraining, applyJobEvent, makeTrainingProfile, readTrainingProfile, normalizePresetName, readPresetStore, upsertPreset, removePreset, serializePresetStore } from "./state.mjs";
import { createTools } from "./tools.js";
import { createImageZoom } from "./image-zoom.mjs";
import { createFullscreen } from "./fullscreen.mjs";
import { SHORTCUT_SECTIONS } from "./shortcuts.mjs";
import { getRecord, loadSelectionStore, rootKey, selectionSummary } from "./training-selection.mjs";
import { isTqdmLine, newJobUi, parseTqdm, progressModel, reduceJobUi } from "./job-progress.mjs";
import { PROJECTS_KEY, createProject, deleteProject, newStore, readStore, renameProject, setActive, updateProjectData } from "./projects.mjs";
import { getMaskColor, hexToRgb, setMaskColor } from "./mask-color.mjs";
import { readPageZoom, stepPageZoom } from "./page-zoom.mjs";
import { clampLogWidth, DEFAULT_LOG_WIDTH, LOG_WIDTH_KEY, parseTheme, THEME_KEY } from "./theme.mjs";
import { initToolsLayout } from "./tools-layout.mjs";
import { BUILTIN_MASK_PRESETS, DEFAULT_MASK_PRESET, MASK_PRESET_KEY, findMaskPreset, normalizeMaskPresetName, readMaskPresetStore, removeMaskPreset, serializeMaskPresetStore, upsertMaskPreset } from "./mask-presets.mjs";

const byId = (id) => document.getElementById(id);
const native = window.__TAURI__;
const invoke = (command, args = {}) => {
  if (!native) return Promise.reject(new Error("Launch the GUI from Tauri. In a browser you can only preview the screen."));
  return native.core.invoke(command, args);
};
const settingsIds = {
  python_path: "python-path", training_python: "training-python", engine_dir: "engine-dir",
  models_dir: "models-dir", tokenizer_dir: "tokenizer-dir"
};
const toSlash = (value) => String(value ?? "").replaceAll("\\", "/");
document.addEventListener("input", (event) => {
  const field = event.target;
  if (!(field instanceof HTMLInputElement) || !field.closest(".path-field") || !field.value.includes("\\")) return;
  const { selectionStart, selectionEnd } = field;
  field.value = toSlash(field.value);
  field.setSelectionRange(selectionStart, selectionEnd);
}, true);

const PATH_KEYS = new Set(["raw_dir", "mask_dir", "caption_dir", "dataset_dir", "train_masks", "training_dir", "sample_checkpoint", ...COMPONENT_KEYS]);
let project = { ...PROJECT_DEFAULTS };
try {
  const stored = JSON.parse(localStorage.getItem("costume-project") || "{}");
  for (const key of Object.keys(PROJECT_DEFAULTS)) {
    if (typeof stored[key] === "string") project[key] = PATH_KEYS.has(key) ? toSlash(stored[key]) : stored[key];
  }
} catch {
  localStorage.removeItem("costume-project");
}
let job = { jobId: null, status: "idle" };
let jobKind = "";
let summaryReady = false; // the training summary needs everything below to be set up
let lastRun = null; // batch size and resolution of the training run in progress, for learning its speed
let entries = [];
const liveMasks = new Map();
let followLive = true;
let imageIndex = 0;
let previewMode = "overlay";
let currentPage = "train";
let previewGeneration = 0;
const lines = [];

function notice(message) {
  const el = byId("notice");
  const text = String(message ?? "").trim();
  if (!text) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  const body = document.createElement("span");
  body.className = "notice-text";
  body.textContent = text;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "notice-close";
  close.setAttribute("aria-label", "Dismiss notice");
  close.textContent = "×";
  close.addEventListener("click", () => notice(""));
  el.replaceChildren(body, close);
  el.hidden = false;
}

function saveProject() {
  localStorage.setItem("costume-project", JSON.stringify(project));
  document.querySelectorAll("[data-project]").forEach((input) => {
    if (document.activeElement !== input) input.value = project[input.dataset.project];
  });
}

function repairTrainMasks() {
  if (!project.dataset_dir || !project.raw_dir || !project.mask_dir) return;
  if (rootKey(project.dataset_dir) !== rootKey(project.raw_dir)) return;
  const autoMasks = rootKey(project.dataset_dir) + "/masks";
  if (!project.train_masks || rootKey(project.train_masks) === autoMasks) {
    project.train_masks = project.mask_dir;
  }
}

document.querySelectorAll("[data-project]").forEach((input) => {
  input.value = project[input.dataset.project];
  input.addEventListener("input", () => {
    project[input.dataset.project] = input.value;
    if (input.dataset.project === "dataset_dir") {
      const sameAsRaw = input.value && project.raw_dir && rootKey(input.value) === rootKey(project.raw_dir);
      project.train_masks = sameAsRaw && project.mask_dir ? project.mask_dir : (input.value ? input.value.replace(/[\\/]+$/, "") + "/masks" : "");
    }
    saveProject();
  });
});

const pageTabs = [...document.querySelectorAll("[data-page]")];
function selectPage(button) {
  const page = button.dataset.page;
  document.querySelectorAll(".page").forEach((section) => { section.hidden = section.id !== "page-" + page; });
  pageTabs.forEach((tab) => {
    const selected = tab === button;
    tab.classList.toggle("active", selected);
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  });
  byId("breadcrumb").textContent = button.querySelector("span").textContent;
  currentPage = page;
  clearInterval(comfyTimer);
  if (page === "comfy") { refreshComfy().catch(notice); comfyTimer = setInterval(() => refreshComfyState().catch(() => {}), 5000); }
  scheduleProjectSave();
  updateSelectionSummary();
  notice("");
  window.scrollTo(0, 0);
}

pageTabs.forEach((button, index) => {
  button.addEventListener("click", () => selectPage(button));
  button.addEventListener("keydown", (event) => {
    let target;
    if (event.key === "ArrowRight") target = pageTabs[(index + 1) % pageTabs.length];
    if (event.key === "ArrowLeft") target = pageTabs[(index + pageTabs.length - 1) % pageTabs.length];
    if (event.key === "Home") target = pageTabs[0];
    if (event.key === "End") target = pageTabs.at(-1);
    if (target) { event.preventDefault(); selectPage(target); target.focus(); }
  });
});

document.querySelectorAll("[data-section]").forEach((button) => {
  button.addEventListener("click", () => {
    const section = byId(button.dataset.section);
    let ancestor = section;
    while (ancestor) {
      if (ancestor.tagName === "DETAILS") ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    section.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  });
});

const trainingFields = PARAM_FIELDS;
const flagKeys = new Set(PARAM_SCHEMA.filter((item) => item.kind === "flag").map((item) => item.key));
function setupParameterControls() {
  const fill = (id, items) => byId(id).replaceChildren(...items.map(([value, label]) => { const option = document.createElement("option"); option.value = String(value); option.textContent = label; return option; }));
  fill("train-resolution", PARAM_SCHEMA.find((item) => item.key === "resolution").options.map((value) => [value, value + " × " + value]));
  fill("optimizer", OPTIMIZERS.map((item) => [item.value, item.label]));
  fill("scheduler", SCHEDULERS.map((item) => [item.value, item.label]));
  for (const item of PARAM_SCHEMA) {
    if (item.kind !== "number") continue;
    const input = byId(item.id);
    input.min = String(item.min);
    input.max = String(item.max);
    input.step = item.integer ? "1" : "any";
    input.required = true;
  }
}
setupParameterControls();
function trainingValues() {
  return Object.fromEntries(Object.entries(trainingFields).map(([key, id]) => [key, flagKeys.has(key) ? byId(id).checked : byId(id).value]));
}
function applyTrainingValues(values) {
  for (const [key, id] of Object.entries(trainingFields)) {
    const value = values[key] ?? DEFAULT_PARAMS[key];
    if (flagKeys.has(key)) byId(id).checked = value === true || value === "true"; else byId(id).value = String(value);
  }
  syncParameterDependencies();
  updateTrainingSummary();
}
// Controls that only matter for some choices are switched off for the others.
function syncParameterDependencies() {
  const alpha = byId("alpha-mask").checked;
  byId("use-masks").disabled = alpha;
  const masks = byId("use-masks").checked && !alpha;
  byId("train-masks").required = masks;
  byId("training-mode-label").textContent = shortLabel() + (alpha ? " · Alpha mask LoRA" : masks ? " · Masked LoRA" : " · LoRA (no masks)");
  byId("lr-cycles").disabled = byId("scheduler").value !== "cosine_with_restarts";
  const family = currentFamily();
  for (const id of ["min-snr", "noise-offset", "clip-skip", "shuffle-caption", "text-encoder-lr"]) byId(id).disabled = family.flow;
  byId("keep-tokens").disabled = family.flow || !byId("shuffle-caption").checked;
  byId("fp8-base").disabled = !family.fp8;
  byId("blocks-to-swap").disabled = !family.swap;
  const info = optimizerInfo(byId("optimizer").value);
  const adaptive = ["Prodigy", "DAdaptAdam", "DAdaptation"].includes(byId("optimizer").value);
  const lr = Number(byId("learning-rate").value);
  const parts = [];
  if (info?.package) parts.push("Needs the Python package “" + info.package + "” in the training Python (pip install " + info.pip + "). “Check environment” tells you if it is missing.");
  if (adaptive && lr > 0 && lr < 0.1) parts.push("This optimizer adapts the learning rate by itself: set Learning rate to 1.");
  byId("optimizer-hint").textContent = parts.join(" ");
}
// ---- model type, model files and downloads ----
const FAMILY_PATHS_KEY = "costume-family-paths";
const currentFamily = () => familyById(project.model_family) ?? familyById(DEFAULT_FAMILY);
const shortLabel = () => currentFamily().short;
function readFamilyPaths() {
  try { const data = JSON.parse(localStorage.getItem(FAMILY_PATHS_KEY) || "{}"); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; }
}
function stashFamilyPaths(familyId) {
  try { localStorage.setItem(FAMILY_PATHS_KEY, JSON.stringify({ ...readFamilyPaths(), [familyId]: Object.fromEntries(COMPONENT_KEYS.map((key) => [key, project[key] ?? ""])) })); } catch { /* storage unavailable */ }
}
function restoreFamilyPaths(familyId) {
  const saved = readFamilyPaths()[familyId] ?? {};
  for (const key of COMPONENT_KEYS) project[key] = typeof saved[key] === "string" ? toSlash(saved[key]) : "";
}
const componentInput = (key) => byId(key === "checkpoint" ? "checkpoint" : "comp-" + key);
const currentPaths = () => Object.fromEntries(COMPONENT_KEYS.map((key) => [key, project[key] ?? ""]));
function familyHint(family) {
  const lines = [];
  if (family.id === "sdxl") lines.push("Pony, Illustrious and NoobAI models are SDXL: use this type.");
  if (family.flow) lines.push("Trains the main network only and caches the text encoder outputs, so Min SNR, noise offset, clip skip and caption shuffle do not apply.");
  if (family.id !== "sd15") lines.push("Tokenizers are loaded by sd-scripts (the first run may download them). Needs a sd-scripts version that has this model's training script.");
  for (const item of family.components) if (item.hint) lines.push(item.hint);
  return lines.join(" ");
}
function renderFamilyControls() {
  const family = currentFamily();
  const select = byId("model-family");
  if (!select.options.length) select.replaceChildren(...FAMILIES.map((item) => { const option = document.createElement("option"); option.value = item.id; option.textContent = item.label; return option; }));
  select.value = family.id;
  const items = new Map(family.components.map((item) => [item.key, item]));
  for (const key of COMPONENT_KEYS) {
    const item = items.get(key);
    const input = componentInput(key);
    const row = key === "checkpoint" ? null : document.querySelector('[data-component="' + key + '"]');
    if (row) row.hidden = !item;
    input.required = Boolean(item?.required);
    if (document.activeElement !== input) input.value = project[key] ?? "";
    const label = key === "checkpoint" ? byId("checkpoint-label") : row?.querySelector("label");
    if (label && item) label.textContent = item.label + (item.required ? "" : " (optional)");
  }
  byId("family-hint").textContent = familyHint(family);
  const standard = [...byId("training-profile").options].find((option) => option.value === "standard");
  if (standard) standard.textContent = family.id === "sd15" ? "SD1.5 Clothing LoRA — Default settings" : shortLabel() + " — Default settings";
  byId("download-source").replaceChildren(...family.downloads.map((item) => { const option = document.createElement("option"); option.value = item.id; option.textContent = item.label; return option; }));
  renderBuiltinGroups();
  syncPresetControls();
  syncParameterDependencies();
  updateDownloadInfo();
}
function updateDownloadInfo() {
  const family = currentFamily();
  const bundle = downloadById(family, byId("download-source").value);
  const parts = [];
  if (byId("download-url").value.trim()) {
    parts.push("Downloads the link as the " + family.components[0].label + " (a .safetensors file).");
  } else if (bundle) {
    const pending = downloadItems(family, bundle, currentPaths());
    const gb = pending.reduce((sum, item) => sum + item.gb, 0);
    parts.push(pending.length ? pending.length + (pending.length === 1 ? " file" : " files") + ", about " + gb.toFixed(1) + " GB. Files you already chose are skipped." : "Every file of this download is already set.");
    if (bundle.gated) parts.push("Gated: accept the license at huggingface.co/" + bundle.gated + " and set your Hugging Face token in Environment.");
    if (bundle.note) parts.push(bundle.note);
  }
  parts.push("Saved in the Models folder (Environment) under base_models/" + family.id + ".");
  byId("download-info").textContent = parts.join(" ");
}
byId("model-family").addEventListener("change", () => {
  const previous = currentFamily().id;
  const next = byId("model-family").value;
  if (next === previous || !familyById(next)) return;
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.id !== "model-family") document.activeElement.blur(); // so the fields below refresh
  stashFamilyPaths(previous);
  restoreFamilyPaths(next);
  project.model_family = next;
  saveProject();
  renderFamilyControls();
  const first = presetsFor(next)[0];
  byId("training-profile").value = BUILTIN_PREFIX + first.id;
  syncPresetControls();
  applyBuiltin(first);
  byId("profile-status").textContent = "Model type changed to " + currentFamily().label + ". Applied “" + first.name + "” — your model files for each type are remembered.";
  notice("");
  scheduleProjectSave();
});
byId("download-source").addEventListener("change", updateDownloadInfo);
byId("download-url").addEventListener("input", updateDownloadInfo);
document.querySelectorAll(".component-row input, #checkpoint").forEach((input) => input.addEventListener("input", updateDownloadInfo));
byId("download-start").addEventListener("click", async () => {
  try {
    const family = currentFamily();
    const link = byId("download-url").value.trim();
    let items;
    if (link) {
      items = [{ key: "checkpoint", url: normalizeDownloadLink(link) }];
    } else {
      const bundle = downloadById(family, byId("download-source").value);
      items = bundle ? downloadItems(family, bundle, currentPaths()) : [];
      if (!items.length) throw new Error("Every file of this download is already set — nothing to download.");
    }
    await run("download", { model_family: family.id, items, hf_token: byId("hf-token").value.trim(), civitai_key: byId("civitai-key").value.trim() });
  } catch (error) { notice(error); }
});
function onDownloaded(data) {
  for (const [key, path] of Object.entries(data.files ?? {})) if (COMPONENT_KEYS.includes(key)) project[key] = toSlash(path);
  saveProject();
  byId("download-url").value = "";
  updateDownloadInfo();
  notice(civitaiMismatch(currentFamily(), data.base_model));
  scheduleProjectSave();
}
for (const [id, key] of [["hf-token", "costume-hf-token"], ["civitai-key", "costume-civitai-key"]]) {
  try { byId(id).value = localStorage.getItem(key) || ""; } catch { /* storage unavailable */ }
  byId(id).addEventListener("input", () => { try { localStorage.setItem(key, byId(id).value.trim()); } catch { /* storage unavailable */ } });
}

// ---- ComfyUI: settings.yaml, start / stop, and trying a trained LoRA in a separate window ----
const LORA_HISTORY_KEY = "costume-lora-history";
let comfyConfig = null;
let comfyTimer = 0;
const dirOf = (path) => String(path ?? "").replaceAll("\\", "/").replace(/\/[^/]*$/, "");
function loraHistory() {
  try { const data = JSON.parse(localStorage.getItem(LORA_HISTORY_KEY) || "[]"); return Array.isArray(data) ? data.filter((item) => item && item.name && Array.isArray(item.files)) : []; } catch { return []; }
}
function onPublished(data) {
  const entry = {
    name: data.name, family: data.family || lastRun?.family || "sd15", lora_dir: data.lora_dir, subfolder: data.subfolder,
    files: data.files, final: String(data.final ?? "").split("/").at(-1), trigger: lastRun?.trigger ?? project.trigger_word,
    paths: lastRun?.files ?? currentPaths(), at: Date.now()
  };
  const history = [entry, ...loraHistory().filter((item) => item.lora_dir !== entry.lora_dir)].slice(0, 20);
  try { localStorage.setItem(LORA_HISTORY_KEY, JSON.stringify(history)); } catch { /* storage unavailable */ }
  renderLoraChoices(0);
  byId("train-try-comfy").hidden = false;
}
function renderLoraChoices(select) {
  const history = loraHistory();
  const box = byId("comfy-lora");
  box.replaceChildren(...history.map((item, index) => {
    const group = document.createElement("optgroup");
    group.label = item.name + " — " + (familyById(item.family)?.short ?? item.family);
    const files = [item.final, ...item.files.filter((file) => file !== item.final).sort().reverse()];
    for (const file of files) {
      const option = document.createElement("option");
      option.value = index + "|" + file;
      option.textContent = file === item.final ? file + " (final)" : file;
      group.append(option);
    }
    return group;
  }));
  if (select !== undefined && history[select]) box.value = select + "|" + history[select].final;
  byId("comfy-try").disabled = history.length === 0;
  syncLoraChoice(true);
}
function selectedLora() {
  const [index, file] = byId("comfy-lora").value.split("|");
  const entry = loraHistory()[Number(index)];
  return entry && file ? { entry, file } : null;
}
function syncLoraChoice(resetPrompt) {
  const chosen = selectedLora();
  if (!chosen) {
    byId("comfy-lora-info").textContent = "Train a LoRA first: when training finishes it is copied to the LoRA folder and listed here.";
    return;
  }
  const { entry } = chosen;
  if (resetPrompt || !byId("comfy-prompt").value.trim()) byId("comfy-prompt").value = trialPrompt(entry.trigger);
  byId("comfy-lora-info").textContent = "Folder: " + entry.lora_dir + (supportsWorkflow(entry.family) ? "" : " — no ready-made workflow for this model type yet: ComfyUI opens with the LoRA in its list.");
}
byId("comfy-lora").addEventListener("change", () => syncLoraChoice(true));
function modelFolders(family, paths) {
  const folders = {};
  for (const item of (familyById(family) ?? currentFamily()).components) {
    const path = String(paths?.[item.key] ?? "").trim();
    if (!path) continue;
    (folders[folderFor(family, item.key)] ??= []).push(dirOf(path));
  }
  return folders;
}
async function refreshComfy() {
  comfyConfig = await invoke("app_config");
  const setup = comfyConfig.comfyui;
  byId("comfy-where").textContent = setup
    ? (setup.mode === "wsl" ? "WSL" + (setup.distro ? " (" + setup.distro + ")" : "") : "Windows") + " · " + setup.root + (setup.origin === "managed" ? " (installed by this app)" : "")
    : "Not set up";
  byId("comfy-lora-dir").textContent = comfyConfig.lora_output_dir;
  byId("comfy-source").textContent = comfyConfig.source ?? "none (defaults)";
  byId("comfy-config-error").hidden = !comfyConfig.error;
  byId("comfy-config-error").textContent = comfyConfig.error ?? "";
  byId("comfy-install").hidden = Boolean(setup);
  byId("comfy-open").disabled = !setup;
  byId("comfy-try").disabled = !setup || loraHistory().length === 0;
  await refreshComfyState();
}
async function refreshComfyState() {
  if (!comfyConfig?.comfyui) { byId("comfy-state").textContent = "—"; return null; }
  const status = await invoke("comfy_status");
  byId("comfy-state").textContent = status.reachable
    ? "Running at " + status.url + (status.started_by_app ? "" : " (started outside this app)")
    : status.started_by_app ? "Starting… (log: " + status.log + ")" : "Stopped";
  byId("comfy-stop").disabled = !status.started_by_app;
  return status;
}
async function ensureComfy(folders) {
  if (!comfyConfig) await refreshComfy();
  let status = await invoke("comfy_start", { folders });
  const started = Date.now();
  while (!status.reachable) {
    if (!status.started_by_app) throw new Error("ComfyUI stopped while starting. See its log: " + status.log);
    if (Date.now() - started > 300000) throw new Error("ComfyUI did not answer within 5 minutes. See its log: " + status.log);
    byId("comfy-state").textContent = "Starting… " + Math.round((Date.now() - started) / 1000) + " s";
    await new Promise((resolve) => setTimeout(resolve, Number(window.__comfyPoll) || 1500));
    status = await invoke("comfy_status");
  }
  await refreshComfyState();
  return status;
}
async function withComfyButtons(task) {
  const buttons = ["comfy-open", "comfy-try", "train-try-comfy"].map(byId);
  const before = buttons.map((button) => button.disabled);
  buttons.forEach((button) => { button.disabled = true; });
  try { await task(); } catch (error) { notice(error); } finally { buttons.forEach((button, index) => { button.disabled = before[index]; }); }
}
byId("comfy-open").addEventListener("click", () => withComfyButtons(async () => {
  notice("");
  await ensureComfy(modelFolders(currentFamily().id, currentPaths()));
  await invoke("open_comfy_window", { script: null });
}));
byId("comfy-stop").addEventListener("click", () => withComfyButtons(async () => { await invoke("comfy_stop"); await refreshComfyState(); }));
byId("comfy-install").addEventListener("click", async () => {
  try { await run("comfy_install", {}); } catch (error) { notice(error); }
});
async function tryInComfy() {
  const chosen = selectedLora();
  if (!chosen) throw new Error("Choose a LoRA first");
  const { entry, file } = chosen;
  notice("");
  await ensureComfy(modelFolders(entry.family, entry.paths));
  let script = null;
  if (supportsWorkflow(entry.family)) {
    const objectInfo = {};
    for (const node of new Set(NEEDS[entry.family].map(([name]) => name))) {
      const answer = await invoke("comfy_http", { method: "GET", path: "/object_info/" + node, body: null });
      if (answer.status !== 200) throw new Error("ComfyUI answered " + answer.status + " for " + node);
      Object.assign(objectInfo, answer.body);
    }
    const strength = Number(byId("comfy-strength").value);
    const { workflow, missing } = buildTrialWorkflow({
      family: entry.family, objectInfo, files: entry.paths, lora: { name: entry.name, subfolder: entry.subfolder, file },
      prompt: byId("comfy-prompt").value.trim() || trialPrompt(entry.trigger), strength: Number.isFinite(strength) ? strength : 0.8
    });
    if (!workflow) throw new Error("ComfyUI does not list " + missing.join(", ") + ". If ComfyUI was already running before, stop it and press the button again, or add the folder to its extra_model_paths.yaml.");
    script = loaderScript(workflow, entry.name + " test");
  } else {
    notice("No ready-made workflow for this model type yet: ComfyUI opens with your LoRA in the LoRA list.");
  }
  await invoke("open_comfy_window", { script });
}
byId("comfy-try").addEventListener("click", () => withComfyButtons(tryInComfy));
byId("train-try-comfy").addEventListener("click", () => {
  const tab = pageTabs.find((item) => item.dataset.page === "comfy");
  if (tab) selectPage(tab);
  withComfyButtons(tryInComfy);
});
renderLoraChoices(0);
refreshComfy().catch((error) => { byId("comfy-where").textContent = "Unavailable"; byId("comfy-config-error").hidden = false; byId("comfy-config-error").textContent = String(error?.message ?? error); });

const PRESET_KEY = "costume-training-presets";
const LEGACY_PROFILE_KEY = "costume-training-profile";
function loadPresets() {
  try {
    const stored = readPresetStore(localStorage.getItem(PRESET_KEY));
    if (stored.length || localStorage.getItem(PRESET_KEY)) return stored;
    // One-time migration of the old single saved configuration (parameters only).
    const legacy = localStorage.getItem(LEGACY_PROFILE_KEY);
    if (legacy) return [{ name: "Saved settings", parameters: readTrainingProfile(JSON.parse(legacy)).parameters }];
  } catch { /* unreadable storage: start with no custom presets */ }
  return [];
}
let presets = loadPresets();
function persistPresets() {
  localStorage.setItem(PRESET_KEY, serializePresetStore(presets));
}
const BUILTIN_PREFIX = "builtin:";
function renderBuiltinGroups() {
  const select = byId("training-profile");
  select.querySelectorAll("optgroup[data-builtin]").forEach((group) => group.remove());
  const anchor = byId("custom-presets");
  const groups = new Map();
  for (const item of presetsFor(currentFamily().id)) {
    if (!groups.has(item.group)) { const group = document.createElement("optgroup"); group.label = item.group; group.dataset.builtin = "1"; groups.set(item.group, group); }
    const option = document.createElement("option");
    option.value = BUILTIN_PREFIX + item.id;
    option.textContent = item.name;
    groups.get(item.group).append(option);
  }
  for (const group of groups.values()) select.insertBefore(group, anchor);
  if (![...select.options].some((option) => option.value === select.value)) select.value = "standard";
}
renderBuiltinGroups();
function renderPresets(selectedName) {
  const group = byId("custom-presets");
  group.replaceChildren(...presets.map((preset) => {
    const option = document.createElement("option");
    option.value = "custom:" + preset.name;
    option.textContent = preset.name;
    return option;
  }));
  group.hidden = presets.length === 0;
  const wanted = selectedName ? "custom:" + selectedName : byId("training-profile").value;
  byId("training-profile").value = [...byId("training-profile").options].some((option) => option.value === wanted) ? wanted : "standard";
  syncPresetControls();
}
function selectedPreset() {
  const value = byId("training-profile").value;
  return value.startsWith("custom:") ? presets.find((preset) => preset.name === value.slice(7)) : null;
}
function selectedBuiltin() {
  const value = byId("training-profile").value;
  return value.startsWith(BUILTIN_PREFIX) ? presetById(currentFamily().id, value.slice(BUILTIN_PREFIX.length)) : null;
}
function syncPresetControls() {
  byId("delete-profile").disabled = !selectedPreset();
  byId("preset-description").textContent = selectedBuiltin()?.description ?? "";
}
function applyBuiltin(item) {
  applyTrainingValues(item.parameters);
  byId("profile-status").textContent = "Applied “" + item.name + "”. Folder paths are unchanged — adjust any value below.";
}
renderPresets();
byId("training-profile").addEventListener("change", () => {
  const preset = selectedPreset();
  const builtin = selectedBuiltin();
  byId("preset-name").value = preset ? preset.name : "";
  syncPresetControls();
  if (builtin) { applyBuiltin(builtin); notice(""); } // built-in presets apply as soon as they are picked
});
byId("save-profile").addEventListener("click", () => {
  try {
    const name = normalizePresetName(byId("preset-name").value || selectedPreset()?.name);
    const overwrite = presets.some((preset) => preset.name === name);
    presets = upsertPreset(presets, name, trainingValues());
    persistPresets();
    renderPresets(name);
    byId("preset-name").value = name;
    byId("profile-status").textContent = "Preset “" + name + "” " + (overwrite ? "overwritten" : "saved") + ". Pick it from the dropdown and press Load to use it.";
    notice("");
  } catch (error) { notice(error); }
});
byId("load-profile").addEventListener("click", () => {
  try {
    const preset = selectedPreset();
    const builtin = selectedBuiltin();
    if (builtin) {
      applyBuiltin(builtin);
    } else if (!preset) {
      applyTrainingValues(familyParams(currentFamily()));
      byId("profile-status").textContent = "Parameters reset to defaults. Folder paths are unchanged.";
    } else {
      applyTrainingValues(preset.parameters);
      byId("profile-status").textContent = "Loaded “" + preset.name + "”. Folder paths are unchanged.";
    }
    notice("");
  } catch (error) { notice(error); }
});
byId("delete-profile").addEventListener("click", () => {
  try {
    const preset = selectedPreset();
    if (!preset) return;
    presets = removePreset(presets, preset.name);
    persistPresets();
    byId("training-profile").value = "standard";
    byId("preset-name").value = "";
    renderPresets();
    byId("profile-status").textContent = "Deleted “" + preset.name + "”.";
    notice("");
  } catch (error) { notice(error); }
});

function sampleFormValues() {
  return {
    every_n_epochs: Number(byId("sample-every-n-epochs").value) || 0,
    checkpoint: (project.sample_checkpoint ?? "").trim(),
    lora_strength: Number(byId("sample-lora-strength").value),
    width: Number(byId("sample-width").value),
    height: Number(byId("sample-height").value),
    steps: Number(byId("sample-steps").value),
    cfg: Number(byId("sample-cfg").value),
    sampler: byId("sample-sampler").value,
    clip_skip: Number(byId("sample-clip-skip").value),
    seed: Number(byId("sample-seed").value),
    prompt: byId("sample-prompt").value,
    negative: byId("sample-negative").value
  };
}

function applySampleValues(sample) {
  if (!sample) return;
  byId("sample-every-n-epochs").value = String(sample.every_n_epochs);
  byId("sample-lora-strength").value = String(sample.lora_strength);
  byId("sample-width").value = String(sample.width);
  byId("sample-height").value = String(sample.height);
  byId("sample-steps").value = String(sample.steps);
  byId("sample-cfg").value = String(sample.cfg);
  byId("sample-sampler").value = sample.sampler;
  byId("sample-clip-skip").value = String(sample.clip_skip);
  byId("sample-seed").value = String(sample.seed);
  byId("sample-prompt").value = sample.prompt;
  byId("sample-negative").value = sample.negative;
  if (sample.checkpoint) {
    project.sample_checkpoint = toSlash(sample.checkpoint);
    saveProject();
  }
  syncSampleControls();
  if (sample.every_n_epochs > 0) byId("sample-section").open = true;
}

byId("export-config-file").addEventListener("click", async () => {
  try {
    const rawName = (byId("preset-name").value || project.output_name || "lora-config").trim();
    const safeFile = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "lora-config";
    const doc = buildConfigDocument({
      name: byId("preset-name").value.trim() || project.output_name,
      model_family: currentFamily().id,
      parameters: trainingValues(),
      sample: sampleFormValues()
    });
    const saved = await invoke("export_config_file", { defaultName: safeFile + ".yaml", content: doc });
    if (!saved) return;
    byId("profile-status").textContent = "Exported settings to " + saved;
    notice("");
  } catch (error) { notice(error); }
});

byId("import-config-file").addEventListener("click", async () => {
  try {
    const result = await invoke("import_config_file");
    if (!result) return;
    const loaded = parseConfigDocument(result.data);
    if (loaded.model_family && loaded.model_family !== currentFamily().id) {
      stashFamilyPaths(currentFamily().id);
      restoreFamilyPaths(loaded.model_family);
      project.model_family = loaded.model_family;
      saveProject();
      renderFamilyControls();
    }
    applyTrainingValues(loaded.parameters);
    if (loaded.sample) applySampleValues(loaded.sample);
    if (loaded.name) byId("preset-name").value = loaded.name;
    byId("profile-status").textContent = "Imported " + (loaded.name ? "“" + loaded.name + "” from " : "") + result.path + ". Dataset and output folders are unchanged.";
    notice("");
    scheduleProjectSave();
  } catch (error) { notice(error); }
});

document.querySelectorAll(".browse").forEach((button) => {
  button.addEventListener("click", async () => {
    try {
      const result = await invoke("choose_path", { directory: !button.hasAttribute("data-file") });
      if (result) {
        const input = byId(button.dataset.target);
        input.value = result;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (error) { notice(error); }
  });
});

function log(message) {
  lines.push(String(message));
  if (lines.length > 500) lines.shift();
  const box = byId("logs");
  // Follow new lines only if the reader is already at the bottom; otherwise keep their place.
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
  const top = box.scrollTop;
  box.textContent = lines.join("\n");
  box.scrollTop = atBottom ? box.scrollHeight : top;
}

function setBusy(busy) {
  document.querySelectorAll(".job-action").forEach((button) => { button.disabled = busy; });
  byId("cancel-job").disabled = !busy;
  byId("job-dot").classList.toggle("busy", busy);
  if (busy) byId("progress").removeAttribute("value");
  window.dispatchEvent(new Event("studio-busy"));
}

// ---------- job bar: always visible, even on other tabs ----------
let jobUi = null;
let jobTicker = 0;
let jobBarHideTimer = 0;
function renderJobBar() {
  const bar = byId("job-bar");
  if (!jobUi) { bar.hidden = true; return; }
  const model = progressModel(jobUi, Date.now());
  bar.hidden = false;
  bar.dataset.tone = model.tone;
  byId("job-bar-title").textContent = model.title;
  byId("job-bar-phase").textContent = model.phaseText;
  const progress = byId("job-bar-progress");
  if (model.fraction === null) progress.removeAttribute("value"); else progress.value = model.fraction;
  byId("job-bar-percent").textContent = model.percentText;
  byId("job-bar-time").textContent = model.timeText;
  byId("job-bar-note").textContent = model.noteText;
  byId("job-bar-note").hidden = !model.noteText;
  byId("job-bar-stop").hidden = !model.running;
  if (model.running && model.fraction !== null) {
    byId("progress").value = model.fraction;
    if (!jobUi.total && jobUi.bar) {
      const counts = jobUi.bar.doneText && jobUi.bar.totalText ? " · " + jobUi.bar.doneText + " / " + jobUi.bar.totalText : "";
      byId("job-status").textContent = model.percentText + counts;
    }
  }
}
function startJobUi(kind) {
  clearTimeout(jobBarHideTimer);
  clearInterval(jobTicker);
  jobUi = newJobUi(kind, Date.now());
  jobTicker = setInterval(renderJobBar, 1000); // keeps the elapsed time and the "still working" note moving
  renderJobBar();
}
function updateJobUi(data) {
  if (!jobUi) return;
  jobUi = reduceJobUi(jobUi, data, Date.now());
  renderJobBar();
  if (jobUi.status === "running") return;
  clearInterval(jobTicker);
  if (jobUi.status === "succeeded") {
    const shown = jobUi;
    jobBarHideTimer = setTimeout(() => { if (jobUi === shown) { jobUi = null; renderJobBar(); } }, 20000);
  }
}
byId("job-bar-stop").addEventListener("click", () => byId("cancel-job").click());
byId("job-bar-dismiss").addEventListener("click", () => { clearInterval(jobTicker); clearTimeout(jobBarHideTimer); jobUi = null; renderJobBar(); });

function handleEvent(event) {
  if (job.jobId && event.jobId !== job.jobId) return;
  job = applyJobEvent(job, event);
  const data = event.data;
  if (!jobUi && job.status === "running") startJobUi(jobKind); // e.g. the app was reopened while a job runs
  updateJobUi(data);
  learnFromTrainingEvent(data);
  if (data.type === "downloaded") onDownloaded(data);
  if (data.type === "published") onPublished(data);
  if (data.type === "comfy_installed") refreshComfy().catch(notice);
  toolEditor.handleEvent(event).catch(notice);
  if (data.message && !isTqdmLine(data.message)) log(data.level === "error" ? "[ERROR] " + data.message : data.message);
  if (jobKind === "mask" && data.preview_mask) showLiveMask(data.preview_source, data.preview_mask).catch(notice);
  if (data.total > 0) {
    byId("progress").value = data.current / data.total;
    byId("job-status").textContent = data.current + " / " + data.total;
  }
  if (data.status) {
    const labels = { succeeded: "Done", failed: "Failed", cancelled: "Cancelled" };
    byId("job-status").textContent = labels[data.status] || data.status;
    setBusy(data.status === "running");
    byId("progress").value = data.status === "succeeded" ? 1 : 0;
    if (data.status === "succeeded" && jobKind === "mask") refreshPreview().catch(notice);
  }
}

function settingsFromForm() {
  return Object.fromEntries(Object.entries(settingsIds).map(([key, id]) => [key, required(byId(id).value, byId(id).previousElementSibling?.textContent || key)]));
}

async function run(kind, payload) {
  if (job.status === "running") throw new Error("Wait for the running job to finish");
  notice("");
  job = { jobId: null, status: "running" };
  setBusy(true);
  jobKind = kind;
  startJobUi(kind);
  if (kind === "mask") { liveMasks.clear(); followLive = true; entries = []; }
  byId("job-status").textContent = "Starting…";
  try {
    await invoke("save_settings", { settings: settingsFromForm() });
    const id = await invoke("start_job", { kind, payload });
    if (!job.jobId) job.jobId = id;
    if (job.status === "running") byId("job-status").textContent = kind === "validate" ? "Running pre-flight check" : "Running";
  } catch (error) {
    job.status = "failed";
    updateJobUi({ status: "failed", level: "error", message: String(error?.message ?? error) });
    setBusy(false);
    byId("progress").value = 0;
    byId("job-status").textContent = "Failed to start";
    throw error;
  }
}

// --- Mask Creation segmentation presets (shared with Tools via localStorage) ---
{
  const select = byId("mask-preset-select");
  const builtinGroup = byId("mask-builtin-presets");
  const customGroup = byId("mask-custom-presets");
  const nameInput = byId("mask-preset-name");
  const saveBtn = byId("mask-preset-save");
  const deleteBtn = byId("mask-preset-delete");
  const statusEl = byId("mask-preset-status");
  const maskPromptEl = byId("mask-prompt");
  const excludePromptEl = byId("exclude-prompt");
  const loadCustom = () => { try { return readMaskPresetStore(localStorage.getItem(MASK_PRESET_KEY)); } catch { return []; } };
  const makeOpt = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; };
  function renderMaskPresets(preferred) {
    const custom = loadCustom();
    builtinGroup.replaceChildren(...BUILTIN_MASK_PRESETS.map((p) => makeOpt("builtin:" + p.id, p.name)));
    customGroup.replaceChildren(...custom.map((p) => makeOpt("custom:" + p.name, p.name)));
    customGroup.hidden = custom.length === 0;
    const wanted = preferred ?? select.value;
    const fallback = "builtin:" + DEFAULT_MASK_PRESET.id;
    select.value = [...select.options].some((o) => o.value === wanted) ? wanted : fallback;
    deleteBtn.disabled = !select.value.startsWith("custom:");
  }
  renderMaskPresets("builtin:" + DEFAULT_MASK_PRESET.id);
  window.addEventListener("costume-mask-presets-changed", () => renderMaskPresets());
  select.addEventListener("change", () => {
    const chosen = findMaskPreset(select.value, loadCustom());
    if (!chosen) return;
    maskPromptEl.value = chosen.mask_prompt;
    excludePromptEl.value = chosen.exclude_prompt;
    nameInput.value = select.value.startsWith("custom:") ? chosen.name : "";
    deleteBtn.disabled = !select.value.startsWith("custom:");
    statusEl.textContent = "Applied “" + chosen.name + "”.";
    scheduleProjectSave();
  });
  saveBtn.addEventListener("click", () => {
    try {
      const custom = loadCustom();
      const currentName = select.value.startsWith("custom:") ? (findMaskPreset(select.value, custom)?.name ?? "") : "";
      const name = normalizeMaskPresetName(nameInput.value || currentName);
      const overwrite = custom.some((p) => p.name === name);
      const next = upsertMaskPreset(custom, name, maskPromptEl.value, excludePromptEl.value);
      localStorage.setItem(MASK_PRESET_KEY, serializeMaskPresetStore(next));
      renderMaskPresets("custom:" + name);
      nameInput.value = name;
      statusEl.textContent = "Preset “" + name + "” " + (overwrite ? "overwritten" : "saved") + ".";
      window.dispatchEvent(new CustomEvent("costume-mask-presets-changed"));
      notice("");
    } catch (error) { notice(error); }
  });
  deleteBtn.addEventListener("click", () => {
    try {
      const custom = loadCustom();
      const chosen = select.value.startsWith("custom:") ? findMaskPreset(select.value, custom) : null;
      if (!chosen) return;
      const next = removeMaskPreset(custom, chosen.name);
      localStorage.setItem(MASK_PRESET_KEY, serializeMaskPresetStore(next));
      renderMaskPresets("builtin:" + DEFAULT_MASK_PRESET.id);
      nameInput.value = "";
      statusEl.textContent = "Deleted “" + chosen.name + "”.";
      window.dispatchEvent(new CustomEvent("costume-mask-presets-changed"));
      notice("");
    } catch (error) { notice(error); }
  });
}

byId("mask-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await run("mask", {
      input_dir: required(project.raw_dir, "Source images folder"),
      output_dir: required(project.mask_dir, "Mask output"),
      mask_prompt: required(byId("mask-prompt").value, "Clothing prompt"),
      exclude_prompt: byId("exclude-prompt").value.trim(),
      device: byId("mask-device").value
    });
  } catch (error) { notice(error); }
});

byId("dataset-transparent").addEventListener("change", () => {
  byId("dataset-masks").required = !byId("dataset-transparent").checked;
});
byId("dataset-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await run("dataset", {
      input_dir: required(project.raw_dir, "Source images folder"),
      transparent: byId("dataset-transparent").checked,
      mask_dir: byId("dataset-transparent").checked ? "" : required(project.mask_dir, "Mask folder"),
      output_dir: required(project.dataset_dir, "Dataset output"),
      trigger_word: required(project.trigger_word, "Trigger word"),
      caption_mode: byId("caption-mode").value, max_resolution: Number(byId("resolution").value),
      caption_dir: project.caption_dir,
      precision: byId("caption-precision").value, device: byId("mask-device").value
    });
  } catch (error) { notice(error); }
});

// Images unchecked in Tools are left out of training when "Use only the images selected in Tools" is on.
function selectionRecord() {
  const store = loadSelectionStore();
  const primary = getRecord(store, project.raw_dir);
  if (primary.total > 0 || primary.excluded.length > 0) return primary;
  return getRecord(store, project.dataset_dir);
}
function excludedSources() {
  return byId("use-tools-selection").checked ? selectionRecord().excluded : [];
}
function updateSelectionSummary() {
  byId("tools-selection-summary").textContent = selectionSummary(selectionRecord(), byId("use-tools-selection").checked);
  updateTrainingSummary();
}
byId("use-tools-selection").addEventListener("change", updateSelectionSummary);
window.addEventListener("training-selection-change", updateSelectionSummary);

// ---- total steps / repeats / time estimate at the bottom of the Training tab ----
const IMAGES_KEY = "costume-train-images";
const SPEED_KEY = "costume-train-speed";
function readImageCache() {
  try { const data = JSON.parse(localStorage.getItem(IMAGES_KEY) || "{}"); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; } catch { return {}; }
}
function rememberImageCount(count) {
  const key = rootKey(project.dataset_dir);
  if (!key || !(count > 0)) return;
  try { localStorage.setItem(IMAGES_KEY, JSON.stringify({ ...readImageCache(), [key]: count })); } catch { /* storage unavailable */ }
  updateTrainingSummary();
}
function trainingImages() {
  const record = selectionRecord();
  if (record.total > 0) {
    const count = byId("use-tools-selection").checked ? Math.max(0, record.total - record.excluded.length) : record.total;
    return { count, source: "the images in Tools" };
  }
  const cached = Number(readImageCache()[rootKey(project.dataset_dir)]);
  return cached > 0 ? { count: cached, source: "your last environment check" } : null;
}
function loadSpeed() {
  try { return parseSpeed(localStorage.getItem(SPEED_KEY)); } catch { return null; }
}
function formField(key) {
  const text = byId(trainingFields[key]).value.trim();
  const value = Number(text);
  return text !== "" && Number.isFinite(value) && value > 0 ? value : DEFAULT_PARAMS[key];
}
function updateTrainingSummary() {
  if (!summaryReady) return;
  const values = { ...DEFAULT_PARAMS, resolution: formField("resolution"), batch_size: formField("batch_size"), repeats: formField("repeats"), epochs: formField("epochs") };
  const limit = Number(byId("steps").value);
  values.steps = Number.isFinite(limit) && limit > 0 ? limit : 0;
  const images = trainingImages();
  const model = summaryModel(values, images, loadSpeed());
  const set = (id, text) => { byId(id).textContent = text; };
  set("sum-images", images ? String(images.count) : "—");
  set("sum-repeats", String(values.repeats));
  set("sum-epochs", model.ready && model.totals.byMaxSteps ? "≈ " + Number(model.totals.epochs.toFixed(1)) : String(values.epochs));
  set("sum-batch", String(values.batch_size));
  if (!model.ready) {
    for (const id of ["sum-spe", "sum-total", "sum-time"]) set(id, "—");
    set("summary-formula", "");
    set("summary-note", images && images.count === 0
      ? "Every image is unchecked in Tools — nothing would be trained."
      : "The image count is not known yet. Load your source folder in Tools, or press “Check environment” once, and the totals appear here.");
    return;
  }
  const totals = model.totals;
  const number = (value) => value.toLocaleString("en-US");
  set("sum-spe", number(totals.stepsPerEpoch));
  set("sum-total", number(totals.totalSteps));
  set("sum-time", model.estimate);
  set("summary-formula", totals.byMaxSteps
    ? "Max train steps is set, so training stops at " + number(totals.totalSteps) + " steps (" + number(totals.stepsPerEpoch) + " steps per epoch × about " + Number(totals.epochs.toFixed(1)) + " epochs)."
    : images.count + " images × " + values.repeats + " repeats ÷ batch " + values.batch_size + " = " + number(totals.stepsPerEpoch) + " steps per epoch × " + values.epochs + " epochs = " + number(totals.totalSteps) + " steps.");
  set("summary-note", "Time estimate: " + model.speedNote + ". Image count comes from " + images.source + ".");
}
document.getElementById("parameters-section").addEventListener("input", () => { syncParameterDependencies(); updateTrainingSummary(); });
document.getElementById("parameters-section").addEventListener("change", () => { syncParameterDependencies(); updateTrainingSummary(); });
document.querySelectorAll("[data-project=dataset_dir], [data-project=raw_dir]").forEach((input) => input.addEventListener("input", updateTrainingSummary));

function syncSampleControls() {
  const active = Number(byId("sample-every-n-epochs").value) > 0;
  byId("sample-prompt").required = active;
  const key = byId("sample-width").value + "x" + byId("sample-height").value;
  const aspect = byId("sample-aspect");
  aspect.value = [...aspect.options].some((option) => option.value === key) ? key : "custom";
}
byId("sample-aspect").addEventListener("change", () => {
  const match = /^(\d+)x(\d+)$/.exec(byId("sample-aspect").value);
  if (!match) return;
  byId("sample-width").value = match[1];
  byId("sample-height").value = match[2];
});
for (const id of ["sample-every-n-epochs", "sample-width", "sample-height"]) {
  byId(id).addEventListener("input", syncSampleControls);
  byId(id).addEventListener("change", syncSampleControls);
}
syncSampleControls();

// The pre-flight check reports how many images will really be used; the training progress bar tells the speed.
function learnFromTrainingEvent(data) {
  if (jobKind !== "train" && jobKind !== "validate") return;
  if (data.type === "validated" && data.samples > 0) rememberImageCount(data.samples);
  if (jobKind !== "train" || !lastRun || !data.message) return;
  const bar = parseTqdm(data.message);
  if (!bar || !/^steps/i.test(bar.label) || bar.percent < 2 || !bar.rate) return;
  const next = updateSpeed(loadSpeed(), { rateText: bar.rate, batchSize: lastRun.batchSize, resolution: lastRun.resolution });
  if (next) { try { localStorage.setItem(SPEED_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ } updateTrainingSummary(); }
}
renderFamilyControls();
applyTrainingValues(TRAINING_DEFAULTS); // the form starts with the default parameters
summaryReady = true;
updateTrainingSummary();

function confirmOverwriteOutput(message) {
  const dialog = byId("train-overwrite-dialog");
  byId("train-overwrite-message").textContent = message;
  return new Promise((resolve) => {
    const close = (result) => { dialog.close(); dialog.oncancel = null; resolve(result); };
    byId("train-overwrite-cancel").onclick = () => close(false);
    byId("train-overwrite-confirm").onclick = () => close(true);
    dialog.oncancel = (event) => { event.preventDefault(); close(false); };
    dialog.showModal();
    byId("train-overwrite-confirm").focus();
  });
}

async function startTraining(kind) {
  const form = byId("train-form");
  const invalid = form.querySelector(":invalid");
  if (invalid) {
    let ancestor = invalid.parentElement;
    while (ancestor) {
      if (ancestor.tagName === "DETAILS") ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
  }
  if (!form.reportValidity()) return;
  try {
    const values = trainingValues();
    const payload = validateTraining({
      ...values,
      model_family: currentFamily().id,
      checkpoint: required(project.checkpoint, currentFamily().components[0].label),
      dataset_dir: required(project.dataset_dir, "Dataset"),
      mask_dir: values.use_masks && !values.alpha_mask ? required(project.train_masks, "Training masks") : "",
      caption_dir: project.caption_dir,
      output_dir: required(project.training_dir, "LoRA output"),
      output_name: required(project.output_name, "LoRA name")
    });
    for (const item of currentFamily().components.slice(1)) {
      const path = (project[item.key] ?? "").trim();
      if (path) payload[item.key] = path;
      else if (item.required) throw new Error(item.label + " is required — choose the file or download it in the Model section");
    }
    for (const key of Object.keys(payload)) if (payload[key] === "") delete payload[key]; // optional empty fields use the backend defaults
    const sampleEvery = Number(byId("sample-every-n-epochs").value);
    if (Number.isFinite(sampleEvery) && sampleEvery > 0) {
      payload.sample_every_n_epochs = sampleEvery;
      payload.sample_prompt = required(byId("sample-prompt").value, "Sample prompt");
      payload.sample_negative = byId("sample-negative").value.trim();
      payload.sample_lora_strength = Number(byId("sample-lora-strength").value);
      payload.sample_width = Number(byId("sample-width").value);
      payload.sample_height = Number(byId("sample-height").value);
      payload.sample_steps = Number(byId("sample-steps").value);
      payload.sample_cfg = Number(byId("sample-cfg").value);
      payload.sample_sampler = byId("sample-sampler").value;
      payload.sample_clip_skip = Number(byId("sample-clip-skip").value);
      payload.sample_seed = Number(byId("sample-seed").value);
      if ((project.sample_checkpoint ?? "").trim()) payload.sample_checkpoint = project.sample_checkpoint.trim();
    }
    const skipped = excludedSources();
    if (skipped.length) payload.excluded_sources = skipped;
    if (native) {
      const existing = await invoke("check_output_dir", { path: payload.output_dir, outputName: payload.output_name });
      if (existing?.non_empty) {
        if (kind === "train") {
          const lead = existing.same_name
            ? `A LoRA named “${payload.output_name}” already exists in ${payload.output_dir}.`
            : `The output folder ${payload.output_dir} already contains files.`;
          const ok = await confirmOverwriteOutput(lead + " Overwrite and continue?");
          if (!ok) return;
        }
        payload.overwrite_output = true;
      }
    }
    lastRun = { batchSize: payload.batch_size, resolution: payload.resolution, family: currentFamily().id, files: currentPaths(), trigger: project.trigger_word };
    byId("train-try-comfy").hidden = true;
    await run(kind, payload);
  } catch (error) { notice(error); }
}

byId("train-form").addEventListener("submit", (event) => { event.preventDefault(); startTraining("train"); });
byId("validate-training").addEventListener("click", () => startTraining("validate"));
byId("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await invoke("save_settings", { settings: settingsFromForm() });
    notice("");
    log("Settings saved");
  } catch (error) { notice(error); }
});
byId("cancel-job").addEventListener("click", async () => {
  try {
    byId("cancel-job").disabled = true;
    await invoke("cancel_job", { jobId: job.jobId });
    log("Stop requested. Saved weights are kept.");
  } catch (error) { notice(error); byId("cancel-job").disabled = false; }
});
byId("clear-log").addEventListener("click", () => { lines.length = 0; byId("logs").textContent = ""; });
byId("copy-log").addEventListener("click", async () => {
  const button = byId("copy-log");
  try {
    await navigator.clipboard.writeText(byId("logs").textContent || "");
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = "Copy"; }, 1400);
  } catch { /* clipboard unavailable */ }
});
const LOG_DOCK_KEY = "costume-log-dock-hidden";
function setLogDockHidden(hidden) {
  byId("app-shell").classList.toggle("log-hidden", hidden);
  byId("log-dock").hidden = hidden;
  byId("log-resizer").hidden = hidden;
  byId("log-dock-open").hidden = !hidden;
  try { localStorage.setItem(LOG_DOCK_KEY, hidden ? "1" : "0"); } catch { /* storage unavailable */ }
}
byId("log-dock-close").addEventListener("click", () => setLogDockHidden(true));
byId("log-dock-open").addEventListener("click", () => setLogDockHidden(false));
try { if (localStorage.getItem(LOG_DOCK_KEY) === "1") setLogDockHidden(true); } catch { /* storage unavailable */ }

// ---- Appearance: surface style and color mode ----
let uiTheme = parseTheme((() => { try { return localStorage.getItem(THEME_KEY); } catch { return null; } })());
function applyTheme(next) {
  uiTheme = parseTheme(next);
  document.documentElement.dataset.style = uiTheme.style;
  document.documentElement.dataset.mode = uiTheme.mode;
  document.documentElement.style.colorScheme = uiTheme.mode;
  document.querySelectorAll("[data-theme-style]").forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.themeStyle === uiTheme.style)));
  document.querySelectorAll("[data-theme-mode]").forEach((btn) => btn.setAttribute("aria-pressed", String(btn.dataset.themeMode === uiTheme.mode)));
  try { localStorage.setItem(THEME_KEY, JSON.stringify(uiTheme)); } catch { /* storage unavailable */ }
}
document.querySelectorAll("[data-theme-style]").forEach((btn) => btn.addEventListener("click", () => applyTheme({ ...uiTheme, style: btn.dataset.themeStyle })));
document.querySelectorAll("[data-theme-mode]").forEach((btn) => btn.addEventListener("click", () => applyTheme({ ...uiTheme, mode: btn.dataset.themeMode })));
applyTheme(uiTheme);

// ---- Draggable splitter between settings workspace and right log dock ----
let preferredLogWidth = DEFAULT_LOG_WIDTH;
let logDockWidth = DEFAULT_LOG_WIDTH;
function applyLogWidth(width, persist = true) {
  logDockWidth = clampLogWidth(width, window.innerWidth);
  document.documentElement.style.setProperty("--log-width", logDockWidth + "px");
  if (persist) {
    preferredLogWidth = logDockWidth;
    try { localStorage.setItem(LOG_WIDTH_KEY, String(preferredLogWidth)); } catch { /* storage unavailable */ }
  }
}
try {
  const storedWidth = localStorage.getItem(LOG_WIDTH_KEY);
  if (storedWidth && Number.isFinite(Number(storedWidth))) preferredLogWidth = Number(storedWidth);
} catch { /* storage unavailable */ }
applyLogWidth(preferredLogWidth, false);
window.addEventListener("resize", () => applyLogWidth(preferredLogWidth, false));

const logResizer = byId("log-resizer");
let dragState = null;
logResizer.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  dragState = { startX: event.clientX, startWidth: byId("log-dock").getBoundingClientRect().width || logDockWidth };
  logResizer.classList.add("dragging");
  document.body.classList.add("resizing-dock");
  logResizer.setPointerCapture?.(event.pointerId);
});
logResizer.addEventListener("pointermove", (event) => {
  if (!dragState) return;
  applyLogWidth(dragState.startWidth + (dragState.startX - event.clientX), false);
});
function endDockDrag(event) {
  if (!dragState) return;
  dragState = null;
  logResizer.classList.remove("dragging");
  document.body.classList.remove("resizing-dock");
  if (event?.pointerId !== undefined) try { logResizer.releasePointerCapture?.(event.pointerId); } catch { /* ignore */ }
  applyLogWidth(logDockWidth, true);
}
logResizer.addEventListener("pointerup", endDockDrag);
logResizer.addEventListener("pointercancel", endDockDrag);
logResizer.addEventListener("dblclick", () => applyLogWidth(DEFAULT_LOG_WIDTH, true));
logResizer.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") { event.preventDefault(); applyLogWidth(logDockWidth + 28, true); }
  else if (event.key === "ArrowRight") { event.preventDefault(); applyLogWidth(logDockWidth - 28, true); }
  else if (event.key === "Home") { event.preventDefault(); applyLogWidth(DEFAULT_LOG_WIDTH, true); }
});

function imageFromURL(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not display the image"));
    image.src = url;
  });
}

const previewCanvas = byId("preview-canvas");
const previewStage = previewCanvas.closest(".preview-stage");
const previewZoom = createImageZoom({
  canvas: previewCanvas, scroller: previewStage,
  onChange: (zoom) => { byId("preview-zoom-reset").textContent = zoom === "fit" ? "Fit" : Math.round(zoom * 100) + "%"; }
});
let previewData = null; // { image, mask, layer } for the picture currently shown

function tintLayer(mask, width, height) {
  const [red, green, blue] = hexToRgb(getMaskColor());
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const context = layer.getContext("2d");
  context.drawImage(mask, 0, 0, width, height);
  const pixels = context.getImageData(0, 0, width, height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const alpha = pixels.data[index] > 127 ? 255 : 0;
    pixels.data[index] = red; pixels.data[index + 1] = green; pixels.data[index + 2] = blue; pixels.data[index + 3] = alpha;
  }
  context.putImageData(pixels, 0, 0);
  return layer;
}

// Redraw from cached pictures: switching mode or moving the opacity slider never reloads files.
function renderPreview() {
  if (!previewData) return;
  const { image, mask } = previewData;
  const context = previewCanvas.getContext("2d");
  context.globalAlpha = 1;
  context.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  if (previewMode === "mask" && mask) context.drawImage(mask, 0, 0, previewCanvas.width, previewCanvas.height);
  else {
    context.globalAlpha = Math.max(0, Math.min(1, Number(byId("preview-image-opacity").value) / 100));
    context.drawImage(image, 0, 0, previewCanvas.width, previewCanvas.height);
    context.globalAlpha = 1;
  }
  if ((previewMode === "overlay" || previewMode === "split") && mask) {
    previewData.layer ??= tintLayer(mask, previewCanvas.width, previewCanvas.height);
    context.globalAlpha = Math.max(0, Math.min(1, Number(byId("preview-opacity").value) / 100));
    if (previewMode === "split") {
      // Left of the divider: plain image. Right of it: image + mask overlay.
      const x = Math.round(previewCanvas.width * Number(byId("preview-split").value) / 100);
      context.save();
      context.beginPath();
      context.rect(x, 0, previewCanvas.width - x, previewCanvas.height);
      context.clip();
      context.drawImage(previewData.layer, 0, 0);
      context.restore();
      context.globalAlpha = 1;
      context.fillStyle = "#fff";
      const bar = Math.max(2, Math.round(previewCanvas.width / 500));
      context.fillRect(x - bar / 2, 0, bar, previewCanvas.height);
    } else context.drawImage(previewData.layer, 0, 0);
    context.globalAlpha = 1;
  }
  byId("preview-image-opacity").disabled = previewMode === "mask" && Boolean(mask);
  byId("preview-opacity").disabled = (previewMode !== "overlay" && previewMode !== "split") || !mask;
  byId("preview-split").disabled = previewMode !== "split" || !mask;
}

async function drawPreview() {
  const generation = ++previewGeneration;
  const entry = entries[imageIndex];
  if (!entry) return;
  byId("image-choice").value = String(imageIndex);
  byId("image-count").textContent = (imageIndex + 1) + " / " + entries.length;
  const live = job.status === "running" && jobKind === "mask" ? liveMasks.get(toSlash(entry.relative)) : null;
  const [image, mask] = await Promise.all([
    invoke("preview_image", { path: entry.image }).then(imageFromURL),
    live ? imageFromURL(live) : entry.mask ? invoke("preview_image", { path: entry.mask }).then(imageFromURL) : null
  ]);
  if (generation !== previewGeneration) return;
  const scale = Math.min(1, 2048 / Math.max(image.width, image.height));
  previewCanvas.width = Math.max(1, Math.round(image.width * scale));
  previewCanvas.height = Math.max(1, Math.round(image.height * scale));
  previewData = { image, mask, layer: null };
  byId("preview-empty").hidden = true;
  previewCanvas.hidden = false;
  byId("preview-fullscreen").hidden = false;
  renderPreview();
  previewZoom.refresh();
  if (previewMode !== "original" && !mask) log(entry.relative + ": no mask yet");
}

// During a mask job each finished mask arrives as a small data URL; show it before the job ends.
async function showLiveMask(source, dataUrl) {
  const key = toSlash(source);
  liveMasks.set(key, dataUrl);
  if (!entries.length) {
    try { await refreshPreview(); } catch { return; }
  }
  if (followLive) {
    const index = entries.findIndex((entry) => toSlash(entry.relative) === key);
    if (index >= 0) { imageIndex = index; await drawPreview(); }
  } else if (entries[imageIndex] && toSlash(entries[imageIndex].relative) === key) {
    await drawPreview();
  }
}

async function refreshPreview() {
  notice("");
  entries = await invoke("scan_images", { root: required(project.raw_dir, "Source images folder"), maskRoot: project.mask_dir });
  const select = byId("image-choice");
  select.replaceChildren();
  for (const [index, entry] of entries.entries()) {
    const option = document.createElement("option");
    option.value = index;
    option.textContent = entry.relative + (entry.mask ? " · mask" : "");
    select.append(option);
  }
  if (!entries.length) {
    ++previewGeneration;
    byId("preview-empty").hidden = false;
    byId("preview-canvas").hidden = true;
    byId("preview-fullscreen").hidden = true;
    byId("image-count").textContent = "0 images";
    throw new Error("No previewable images (PNG / JPEG / WebP / BMP)");
  }
  imageIndex = 0;
  await drawPreview();
}

byId("refresh-preview").addEventListener("click", () => refreshPreview().catch(notice));
byId("image-choice").addEventListener("change", () => { followLive = false; imageIndex = Number(byId("image-choice").value); drawPreview().catch(notice); });
for (const [id, direction] of [["previous-image", -1], ["next-image", 1]]) {
  byId(id).addEventListener("click", () => {
    if (!entries.length) return;
    followLive = false;
    imageIndex = (imageIndex + direction + entries.length) % entries.length;
    drawPreview().catch(notice);
  });
}
document.querySelectorAll("[data-preview]").forEach((button) => {
  button.addEventListener("click", () => {
    previewMode = button.dataset.preview;
    document.querySelectorAll("[data-preview]").forEach((option) => {
      option.classList.toggle("selected", option === button);
      option.setAttribute("aria-pressed", String(option === button));
    });
    if (previewData) renderPreview(); else drawPreview().catch(notice);
  });
});
byId("preview-opacity").addEventListener("input", () => {
  byId("preview-opacity-value").value = byId("preview-opacity").value + " %";
  renderPreview();
});
byId("preview-zoom-reset").addEventListener("click", () => previewZoom.reset());
byId("preview-split").addEventListener("input", renderPreview);
for (const button of document.querySelectorAll("[data-preview]")) {
  button.title = { original: "Original (Q toggles the overlay)", overlay: "Overlay (Q toggles, Shift+Q cycles)", mask: "Mask (Shift+Q cycles)", split: "Split (Shift+Q cycles)" }[button.dataset.preview];
}
byId("preview-image-opacity").addEventListener("input", () => {
  byId("preview-image-opacity-value").value = byId("preview-image-opacity").value + " %";
  renderPreview();
});
byId("preview-mask-color").value = getMaskColor();
byId("preview-mask-color").addEventListener("input", () => setMaskColor(byId("preview-mask-color").value));
window.addEventListener("mask-color-change", () => {
  byId("preview-mask-color").value = getMaskColor();
  if (previewData) previewData.layer = null;
  renderPreview();
});

// Full screen: the same panel is pinned over the whole window (controls, zoom and pan keep working).
const previewPanel = document.querySelector(".preview-panel");
const previewFullscreen = createFullscreen({ panel: previewPanel, button: byId("preview-fullscreen"), onChange: () => previewZoom.reset() });
document.addEventListener("keydown", (event) => {
  if (!previewFullscreen.active || event.ctrlKey || event.metaKey || event.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
  if (event.key === "ArrowLeft") { event.preventDefault(); byId("previous-image").click(); }
  else if (event.key === "ArrowRight") { event.preventDefault(); byId("next-image").click(); }
});

// Mask Creation keys (the full list is shown by "?").
const TEXT_INPUT_TYPES = new Set(["text", "search", "number", "email", "url", "password", "tel"]);
// Only fields you type into block shortcuts; a focused checkbox, slider or button does not.
const isTypingTarget = (target) => target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable
  || (target.tagName === "INPUT" && TEXT_INPUT_TYPES.has(target.type));
const typingTarget = (event) => isTypingTarget(event.target);
document.addEventListener("keydown", (event) => {
  if (byId("page-mask").hidden || event.ctrlKey || event.metaKey || event.altKey || typingTarget(event) || document.querySelector("dialog[open]")) return;
  const order = ["original", "overlay", "mask", "split"];
  if (event.key.toLowerCase() === "q") {
    const next = event.shiftKey ? order[(order.indexOf(previewMode) + 1) % order.length] : (previewMode === "original" ? "overlay" : "original");
    document.querySelector('[data-preview="' + next + '"]').click();
  }
  else if (event.key.toLowerCase() === "f" && !previewCanvas.hidden) previewFullscreen.set(!previewFullscreen.active);
  else if (event.key === "PageUp") byId("previous-image").click();
  else if (event.key === "PageDown") byId("next-image").click();
  else return;
  event.preventDefault();
});

// Whole-UI zoom (like a browser's Ctrl + wheel / Ctrl + / Ctrl -). Over a picture those keys zoom the
// picture instead; in a plain browser the browser's own zoom already works, so only the app handles it.
const PAGE_ZOOM_KEY = "costume-ui-zoom";
let pageZoom = 1;
try { pageZoom = readPageZoom(localStorage.getItem(PAGE_ZOOM_KEY)); } catch { /* storage unavailable */ }
let zoomToastTimer = 0;
function showZoomToast(level) {
  const toast = byId("zoom-toast");
  toast.textContent = Math.round(level * 100) + "%";
  toast.hidden = false;
  clearTimeout(zoomToastTimer);
  zoomToastTimer = setTimeout(() => { toast.hidden = true; }, 1200);
}
async function applyPageZoom(level, announce = true) {
  pageZoom = level;
  try { localStorage.setItem(PAGE_ZOOM_KEY, String(level)); } catch { /* storage unavailable */ }
  try {
    await native.webview.getCurrentWebview().setZoom(level);
    document.documentElement.style.zoom = "";
  } catch {
    document.documentElement.style.zoom = level === 1 ? "" : String(level);
  }
  if (announce) showZoomToast(level);
}
const overPicture = () => Boolean(document.querySelector("[data-image-zoom]:hover canvas:not([hidden])"));
if (native) {
  if (pageZoom !== 1) applyPageZoom(pageZoom, false);
  let wheelAmount = 0;
  window.addEventListener("wheel", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
    event.preventDefault();
    wheelAmount += event.deltaY;
    if (Math.abs(wheelAmount) < 40) return;
    const direction = wheelAmount < 0 ? 1 : -1;
    wheelAmount = 0;
    applyPageZoom(stepPageZoom(pageZoom, direction));
  }, { passive: false });
  window.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || overPicture()) return;
    let direction;
    if (event.key === "+" || event.key === "=") direction = 1;
    else if (event.key === "-" || event.key === "_") direction = -1;
    else if (event.key === "0") direction = 0;
    else return;
    event.preventDefault();
    applyPageZoom(stepPageZoom(pageZoom, direction));
  });
}

// ---------- keyboard shortcut help ("?") ----------
const shortcutsDialog = byId("shortcuts-dialog");
function openShortcuts() {
  const parts = [];
  for (const section of SHORTCUT_SECTIONS) {
    const heading = document.createElement("h4");
    heading.textContent = section.title;
    parts.push(heading);
    for (const [keys, description] of section.items) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      const key = document.createElement("kbd");
      key.textContent = keys;
      const text = document.createElement("span");
      text.textContent = description;
      row.append(text, key);
      parts.push(row);
    }
  }
  byId("shortcuts-body").replaceChildren(...parts);
  if (!shortcutsDialog.open) shortcutsDialog.showModal();
}
byId("shortcuts-close").addEventListener("click", () => shortcutsDialog.close());
document.querySelectorAll(".shortcut-button").forEach((button) => button.addEventListener("click", openShortcuts));
document.addEventListener("keydown", (event) => {
  if (event.key !== "?" || event.ctrlKey || event.metaKey || typingTarget(event) || document.querySelector("dialog[open]")) return;
  event.preventDefault();
  openShortcuts();
});

async function init() {
  if (!native) { notice("This is a screen preview. Start the Tauri app with pnpm dev to run jobs."); return; }
  await native.event.listen("job-event", (event) => handleEvent(event.payload));
  await native.event.listen("close-blocked", (event) => notice(event.payload));
  const settings = await invoke("load_settings");
  for (const [key, id] of Object.entries(settingsIds)) byId(id).value = toSlash(settings[key] || "");
  const saved = await invoke("job_status");
  if (saved.snapshot?.jobId) {
    job = saved.snapshot;
    jobKind = saved.snapshot.kind;
    setBusy(job.status === "running");
    for (const event of saved.logs) handleEvent(event);
    byId("job-status").textContent = job.status === "running" ? "Running" : ({ succeeded: "Done", failed: "Failed", cancelled: "Cancelled" }[job.status] || "Idle");
  }
}
const toolEditor = createTools({ invoke, run, notice, getProject: () => project, getJob: () => job });
initToolsLayout(byId("tools-workspace"));
// ---------- projects: everything you enter is autosaved and restored ----------
const SNAPSHOT_SKIP = new Set(["model-family", "download-source", "download-url", "image-choice", "tools-zoom", "tools-caption-text", "tools-check-tagfilter"]);
function trackedControls() {
  return [...document.querySelectorAll("#page-train, #page-dataset, #page-mask, #page-tools")]
    .flatMap((page) => [...page.querySelectorAll("input, select, textarea")])
    .filter((control) => control.id && !SNAPSHOT_SKIP.has(control.id) && !control.closest("dialog") && !control.readOnly
      && !["file", "color", "button"].includes(control.type));
}
function snapshotFields() {
  const fields = {};
  for (const control of trackedControls()) fields[control.id] = control.type === "checkbox" ? control.checked : control.value;
  return fields;
}
const collectProjectData = () => ({ version: 1, fields: snapshotFields(), project: { ...project }, page: currentPage });
const pristineData = { version: 1, fields: snapshotFields(), project: { ...PROJECT_DEFAULTS }, page: "train" };

let projectStore = null;
let projectSaveTimer = 0;
let suspendProjectSave = false;
const activeProject = () => projectStore.projects.find((item) => item.id === projectStore.activeId);
const showProjectStatus = (text) => { byId("project-status").textContent = text; };
function persistProjects() {
  try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(projectStore)); return true; } catch { return false; }
}
function saveProjectNow() {
  clearTimeout(projectSaveTimer);
  projectSaveTimer = 0;
  if (suspendProjectSave || !projectStore) return;
  try { projectStore = updateProjectData(projectStore, projectStore.activeId, collectProjectData()); }
  catch (error) { showProjectStatus("Autosave failed: " + error.message); return; }
  showProjectStatus(persistProjects() ? "Autosaved " + new Date().toLocaleTimeString() : "Autosave failed (browser storage is full)");
}
function scheduleProjectSave() {
  if (suspendProjectSave || !projectStore) return;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(saveProjectNow, 600);
}
for (const type of ["input", "change"]) {
  document.addEventListener(type, (event) => {
    if (event.target.closest?.("#page-settings, dialog, .project-bar")) return;
    scheduleProjectSave();
  });
}
window.addEventListener("pagehide", saveProjectNow);
document.addEventListener("visibilitychange", () => { if (document.hidden) saveProjectNow(); });

function applyProjectData(data) {
  suspendProjectSave = true;
  try {
    for (const control of trackedControls()) {
      const value = data.fields?.[control.id];
      if (value === undefined) continue;
      if (control.type === "checkbox") control.checked = Boolean(value);
      else if (typeof value === "string" && (control.tagName !== "SELECT" || [...control.options].some((option) => option.value === value))) control.value = value;
    }
    const saved = data.project ?? {};
    for (const key of Object.keys(PROJECT_DEFAULTS)) {
      project[key] = typeof saved[key] === "string" ? (PATH_KEYS.has(key) ? toSlash(saved[key]) : saved[key]) : PROJECT_DEFAULTS[key];
    }
    repairTrainMasks();
    saveProject();
    renderFamilyControls();
    syncSampleControls();
    // Sliders drive read-outs and redraws through their input handlers.
    document.querySelectorAll('#page-train input[type="range"], #page-mask input[type="range"], #page-tools input[type="range"]')
      .forEach((range) => range.dispatchEvent(new Event("input", { bubbles: true })));
  } finally { suspendProjectSave = false; }
  const tab = pageTabs.find((item) => item.dataset.page === data.page);
  if (tab) selectPage(tab);
}
function resetPreview() {
  ++previewGeneration;
  entries = [];
  imageIndex = 0;
  previewData = null;
  liveMasks.clear();
  byId("preview-empty").hidden = false;
  previewCanvas.hidden = true;
  byId("preview-fullscreen").hidden = true;
  byId("image-count").textContent = "0 images";
  byId("image-choice").replaceChildren(new Option("No images", ""));
}
function renderProjectSelect() {
  byId("project-select").replaceChildren(...projectStore.projects.map((item) => new Option(item.name, item.id)));
  byId("project-select").value = projectStore.activeId;
  byId("project-delete").disabled = projectStore.projects.length <= 1;
}
async function openProject(afterSwitch) {
  saveProjectNow();
  await toolEditor.prepareForProjectChange();
  afterSwitch();
  applyProjectData(activeProject().data);
  updateSelectionSummary();
  resetPreview();
  toolEditor.resetForProject();
  if (native) toolEditor.autoLoad();
  renderProjectSelect();
  showProjectStatus("Opened “" + activeProject().name + "”");
}

// A small in-app dialog (window.prompt is not reliable in the desktop webview).
function askProject({ title, message = "", value = null, okLabel = "OK", apply }) {
  const dialog = byId("project-dialog");
  const input = byId("project-name");
  byId("project-dialog-title").textContent = title;
  byId("project-dialog-message").textContent = message;
  byId("project-dialog-error").textContent = "";
  byId("project-dialog-ok").textContent = okLabel;
  input.hidden = value === null;
  input.value = value ?? "";
  return new Promise((resolve) => {
    const close = (result) => { dialog.close(); dialog.oncancel = null; resolve(result); };
    byId("project-dialog-cancel").onclick = () => close(false);
    dialog.oncancel = (event) => { event.preventDefault(); close(false); };
    const confirm = async () => {
      try { await apply(input.value); close(true); }
      catch (error) { byId("project-dialog-error").textContent = error.message; }
    };
    byId("project-dialog-ok").onclick = confirm;
    input.onkeydown = (event) => { if (event.key === "Enter") { event.preventDefault(); confirm(); } };
    dialog.showModal();
    if (value !== null) { input.focus(); input.select(); }
  });
}
byId("project-select").addEventListener("change", () => {
  const id = byId("project-select").value;
  if (id === projectStore.activeId) return;
  openProject(() => { projectStore = setActive(projectStore, id); persistProjects(); }).catch(notice);
});
byId("project-new").addEventListener("click", () => {
  askProject({
    title: "New project", message: "Starts with empty folders and default settings. The current project stays saved.", value: "", okLabel: "Create",
    apply: (name) => openProject(() => { projectStore = createProject(projectStore, name || "Project", pristineData).store; persistProjects(); })
  }).catch(notice);
});
byId("project-duplicate").addEventListener("click", () => {
  saveProjectNow();
  askProject({
    title: "Duplicate project", message: "Copies the current settings into a new project and opens it.", value: activeProject().name + " copy", okLabel: "Duplicate",
    apply: (name) => { projectStore = createProject(projectStore, name, collectProjectData()).store; persistProjects(); renderProjectSelect(); showProjectStatus("Opened “" + activeProject().name + "”"); }
  }).catch(notice);
});
byId("project-rename").addEventListener("click", () => {
  askProject({
    title: "Rename project", value: activeProject().name, okLabel: "Rename",
    apply: (name) => { projectStore = renameProject(projectStore, projectStore.activeId, name); persistProjects(); renderProjectSelect(); }
  }).catch(notice);
});
byId("project-delete").addEventListener("click", () => {
  const doomed = activeProject();
  askProject({
    title: "Delete project", message: "Delete “" + doomed.name + "”? Its saved settings are removed. Your image, mask and caption files are not touched.", okLabel: "Delete",
    apply: async () => { await openProject(() => { projectStore = deleteProject(projectStore, doomed.id); persistProjects(); }); }
  }).catch(notice);
});

projectStore = readStore(localStorage.getItem(PROJECTS_KEY));
if (projectStore) applyProjectData(activeProject().data);
else { repairTrainMasks(); saveProject(); projectStore = newStore("My project", collectProjectData()); persistProjects(); }
renderProjectSelect();
updateSelectionSummary();
showProjectStatus("Autosave on");
if (native) toolEditor.autoLoad();

init().catch(notice);
