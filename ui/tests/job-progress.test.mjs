import test from "node:test";
import assert from "node:assert/strict";
import { STALL_MS, formatDuration, isTqdmLine, jobTitle, newJobUi, parseTqdm, progressModel, reduceJobUi } from "../job-progress.mjs";

test("tqdm lines from downloads and training are parsed", () => {
  const download = parseTqdm("model.safetensors:  34%|███▍      | 1.19G/3.50G [00:30<01:00, 40.1MB/s]");
  assert.deepEqual(download, { label: "model.safetensors", percent: 34, doneText: "1.19G", totalText: "3.50G", rate: "40.1MB/s", eta: "01:00" });
  const files = parseTqdm("Fetching 12 files:   8%|▊         | 1/12 [00:05<00:55,  5.0s/it]");
  assert.equal(files.label, "Fetching 12 files");
  assert.equal(files.percent, 8);
  assert.equal(files.totalText, "12");
  const steps = parseTqdm("\u001b[Asteps:  12%|█▏        | 120/1000 [01:12<08:48,  1.66it/s, avr_loss=0.0912]");
  assert.equal(steps.label, "steps");
  assert.equal(steps.rate, "1.66it/s");
  assert.equal(steps.eta, "08:48");
  const initial = parseTqdm("steps:   0%|          | 0/1160 [00:00<?, ?it/s]");
  assert.deepEqual(initial, { label: "steps", percent: 0, doneText: "0", totalText: "1160", rate: "", eta: "" });
});

test("ordinary log lines are not mistaken for progress bars", () => {
  for (const line of ["Caption: a.png", "Mask created: x", "50% done", "", "loss 12%|"]) assert.equal(isTqdmLine(line), false, line);
});

test("durations are formatted as mm:ss or h:mm:ss", () => {
  assert.equal(formatDuration(0), "00:00");
  assert.equal(formatDuration(75), "01:15");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(formatDuration(-4), "00:00");
});

test("a caption job moves through check, download, load and counted work with an ETA", () => {
  let state = newJobUi("caption", 0);
  assert.equal(progressModel(state, 1000).phaseText, "Starting…");
  state = reduceJobUi(state, { message: "Checking model files…", phase: "check" }, 1000);
  assert.equal(progressModel(state, 1500).phaseText, "Checking model files…");
  state = reduceJobUi(state, { message: "Downloading", phase: "download" }, 2000);
  state = reduceJobUi(state, { message: "model.safetensors:  34%|███▍      | 1.19G/3.50G [00:30<01:00, 40.1MB/s]" }, 3000);
  let model = progressModel(state, 3000);
  assert.equal(model.fraction, 0.34);
  assert.match(model.noteText, /1\.19G \/ 3\.50G/);
  assert.match(model.noteText, /40\.1MB\/s/);
  state = reduceJobUi(state, { message: "Loading the caption model…", phase: "load" }, 5000);
  model = progressModel(state, 5000);
  assert.equal(model.fraction, null);
  assert.match(model.phaseText, /Loading the model/);
  state = reduceJobUi(state, { message: "Model ready", phase: "run", current: 0, total: 40 }, 10000);
  state = reduceJobUi(state, { message: "Caption: a.png", current: 1, total: 40, image: "C:/raw/a.png" }, 12000);
  state = reduceJobUi(state, { message: "Caption: b.png", current: 2, total: 40, image: "b.png" }, 14000);
  model = progressModel(state, 14000);
  assert.equal(model.phaseText, "Captioning 2 / 40 — b.png");
  assert.equal(model.fraction, 2 / 40);
  assert.match(model.timeText, /00:14 elapsed · about 01:16 left/); // 4 s for 2 items -> 38 left x 2 s
});

test("a silent job shows a still-working note, and the note names slow steps", () => {
  let state = reduceJobUi(newJobUi("caption", 0), { phase: "load", message: "Loading" }, 1000);
  assert.equal(progressModel(state, 1000 + STALL_MS - 1).stalled, undefined);
  const model = progressModel(state, 1000 + STALL_MS + 5000);
  assert.equal(model.stalled, true);
  assert.match(model.noteText, /Still working — no update for 25 s/);
  assert.match(model.noteText, /can take a few minutes/);
});

test("finished jobs show their outcome: done, cancelled, or the error message", () => {
  const base = reduceJobUi(newJobUi("mask", 0), { current: 3, total: 3, message: "x" }, 5000);
  const done = progressModel(reduceJobUi(base, { status: "succeeded" }, 8000), 9000);
  assert.deepEqual([done.tone, done.fraction, done.running], ["ok", 1, false]);
  assert.match(done.phaseText, /Done — 3 items/);
  assert.equal(done.timeText, "took 00:08");
  const cancelled = progressModel(reduceJobUi(base, { status: "cancelled" }, 8000), 9000);
  assert.equal(cancelled.tone, "cancelled");
  const failed = progressModel(reduceJobUi(reduceJobUi(base, { level: "error", message: "Boom" }, 7000), { status: "failed" }, 8000), 9000);
  assert.equal(failed.tone, "error");
  assert.equal(failed.noteText, "Boom");
  assert.equal(jobTitle("train"), "LoRA training");
  assert.equal(jobTitle("nope"), "Job");
});

test("a training bar without counted items uses the tqdm numbers", () => {
  let state = reduceJobUi(newJobUi("train", 0), { message: "Starting SD1.5 LoRA training", phase: "run" }, 1000);
  state = reduceJobUi(state, { message: "steps:  12%|█▏ | 120/1000 [01:12<08:48,  1.66it/s, avr_loss=0.09]" }, 2000);
  const model = progressModel(state, 2000);
  assert.equal(model.fraction, 0.12);
  assert.match(model.phaseText, /Training — steps/);
  assert.match(model.noteText, /120 \/ 1000 · 1\.66it\/s · about 08:48 left/);
});
