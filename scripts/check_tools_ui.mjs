import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const artifacts = path.join(root, ".qa-temp");
await mkdir(artifacts, { recursive: true });
const fixture = "data:image/png;base64," + (await readFile(path.join(root, "src-tauri/icons/icon.png"))).toString("base64");
const browser = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", [
  "--headless=new", "--no-first-run", "--no-default-browser-check",
  "--disable-gpu", "--in-process-gpu",
  "--disable-background-networking", "--disable-component-update",
  "--remote-debugging-pipe", "--allow-file-access-from-files",
  "--user-data-dir=" + path.join(artifacts, "edge-tools-" + Date.now())
], { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], windowsHide: true });
const pending = new Map();
let identifier = 0;
let received = "";
let browserErrors = "";
const pageErrors = [];
browser.stderr.on("data", (data) => { browserErrors = (browserErrors + data).slice(-4000); });
browser.on("error", (error) => { for (const request of pending.values()) request.reject(error); });
browser.stdio[4].on("data", (chunk) => {
  received += chunk.toString();
  let delimiter;
  while ((delimiter = received.indexOf("\0")) !== -1) {
    const raw = received.slice(0, delimiter);
    received = received.slice(delimiter + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.method === "Runtime.exceptionThrown") pageErrors.push(JSON.stringify(message.params));
    if (message.id && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  }
});
function send(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++identifier;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + " timed out: " + browserErrors)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    browser.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}

try {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function waitFor(expression) {
    for (let attempt = 0; attempt < 80; attempt++) {
      if (await evaluate(expression)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("UI condition failed: " + expression + " | " + await evaluate("document.getElementById('notice')?.textContent"));
  }
  const click = async (id) => {
    await evaluate("document.getElementById(" + JSON.stringify(id) + ").click()");
  };
  const fill = async (id, value) => {
    await evaluate("(() => { const input=document.getElementById(" + JSON.stringify(id) + "); input.value=" + JSON.stringify(value) + "; input.dispatchEvent(new Event('input',{bubbles:true})); })()");
  };
  await call("Page.enable", {});
  await call("Runtime.enable", {});
  await call("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await call("Page.addScriptToEvaluateOnNewDocument", { source: "(" + function (image) {
    window.calls = [];
    window.handlers = {};
    window.__TAURI__ = {
      core: { invoke: async (name, args) => {
        window.calls.push({ name, args });
        if (name === "load_settings") return {
          python_path: "C:/python.exe", training_python: "C:/training.exe",
          engine_dir: "C:/engine", models_dir: "C:/models", tokenizer_dir: "C:/tokenizers"
        };
        if (name === "job_status") return { snapshot: null, logs: [] };
        if (name === "scan_images") return [
          { relative: "first.png", image: "C:/raw/first.png", mask: null },
          { relative: "second.png", image: "C:/raw/second.png", mask: null }
        ];
        if (name === "preview_image") return image;
        if (name === "load_tool_caption") return "my_costume, standing outdoors.";
        if (name === "save_tool_mask") return "C:/masks/" + args.request.image.split("/").at(-1);
        if (name === "save_tool_caption") return "C:/captions/first.txt";
        if (name === "start_job") return "tool-job";
        return null;
      } },
      event: { listen: async (name, callback) => { window.handlers[name] = callback; return () => {}; } }
    };
    window.deliver = (data) => window.handlers["job-event"]({ payload: { jobId: "tool-job", data } });
  }.toString() + ")(" + JSON.stringify(fixture) + ");" });
  await call("Page.navigate", { url: new URL("../ui/index.html", import.meta.url).href });
  await waitFor("document.getElementById('python-path')?.value");
  await click("tab-tools");
  assert.equal(await evaluate("document.getElementById('page-tools').hidden"), false);
  await click("tools-load");
  await waitFor("document.getElementById('notice').textContent.includes('元画像')");
  await fill("tools-root", "C:\\raw\\images");
  assert.equal(await evaluate("document.getElementById('tools-root').value"), "C:/raw/images");
  await fill("tools-root", "C:/raw");
  await fill("tools-mask-dir", "C:/masks");
  await fill("tools-caption-dir", "C:/captions");
  await fill("tools-trigger", "my_costume");
  await click("tools-load");
  await waitFor("!document.getElementById('tools-canvas').hidden");
  assert.equal(await evaluate("document.getElementById('tools-canvas').width"), 64);
  assert.equal(await evaluate("document.querySelectorAll('.tool-image-item').length"), 2);
  await click("tools-mode-mask");
  const rect = await evaluate("(() => {const rect=document.getElementById('tools-canvas').getBoundingClientRect(); return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};})()");
  const start = { x: rect.x + rect.width * 0.3, y: rect.y + rect.height * 0.4 };
  const end = { x: rect.x + rect.width * 0.6, y: rect.y + rect.height * 0.5 };
  await call("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", clickCount: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...end, button: "left", buttons: 1 });
  await call("Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", clickCount: 1 });
  await waitFor("document.getElementById('tools-dirty').textContent.includes('未保存')");
  const painted = await evaluate("document.getElementById('tools-coverage').textContent");
  assert.notEqual(painted, "白い領域: 0.0%");
  await click("tools-undo");
  assert.equal(await evaluate("document.getElementById('tools-coverage').textContent"), "白い領域: 0.0%");
  await click("tools-redo");
  assert.equal(await evaluate("document.getElementById('tools-coverage').textContent"), painted);
  await evaluate("document.querySelectorAll('.tool-image-item')[1].click()");
  await waitFor("document.getElementById('tools-unsaved-dialog').open");
  await click("tools-discard-cancel");
  assert.equal(await evaluate("document.getElementById('tools-image-name').textContent"), "first.png");
  await click("tools-auto-mask");
  await waitFor("window.calls.some(call => call.name==='start_job' && call.args.kind==='mask_image')");
  const maskRequest = await evaluate("window.calls.filter(call => call.name==='start_job').at(-1).args");
  assert.equal(maskRequest.payload.points[0].label, 1);
  assert.equal(maskRequest.payload.mask_prompt, "衣装");
  assert.equal(await evaluate("document.getElementById('tools-save-mask').disabled"), true);
  await evaluate("window.deliver({image:'C:/raw/first.png',preview_mask:" + JSON.stringify(fixture) + ",message:'preview'})");
  await evaluate("window.deliver({status:'succeeded',message:'done'})");
  await waitFor("!document.getElementById('tools-save-mask').disabled");
  await click("tools-save-mask");
  await waitFor("window.calls.some(call => call.name==='save_tool_mask')");
  const saved = await evaluate("window.calls.filter(call => call.name==='save_tool_mask').at(-1).args.request");
  assert.equal(saved.output_dir, "C:/masks");
  const png = Buffer.from(saved.content.split(",")[1], "base64");
  assert.equal(png.readUInt32BE(16), 64);
  assert.equal(png.readUInt32BE(20), 64);
  await click("tools-mode-caption");
  await click("tools-caption-one");
  await waitFor("window.calls.some(call => call.name==='start_job' && call.args.kind==='caption')");
  await evaluate("window.deliver({image:'C:/raw/first.png',caption:'my_costume, sitting outside.',message:'caption'})");
  await evaluate("window.deliver({status:'succeeded',message:'done'})");
  await waitFor("document.getElementById('tools-caption-text').value==='my_costume, sitting outside.'");
  await fill("tools-caption-text", "my_costume, standing in a garden.");
  await click("tools-save-caption");
  await waitFor("window.calls.some(call => call.name==='save_tool_caption')");
  assert.equal(await evaluate("window.calls.filter(call=>call.name==='save_tool_caption').at(-1).args.request.content"), "my_costume, standing in a garden.");
  await click("tools-mode-mask");
  const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await writeFile(path.join(artifacts, "tools-desktop.png"), Buffer.from(screenshot.data, "base64"));
  // Mask Creation: a finished mask must appear before the whole job ends.
  await click("tab-mask");
  await fill("raw-dir", "C:\raw");
  await fill("mask-dir", "C:\masks");
  await evaluate("document.getElementById('mask-form').requestSubmit()");
  await waitFor("window.calls.some(call => call.name==='start_job' && call.args.kind==='mask')");
  assert.equal(await evaluate("document.getElementById('preview-canvas').hidden"), true);
  await evaluate("window.deliver({message:'マスク作成: second.png',current:1,total:2,preview_source:'second.png',preview_mask:" + JSON.stringify(fixture) + "})");
  await waitFor("!document.getElementById('preview-canvas').hidden");
  assert.equal(await evaluate("document.getElementById('image-count').textContent"), "2 / 2");
  assert.equal(await evaluate("document.getElementById('job-status').textContent"), "1 / 2");
  await evaluate("window.deliver({message:'[SKIP] first.png: 背景が透過済みの画像です (透過 80%)',current:2,total:2})");
  assert.match(await evaluate("document.getElementById('logs').textContent"), /\[SKIP\] first\.png/);
  assert.equal(await evaluate("document.getElementById('notice').hidden"), true);
  await click("tab-dataset");
  assert.equal(await evaluate("document.getElementById('dataset-captions').value"), "C:/captions");
  for (const width of [800, 375]) {
    await call("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await click("tab-tools");
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  }
  assert.deepEqual(pageErrors, []);
  console.log("Tools UI: folder selection, actual mouse painting, Undo/Redo, unsaved dialog, AI guidance, caption edit/save, original-size PNG, caption reuse, live mask preview and skip log, 800/375px layout: PASS");
} finally {
  try { await send("Browser.close"); } catch { browser.kill(); }
  for (const request of pending.values()) clearTimeout(request.timer);
}
