// Progress model for the always-visible job bar: parses tqdm lines (model downloads, training steps),
// tracks the phase of a job and turns it into text, a bar fraction, elapsed time and an ETA.
export const STALL_MS = 20000;

const TITLES = {
  caption: "Caption generation", mask: "Mask creation", mask_image: "Auto mask", dataset: "Dataset preparation",
  validate: "Environment check", train: "LoRA training", download: "Model download", comfy_install: "ComfyUI install"
};
const WORK_VERB = {
  caption: "Captioning", mask: "Creating masks", mask_image: "Selecting", dataset: "Preparing", train: "Training", validate: "Checking", download: "Downloading", comfy_install: "Installing"
};

export const jobTitle = (kind) => TITLES[kind] ?? "Job";

export function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

// "model.safetensors:  34%|###4 | 1.19G/3.50G [00:30<01:00, 40.1MB/s]" -> { label, percent, doneText, totalText, rate, eta }
export function parseTqdm(line) {
  const text = stripAnsi(line).trim();
  const percent = /(\d{1,3})%\|/.exec(text);
  if (!percent || !text.includes("[")) return null;
  const label = text.slice(0, text.indexOf(percent[0])).replace(/:\s*$/, "").trim();
  const counts = /\|\s*([\d.]+\s?[kKmMgGtT]?B?)\s*\/\s*([\d.]+\s?[kKmMgGtT]?B?)\s*\[/.exec(text);
  const timing = /\[([\d:]+)<([\d:?]+)(?:,\s*([^\],]+))?/.exec(text);
  return {
    label, percent: Math.min(100, Number(percent[1])),
    doneText: counts ? counts[1].trim() : "", totalText: counts ? counts[2].trim() : "",
    rate: timing?.[3] && !timing[3].includes("?") ? timing[3].trim() : "",
    eta: timing && !timing[2].includes("?") ? timing[2] : ""
  };
}
export const isTqdmLine = (line) => parseTqdm(line) !== null;

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? hours + ":" + String(minutes).padStart(2, "0") + ":" + rest : String(minutes).padStart(2, "0") + ":" + rest;
}

export function newJobUi(kind, now) {
  return {
    kind, status: "running", startedAt: now, lastEventAt: now, workStartedAt: null, endedAt: null,
    phase: "start", current: 0, total: 0, image: "", bar: null, message: "", error: ""
  };
}

const basename = (path) => String(path ?? "").split(/[\\/]/).pop();

// Folds one job event ({ message, phase, current, total, image, level, status }) into the state.
export function reduceJobUi(state, data, now) {
  const next = { ...state, lastEventAt: now };
  const message = typeof data.message === "string" ? data.message : "";
  const bar = message ? parseTqdm(message) : null;
  if (bar) next.bar = bar;
  else if (message) next.message = message;
  if (data.phase && data.phase !== state.phase) {
    next.phase = data.phase;
    if (data.phase !== "download") next.bar = bar;
    if (data.phase === "run" && !next.workStartedAt) next.workStartedAt = now;
  }
  if (data.total > 0) {
    next.total = data.total;
    next.current = Math.min(data.total, Math.max(0, data.current ?? next.current));
    if (!next.workStartedAt) next.workStartedAt = now;
    if (next.phase !== "download" && next.phase !== "load") { next.phase = "run"; if (!bar) next.bar = null; }
  }
  if (data.image) next.image = basename(data.image);
  if (data.level === "error" && message) next.error = message;
  if (data.status) {
    next.status = data.status;
    if (data.status !== "running") { next.endedAt = now; next.bar = null; }
  }
  return next;
}

// Everything the bar shows. fraction === null means "unknown" (indeterminate bar).
export function progressModel(state, now) {
  const verb = WORK_VERB[state.kind] ?? "Working";
  const running = state.status === "running";
  const elapsed = ((state.endedAt ?? now) - state.startedAt) / 1000;
  const model = {
    title: jobTitle(state.kind), tone: "running", fraction: null, percentText: "", phaseText: "", noteText: "",
    timeText: formatDuration(elapsed) + " elapsed", running
  };
  if (!running) {
    if (state.status === "succeeded") {
      model.tone = "ok"; model.fraction = 1; model.percentText = "100%";
      model.phaseText = "Done" + (state.total ? " — " + state.total + (state.total === 1 ? " item" : " items") : "");
      model.timeText = "took " + formatDuration(elapsed);
    } else if (state.status === "cancelled") {
      model.tone = "cancelled"; model.phaseText = "Cancelled"; model.timeText = "after " + formatDuration(elapsed);
    } else {
      model.tone = "error"; model.phaseText = "Failed"; model.noteText = state.error || state.message || "See the log below for details.";
      model.timeText = "after " + formatDuration(elapsed);
    }
    return model;
  }
  const counted = state.total > 0;
  if (state.phase === "check") model.phaseText = "Checking model files…";
  else if (state.phase === "download") {
    model.phaseText = "Downloading the model (first run only)";
    if (state.bar) {
      model.fraction = state.bar.percent / 100;
      model.percentText = state.bar.percent + "%";
      model.noteText = [state.bar.label, state.bar.doneText && state.bar.totalText ? state.bar.doneText + " / " + state.bar.totalText : "",
        state.bar.rate, state.bar.eta ? "about " + state.bar.eta + " left" : ""].filter(Boolean).join(" · ");
    }
  } else if (state.phase === "load") model.phaseText = "Loading the model — the first load can take a few minutes";
  else if (counted || state.bar) {
    const bar = state.bar;
    if (counted) {
      model.fraction = state.current / state.total;
      model.percentText = Math.round(model.fraction * 100) + "%";
      model.phaseText = verb + " " + state.current + " / " + state.total + (state.image ? " — " + state.image : "");
      const worked = state.workStartedAt ? (now - state.workStartedAt) / 1000 : 0;
      if (state.current >= 2 && worked > 0) model.timeText += " · about " + formatDuration(worked / state.current * (state.total - state.current)) + " left";
    } else {
      model.fraction = bar.percent / 100;
      model.percentText = bar.percent + "%";
      model.phaseText = verb + (bar.label ? " — " + bar.label : "");
      model.noteText = [bar.doneText && bar.totalText ? bar.doneText + " / " + bar.totalText : "", bar.rate, bar.eta ? "about " + bar.eta + " left" : ""].filter(Boolean).join(" · ");
    }
  } else if (state.phase === "run") model.phaseText = verb + "…";
  else model.phaseText = "Starting…";
  const silent = now - state.lastEventAt;
  if (silent >= STALL_MS) {
    model.noteText = "Still working — no update for " + Math.round(silent / 1000) + " s" +
      (state.phase === "load" || state.phase === "download" || state.phase === "check" ? " (this step can take a few minutes)" : "") + ". If this lasts much longer, check the log below.";
    model.stalled = true;
  }
  return model;
}
