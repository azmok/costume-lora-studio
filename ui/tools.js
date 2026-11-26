import { required } from "./state.mjs";
import { imagePoint, MaskHistory } from "./tools-state.mjs";
import { createDraftStore } from "./tools-drafts.mjs";
import { createFullscreen } from "./fullscreen.mjs";
import { getMaskColor, hexToRgb, setMaskColor } from "./mask-color.mjs";
import { coverage as maskCoverage, fillHoles, growMask, invertMask, removeSpecks, shrinkMask } from "./mask-ops.mjs";
import { ISSUE_LABELS, classify, laplacianVariance, tagFrequency, toGray } from "./dataset-check.mjs";
import { getRecord, loadSelectionStore, saveSelectionStore, setRecord } from "./training-selection.mjs";
import { dedupeTags, hasTag, normalizeCaption, removeTag, BUILTIN_TEMPLATES, NO_TEMPLATE, insertTags, normalizeTemplateName, readTemplateStore, removeTemplate, serializeTemplateStore, splitTags, upsertTemplate } from "./tools-captions.mjs";
import { BUILTIN_MASK_PRESETS, DEFAULT_MASK_PRESET, MASK_PRESET_KEY, findMaskPreset, normalizeMaskPresetName, readMaskPresetStore, removeMaskPreset, serializeMaskPresetStore, upsertMaskPreset } from "./mask-presets.mjs";

export function createTools({ invoke, run, notice, getProject, getJob }) {
  const byId = (id) => document.getElementById(id);
  const canvas = byId("tools-canvas");
  const maskCanvas = document.createElement("canvas");
  const overlay = document.createElement("canvas");
  const history = new MaskHistory();
  let entries = [];
  let selected = -1;
  let loadedRoot = "";
  let original = null;
  let originalURL = "";
  let mode = "mask"; // there is no mode switch any more: painting is always on, captions live in the same panel
  let view = "overlay";
  let brush = "add";
  let loading = false;
  let saving = false;
  let maskDirty = false;
  let captionDirty = false;
  let guidance = [];
  let stroke = null;
  let pending = null;
  const drafts = createDraftStore();
  let draftTimer = 0;
  let checked = new Set(); // image-list multi selection (Ctrl / Shift + click)
  let anchor = -1;
  let filter = null; // { kind: "tag" | "issue", value, label, set: Set(relative) } - narrows the image list
  let checkInfo = new Map(); // relative -> { width, height, blur, coverage, hasMask, caption } from the dataset check
  let checkIssues = new Map(); // relative -> [issue codes]
  let lastBulk = null; // { label, before: Map(relative -> caption) } for "Undo last bulk edit"
  let trainingStore = {}; // which images LoRA training uses, per source folder (unchecked = left out)
  const excludedTraining = new Set();
  let editRev = 0; // bumps on every edit, so a save in progress never clears the "unsaved" flag of newer edits
  let autosaveTimer = 0;
  let reviewed = new Set();
  let spaceDown = false;
  let altDown = false;
  let originalAvailable = false; // the first automatic mask of this image is stored
  let peek = false;
  let pan = null;
  let adjust = null; // right-button drag: width = brush size, with Alt = brush opacity
  const thumbCache = new Map();
  const thumbQueue = [];
  let thumbActive = 0;
  let thumbGeneration = 0;
  const current = () => entries[selected];
  // Caption folder is optional: blank (or the source folder itself) = save beside each image.
  const captionDir = () => {
    const dir = String(getProject().caption_dir ?? "").trim();
    return !dir || samePath(dir, loadedRoot) ? "" : dir;
  };
  const busy = () => loading || saving || getJob().status === "running";
  const samePath = (left, right) => String(left).replaceAll("\\", "/").replace(/^\/\/\?\//, "").toLowerCase() === String(right).replaceAll("\\", "/").replace(/^\/\/\?\//, "").toLowerCase();

  function updateControls() {
    const locked = busy();
    document.querySelectorAll("#page-tools [data-tool-lock]").forEach((control) => { control.disabled = locked; });
    document.querySelectorAll("#page-tools .tool-image-action").forEach((button) => { button.disabled = locked || !current(); });
    byId("tools-caption-all").disabled = locked || entries.length === 0;
    byId("tools-fullscreen").hidden = canvas.hidden;
    byId("tools-fs-info").textContent = current() ? current().relative + (maskDirty || captionDirty ? "  ●" : "") : "";
    const visible = visibleIndexes();
    const position = visible.indexOf(selected);
    byId("tools-count").textContent = (filter ? visible.length + " of " + entries.length : entries.length) + (entries.length === 1 ? " image" : " images") + (entries.length ? " · " + reviewed.size + " reviewed · " + (entries.length - excludedCount()) + " for training" : "");
    byId("tools-train-toggle").setAttribute("aria-pressed", String(Boolean(current() && !excludedTraining.has(current().relative))));
    byId("tools-train-toggle").disabled = locked || !current();
    for (const id of ["tools-train-all", "tools-train-none", "tools-train-invert", "tools-train-highlighted"]) byId(id).disabled = locked || entries.length === 0;
    document.querySelectorAll(".train-check").forEach((box) => { box.disabled = locked; });
    byId("tools-reviewed").setAttribute("aria-pressed", String(Boolean(current() && reviewed.has(current().relative))));
    byId("tools-prev").disabled = locked || position <= 0;
    byId("tools-next").disabled = locked || visible.length === 0 || position >= visible.length - 1;
    byId("tools-next-unreviewed").disabled = locked || entries.length === 0;
    byId("tools-check").disabled = locked || entries.length === 0;
    byId("tools-check-force").disabled = locked || entries.length === 0;
    byId("tools-check-fixdup").disabled = locked || !byId("tools-check-fixdup").dataset.count || byId("tools-check-fixdup").dataset.count === "0";
    byId("tools-check-undo").disabled = locked || !lastBulk;
    byId("tools-op-original").disabled = locked || !current() || !originalAvailable;
    byId("tools-undo").disabled = locked || history.index <= 0;
    byId("tools-redo").disabled = locked || history.index >= history.states.length - 1;
    if (current()) current().draft = maskDirty || captionDirty ? { mask: maskDirty, caption: captionDirty } : null;
    byId("tools-dirty").textContent = !current() ? "No image" : maskDirty || captionDirty ? "Unsaved edits (auto-saved temporarily)" : "Saved / no edits";
    const unsaved = entries.filter((entry) => entry.draft).length;
    byId("tools-save-all").textContent = unsaved ? "Save all changes (" + unsaved + (unsaved === 1 ? " image)" : " images)") : "Save all changes";
    byId("tools-save-all").disabled = locked || unsaved === 0;
    document.querySelectorAll(".tool-image-item").forEach((button, index) => {
      button.disabled = locked;
      button.classList.toggle("has-draft", Boolean(entries[index]?.draft));
      button.classList.toggle("multi-selected", checked.has(index));
      button.classList.toggle("reviewed", reviewed.has(entries[index]?.relative));
    });
    byId("tools-tags-selected").textContent = "Insert into selected images (" + checked.size + (checked.size === 1 ? " image)" : " images)");
    byId("tools-tags-selected").disabled = locked || checked.size === 0;
    byId("tools-caption-selected").textContent = "Generate captions for selected images (" + checked.size + (checked.size === 1 ? " image)" : " images)");
    byId("tools-caption-selected").disabled = locked || checked.size === 0 || !current();
    byId("tools-tags-all").disabled = locked || entries.length === 0;
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not open the image"));
      image.src = url;
    });
  }

  function bitmap() {
    const rgba = maskCanvas.getContext("2d").getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
    const result = new Uint8Array(maskCanvas.width * maskCanvas.height);
    let white = 0;
    for (let index = 0; index < result.length; index++) {
      result[index] = rgba[index * 4 + 3];
      if (result[index] >= 128) white++;
    }
    byId("tools-coverage").textContent = "White area: " + (100 * white / result.length).toFixed(1) + "%";
    return result;
  }

  function putBitmap(mask) {
    const context = maskCanvas.getContext("2d");
    const pixels = context.createImageData(maskCanvas.width, maskCanvas.height);
    for (let index = 0; index < mask.length; index++) {
      const offset = index * 4;
      pixels.data[offset] = 255;
      pixels.data[offset + 1] = 255;
      pixels.data[offset + 2] = 255;
      pixels.data[offset + 3] = mask[index];
    }
    context.putImageData(pixels, 0, 0);
    bitmap();
  }

  const imageOpacity = () => Math.max(0, Math.min(1, Number(byId("tools-image-opacity").value) / 100));
  const maskOpacity = () => Math.max(0, Math.min(1, Number(byId("tools-mask-opacity").value) / 100));
  function syncOpacityControls() {
    byId("tools-image-opacity").disabled = view === "mask";
    byId("tools-mask-opacity").disabled = view !== "overlay" && view !== "split";
    byId("tools-split").disabled = view !== "split";
  }

  // ---- review marks and "resume where I left off" (kept per source folder) ----
  const REVIEW_KEY = "costume-reviewed";
  const LAST_IMAGE_KEY = "costume-last-image";
  function readJson(key) {
    try { const value = JSON.parse(localStorage.getItem(key) || "{}"); return value && typeof value === "object" ? value : {}; } catch { return {}; }
  }
  function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ } }
  function loadReviewed() {
    const list = readJson(REVIEW_KEY)[loadedRoot];
    return new Set(Array.isArray(list) ? list.filter((item) => typeof item === "string") : []);
  }
  function saveReviewed() { const all = readJson(REVIEW_KEY); all[loadedRoot] = [...reviewed]; writeJson(REVIEW_KEY, all); }
  const lastImageFor = (root) => { const value = readJson(LAST_IMAGE_KEY)[root]; return typeof value === "string" ? value : ""; };
  function rememberImage(relative) { const all = readJson(LAST_IMAGE_KEY); all[loadedRoot] = relative; writeJson(LAST_IMAGE_KEY, all); }
  function toggleReviewed() {
    const entry = current();
    if (!entry) return;
    if (reviewed.has(entry.relative)) reviewed.delete(entry.relative); else reviewed.add(entry.relative);
    saveReviewed();
    updateControls();
  }
  function go(index) {
    if (busy() || !entries[index] || index === selected) return;
    anchor = index;
    if (!filter) checked = new Set([index]);
    selectImage(index).catch(notice);
  }
  // Prev / Next / N move through the images that are currently shown (all of them, or the filtered ones).
  function visibleIndexes() {
    const all = entries.map((_, index) => index);
    return filter ? all.filter((index) => filter.set.has(entries[index].relative)) : all;
  }
  function step(delta) {
    const visible = visibleIndexes();
    if (!visible.length) return;
    const position = visible.indexOf(selected);
    const target = position < 0 ? visible[0] : visible[position + delta];
    if (target !== undefined) go(target);
  }
  function goNextUnreviewed() {
    const visible = visibleIndexes();
    if (!visible.length || busy()) return;
    const start = visible.indexOf(selected);
    for (let offset = 1; offset <= visible.length; offset++) {
      const index = visible[(start + offset + visible.length) % visible.length];
      if (!reviewed.has(entries[index].relative)) { go(index); return; }
    }
    byId("tools-dirty").textContent = "All images are reviewed";
  }

  function render() {
    syncOpacityControls();
    if (!original) return;
    const shown = peek ? "original" : view;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (shown !== "mask") { context.globalAlpha = imageOpacity(); context.drawImage(original, 0, 0); context.globalAlpha = 1; }
    else { context.fillStyle = "#000"; context.fillRect(0, 0, canvas.width, canvas.height); }
    const ratio = Math.max(1, canvas.width / Math.max(1, canvas.getBoundingClientRect().width));
    if (shown !== "original") {
      if (shown === "mask") context.drawImage(maskCanvas, 0, 0);
      else {
        const color = overlay.getContext("2d");
        color.clearRect(0, 0, overlay.width, overlay.height);
        color.globalCompositeOperation = "source-over";
        color.drawImage(maskCanvas, 0, 0);
        color.globalCompositeOperation = "source-in";
        color.fillStyle = getMaskColor();
        color.fillRect(0, 0, overlay.width, overlay.height);
        color.globalCompositeOperation = "source-over";
        context.globalAlpha = maskOpacity();
        if (shown === "split") {
          // Left of the divider: plain image. Right of it: image + mask overlay.
          const x = Math.round(canvas.width * Number(byId("tools-split").value) / 100);
          context.save();
          context.beginPath();
          context.rect(x, 0, canvas.width - x, canvas.height);
          context.clip();
          context.drawImage(overlay, 0, 0);
          context.restore();
          context.globalAlpha = 1;
          context.fillStyle = "#fff";
          context.fillRect(x - ratio, 0, 2 * ratio, canvas.height);
        } else context.drawImage(overlay, 0, 0);
        context.globalAlpha = 1;
      }
    }
    if (mode === "mask" && (shown === "overlay" || shown === "split") && byId("tools-show-guides").checked) {
      for (const point of guidance) {
        context.beginPath();
        context.arc(point.x, point.y, 4 * ratio, 0, Math.PI * 2);
        context.strokeStyle = point.label ? "#baffd4" : "#ff7d7d";
        context.lineWidth = 1.5 * ratio;
        context.stroke();
      }
    }
  }

  // ---- which images are used for LoRA training: all of them unless unchecked ----
  const excludedCount = () => entries.filter((entry) => excludedTraining.has(entry.relative)).length;
  function persistTrainingSelection() {
    trainingStore = setRecord(trainingStore, loadedRoot, { excluded: [...excludedTraining], total: entries.length });
    saveSelectionStore(trainingStore); // the Train tab reads this
  }
  function loadTrainingSelection() {
    trainingStore = loadSelectionStore();
    const present = new Set(entries.map((entry) => entry.relative));
    excludedTraining.clear();
    for (const name of getRecord(trainingStore, loadedRoot).excluded) if (present.has(name)) excludedTraining.add(name);
    persistTrainingSelection();
  }
  function refreshTrainingMarks() {
    for (const box of byId("tools-files").querySelectorAll(".train-check")) {
      const used = !excludedTraining.has(box.dataset.relative);
      box.checked = used;
      box.closest(".tool-image-row").classList.toggle("excluded", !used);
    }
    updateControls();
  }
  function setTrainingSelection(usedNames) {
    excludedTraining.clear();
    for (const entry of entries) if (!usedNames.has(entry.relative)) excludedTraining.add(entry.relative);
    persistTrainingSelection();
    refreshTrainingMarks();
  }
  function setTrainingUse(relatives, used) {
    for (const relative of relatives) { if (used) excludedTraining.delete(relative); else excludedTraining.add(relative); }
    persistTrainingSelection();
    refreshTrainingMarks();
  }
  function toggleTraining() {
    const entry = current();
    if (entry) setTrainingUse([entry.relative], excludedTraining.has(entry.relative));
  }

  // Lazy list thumbnails: only items scrolled into view are loaded, two at a time.
  function drawThumb(image) {
    const side = 72;
    const surface = document.createElement("canvas");
    surface.width = surface.height = side;
    const scale = Math.max(side / image.naturalWidth, side / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    surface.getContext("2d").drawImage(image, (side - width) / 2, (side - height) / 2, width, height);
    return surface.toDataURL("image/jpeg", 0.7);
  }
  function applyThumb(entry) {
    const url = thumbCache.get(entry.image);
    const slot = byId("tools-files").querySelector('.tool-image-item[data-index="' + entries.indexOf(entry) + '"]')?.firstElementChild;
    if (!url || !slot || slot.tagName === "IMG") return;
    const picture = document.createElement("img");
    picture.src = url;
    picture.alt = "";
    slot.replaceWith(picture);
  }
  function pumpThumbs() {
    while (thumbActive < 2 && thumbQueue.length) {
      const { entry, generation } = thumbQueue.shift();
      if (generation !== thumbGeneration || thumbCache.has(entry.image)) continue;
      thumbActive++;
      (async () => {
        try {
          const image = await loadImage(await invoke("preview_image", { path: entry.image }));
          if (generation === thumbGeneration) thumbCache.set(entry.image, drawThumb(image));
        } catch { if (generation === thumbGeneration) thumbCache.set(entry.image, ""); }
        finally {
          thumbActive--;
          if (generation === thumbGeneration) applyThumb(entry);
          pumpThumbs();
        }
      })();
    }
  }
  const thumbObserver = new IntersectionObserver((records) => {
    for (const record of records) {
      if (!record.isIntersecting) continue;
      thumbObserver.unobserve(record.target);
      const entry = entries[Number(record.target.dataset.index)];
      if (entry && !thumbCache.has(entry.image) && !thumbQueue.some((item) => item.entry === entry)) thumbQueue.push({ entry, generation: thumbGeneration });
    }
    pumpThumbs();
  }, { root: byId("tools-files"), rootMargin: "160px" });

  function renderFiles() {
    const list = byId("tools-files");
    thumbObserver.disconnect();
    list.replaceChildren();
    entries.forEach((entry, index) => {
      if (filter && !filter.set.has(entry.relative)) return;
      const row = document.createElement("div");
      row.className = "tool-image-row" + (excludedTraining.has(entry.relative) ? " excluded" : "");
      const useBox = document.createElement("input");
      useBox.type = "checkbox";
      useBox.className = "train-check";
      useBox.dataset.relative = entry.relative;
      useBox.checked = !excludedTraining.has(entry.relative);
      useBox.title = "Use this image for LoRA training";
      useBox.setAttribute("aria-label", "Use " + entry.relative + " for LoRA training");
      useBox.addEventListener("change", () => setTrainingUse([entry.relative], useBox.checked));
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tool-image-item";
      button.dataset.index = index;
      button.setAttribute("aria-pressed", String(index === selected));
      const cached = thumbCache.get(entry.image);
      const source = index === selected && originalURL ? originalURL : cached;
      const thumbnail = document.createElement(source ? "img" : "span");
      if (source) { thumbnail.src = source; thumbnail.alt = ""; }
      else { thumbnail.className = "tool-image-number"; thumbnail.textContent = index + 1; if (cached === undefined) thumbObserver.observe(button); }
      const label = document.createElement("span");
      label.textContent = entry.relative + (entry.mask ? " · mask" : "");
      if (filter && checkInfo.has(entry.relative)) {
        // While a filter is active, show why the image matches (the caption with the tag highlighted, or the issues).
        const note = document.createElement("small");
        note.className = "item-note";
        if (filter.kind === "tag") {
          splitTags(checkInfo.get(entry.relative).caption).forEach((tag, position) => {
            if (position) note.append(", ");
            if (tag.toLowerCase() === filter.value.toLowerCase()) { const mark = document.createElement("mark"); mark.textContent = tag; note.append(mark); }
            else note.append(tag);
          });
        } else note.textContent = (checkIssues.get(entry.relative) ?? []).map((code) => ISSUE_LABELS[code]).join(" · ");
        label.append(note);
      }
      button.append(thumbnail, label);
      button.addEventListener("click", (event) => {
        if (busy()) return;
        if (event.ctrlKey || event.metaKey) {
          if (checked.has(index)) checked.delete(index); else checked.add(index);
          anchor = index;
          updateControls();
        } else if (event.shiftKey && anchor >= 0) {
          for (let position = Math.min(anchor, index); position <= Math.max(anchor, index); position++) if (!filter || filter.set.has(entries[position].relative)) checked.add(position);
          updateControls();
        } else {
          anchor = index;
          checked = new Set([index]);
          selectImage(index).catch(notice);
        }
      });
      row.append(useBox, button);
      list.append(row);
    });
    updateControls();
  }

  // --- drafts: unsaved edits are auto-stored so they survive switching images and restarts ---
  async function writeDraft() {
    const entry = current();
    if (!entry || !loadedRoot || !original) return;
    if (!maskDirty && !captionDirty) { await drafts.remove(loadedRoot, entry.relative); return; }
    await drafts.put({
      root: loadedRoot, relative: entry.relative,
      mask: maskDirty ? maskCanvas.toDataURL("image/png") : null,
      caption: captionDirty ? byId("tools-caption-text").value : null,
      guidance: structuredClone(guidance)
    });
    scheduleAutosave();
  }
  function scheduleDraft(delay = 600) {
    editRev++;
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => { draftTimer = 0; writeDraft().catch(() => {}); }, delay);
  }
  async function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    await writeDraft().catch(() => {});
  }
  window.addEventListener("pagehide", () => { if (draftTimer) flushDraft(); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && draftTimer) flushDraft(); });

  // The first automatic mask of each image is kept once, so "Restore auto mask" still works after
  // later edits have been saved over the file.
  const originalKey = () => loadedRoot + "::first-auto-mask";
  async function ensureOriginal(entry) {
    if (!await drafts.get(originalKey(), entry.relative)) {
      await drafts.put({ root: originalKey(), relative: entry.relative, mask: maskCanvas.toDataURL("image/png"), caption: null, guidance: [] });
    }
    originalAvailable = true;
  }

  async function applyDraft(draft) {
    if (draft.mask) {
      const image = await loadImage(draft.mask);
      if (image.naturalWidth === canvas.width && image.naturalHeight === canvas.height) {
        const context = maskCanvas.getContext("2d");
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0);
        guidance = structuredClone(draft.guidance ?? []);
        history.reset(bitmap(), guidance);
        maskDirty = true;
      }
    }
    if (typeof draft.caption === "string") {
      byId("tools-caption-text").value = draft.caption;
      captionDirty = true;
    }
  }

  async function confirmOverwrite(count) {
    const dialog = byId("tools-overwrite-dialog");
    byId("tools-overwrite-message").textContent = "Overwriting captions for " + count + " images: existing captions are fully replaced (cannot be undone). Captions of images outside the target are not changed.";
    return new Promise((resolve) => {
      const finish = (confirmed) => {
        dialog.close();
        dialog.oncancel = null;
        resolve(confirmed);
      };
      byId("tools-overwrite-cancel").onclick = () => finish(false);
      byId("tools-overwrite-confirm").onclick = () => finish(true);
      dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
      dialog.showModal();
    });
  }

  async function confirmDiscard(force = false) {
    if (!force && !maskDirty && !captionDirty) return true;
    const dialog = byId("tools-unsaved-dialog");
    return new Promise((resolve) => {
      const finish = (confirmed) => {
        dialog.close();
        dialog.oncancel = null;
        resolve(confirmed);
      };
      byId("tools-discard-cancel").onclick = () => finish(false);
      byId("tools-discard-confirm").onclick = () => finish(true);
      dialog.oncancel = (event) => { event.preventDefault(); finish(false); };
      dialog.showModal();
    });
  }

  async function maskFromURL(url, recordHistory) {
    const image = await loadImage(url);
    if (image.naturalWidth !== canvas.width || image.naturalHeight !== canvas.height) {
      throw new Error("Mask and source image have different pixel dimensions");
    }
    const context = overlay.getContext("2d");
    context.clearRect(0, 0, overlay.width, overlay.height);
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, overlay.width, overlay.height).data;
    const mask = new Uint8Array(canvas.width * canvas.height);
    for (let index = 0; index < mask.length; index++) mask[index] = data[index * 4] >= 128 && data[index * 4 + 3] >= 128 ? 255 : 0;
    putBitmap(mask);
    if (recordHistory) history.commit(mask, guidance); else history.reset(mask);
    render();
  }

  async function selectImage(index, force = false) {
    if (busy() || !entries[index]) return;
    if (!force && index === selected) return;
    await flushDraft();
    loading = true;
    updateControls();
    try {
      const entry = entries[index];
      const url = await invoke("preview_image", { path: entry.image });
      const image = await loadImage(url);
      if (image.naturalWidth * image.naturalHeight > 16_777_216) throw new Error("Paint editing supports up to 16.77 megapixels. Please downsize the source image.");
      const caption = await invoke("load_tool_caption", { root: loadedRoot, image: entry.image, captionDir: getProject().caption_dir });
      selected = index;
      rememberImage(entry.relative);
      if (!filter) checked = new Set([index]); else checked.add(index);
      anchor = index;
      original = image;
      originalURL = url;
      for (const surface of [canvas, maskCanvas, overlay]) {
        surface.width = image.naturalWidth;
        surface.height = image.naturalHeight;
      }
      setZoom("fit");
      history.reset(new Uint8Array(canvas.width * canvas.height));
      maskCanvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
      if (entry.mask) { await maskFromURL(await invoke("preview_image", { path: entry.mask }), false); await ensureOriginal(entry); }
      else { bitmap(); originalAvailable = Boolean(await drafts.get(originalKey(), entry.relative)); }
      guidance = [];
      maskDirty = false;
      captionDirty = false;
      byId("tools-caption-text").value = caption || "";
      const draft = await drafts.get(loadedRoot, entry.relative);
      if (draft) await applyDraft(draft);
      byId("tools-image-name").textContent = entry.relative;
      byId("tools-image-size").textContent = canvas.width + " × " + canvas.height + " px";
      byId("tools-empty").hidden = true;
      canvas.hidden = false;
      renderFiles();
      render();
      initialZoom();
      notice("");
    } catch (error) {
      selected = -1;
      original = null;
      originalURL = "";
      maskDirty = false;
      captionDirty = false;
      canvas.hidden = true;
      setZoom("fit");
      byId("tools-empty").hidden = false;
      byId("tools-caption-text").value = "";
      byId("tools-image-name").textContent = "Could not open the image";
      renderFiles();
      throw error;
    } finally { loading = false; updateControls(); }
  }

  byId("tools-load").addEventListener("click", async () => {
    try {
      if (busy()) return;
      const root = required(byId("tools-root").value, "Source images folder");
      await flushDraft();
      loading = true;
      updateControls();
      const scanned = await invoke("scan_images", { root, maskRoot: getProject().mask_dir });
      const names = scanned.map((entry) => entry.relative.replace(/\.[^.]+$/, "").toLowerCase());
      if (new Set(names).size !== names.length) throw new Error("Files with the same name (e.g. JPG / PNG) exist in the same place. Their saved names would collide; rename them.");
      const saved = await drafts.listByRoot(root);
      for (const entry of scanned) {
        const draft = saved.find((item) => item.relative === entry.relative);
        entry.draft = draft ? { mask: Boolean(draft.mask), caption: typeof draft.caption === "string" } : null;
      }
      entries = scanned;
      filter = null;
      checkInfo = new Map();
      checkIssues = new Map();
      lastBulk = null;
      byId("tools-filter-bar").hidden = true;
      byId("tools-check-panel").hidden = true;
      checked = new Set();
      anchor = -1;
      loadedRoot = root;
      reviewed = loadReviewed();
      loadTrainingSelection();
      thumbCache.clear();
      thumbQueue.length = 0;
      thumbGeneration++;
      selected = -1;
      original = null;
      originalURL = "";
      maskDirty = false;
      captionDirty = false;
      byId("tools-count").textContent = entries.length + " images";
      byId("tools-empty").hidden = false;
      canvas.hidden = true;
      renderFiles();
      loading = false;
      if (!entries.length) throw new Error("No supported images (PNG / JPEG / WebP / BMP)");
      const resumeAt = entries.findIndex((entry) => entry.relative === lastImageFor(root));
      await selectImage(resumeAt >= 0 ? resumeAt : 0, true);
    } catch (error) { notice(error); }
    finally { loading = false; updateControls(); }
  });

  function setView(value) {
    view = value;
    document.querySelectorAll("[data-editor-view]").forEach((option) => option.classList.toggle("selected", option.dataset.editorView === value));
    render();
  }
  document.querySelectorAll("[data-editor-view]").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.editorView));
    button.title = { original: "Original (Q toggles the overlay)", overlay: "Overlay (Q toggles, Shift+Q cycles)", mask: "Mask (Shift+Q cycles)", split: "Split (Shift+Q cycles)" }[button.dataset.editorView];
  });
  byId("tools-split").addEventListener("input", () => { byId("tools-split-value").value = byId("tools-split").value + " %"; render(); });
  // Zoom: "fit" or a scale factor (CSS px per image px). Ctrl+wheel / Ctrl+Up/Down / +/- buttons.
  const scroller = byId("tools-canvas-scroll");
  const zoomSelect = byId("tools-zoom");
  const ZOOM_MIN = 0.1;
  const ZOOM_MAX = 32; // 3200%, like Photoshop
  const PIXEL_ZOOM = 3; // from here on pixels are drawn crisp instead of smoothed
  let zoom = "fit";
  let isFullscreen = false;
  // In full screen "fit" is computed in JS (and may scale up) so pointer maths stay exact.
  const fitScale = () => (isFullscreen ? Math.min(8, Math.max(0.05, Math.min((scroller.clientWidth - 4) / canvas.width, (scroller.clientHeight - 4) / canvas.height))) : null);
  function syncZoomSelect() {
    const preset = [...zoomSelect.options].find((option) => option.value !== "custom" && option.value !== "fit" && Number(option.value) === zoom);
    const custom = zoomSelect.querySelector("option[value=custom]");
    if (zoom === "fit") zoomSelect.value = "fit";
    else if (preset) zoomSelect.value = preset.value;
    else { custom.textContent = Math.round(zoom * 100) + "%"; custom.hidden = false; zoomSelect.value = "custom"; }
  }
  function setZoom(next, anchor) {
    if (next !== "fit") next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const before = !canvas.hidden && canvas.width > 0 ? canvas.getBoundingClientRect() : null;
    const frame = scroller.getBoundingClientRect();
    const point = anchor ?? { x: frame.left + frame.width / 2, y: frame.top + frame.height / 2 };
    zoom = next;
    const shown = next === "fit" ? fitScale() : next;
    canvas.classList.toggle("zoomed", shown !== null);
    canvas.classList.toggle("pixelated", shown !== null && shown >= PIXEL_ZOOM);
    canvas.style.width = shown === null ? "" : Math.round(canvas.width * shown) + "px";
    canvas.style.height = shown === null ? "" : Math.round(canvas.height * shown) + "px";
    padCanvas();
    syncZoomSelect();
    updateBrushCursor();
    if (before && before.width && before.height) {
      const fx = (point.x - before.left) / before.width;
      const fy = (point.y - before.top) / before.height;
      const after = canvas.getBoundingClientRect();
      scroller.scrollLeft += after.left + fx * after.width - point.x;
      scroller.scrollTop += after.top + fy * after.height - point.y;
    }
    render();
  }
  // A free canvas like Photoshop: while zoomed, half a frame of empty space surrounds the picture so any
  // edge or corner can be pulled to the middle of the screen.
  function padCanvas() {
    canvas.style.margin = canvas.classList.contains("zoomed") ? Math.round(scroller.clientHeight / 2) + "px " + Math.round(scroller.clientWidth / 2) + "px" : "";
  }
  function initialZoom() {
    if (canvas.hidden || !original) return;
    const base = Math.min((scroller.clientWidth - 4) / canvas.width, (scroller.clientHeight - 4) / canvas.height);
    setZoom(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, base * 1.1)));
    scroller.scrollLeft = (scroller.scrollWidth - scroller.clientWidth) / 2;
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
  }
  const displayedScale = () => canvas.getBoundingClientRect().width / Math.max(1, canvas.width);
  function stepZoom(factor, anchor) {
    if (!original || canvas.hidden) return;
    setZoom((zoom === "fit" ? displayedScale() : zoom) * factor, anchor);
  }
  zoomSelect.addEventListener("change", () => {
    if (zoomSelect.value === "custom") return;
    setZoom(zoomSelect.value === "fit" ? "fit" : Number(zoomSelect.value));
  });
  byId("tools-zoom-in").addEventListener("click", () => stepZoom(1.25));
  byId("tools-zoom-out").addEventListener("click", () => stepZoom(1 / 1.25));
  scroller.addEventListener("wheel", (event) => {
    // Alt + wheel zooms the picture; Ctrl + wheel is left to the whole-UI zoom (app.js).
    if (!event.altKey || event.ctrlKey || event.metaKey || !original || canvas.hidden) return;
    event.preventDefault();
    stepZoom(Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.002), { x: event.clientX, y: event.clientY });
  }, { passive: false });
  document.addEventListener("keydown", (event) => {
    if (byId("page-tools").hidden || !(event.ctrlKey || event.metaKey) || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
    // Ctrl + arrows always zoom the picture; Ctrl + / - / 0 only while the pointer is over it
    // (elsewhere they zoom the whole UI, handled in app.js).
    const hovered = scroller.matches(":hover") && !canvas.hidden;
    if (event.key === "ArrowUp") stepZoom(1.25);
    else if (event.key === "ArrowDown") stepZoom(1 / 1.25);
    else if (!hovered) return;
    else if (event.key === "+" || event.key === "=") stepZoom(1.25);
    else if (event.key === "-" || event.key === "_") stepZoom(1 / 1.25);
    else if (event.key === "0") setZoom("fit");
    else return;
    event.preventDefault();
  });
  for (const [id, outputId] of [["tools-image-opacity", "tools-image-opacity-value"], ["tools-mask-opacity", "tools-mask-opacity-value"]]) {
    byId(id).addEventListener("input", () => { byId(outputId).value = byId(id).value + " %"; render(); });
  }
  byId("tools-mask-color").value = getMaskColor();
  byId("tools-mask-color").addEventListener("input", () => setMaskColor(byId("tools-mask-color").value));
  window.addEventListener("mask-color-change", () => { byId("tools-mask-color").value = getMaskColor(); render(); updateBrushCursor(); });

  // Full screen = focus mode. The panel header / view bar / footer are hidden (CSS) and everything the
  // editor needs moves into one translucent toolbar over the picture, then back on exit.
  const paintTools = byId("tools-paint-tools");
  const fsToolbar = byId("tools-fs-toolbar");
  // The toolbox can be dragged by its handle; the position is remembered (double-click resets it).
  const handle = document.createElement("div");
  handle.className = "fs-handle";
  handle.textContent = "⠿ Tools — drag to move";
  handle.title = "Drag to move the toolbox. Double-click to put it back.";
  fsToolbar.prepend(handle);
  const TOOLBOX_KEY = "costume-toolbox-pos";
  const savedToolbox = () => {
    try { const value = JSON.parse(localStorage.getItem(TOOLBOX_KEY) || "null"); return value && Number.isFinite(value.right) && Number.isFinite(value.top) ? value : null; } catch { return null; }
  };
  function placeToolbox(position) {
    const frame = fsToolbar.offsetParent;
    if (!frame || fsToolbar.hidden) return;
    if (!position) { fsToolbar.style.right = ""; fsToolbar.style.top = ""; fsToolbar.style.maxHeight = ""; return; }
    const room = frame.getBoundingClientRect();
    const right = Math.max(0, Math.min(room.width - fsToolbar.offsetWidth, position.right));
    const top = Math.max(0, Math.min(room.height - 40, position.top));
    fsToolbar.style.right = right + "px";
    fsToolbar.style.top = top + "px";
    fsToolbar.style.maxHeight = Math.max(120, room.height - top - 12) + "px";
  }
  let dragBox = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const box = fsToolbar.getBoundingClientRect();
    const room = fsToolbar.offsetParent.getBoundingClientRect();
    dragBox = { x: event.clientX, y: event.clientY, right: room.right - box.right, top: box.top - room.top };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (dragBox) placeToolbox({ right: dragBox.right - (event.clientX - dragBox.x), top: dragBox.top + (event.clientY - dragBox.y) });
  });
  const dropToolbox = () => {
    if (!dragBox) return;
    dragBox = null;
    const room = fsToolbar.offsetParent.getBoundingClientRect();
    const box = fsToolbar.getBoundingClientRect();
    try { localStorage.setItem(TOOLBOX_KEY, JSON.stringify({ right: Math.round(room.right - box.right), top: Math.round(box.top - room.top) })); } catch { /* storage unavailable */ }
  };
  handle.addEventListener("pointerup", dropToolbox);
  handle.addEventListener("pointercancel", dropToolbox);
  handle.addEventListener("dblclick", () => { try { localStorage.removeItem(TOOLBOX_KEY); } catch { /* storage unavailable */ } placeToolbox(null); });
  const movable = [
    document.querySelector(".tool-editor-toolbar .segmented"), document.querySelector(".tool-editor-toolbar .zoom-controls"),
    document.querySelector(".tool-editor-toolbar .tool-opacity-row"), paintTools, document.querySelector(".tool-nav"), byId("tools-save-all")
  ].map((node) => { const marker = document.createComment("home"); node.before(marker); return { node, marker }; });
  const toolsFullscreen = createFullscreen({
    panel: document.querySelector(".tool-editor-panel"), button: byId("tools-fullscreen"),
    onChange: (on) => {
      isFullscreen = on;
      if (on) for (const { node } of movable) fsToolbar.append(node);
      else for (const { node, marker } of movable) marker.after(node);
      fsToolbar.hidden = !on;
      if (!on) fsToolbar.classList.remove("collapsed");
      if (on) placeToolbox(savedToolbox());
      initialZoom();
      updateBrushCursor();
    }
  });
  window.addEventListener("resize", () => { if (isFullscreen && zoom === "fit") setZoom("fit"); else padCanvas(); if (isFullscreen) placeToolbox(savedToolbox()); });
  const BRUSH_IDS = { add: "tools-brush-add", remove: "tools-brush-remove", box: "tools-brush-box", lasso: "tools-brush-lasso" };
  function setBrush(value) {
    brush = value;
    for (const [name, id] of Object.entries(BRUSH_IDS)) {
      byId(id).classList.toggle("selected", name === value);
      byId(id).setAttribute("aria-pressed", String(name === value));
    }
    updateBrushCursor();
  }
  for (const [name, id] of Object.entries(BRUSH_IDS)) byId(id).addEventListener("click", () => setBrush(name));
  for (const [id, title] of [["tools-brush-add", "Paint (B) — hold Alt to erase"], ["tools-brush-remove", "Erase (E) — hold Alt to paint"], ["tools-brush-box", "Box — hold Alt to erase (M)"], ["tools-brush-lasso", "Lasso — hold Alt to erase (L)"]]) byId(id).title = title;
  byId("tools-brush-random").addEventListener("input", () => { byId("tools-random-value").value = byId("tools-brush-random").value + " %"; });
  byId("tools-brush-size").addEventListener("input", () => { byId("tools-brush-value").value = byId("tools-brush-size").value + " px"; });
  byId("tools-brush-opacity").addEventListener("input", () => { byId("tools-opacity-value").value = byId("tools-brush-opacity").value + " %"; });
  const baseLayer = document.createElement("canvas");
  const strokeLayer = document.createElement("canvas");
  const pointFor = (event) => {
    const point = imagePoint(canvas.getBoundingClientRect(), canvas.width, canvas.height, event.clientX, event.clientY);
    const size = Number(byId("tools-brush-size").value);
    if (brush === "box" || brush === "lasso" || size >= 3) return point;
    return { x: Math.floor(point.x) + 0.5, y: Math.floor(point.y) + 0.5 };
  };
  // Brush cursor: a ring sized to the real brush diameter on screen, filled at the brush opacity.
  const cursorRing = document.createElement("div");
  cursorRing.className = "brush-cursor";
  cursorRing.hidden = true;
  const cursorLabel = document.createElement("span");
  cursorRing.append(cursorLabel);
  document.body.append(cursorRing);
  let cursorAt = null;
  function updateBrushCursor() {
    const show = cursorAt && mode === "mask" && original && !canvas.hidden && brush !== "box" && brush !== "lasso" && !spaceDown;
    canvas.classList.toggle("brush-cursor-on", Boolean(show));
    cursorRing.hidden = !show;
    if (!show) return;
    const rect = canvas.getBoundingClientRect();
    const diameter = Math.max(4, Number(byId("tools-brush-size").value) * rect.width / Math.max(1, canvas.width));
    const opacity = Math.round(brushOpacity() * 100);
    cursorRing.style.width = cursorRing.style.height = diameter + "px";
    cursorRing.style.transform = "translate(" + (cursorAt.x - diameter / 2) + "px," + (cursorAt.y - diameter / 2) + "px)";
    cursorRing.style.setProperty("--brush-alpha", String(brushOpacity() * 0.55));
    cursorRing.classList.toggle("erase", (brush === "remove") !== altDown);
    cursorRing.style.setProperty("--brush-rgb", hexToRgb(getMaskColor()).join(" "));
    cursorLabel.textContent = byId("tools-brush-size").value + " px · " + opacity + "%";
  }
  function setRangeValue(id, value) {
    const input = byId(id);
    const step = Number(input.step) > 0 ? Number(input.step) : 1;
    const next = Number(Math.max(Number(input.min), Math.min(Number(input.max), Math.round(value / step) * step)).toFixed(2));
    if (String(next) !== input.value) { input.value = String(next); input.dispatchEvent(new Event("input", { bubbles: true })); }
  }
  canvas.addEventListener("pointermove", (event) => {
    if (adjust) { updateBrushCursor(); return; } // the ring stays where the right-drag started
    cursorAt = { x: event.clientX, y: event.clientY };
    updateBrushCursor();
  });
  canvas.addEventListener("contextmenu", (event) => { if (mode === "mask") event.preventDefault(); });
  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 2 || mode !== "mask" || !original || busy()) return;
    // Right-drag: left / right = brush size. With Alt held, up / down also changes the brush opacity.
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    adjust = { x: event.clientX, y: event.clientY, withOpacity: event.altKey, size: Number(byId("tools-brush-size").value), opacity: Number(byId("tools-brush-opacity").value) };
  });
  canvas.addEventListener("pointerenter", (event) => { cursorAt = { x: event.clientX, y: event.clientY }; updateBrushCursor(); });
  canvas.addEventListener("pointerleave", () => { if (!stroke) { cursorAt = null; updateBrushCursor(); } });
  canvas.addEventListener("pointerup", (event) => {
    const rect = canvas.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) { cursorAt = null; updateBrushCursor(); }
  });
  for (const id of ["tools-brush-size", "tools-brush-opacity"]) byId(id).addEventListener("input", updateBrushCursor);
  scroller.addEventListener("scroll", updateBrushCursor);
  window.addEventListener("resize", updateBrushCursor);
  const brushOpacity = () => Math.max(0.05, Math.min(1, Number(byId("tools-brush-opacity").value) / 100 || 1));
  const brushRandomness = () => Math.max(0, Math.min(1, Number(byId("tools-brush-random").value) / 100 || 0));
  function drawStroke(point) {
    const size = Number(byId("tools-brush-size").value);
    const layered = stroke.layered;
    // Layered: the whole stroke is drawn opaque on its own layer, then blended once at the
    // chosen opacity, so overlapping dabs inside one stroke never darken each other.
    const target = layered ? strokeLayer.getContext("2d") : maskCanvas.getContext("2d");
    target.globalCompositeOperation = !layered && stroke.erase ? "destination-out" : "source-over";
    target.strokeStyle = "#fff";
    target.fillStyle = "#fff";
    target.lineWidth = size;
    target.lineCap = "round";
    if (stroke.shape === "box") {
      target.clearRect(0, 0, strokeLayer.width, strokeLayer.height);
      target.fillRect(Math.min(stroke.start.x, point.x), Math.min(stroke.start.y, point.y), Math.max(1, Math.abs(point.x - stroke.start.x)), Math.max(1, Math.abs(point.y - stroke.start.y)));
    } else if (stroke.shape === "lasso") {
      stroke.points.push(point);
      target.clearRect(0, 0, strokeLayer.width, strokeLayer.height);
      target.beginPath();
      stroke.points.forEach((spot, position) => { if (position) target.lineTo(spot.x, spot.y); else target.moveTo(spot.x, spot.y); });
      target.closePath();
      target.fill();
    } else if (brushRandomness() > 0) {
      // Randomness (opacity jitter): round stamps along the path, each with its own random strength,
      // so even a single click can be weak.
      const spacing = Math.max(1, size * 0.25);
      const dab = (x, y) => {
        target.globalAlpha = 1 - brushRandomness() * Math.random();
        target.beginPath();
        target.arc(x, y, size / 2, 0, 2 * Math.PI);
        target.fill();
      };
      if (!stroke.stamped) { dab(point.x, point.y); stroke.stamped = true; stroke.carry = 0; }
      else {
        const dx = point.x - stroke.last.x;
        const dy = point.y - stroke.last.y;
        const length = Math.hypot(dx, dy);
        let travelled = spacing - stroke.carry;
        while (travelled <= length) { const t = travelled / length; dab(stroke.last.x + dx * t, stroke.last.y + dy * t); travelled += spacing; }
        stroke.carry = length - (travelled - spacing);
      }
      target.globalAlpha = 1;
    } else {
      target.beginPath();
      target.moveTo(stroke.last.x, stroke.last.y);
      target.lineTo(point.x, point.y);
      target.stroke();
      target.beginPath();
      target.arc(point.x, point.y, size / 2, 0, 2 * Math.PI);
      target.fill();
    }
    target.globalCompositeOperation = "source-over";
    if (layered) {
      const context = maskCanvas.getContext("2d");
      context.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      context.drawImage(baseLayer, 0, 0);
      context.globalAlpha = brushOpacity() * stroke.jitter;
      context.globalCompositeOperation = stroke.erase ? "destination-out" : "source-over";
      context.drawImage(strokeLayer, 0, 0);
      context.globalAlpha = 1;
      context.globalCompositeOperation = "source-over";
    }
    stroke.last = point;
    render();
  }
  canvas.addEventListener("pointerdown", (event) => {
    if (!original || busy() || event.button !== 0) return;
    if (mode !== "mask" && !spaceDown) return;
    event.preventDefault();
    if (spaceDown) {
      // Space + drag pans the image instead of painting.
      pan = { x: event.clientX, y: event.clientY, left: scroller.scrollLeft, top: scroller.scrollTop };
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("panning");
      return;
    }
    if (view === "original" || peek) { peek = false; setView(view === "original" ? "overlay" : view); }
    canvas.setPointerCapture(event.pointerId);
    const shape = brush === "box" || brush === "lasso" ? brush : "brush";
    const erase = shape === "brush" ? (brush === "remove") !== event.altKey : event.altKey;
    stroke = { start: pointFor(event), last: pointFor(event), shape, erase, points: [pointFor(event)], label: erase ? 0 : 1, layered: shape !== "brush" || brushOpacity() < 1 || brushRandomness() > 0,
      jitter: shape === "brush" ? 1 : 1 - brushRandomness() * Math.random(), stamped: false, carry: 0 };
    if (stroke.layered) {
      for (const layer of [baseLayer, strokeLayer]) { layer.width = canvas.width; layer.height = canvas.height; }
      baseLayer.getContext("2d").drawImage(maskCanvas, 0, 0);
    }
    drawStroke(stroke.start);
  });
  canvas.addEventListener("pointermove", (event) => {
    if (adjust) {
      setRangeValue("tools-brush-size", adjust.size * Math.exp((event.clientX - adjust.x) / 120));
      if (adjust.withOpacity) setRangeValue("tools-brush-opacity", adjust.opacity - (event.clientY - adjust.y) * 0.5); // up = denser, down = lighter
    } else if (pan) {
      scroller.scrollLeft = pan.left - (event.clientX - pan.x);
      scroller.scrollTop = pan.top - (event.clientY - pan.y);
    } else if (stroke) drawStroke(pointFor(event));
  });
  const finishStroke = () => {
    if (adjust) { adjust = null; return; }
    if (pan) { pan = null; canvas.classList.remove("panning"); return; }
    if (!stroke) return;
    let center = stroke.start;
    if (stroke.shape === "box") center = { x: (stroke.start.x + stroke.last.x) / 2, y: (stroke.start.y + stroke.last.y) / 2 };
    else if (stroke.shape === "lasso") {
      const xs = stroke.points.map((spot) => spot.x);
      const ys = stroke.points.map((spot) => spot.y);
      center = { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    }
    guidance.push({ ...center, label: stroke.label });
    guidance = guidance.slice(-64);
    stroke = null;
    history.commit(bitmap(), guidance);
    maskDirty = true;
    updateControls();
    render();
    scheduleDraft();
  };
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  for (const [id, action] of [["tools-undo", "undo"], ["tools-redo", "redo"]]) {
    byId(id).addEventListener("click", () => {
      if (busy()) return;
      const mask = history[action]();
      if (mask) { putBitmap(mask); maskDirty = true; guidance = structuredClone(history.extra); render(); updateControls(); scheduleDraft(); }
    });
  }
  byId("tools-clear-guidance").addEventListener("click", () => { guidance = []; render(); });
  byId("tools-show-guides").addEventListener("change", render);
  byId("tools-caption-text").addEventListener("input", () => { captionDirty = true; updateControls(); scheduleDraft(400); });
  // --- instruction templates (copied into the prompt box; custom ones are user-editable) ---
  const TEMPLATE_KEY = "costume-caption-templates";
  const templateSelect = byId("tools-caption-template");
  let customTemplates = [];
  try { customTemplates = readTemplateStore(localStorage.getItem(TEMPLATE_KEY)); } catch { /* storage unavailable */ }
  const templateOption = (value, label) => { const option = document.createElement("option"); option.value = value; option.textContent = label; return option; };
  function selectedTemplate() {
    const value = templateSelect.value;
    if (value.startsWith("builtin:")) return BUILTIN_TEMPLATES.find((template) => "builtin:" + template.id === value) ?? NO_TEMPLATE;
    if (value.startsWith("custom:")) return customTemplates.find((template) => "custom:" + template.name === value) ?? NO_TEMPLATE;
    return NO_TEMPLATE;
  }
  function renderTemplates(selectedValue) {
    byId("tools-builtin-templates").replaceChildren(...BUILTIN_TEMPLATES.map((template) => templateOption("builtin:" + template.id, template.name)));
    byId("tools-custom-templates").replaceChildren(...customTemplates.map((template) => templateOption("custom:" + template.name, template.name)));
    byId("tools-custom-templates").hidden = customTemplates.length === 0;
    const wanted = selectedValue ?? templateSelect.value;
    templateSelect.value = [...templateSelect.options].some((option) => option.value === wanted) ? wanted : "none";
    byId("tools-template-delete").disabled = !templateSelect.value.startsWith("custom:");
  }
  renderTemplates("none");
  templateSelect.addEventListener("change", () => {
    const template = selectedTemplate();
    byId("tools-caption-prompt").value = template.prompt;
    byId("tools-template-name").value = templateSelect.value.startsWith("custom:") ? template.name : "";
    byId("tools-template-delete").disabled = !templateSelect.value.startsWith("custom:");
    byId("tools-template-status").textContent = template === NO_TEMPLATE ? "Instruction cleared." : "Copied “" + template.name + "” into the instruction box. You can edit it freely.";
  });
  byId("tools-template-save").addEventListener("click", () => {
    try {
      const current = templateSelect.value.startsWith("custom:") ? selectedTemplate().name : "";
      const name = normalizeTemplateName(byId("tools-template-name").value || current);
      const overwrite = customTemplates.some((template) => template.name === name);
      customTemplates = upsertTemplate(customTemplates, name, byId("tools-caption-prompt").value, selectedTemplate().excludeClothing);
      localStorage.setItem(TEMPLATE_KEY, serializeTemplateStore(customTemplates));
      renderTemplates("custom:" + name);
      byId("tools-template-name").value = name;
      byId("tools-template-status").textContent = "Template “" + name + "” " + (overwrite ? "overwritten" : "saved") + ".";
      notice("");
    } catch (error) { notice(error); }
  });
  byId("tools-template-delete").addEventListener("click", () => {
    try {
      const template = templateSelect.value.startsWith("custom:") ? selectedTemplate() : null;
      if (!template) return;
      customTemplates = removeTemplate(customTemplates, template.name);
      localStorage.setItem(TEMPLATE_KEY, serializeTemplateStore(customTemplates));
      renderTemplates("none");
      byId("tools-template-name").value = "";
      byId("tools-template-status").textContent = "Deleted “" + template.name + "” (the instruction box is unchanged).";
      notice("");
    } catch (error) { notice(error); }
  });

  async function generateCaption(scope) {
    if (!current() || busy()) return;
    if (scope === "one" && captionDirty && !await confirmDiscard()) return;
    const instruction = byId("tools-caption-prompt").value.trim();
    if (byId("tools-caption-model").value === "qwen2-vl" && !instruction) {
      throw new Error("The instruction is empty. Pick a template or type an instruction.");
    }
    const payload = {
      input_dir: loadedRoot, output_dir: captionDir(),
      trigger_word: required(getProject().trigger_word, "Trigger word"),
      caption_model: byId("tools-caption-model").value, precision: byId("tools-caption-precision").value,
      caption_prompt: instruction,
      exclude_clothing: selectedTemplate().excludeClothing, device: byId("mask-device").value
    };
    const overwrite = byId("tools-caption-overwrite").checked;
    let targets = [];
    if (scope === "one") payload.image_path = current().image;
    else {
      targets = scope === "selected" ? [...checked].sort((a, b) => a - b).map((index) => entries[index]).filter(Boolean) : entries.slice();
      // Unsaved (draft) captions are protected unless overwrite is on.
      if (!overwrite) targets = targets.filter((entry) => !entry.draft?.caption);
      if (!targets.length) throw new Error("No images to generate. Images with unsaved captions become targets when “Overwrite existing captions” is checked.");
      payload.image_paths = targets.map((entry) => entry.image);
      payload.overwrite = overwrite;
      if (overwrite && !await confirmOverwrite(targets.length)) return;
    }
    pending = { kind: "caption", batch: scope !== "one", overwrite, targets: new Set(targets.map((entry) => entry.relative)) };
    try { await run("caption", payload); } catch (error) { pending = null; throw error; }
  }
  // --- bulk tag insertion: right after the trigger word, applied as drafts ---
  async function captionFor(entry) {
    if (entry === current()) return byId("tools-caption-text").value;
    const draft = await drafts.get(loadedRoot, entry.relative);
    if (draft && typeof draft.caption === "string") return draft.caption;
    return invoke("load_tool_caption", { root: loadedRoot, image: entry.image, captionDir: captionDir() });
  }
  async function insertTagsInto(targets, label) {
    if (busy() || !targets.length) return;
    const tagsText = byId("tools-extra-tags").value;
    if (!splitTags(tagsText).length) throw new Error("Enter the tags to add");
    const trigger = String(getProject().trigger_word ?? "").trim();
    await flushDraft();
    saving = true;
    updateControls();
    let changed = 0;
    const failed = [];
    try {
      for (const entry of targets) {
        try {
          const before = await captionFor(entry);
          const after = insertTags(before, trigger, tagsText);
          if (after === splitTags(before).join(", ")) continue;
          if (entry === current()) { byId("tools-caption-text").value = after; captionDirty = true; }
          else {
            const existing = await drafts.get(loadedRoot, entry.relative);
            await drafts.put({ root: loadedRoot, relative: entry.relative, mask: existing?.mask ?? null, caption: after, guidance: existing?.guidance ?? [] });
            entry.draft = { mask: Boolean(existing?.mask), caption: true };
          }
          const info = checkInfo.get(entry.relative);
          if (info) info.caption = after;
          changed++;
        } catch { failed.push(entry.relative); }
      }
    } finally { saving = false; }
    await flushDraft();
    updateControls();
    if (checkInfo.size) recomputeCheck();
    scheduleAutosave();
    byId("tools-tags-status").textContent = label + ": inserted into " + changed + ", unchanged " + (targets.length - changed - failed.length) + (failed.length ? ", failed " + failed.length : "") + ". Write them out with “Save all changes”.";
    if (failed.length) throw new Error("Could not insert into: " + failed.join(" / "));
  }
  byId("tools-tags-selected").addEventListener("click", () => insertTagsInto([...checked].sort((a, b) => a - b).map((index) => entries[index]).filter(Boolean), "Selected images").catch(notice));
  byId("tools-tags-all").addEventListener("click", () => insertTagsInto(entries.slice(), "All images").catch(notice));
  byId("tools-caption-one").addEventListener("click", () => generateCaption("one").catch(notice));
  byId("tools-caption-selected").addEventListener("click", () => generateCaption("selected").catch(notice));
  byId("tools-caption-all").addEventListener("click", () => generateCaption("all").catch(notice));
  // --- Auto-mask prompt presets (shared with Mask Creation via localStorage) ---
  {
    const select = byId("tools-mask-preset-select");
    const builtinGroup = byId("tools-mask-builtin-presets");
    const customGroup = byId("tools-mask-custom-presets");
    const nameInput = byId("tools-mask-preset-name");
    const saveBtn = byId("tools-mask-preset-save");
    const deleteBtn = byId("tools-mask-preset-delete");
    const statusEl = byId("tools-mask-preset-status");
    const maskPromptEl = byId("tools-mask-prompt");
    const excludePromptEl = byId("tools-exclude-prompt");
    const loadCustom = () => { try { return readMaskPresetStore(localStorage.getItem(MASK_PRESET_KEY)); } catch { return []; } };
    const makeOpt = (value, label) => { const o = document.createElement("option"); o.value = value; o.textContent = label; return o; };
    function renderToolsMaskPresets(preferred) {
      const custom = loadCustom();
      builtinGroup.replaceChildren(...BUILTIN_MASK_PRESETS.map((p) => makeOpt("builtin:" + p.id, p.name)));
      customGroup.replaceChildren(...custom.map((p) => makeOpt("custom:" + p.name, p.name)));
      customGroup.hidden = custom.length === 0;
      const wanted = preferred ?? select.value;
      const fallback = "builtin:" + DEFAULT_MASK_PRESET.id;
      select.value = [...select.options].some((o) => o.value === wanted) ? wanted : fallback;
      deleteBtn.disabled = !select.value.startsWith("custom:");
    }
    renderToolsMaskPresets("builtin:" + DEFAULT_MASK_PRESET.id);
    window.addEventListener("costume-mask-presets-changed", () => renderToolsMaskPresets());
    select.addEventListener("change", () => {
      const chosen = findMaskPreset(select.value, loadCustom());
      if (!chosen) return;
      maskPromptEl.value = chosen.mask_prompt;
      excludePromptEl.value = chosen.exclude_prompt;
      nameInput.value = select.value.startsWith("custom:") ? chosen.name : "";
      deleteBtn.disabled = !select.value.startsWith("custom:");
      statusEl.textContent = "Applied “" + chosen.name + "”.";
    });
    saveBtn.addEventListener("click", () => {
      try {
        const custom = loadCustom();
        const currentName = select.value.startsWith("custom:") ? (findMaskPreset(select.value, custom)?.name ?? "") : "";
        const name = normalizeMaskPresetName(nameInput.value || currentName);
        const overwrite = custom.some((p) => p.name === name);
        const next = upsertMaskPreset(custom, name, maskPromptEl.value, excludePromptEl.value);
        localStorage.setItem(MASK_PRESET_KEY, serializeMaskPresetStore(next));
        renderToolsMaskPresets("custom:" + name);
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
        renderToolsMaskPresets("builtin:" + DEFAULT_MASK_PRESET.id);
        nameInput.value = "";
        statusEl.textContent = "Deleted “" + chosen.name + "”.";
        window.dispatchEvent(new CustomEvent("costume-mask-presets-changed"));
        notice("");
      } catch (error) { notice(error); }
    });
  }

  byId("tools-auto-mask").addEventListener("click", async () => {
    try {
      if (!current() || busy()) return;
      let hasPaintedArea = false;
      if (maskCanvas.width > 0 && maskCanvas.height > 0) {
        const pixels = maskCanvas.getContext("2d").getImageData(0, 0, maskCanvas.width, maskCanvas.height).data;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] >= 128) { hasPaintedArea = true; break; }
        }
      }
      pending = { kind: "mask_image" };
      await run("mask_image", {
        input_dir: loadedRoot, image_path: current().image,
        output_dir: required(getProject().mask_dir, "Mask output"),
        mask_prompt: required(byId("tools-mask-prompt").value, "What to train on"),
        exclude_prompt: byId("tools-exclude-prompt").value.trim(),
        points: guidance,
        ...(hasPaintedArea ? { guide_mask: maskCanvas.toDataURL("image/png") } : {}),
        device: byId("mask-device").value
      });
    } catch (error) { pending = null; notice(error); }
  });

  async function save(kind) {
    if (!current() || busy()) return;
    const output = kind === "mask" ? required(getProject().mask_dir, "Mask output") : captionDir();
    let content = kind === "mask" ? maskCanvas.toDataURL("image/png") : required(byId("tools-caption-text").value, "Caption");
    if (kind === "caption" && byId("tools-dedupe-save").checked) {
      const cleaned = dedupeTags(content) || content;
      if (cleaned !== content.trim()) byId("tools-caption-text").value = cleaned;
      content = cleaned;
    }
    saving = true;
    updateControls();
    try {
      const path = await invoke(kind === "mask" ? "save_tool_mask" : "save_tool_caption", {
        request: { root: loadedRoot, image: current().image, output_dir: output, content }
      });
      if (kind === "mask") { current().mask = path; current().maskRev = (current().maskRev ?? 0) + 1; maskDirty = false; renderFiles(); }
      else captionDirty = false;
      await flushDraft();
      byId("tools-dirty").textContent = "Saved: " + path;
      notice("");
    } finally { saving = false; updateControls(); }
  }
  const dedupeOnSave = (text) => (byId("tools-dedupe-save").checked ? dedupeTags(text) || text : text);
  async function saveAll(options = {}) {
    const auto = options.auto === true;
    if (busy() || !entries.length) return "idle";
    await flushDraft();
    const revision = editRev;
    const pendingDrafts = await drafts.listByRoot(loadedRoot);
    if (!pendingDrafts.length) { updateControls(); return "idle"; }
    if (auto && pendingDrafts.some((draft) => draft.mask) && !String(getProject().mask_dir ?? "").trim()) {
      byId("tools-autosave-status").textContent = "Auto-save paused: set the Mask output folder";
      return "paused";
    }
    const maskDir = pendingDrafts.some((draft) => draft.mask) ? required(getProject().mask_dir, "Mask output") : "";
    const captionOutput = captionDir();
    saving = true;
    updateControls();
    const failures = [];
    let saved = 0;
    try {
      for (const draft of pendingDrafts) {
        const entry = entries.find((item) => item.relative === draft.relative);
        if (!entry) continue;
        const rest = { ...draft };
        try {
          if (draft.mask) {
            entry.mask = await invoke("save_tool_mask", { request: { root: loadedRoot, image: entry.image, output_dir: maskDir, content: draft.mask } });
            entry.maskRev = (entry.maskRev ?? 0) + 1;
            rest.mask = null;
            if (entry === current() && editRev === revision) maskDirty = false;
          }
          // Auto-save never writes an empty caption (the draft stays until you type something).
          if (typeof draft.caption === "string" && !(auto && !draft.caption.trim())) {
            await invoke("save_tool_caption", { request: { root: loadedRoot, image: entry.image, output_dir: captionOutput, content: dedupeOnSave(required(draft.caption, "Caption")) } });
            rest.caption = null;
            if (entry === current() && editRev === revision) captionDirty = false;
          }
          saved++;
        } catch (error) { failures.push(entry.relative + ": " + (error?.message ?? error)); }
        if (rest.mask === null && rest.caption === null) await drafts.remove(loadedRoot, entry.relative);
        else await drafts.put(rest);
        entry.draft = rest.mask || typeof rest.caption === "string" ? { mask: Boolean(rest.mask), caption: typeof rest.caption === "string" } : null;
      }
    } finally { saving = false; renderFiles(); }
    if (editRev !== revision) scheduleDraft(0); // you kept editing while it saved: keep those edits as a draft
    if (auto) {
      byId("tools-autosave-status").textContent = failures.length
        ? "Auto-save failed for " + failures.length + " " + (failures.length === 1 ? "image" : "images")
        : "Auto-saved " + saved + (saved === 1 ? " image" : " images") + " at " + new Date().toLocaleTimeString();
      if (failures.length) notice(new Error("Could not auto-save: " + failures.join(" / ")));
    } else {
      byId("tools-dirty").textContent = "Saved changes for " + saved + (saved === 1 ? " image" : " images") + (failures.length ? " (" + failures.length + " failed)" : "");
      notice(failures.length ? new Error("Could not save: " + failures.join(" / ")) : "");
    }
    return failures.length ? "failed" : "saved";
  }

  // ---- auto-save: edits reach the files a few seconds after you stop ----
  const autosaveDelay = () => Math.max(200, Number(window.__autosaveDelay) || 8000);
  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (!byId("tools-autosave").checked) return;
    autosaveTimer = setTimeout(() => runAutosave().catch(notice), autosaveDelay());
  }
  async function runAutosave() {
    autosaveTimer = 0;
    if (!byId("tools-autosave").checked || !entries.length) return;
    // Never in the middle of a stroke or while a job / another save is running: try again shortly.
    if (stroke || pan || adjust || busy()) { autosaveTimer = setTimeout(() => runAutosave().catch(notice), autosaveDelay()); return; }
    const result = await saveAll({ auto: true });
    if (result === "paused") autosaveTimer = setTimeout(() => runAutosave().catch(notice), autosaveDelay());
  }
  byId("tools-autosave").addEventListener("change", () => {
    byId("tools-autosave-status").textContent = byId("tools-autosave").checked ? "" : "Auto-save is off";
    if (byId("tools-autosave").checked) scheduleAutosave(); else clearTimeout(autosaveTimer);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && byId("tools-autosave").checked && entries.length) { clearTimeout(autosaveTimer); runAutosave().catch(notice); }
  });
  byId("tools-save-all").addEventListener("click", () => saveAll().catch(notice));
  byId("tools-save-mask").addEventListener("click", () => save("mask").catch(notice));
  byId("tools-save-caption").addEventListener("click", () => save("caption").catch(notice));
  window.addEventListener("studio-busy", updateControls);
  // ---- mask operations ----
  function runMaskOp(compute) {
    if (!original || busy()) return;
    putBitmap(compute(bitmap(), canvas.width, canvas.height));
    history.commit(bitmap(), guidance);
    maskDirty = true;
    updateControls();
    render();
    scheduleDraft();
  }
  const opRadius = () => Math.max(1, Math.min(50, Math.round(Number(byId("tools-op-radius").value)) || 3));
  const opMinArea = () => Math.max(1, Math.min(100000, Math.round(Number(byId("tools-op-minarea").value)) || 64));
  byId("tools-op-invert").addEventListener("click", () => runMaskOp((mask) => invertMask(mask)));
  byId("tools-op-fill").addEventListener("click", () => runMaskOp((mask, width, height) => fillHoles(mask, width, height)));
  byId("tools-op-clear").addEventListener("click", () => runMaskOp((mask) => new Uint8Array(mask.length)));
  byId("tools-op-grow").addEventListener("click", () => runMaskOp((mask, width, height) => growMask(mask, width, height, opRadius())));
  byId("tools-op-shrink").addEventListener("click", () => runMaskOp((mask, width, height) => shrinkMask(mask, width, height, opRadius())));
  byId("tools-op-specks").addEventListener("click", () => runMaskOp((mask, width, height) => removeSpecks(mask, width, height, opMinArea())));

  // Both buttons add one history step, so Undo always brings the previous mask back.
  async function restoreMask(kind) {
    const entry = current();
    if (!entry || busy()) return;
    loading = true;
    updateControls();
    try {
      guidance = [];
      if (kind === "original") {
        const stored = await drafts.get(originalKey(), entry.relative);
        if (!stored?.mask) throw new Error("No original auto mask is stored for this image yet");
        await maskFromURL(stored.mask, true);
        maskDirty = true;
      } else if (entry.mask) {
        await maskFromURL(await invoke("preview_image", { path: entry.mask }), true);
        maskDirty = false;
      } else {
        const empty = new Uint8Array(canvas.width * canvas.height);
        putBitmap(empty);
        history.commit(empty, guidance);
        maskDirty = false;
        render();
      }
    } finally { loading = false; updateControls(); }
    await flushDraft();
  }
  byId("tools-op-reset").addEventListener("click", () => restoreMask("saved").catch(notice));
  byId("tools-op-original").addEventListener("click", () => restoreMask("original").catch(notice));

  byId("tools-train-toggle").addEventListener("click", toggleTraining);
  byId("tools-train-all").addEventListener("click", () => setTrainingSelection(new Set(entries.map((entry) => entry.relative))));
  byId("tools-train-none").addEventListener("click", () => setTrainingSelection(new Set()));
  byId("tools-train-invert").addEventListener("click", () => setTrainingSelection(new Set(entries.filter((entry) => excludedTraining.has(entry.relative)).map((entry) => entry.relative))));
  byId("tools-train-highlighted").addEventListener("click", () => setTrainingSelection(new Set([...checked].map((index) => entries[index]?.relative).filter(Boolean))));
  byId("tools-prev").addEventListener("click", () => step(-1));
  byId("tools-next").addEventListener("click", () => step(1));
  byId("tools-next-unreviewed").addEventListener("click", goNextUnreviewed);
  byId("tools-reviewed").addEventListener("click", toggleReviewed);

  // ---- dataset check -----------------------------------------------------------------------------
  // Results are cached (also across restarts). Pressing "Check dataset" again only re-analyses images whose
  // image / mask changed; captions and the trigger word are re-read and re-judged instantly.
  const CHECK_VERSION = 1; // bump when the analysis itself changes
  const checkCacheRoot = () => loadedRoot + "::check-cache";
  const triggerWord = () => String(getProject().trigger_word ?? "").trim();
  let checkCancelled = false;
  let tagQuery = "";

  function hashText(text) {
    let hash = 5381;
    for (let index = 0; index < text.length; index++) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
    return (hash >>> 0).toString(36) + ":" + text.length;
  }
  async function maskFractionFrom(url) {
    const image = await loadImage(url);
    const scale = Math.min(1, 256 / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const surface = document.createElement("canvas");
    surface.width = width;
    surface.height = height;
    const context = surface.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let white = 0;
    for (let index = 0; index < width * height; index++) if (pixels[index * 4] >= 128 && pixels[index * 4 + 3] >= 128) white++;
    return white / (width * height);
  }
  async function analyseImage(entry, draft) {
    let width = Number.POSITIVE_INFINITY;
    let height = Number.POSITIVE_INFINITY;
    let blur = null;
    let fraction = null;
    try {
      const image = await loadImage(await invoke("preview_image", { path: entry.image }));
      width = image.naturalWidth;
      height = image.naturalHeight;
      const scale = Math.min(1, 256 / Math.max(width, height));
      const sampleWidth = Math.max(3, Math.round(width * scale));
      const sampleHeight = Math.max(3, Math.round(height * scale));
      const surface = document.createElement("canvas");
      surface.width = sampleWidth;
      surface.height = sampleHeight;
      const context = surface.getContext("2d", { willReadFrequently: true });
      context.drawImage(image, 0, 0, sampleWidth, sampleHeight);
      blur = laplacianVariance(toGray(context.getImageData(0, 0, sampleWidth, sampleHeight).data, sampleWidth, sampleHeight), sampleWidth, sampleHeight);
    } catch { /* unreadable image: skip resolution / blur checks */ }
    let hasMask = Boolean(entry.mask);
    try {
      if (entry === current()) { hasMask = hasMask || maskDirty; fraction = hasMask ? maskCoverage(bitmap()) : null; }
      else if (draft?.mask) { hasMask = true; fraction = await maskFractionFrom(draft.mask); }
      else if (entry.mask) fraction = await maskFractionFrom(await invoke("preview_image", { path: entry.mask }));
    } catch { /* leave coverage unknown */ }
    return { width, height, blur, coverage: fraction, hasMask };
  }

  async function runDatasetCheck(force = false) {
    if (busy() || !entries.length) return;
    await flushDraft();
    const status = byId("tools-check-status");
    const progress = byId("tools-check-progress");
    const panel = byId("tools-check-panel");
    panel.hidden = false;
    panel.scrollIntoView?.({ block: "nearest" });
    checkCancelled = false;
    progress.value = 0;
    loading = true;
    updateControls();
    try {
      // 1) cheap: a signature for every image plus its current caption
      const cached = new Map();
      if (!force) for (const item of await drafts.listByRoot(checkCacheRoot())) cached.set(item.relative, item);
      const fresh = new Map();
      const stale = [];
      for (let index = 0; index < entries.length && !checkCancelled; index++) {
        const entry = entries[index];
        status.textContent = "Looking for changes… " + (index + 1) + " / " + entries.length;
        progress.value = index / entries.length;
        let caption = null;
        try { caption = await captionFor(entry); } catch { /* unreadable caption counts as missing */ }
        const draft = await drafts.get(loadedRoot, entry.relative);
        const signature = [CHECK_VERSION, entry.image, entry.mask ?? "", entry.maskRev ?? 0, draft?.mask ? hashText(draft.mask) : ""].join("|");
        const hit = cached.get(entry.relative);
        const info = hit && hit.sig === signature ? hit.info : null;
        fresh.set(entry.relative, { signature, info, caption });
        if (!info) stale.push(entry);
        if (index % 8 === 7) await new Promise((resolve) => setTimeout(resolve));
      }
      // 2) expensive: only the images whose image / mask changed
      for (let position = 0; position < stale.length && !checkCancelled; position++) {
        const entry = stale[position];
        status.textContent = "Analysing " + (position + 1) + " / " + stale.length + " changed images — " + entry.relative;
        progress.value = position / stale.length;
        const draft = entry === current() ? null : await drafts.get(loadedRoot, entry.relative);
        fresh.get(entry.relative).info = await analyseImage(entry, draft);
        if (position % 4 === 3) await new Promise((resolve) => setTimeout(resolve));
      }
      if (checkCancelled) { status.textContent = "Stopped before the end."; return; }
      const now = Date.now();
      checkInfo = new Map();
      for (const [relative, item] of fresh) checkInfo.set(relative, { ...item.info, caption: item.caption });
      for (const entry of stale) {
        const item = fresh.get(entry.relative);
        await drafts.put({ root: checkCacheRoot(), relative: entry.relative, mask: null, caption: null, guidance: [], sig: item.signature, info: item.info, at: now });
      }
      for (const item of cached.values()) if (!fresh.has(item.relative)) await drafts.remove(checkCacheRoot(), item.relative);
      progress.value = 1;
      recomputeCheck();
      const withIssues = [...checkIssues.values()].filter((issues) => issues.length).length;
      const lastAt = Math.max(0, ...[...cached.values()].map((item) => item.at ?? 0));
      const summary = withIssues ? withIssues + " with issues" : "no issues found";
      if (!stale.length && !force) status.textContent = "No changes since " + new Date(lastAt || now).toLocaleTimeString() + " — saved results for " + entries.length + " images, " + summary + ".";
      else status.textContent = "Checked " + entries.length + " images (" + stale.length + " analysed, " + (entries.length - stale.length) + " from cache) — " + summary + ".";
    } finally { loading = false; updateControls(); }
  }

  // Tag table, issue chips and the filter that narrows the image list.
  function filterSet(kind, value) {
    const set = new Set();
    for (const [relative, info] of checkInfo) {
      if (kind === "tag" ? hasTag(info.caption, value) : (checkIssues.get(relative) ?? []).includes(value)) set.add(relative);
    }
    return set;
  }
  function updateFilterBar() {
    byId("tools-filter-bar").hidden = !filter;
    byId("tools-filter-label").textContent = filter ? "Showing " + visibleIndexes().length + " of " + entries.length + " images — " + filter.label : "";
  }
  function setFilter(kind, value, label) {
    if (filter && filter.kind === kind && filter.value === value) { clearFilter(); return; }
    const set = filterSet(kind, value);
    if (!set.size) return;
    filter = { kind, value, label, set };
    const visible = visibleIndexes();
    checked = new Set(visible); // the matches are selected, so bulk actions (tags / captions) apply to them
    anchor = visible[0] ?? -1;
    updateFilterBar();
    renderFiles();
    recomputeCheck();
    if (visible.length && !visible.includes(selected)) {
      selectImage(visible[0]).then(() => { if (filter) { checked = new Set(visibleIndexes()); updateControls(); } }).catch(notice);
    }
  }
  function clearFilter() {
    filter = null;
    checked = new Set(selected >= 0 ? [selected] : []);
    updateFilterBar();
    renderFiles();
    recomputeCheck();
  }
  function recomputeCheck() {
    const summary = byId("tools-check-summary");
    if (!checkInfo.size) { summary.replaceChildren(); byId("tools-check-tags").replaceChildren(); return; }
    const trigger = triggerWord();
    checkIssues = new Map();
    const totals = {};
    for (const [relative, info] of checkInfo) {
      const issues = classify(info, trigger);
      checkIssues.set(relative, issues);
      for (const code of issues) totals[code] = (totals[code] ?? 0) + 1;
    }
    if (filter) {
      filter.set = filterSet(filter.kind, filter.value);
      if (!filter.set.size) { filter = null; checked = new Set(selected >= 0 ? [selected] : []); }
    }
    summary.replaceChildren(...Object.entries(totals).map(([code, count]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "check-chip" + (filter?.kind === "issue" && filter.value === code ? " active" : "");
      chip.textContent = ISSUE_LABELS[code] + ": " + count;
      chip.title = "Show only these images (click again to clear)";
      chip.addEventListener("click", () => setFilter("issue", code, ISSUE_LABELS[code]));
      return chip;
    }));
    const duplicates = totals["duplicate-tags"] ?? 0;
    byId("tools-check-fixdup").dataset.count = String(duplicates);
    byId("tools-check-fixdup").textContent = "Remove duplicate tags (" + duplicates + ")";
    byId("tools-check-undo").title = lastBulk ? "Undo: " + lastBulk.label : "";
    const query = tagQuery.trim().toLowerCase();
    const frequency = tagFrequency([...checkInfo.values()].map((info) => info.caption).filter((caption) => typeof caption === "string"), trigger, 5000)
      .filter((item) => !query || item.tag.toLowerCase().includes(query));
    const biggest = frequency[0]?.count ?? 1;
    byId("tools-check-tags").replaceChildren(...frequency.slice(0, 400).map((item) => {
      const line = document.createElement("div");
      line.className = "check-tag" + (filter?.kind === "tag" && filter.value.toLowerCase() === item.tag.toLowerCase() ? " active" : "");
      line.dataset.tag = item.tag;
      line.style.setProperty("--share", String(item.count / biggest));
      const name = document.createElement("button");
      name.type = "button";
      name.className = "tag-name";
      name.textContent = item.tag;
      name.title = "Show only the images that use this tag (click again to clear)";
      name.addEventListener("click", () => setFilter("tag", item.tag, "tag “" + item.tag + "”"));
      const count = document.createElement("span");
      count.className = "tag-count";
      count.textContent = item.count + (item.count === 1 ? " image" : " images");
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "tag-x";
      remove.textContent = "×";
      remove.title = "Remove “" + item.tag + "” from every caption";
      remove.addEventListener("click", () => removeTagEverywhere(item.tag).catch(notice));
      line.append(name, count, remove);
      return line;
    }));
    updateFilterBar();
    if (filter) renderFiles();
    updateControls();
  }

  // Bulk caption edits become drafts (nothing is written until "Save all changes") and can be undone.
  async function writeCaption(entry, text) {
    if (entry === current()) { byId("tools-caption-text").value = text; captionDirty = true; }
    else {
      const existing = await drafts.get(loadedRoot, entry.relative);
      await drafts.put({ root: loadedRoot, relative: entry.relative, mask: existing?.mask ?? null, caption: text, guidance: existing?.guidance ?? [] });
      entry.draft = { mask: Boolean(existing?.mask), caption: true };
    }
    scheduleAutosave();
  }
  async function bulkEditCaptions(candidates, transform, label) {
    if (busy() || !candidates.length) return 0;
    await flushDraft();
    saving = true;
    updateControls();
    const before = new Map();
    let changed = 0;
    let failed = 0;
    try {
      for (const entry of candidates) {
        try {
          const previous = await captionFor(entry);
          const next = transform(previous);
          if (next === normalizeCaption(previous)) continue;
          before.set(entry.relative, previous);
          await writeCaption(entry, next);
          const info = checkInfo.get(entry.relative);
          if (info) info.caption = next;
          changed++;
        } catch { failed++; }
      }
    } finally { saving = false; }
    await flushDraft();
    if (changed) lastBulk = { label, before };
    recomputeCheck();
    byId("tools-check-status").textContent = label + ": " + changed + (changed === 1 ? " caption" : " captions") + " changed" + (failed ? ", " + failed + " failed" : "") + " — not saved yet (Save all changes), or Undo.";
    return changed;
  }
  async function removeTagEverywhere(tag) {
    const candidates = entries.filter((entry) => hasTag(checkInfo.get(entry.relative)?.caption, tag));
    await bulkEditCaptions(candidates, (caption) => removeTag(caption, tag), "Removed “" + tag + "”");
  }
  async function fixDuplicates() {
    const candidates = entries.filter((entry) => (checkIssues.get(entry.relative) ?? []).includes("duplicate-tags"));
    await bulkEditCaptions(candidates, dedupeTags, "Removed duplicate tags");
  }
  async function undoBulk() {
    if (!lastBulk || busy()) return;
    const { label, before } = lastBulk;
    saving = true;
    updateControls();
    try {
      for (const [relative, text] of before) {
        const entry = entries.find((item) => item.relative === relative);
        if (!entry) continue;
        await writeCaption(entry, text);
        const info = checkInfo.get(relative);
        if (info) info.caption = text;
      }
    } finally { saving = false; }
    lastBulk = null;
    await flushDraft();
    recomputeCheck();
    byId("tools-check-status").textContent = "Undid: " + label;
  }

  byId("tools-check").addEventListener("click", () => runDatasetCheck(false).catch(notice));
  byId("tools-check-force").addEventListener("click", () => runDatasetCheck(true).catch(notice));
  byId("tools-check-fixdup").addEventListener("click", () => fixDuplicates().catch(notice));
  byId("tools-check-undo").addEventListener("click", () => undoBulk().catch(notice));
  byId("tools-check-close").addEventListener("click", () => { checkCancelled = true; if (filter) clearFilter(); byId("tools-check-panel").hidden = true; });
  byId("tools-filter-clear").addEventListener("click", clearFilter);
  byId("tools-check-tagfilter").addEventListener("input", () => { tagQuery = byId("tools-check-tagfilter").value; recomputeCheck(); });

  // Number keys set the brush opacity like Photoshop: 1 = 10% ... 9 = 90%, 0 = 100%; two digits typed quickly = exact (45 -> 45%).
  let digitBuffer = "";
  let digitTimer = 0;
  function setOpacityByDigit(digit) {
    clearTimeout(digitTimer);
    let value;
    if (digitBuffer) { value = Math.min(100, parseInt(digitBuffer + digit, 10)); digitBuffer = ""; }
    else { digitBuffer = digit; value = digit === "0" ? 100 : Number(digit) * 10; digitTimer = setTimeout(() => { digitBuffer = ""; }, 700); }
    setRangeValue("tools-brush-opacity", Math.max(1, value));
  }

  // ---- keyboard shortcuts (the full list is shown by "?") ----
  const TEXT_INPUT_TYPES = new Set(["text", "search", "number", "email", "url", "password", "tel"]);
  // Only fields you type into block shortcuts; a focused checkbox, slider or button does not.
  const isTypingTarget = (target) => target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable
    || (target.tagName === "INPUT" && TEXT_INPUT_TYPES.has(target.type));
  const typing = (event) => isTypingTarget(event.target);
  document.addEventListener("keydown", (event) => {
    if (byId("page-tools").hidden || typing(event) || document.querySelector("dialog[open]")) return;
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (key === "Tab" && toolsFullscreen.active) { event.preventDefault(); fsToolbar.classList.toggle("collapsed"); return; } // Photoshop: Tab hides the panels
    if (key === "Alt") { event.preventDefault(); altDown = true; updateBrushCursor(); return; } // also stops Windows from activating the window menu
    if (ctrl) {
      const lower = key.toLowerCase();
      if (busy()) return;
      if (lower === "z" && mode === "mask") { event.preventDefault(); byId(event.shiftKey ? "tools-redo" : "tools-undo").click(); }
      else if (lower === "y" && mode === "mask") { event.preventDefault(); byId("tools-redo").click(); }
      else if (lower === "s") { event.preventDefault(); saveAll().catch(notice); }
      else if (lower === "i" && mode === "mask") { event.preventDefault(); byId("tools-op-invert").click(); }
      return;
    }
    if (event.altKey) return;
    if (key === " " && original) {
      // Space always means "pan" here, even when a toolbar button still has focus (it would otherwise click it).
      event.preventDefault();
      if (document.activeElement?.tagName === "BUTTON") document.activeElement.blur();
      if (!spaceDown) { spaceDown = true; canvas.classList.add("pan-ready"); updateBrushCursor(); }
      return;
    }
    if (key === "\\" && original) { event.preventDefault(); if (!peek) { peek = true; render(); } return; }
    if (key.toLowerCase() === "q") {
      // Q toggles the mask overlay (Photoshop's quick-mask idea); Shift+Q cycles every view.
      const order = ["original", "overlay", "mask", "split"];
      if (event.shiftKey) setView(order[(order.indexOf(view) + 1) % order.length]);
      else setView(view === "original" ? "overlay" : "original");
    } else if (/^[0-9]$/.test(key) && mode === "mask") setOpacityByDigit(key);
    else if (key.toLowerCase() === "f") { if (!canvas.hidden) toolsFullscreen.set(!toolsFullscreen.active); }
    else if (key === "PageUp" || key === ",") step(-1);
    else if (key === "PageDown" || key === ".") step(1);
    else if (key.toLowerCase() === "n") goNextUnreviewed();
    else if (key.toLowerCase() === "r") toggleReviewed();
    else if (key.toLowerCase() === "t") toggleTraining();
    else if (mode === "mask" && !busy()) {
      const lower = key.toLowerCase();
      const size = byId("tools-brush-size");
      if (lower === "b") setBrush("add");
      else if (lower === "e") setBrush("remove");
      else if (lower === "x") setBrush(brush === "remove" ? "add" : "remove");
      else if (lower === "m") setBrush("box");
      else if (lower === "l") setBrush("lasso");
      else if (key === "[" || key === "]") {
        const current = Number(size.value);
        // tiny brushes move in half-pixel steps, bigger ones proportionally
        const smaller = current <= 4 ? current - 0.5 : Math.floor(current * 0.85);
        const larger = current < 4 ? current + 0.5 : Math.ceil(current * 1.18);
        size.value = String(Math.max(Number(size.min), Math.min(Number(size.max), key === "[" ? smaller : larger)));
        size.dispatchEvent(new Event("input", { bubbles: true }));
      } else return;
    } else return;
    event.preventDefault();
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === " " && spaceDown) { event.preventDefault(); spaceDown = false; canvas.classList.remove("pan-ready"); updateBrushCursor(); }
    else if (event.key === "Alt") { event.preventDefault(); altDown = false; updateBrushCursor(); }
    else if (event.key === "\\" && peek) { peek = false; render(); }
  });
  window.addEventListener("blur", () => {
    const wasPeek = peek;
    spaceDown = false;
    altDown = false;
    peek = false;
    canvas.classList.remove("pan-ready");
    if (wasPeek) render();
  });
  updateControls();
  return {
    // Project switching: save drafts, clear the folder state, and optionally reopen the project's folder.
    prepareForProjectChange() { return flushDraft(); },
    resetForProject() {
      clearTimeout(draftTimer);
      draftTimer = 0;
      entries = [];
      selected = -1;
      loadedRoot = "";
      original = null;
      originalURL = "";
      maskDirty = false;
      captionDirty = false;
      checked = new Set();
      anchor = -1;
      reviewed = new Set();
      excludedTraining.clear();
      guidance = [];
      filter = null;
      checkInfo = new Map();
      checkIssues = new Map();
      lastBulk = null;
      byId("tools-filter-bar").hidden = true;
      byId("tools-check-panel").hidden = true;
      thumbCache.clear();
      thumbQueue.length = 0;
      thumbGeneration++;
      canvas.hidden = true;
      byId("tools-empty").hidden = false;
      byId("tools-caption-text").value = "";
      byId("tools-image-name").textContent = "Select an image";
      byId("tools-image-size").textContent = "—";
      byId("tools-coverage").textContent = "White area: —";
      const note = document.createElement("p");
      note.className = "help";
      note.textContent = "Images appear here after you load a folder.";
      byId("tools-files").replaceChildren(note);
      setZoom("fit");
      updateControls();
    },
    autoLoad() { if (byId("tools-root").value.trim()) byId("tools-load").click(); },
    async handleEvent(event) {
      const data = event.data;
      if (data.image && current() && samePath(data.image, current().image)) {
        if (typeof data.caption === "string") {
          byId("tools-caption-text").value = data.caption;
          captionDirty = true;
          scheduleDraft(0);
        }
        if (data.preview_mask) {
          loading = true;
          updateControls();
          try { await maskFromURL(data.preview_mask, true); maskDirty = true; scheduleDraft(0); await ensureOriginal(current()); }
          finally { loading = false; }
        }
      }
      if (data.status && data.status !== "running") {
        // Only the chosen images were (re)generated; everything else is untouched.
        if (pending?.batch && data.status === "succeeded" && current()) {
          const inTargets = pending.targets.has(current().relative);
          if (pending.overwrite) {
            for (const draft of await drafts.listByRoot(loadedRoot)) {
              if (typeof draft.caption !== "string" || !pending.targets.has(draft.relative)) continue;
              if (draft.mask) await drafts.put({ ...draft, caption: null }); else await drafts.remove(loadedRoot, draft.relative);
              const entry = entries.find((item) => item.relative === draft.relative);
              if (entry && entry !== current()) entry.draft = draft.mask ? { mask: true, caption: false } : null;
            }
            if (inTargets) {
              byId("tools-caption-text").value = await invoke("load_tool_caption", { root: loadedRoot, image: current().image, captionDir: captionDir() });
              captionDirty = false;
            }
            await flushDraft();
          } else if (inTargets && !captionDirty) {
            byId("tools-caption-text").value = await invoke("load_tool_caption", { root: loadedRoot, image: current().image, captionDir: captionDir() });
          }
        }
        pending = null;
      }
      updateControls();
    }
  };
}
