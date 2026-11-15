"""Runtime checks for the editor features (headless Edge, mocked native bridge).

Run: uv run --with playwright python scripts/check_ui_features.py
"""

from pathlib import Path
import json
import os
import mimetypes
import re
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect

MOCK_BRIDGE = """
window.calls = [];
window.zoomCalls = [];
window.handlers = {};
function makeUrl(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  draw(canvas.getContext('2d'));
  return canvas.toDataURL('image/png');
}
const IMAGE_URL = makeUrl(640, 480, (c) => {
  for (let y = 0; y < 480; y += 8) for (let x = 0; x < 640; x += 8) {
    c.fillStyle = ((x + y) / 8) % 2 ? '#d33' : '#36c'; c.fillRect(x, y, 8, 8);
  }
});
const MASK_URL = makeUrl(640, 480, (c) => {
  c.fillStyle = '#000'; c.fillRect(0, 0, 640, 480);
  c.fillStyle = '#fff'; c.fillRect(160, 120, 320, 240);
});
window.__TAURI__ = {
  event: { listen: async (name, callback) => { window.handlers[name] = callback; return () => {}; } },
  webview: { getCurrentWebview: () => ({ setZoom: async (value) => { window.zoomCalls.push(value); } }) },
  core: { invoke: async (name, args) => {
    window.calls.push({ name, args });
    if (name === 'load_settings') return {
      python_path:'C:/runtime/inference/python.exe', training_python:'C:/runtime/training/python.exe',
      engine_dir:'C:/engine', models_dir:'C:/models', tokenizer_dir:'C:/tokenizers'
    };
    if (name === 'job_status') return { snapshot: null, logs: [] };
    if (name === 'start_job') return 'job-1';
    if (name === 'scan_images') return [
      { image: 'C:/raw/a.png', relative: 'a.png', mask: 'C:/masks/a.png' },
      { image: 'C:/raw/b.png', relative: 'b.png', mask: null },
      { image: 'C:/raw/c.png', relative: 'c.png', mask: null }
    ];
    if (name === 'preview_image') return String(args.path).includes('/masks/') ? MASK_URL : IMAGE_URL;
    if (name === 'load_tool_caption') {
      const image = String(args.image);
      if (image.endsWith('a.png')) return 'trig, one, two, three';
      if (image.endsWith('b.png')) return 'trig, x, X, y';
      return '';
    }
    if (name === 'save_tool_mask' || name === 'save_tool_caption') return 'C:/out/' + args.request.image.split('/').pop();
    return null;
  } }
};
"""


def coverage(page):
    text = page.locator("#tools-coverage").inner_text()
    return float(re.search(r"([\d.]+)%", text).group(1))


def main():
    shots = os.environ.get("SHOTS")

    def shot(page, name):
        if shots:
            page.screenshot(path=str(Path(shots) / (name + ".png")))

    project = Path(__file__).resolve().parents[1]
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe", headless=True)
        page = browser.new_page(viewport={"width": 1500, "height": 1000}, reduced_motion="reduce")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.add_init_script(MOCK_BRIDGE)

        def route_local(route):
            relative = urlparse(route.request.url).path.lstrip("/") or "index.html"
            path = (project / "ui" / relative).resolve()
            if not path.is_relative_to(project / "ui") or not path.is_file():
                route.abort()
                return
            mime = "text/javascript" if path.suffix in (".js", ".mjs") else mimetypes.guess_type(path.name)[0]
            route.fulfill(body=path.read_bytes(), content_type=mime or "application/octet-stream")

        page.route("http://studio.test/**", route_local)
        page.goto("http://studio.test/")
        page.wait_for_function("document.getElementById('python-path').value !== ''")

        # --- Tools: load a folder, thumbnails, review marks -------------------------------------
        page.locator("#tab-tools").click()
        page.evaluate("document.querySelectorAll('#page-tools details').forEach((item) => { item.open = true; })")
        page.locator("#tools-root").fill("C:/raw")
        page.locator("#tools-trigger").fill("trig")
        page.locator("#tools-load").click()
        expect(page.locator(".tool-image-item")).to_have_count(3)
        expect(page.locator("#tools-canvas")).to_be_visible()
        page.evaluate("window.__autosaveDelay = 600000")  # keep auto-save out of the way until its own test
        # one panel: no Caption / Mask Paint tabs; the caption box and the brush controls are on screen together
        expect(page.locator("#tools-mode-caption")).to_have_count(0)
        expect(page.locator("#tools-caption-text")).to_be_visible()
        expect(page.locator("#tools-brush-size")).to_be_visible()
        expect(page.locator("#tools-brush-hardness")).to_have_count(0)
        page.evaluate("document.querySelectorAll('#page-tools details').forEach((item) => { item.open = true; })")
        page.wait_for_function("document.querySelectorAll('.tool-image-item img').length >= 2")
        expect(page.locator("#tools-count")).to_contain_text("3 images")
        # Photoshop-like editor: a tall frame (~80% of the window) with the picture slightly bigger than it
        frame = page.locator("#tools-canvas-scroll").bounding_box()
        picture = page.locator("#tools-canvas").bounding_box()
        assert 700 <= frame["height"] <= 820, frame
        assert frame["width"] < picture["width"] < frame["width"] * 1.3, (frame, picture)
        # Space must never scroll the page (it pans the image)
        scroll_before = page.evaluate("window.scrollY")
        page.keyboard.press("Space")
        assert page.evaluate("window.scrollY") == scroll_before

        shot(page, "tools")
        # --- keyboard shortcuts ------------------------------------------------------------------
        # sliders must reach both ends of their container (no inherited text-field padding)
        paddings = page.evaluate("[...document.querySelectorAll('input[type=range]')].map((el) => getComputedStyle(el).paddingLeft + getComputedStyle(el).paddingRight)")
        assert paddings and all(value == "0px0px" for value in paddings), paddings
        page.locator("#tools-mask-controls").scroll_into_view_if_needed()
        shot(page, "mask-panel")
        page.keyboard.press("e")
        expect(page.locator("#tools-brush-remove")).to_have_attribute("aria-pressed", "true")
        page.keyboard.press("l")
        expect(page.locator("#tools-brush-lasso")).to_have_attribute("aria-pressed", "true")
        page.keyboard.press("m")
        expect(page.locator("#tools-brush-box")).to_have_attribute("aria-pressed", "true")
        page.keyboard.press("b")
        expect(page.locator("#tools-brush-add")).to_have_attribute("aria-pressed", "true")
        before = float(page.locator("#tools-brush-size").input_value())
        page.keyboard.press("]")
        assert float(page.locator("#tools-brush-size").input_value()) > before
        page.keyboard.press("[")
        page.keyboard.press("Shift+Q")  # Overlay -> Mask
        page.keyboard.press("Shift+Q")  # Mask -> Split
        expect(page.locator('[data-editor-view="split"]')).to_have_class(re.compile("selected"))
        page.keyboard.press("q")  # Q toggles the overlay: Split -> Original -> Overlay
        expect(page.locator('[data-editor-view="original"]')).to_have_class(re.compile("selected"))
        page.keyboard.press("q")
        expect(page.locator('[data-editor-view="overlay"]')).to_have_class(re.compile("selected"))
        page.keyboard.press("?")
        expect(page.locator("#shortcuts-dialog")).to_be_visible()
        shot(page, "shortcuts")
        assert page.locator("#shortcuts-body .shortcut-row").count() > 15
        page.keyboard.press("Escape")
        expect(page.locator("#shortcuts-dialog")).not_to_be_visible()

        # --- mask operations --------------------------------------------------------------------
        start = coverage(page)
        assert 24 <= start <= 26, start
        page.locator("#tools-op-grow").click()
        grown = coverage(page)
        assert grown > start, (start, grown)
        page.locator("#tools-op-shrink").click()
        page.locator("#tools-op-invert").click()
        assert coverage(page) > 60, coverage(page)
        page.keyboard.press("Control+z")
        page.locator("#tools-op-clear").click()
        assert coverage(page) == 0
        page.keyboard.press("Control+z")
        expect(page.locator("#tools-dirty")).to_contain_text("Unsaved")

        # --- reset to saved / restore the first automatic mask ----------------------------------
        page.locator("#tools-op-clear").click()
        assert coverage(page) == 0
        expect(page.locator("#tools-op-original")).to_be_enabled()
        page.locator("#tools-op-original").click()
        page.wait_for_function("document.getElementById('tools-coverage').textContent.includes('25.0')")
        page.locator("#tools-op-grow").click()
        page.locator("#tools-op-reset").click()
        page.wait_for_function("document.getElementById('tools-coverage').textContent.includes('25.0')")
        expect(page.locator("#tools-dirty")).to_contain_text("Saved")
        page.keyboard.press("Control+z")  # Undo brings the grown mask back
        assert coverage(page) > 25.5

        # --- painting: brush and lasso ----------------------------------------------------------
        page.locator("#tools-op-clear").click()
        def canvas_center():
            # clicks elsewhere scroll the page, so always bring the canvas back to the middle first
            page.evaluate("document.getElementById('tools-canvas-scroll').scrollIntoView({ block: 'center' })")
            box = page.locator("#tools-canvas").bounding_box()
            return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2

        cx, cy = canvas_center()
        page.mouse.move(cx - 40, cy)
        page.mouse.down()
        page.mouse.move(cx + 40, cy, steps=6)
        page.mouse.up()
        painted = coverage(page)
        assert painted > 0.5, painted
        page.keyboard.press("l")
        page.mouse.move(cx - 80, cy + 40)
        page.mouse.down()
        for dx, dy in ((80, 40), (80, -60), (-80, -60)):
            page.mouse.move(cx + dx, cy + dy, steps=3)
        page.mouse.up()
        assert coverage(page) > painted + 1
        page.keyboard.press("b")

        # --- Alt = temporary eraser while the paint brush is selected ----------------------------
        painted_total = coverage(page)
        page.mouse.move(cx - 80, cy)
        page.keyboard.down("Alt")
        page.mouse.down()
        page.mouse.move(cx + 80, cy, steps=6)
        page.mouse.up()
        page.keyboard.up("Alt")
        assert coverage(page) < painted_total, (painted_total, coverage(page))
        expect(page.locator("#tools-brush-add")).to_have_attribute("aria-pressed", "true")

        # --- adjustments: right-drag = size; Alt + right-drag = size and opacity; number keys = opacity --
        def right_drag(dx, dy=0, alt=False):
            cx, cy = canvas_center()
            page.mouse.move(cx, cy)
            if alt:
                page.keyboard.down("Alt")
            page.mouse.down(button="right")
            page.mouse.move(cx + dx, cy + dy, steps=5)
            page.mouse.up(button="right")
            if alt:
                page.keyboard.up("Alt")

        def value(selector):
            return float(page.locator(selector).input_value())

        size0, opacity0 = value("#tools-brush-size"), value("#tools-brush-opacity")
        right_drag(90)  # right-drag: size only
        size1 = value("#tools-brush-size")
        assert size1 > size0 and value("#tools-brush-opacity") == opacity0
        right_drag(-90, 60)
        size2 = value("#tools-brush-size")
        assert size2 < size1 and value("#tools-brush-opacity") == opacity0
        right_drag(40, 60, alt=True)  # Alt + right-drag: right = larger, down = lighter opacity
        assert value("#tools-brush-size") > size2 and value("#tools-brush-opacity") < opacity0
        lighter = value("#tools-brush-opacity")
        right_drag(0, -80, alt=True)  # up = denser
        assert value("#tools-brush-opacity") > lighter
        page.locator("#tools-brush-opacity").fill(str(int(opacity0)))
        cx, cy = canvas_center()
        page.mouse.move(cx, cy)
        page.keyboard.down("Alt")
        page.mouse.move(cx + 80, cy, steps=4)  # Alt alone (no button) changes nothing
        page.keyboard.up("Alt")
        page.keyboard.press("5")  # number keys set the opacity (1 = 10% ... 0 = 100%; two digits quickly = exact)
        assert value("#tools-brush-opacity") == 50
        page.wait_for_timeout(800)
        page.keyboard.press("0")
        assert value("#tools-brush-opacity") == 100
        page.wait_for_timeout(800)
        page.keyboard.press("4")
        page.keyboard.press("5")
        assert value("#tools-brush-opacity") == 45
        page.locator("#tools-brush-opacity").fill("100")

        # --- AI guide points are hidden unless asked for ----------------------------------------
        expect(page.locator("#tools-show-guides")).not_to_be_checked()
        page.locator("#tools-show-guides").check()
        page.locator("#tools-show-guides").uncheck()

        # --- the brush edge is hard: nothing is painted outside the brush circle ---------------------
        page.locator('[data-editor-view="mask"]').click()
        page.locator("#tools-brush-size").fill("40")
        page.locator("#tools-brush-random").fill("0")
        page.locator("#tools-brush-opacity").fill("100")
        page.locator("#tools-op-clear").click()
        cx, cy = canvas_center()
        page.mouse.click(cx, cy)
        reach = page.evaluate("""() => {
          const c = document.getElementById('tools-canvas');
          const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          const cx = c.width / 2, cy = c.height / 2;
          let farthest = 0, peak = 0;
          for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
            const v = data[(y * c.width + x) * 4];
            if (v > 0) farthest = Math.max(farthest, Math.hypot(x - cx, y - cy));
            peak = Math.max(peak, v);
          }
          return { farthest, peak };
        }""")
        assert reach["farthest"] <= 22 and reach["peak"] > 200, reach  # brush radius is 20 px
        page.locator("#tools-brush-size").fill("32")
        page.locator('[data-editor-view="overlay"]').click()

        # --- randomness: 0 = full strength per click, higher = weaker random stamps ----------------
        cx, cy = canvas_center()
        page.locator("#tools-op-clear").click()
        page.locator("#tools-brush-opacity").fill("100")
        page.locator("#tools-brush-random").fill("100")
        page.evaluate("window.__random = Math.random; Math.random = () => 0.95")  # stamps become ~5% strong
        cx, cy = canvas_center()  # the sliders above scrolled the page
        page.mouse.click(cx, cy)
        assert coverage(page) == 0, "a single weak stamp must not reach the 50% threshold"
        page.evaluate("Math.random = () => 0.0")  # ...and the luckiest stamp is full strength
        page.mouse.click(cx, cy)
        assert coverage(page) > 0
        page.locator("#tools-op-clear").click()
        page.evaluate("Math.random = () => 0.5")  # 50% stamps overlap ~4x along a drag and build up past the threshold
        cx, cy = canvas_center()
        page.mouse.move(cx - 60, cy)
        page.mouse.down()
        page.mouse.move(cx + 60, cy, steps=8)  # overlapping stamps build up along a drag
        page.mouse.up()
        assert coverage(page) > 0.2
        page.evaluate("Math.random = window.__random")
        page.locator("#tools-op-clear").click()
        page.locator("#tools-brush-random").fill("0")
        cx, cy = canvas_center()
        page.mouse.click(cx, cy)
        assert coverage(page) > 0

        # --- review marks and navigation --------------------------------------------------------
        page.keyboard.press("r")
        expect(page.locator(".tool-image-item").first).to_have_class(re.compile("reviewed"))
        expect(page.locator("#tools-count")).to_contain_text("1 reviewed")
        page.keyboard.press("n")
        expect(page.locator("#tools-image-name")).to_have_text("b.png")
        expect(page.locator("#tools-op-original")).to_be_disabled()  # b.png never had an automatic mask
        page.locator("#tools-op-reset").click()
        assert coverage(page) == 0
        page.keyboard.press("PageUp")
        expect(page.locator("#tools-image-name")).to_have_text("a.png")

        # --- full screen with the paint toolbar -------------------------------------------------
        page.locator("#tools-canvas").hover()
        expect(page.locator("#tools-fullscreen")).to_be_visible()
        page.locator("#tools-fullscreen").click()
        expect(page.locator(".tool-editor-panel")).to_have_class(re.compile("fullscreen"))
        expect(page.locator("#fs-hint")).to_be_visible()
        shot(page, "tools-fullscreen")
        # Space must pan, never "press" the full-screen button that was just clicked (it used to exit).
        page.keyboard.press("Space")
        expect(page.locator(".tool-editor-panel")).to_have_class(re.compile("fullscreen"))
        page.locator("#tools-fullscreen").focus()
        page.keyboard.press("Space")
        expect(page.locator(".tool-editor-panel")).to_have_class(re.compile("fullscreen"))
        expect(page.locator("#tools-fs-toolbar #tools-brush-size")).to_have_count(1)
        expect(page.locator("#tools-fs-toolbar #tools-op-grow")).to_have_count(1)
        # focus mode: the other bars are gone and their controls live in the translucent toolbar
        for selector in ("#tools-save-all", ".segmented", ".tool-nav", "#tools-image-opacity", ".zoom-controls"):
            expect(page.locator("#tools-fs-toolbar " + selector)).to_have_count(1)
        expect(page.locator(".tool-editor-panel > .panel-header")).to_be_hidden()
        expect(page.locator(".tool-editor-panel > .tool-editor-toolbar")).to_be_hidden()
        expect(page.locator(".tool-editor-panel > .tool-editor-footer")).to_be_hidden()
        assert page.locator("#tools-canvas-scroll").bounding_box()["height"] >= 960
        assert "0.5" in page.evaluate("getComputedStyle(document.getElementById('tools-fs-toolbar')).backgroundColor")
        expect(page.locator("#tools-fs-info")).to_contain_text("a.png")
        shot(page, "tools-focus")
        # free canvas: every edge of the zoomed picture can be pulled to the middle of the screen
        def edges():
            return page.evaluate("""() => {
              const c = document.getElementById('tools-canvas').getBoundingClientRect();
              const f = document.getElementById('tools-canvas-scroll').getBoundingClientRect();
              return { right: c.right - (f.left + f.width / 2), bottom: c.bottom - (f.top + f.height / 2),
                       left: c.left - (f.left + f.width / 2), top: c.top - (f.top + f.height / 2) };
            }""")
        page.evaluate("(() => { const s = document.getElementById('tools-canvas-scroll'); s.scrollLeft = s.scrollWidth; s.scrollTop = s.scrollHeight; })()")
        far = edges()
        assert abs(far["right"]) <= 24 and abs(far["bottom"]) <= 24, far
        page.evaluate("(() => { const s = document.getElementById('tools-canvas-scroll'); s.scrollLeft = 0; s.scrollTop = 0; })()")
        near = edges()
        assert abs(near["left"]) <= 24 and abs(near["top"]) <= 24, near

        # the toolbox can be dragged by its handle, stays inside the window, remembers its place and resets on double-click
        toolbox = page.locator("#tools-fs-toolbar")
        handle = page.locator("#tools-fs-toolbar .fs-handle")

        def drag_handle(dx, dy):
            box = handle.bounding_box()
            x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            page.mouse.move(x, y)
            page.mouse.down()
            page.mouse.move(x + dx, y + dy, steps=6)
            page.mouse.up()

        home = toolbox.bounding_box()
        drag_handle(-400, 200)
        moved = toolbox.bounding_box()
        assert abs((home["x"] - moved["x"]) - 400) <= 3 and abs((moved["y"] - home["y"]) - 200) <= 3, (home, moved)
        drag_handle(-2000, -2000)
        corner = toolbox.bounding_box()
        assert corner["x"] >= -1 and corner["y"] >= -1, corner
        drag_handle(3000, 3000)
        far_corner = toolbox.bounding_box()
        assert far_corner["x"] + far_corner["width"] <= 1501 and far_corner["y"] + 40 <= 1001, far_corner
        drag_handle(-300, -300)
        placed = toolbox.bounding_box()
        page.keyboard.press("Escape")
        page.locator("#tools-canvas").hover()
        page.locator("#tools-fullscreen").click()
        expect(page.locator(".tool-editor-panel")).to_have_class(re.compile("fullscreen"))
        again = toolbox.bounding_box()
        assert abs(again["x"] - placed["x"]) <= 3 and abs(again["y"] - placed["y"]) <= 3, (placed, again)
        handle.dblclick()
        reset = toolbox.bounding_box()
        assert abs(reset["x"] - home["x"]) <= 3 and abs(reset["y"] - home["y"]) <= 3, (home, reset)
        # full screen is a focus mode for the mask: captions stay in the normal panel (no caption dock)
        expect(page.locator("#tools-fs-caption")).to_have_count(0)
        expect(page.locator(".tool-controls #tools-caption-text")).to_have_count(1)
        page.keyboard.press("Tab")  # Photoshop: Tab hides the panels
        expect(toolbox).to_be_hidden()
        page.keyboard.press("Tab")
        expect(toolbox).to_be_visible()
        expect(page.locator("#tools-fs-info")).to_contain_text("a.png")
        panel = page.locator(".tool-editor-panel").bounding_box()
        assert panel["width"] >= 1490 and panel["height"] >= 990, panel
        page.keyboard.press("Escape")
        expect(page.locator(".tool-editor-panel")).not_to_have_class(re.compile("fullscreen"))
        expect(page.locator("#tools-mask-controls #tools-brush-size")).to_have_count(1)
        expect(page.locator("#tools-caption-main #tools-caption-text")).to_have_count(1)  # the caption box is back in the panel
        expect(page.locator("#tools-fs-caption #tools-caption-text")).to_have_count(0)
        expect(page.locator(".tool-editor-toolbar .segmented")).to_have_count(1)
        expect(page.locator(".tool-editor-panel > .panel-header #tools-save-all")).to_have_count(1)
        expect(page.locator(".tool-editor-panel > .tool-editor-footer")).to_be_visible()

        # --- zoom: over the picture vs. the whole UI --------------------------------------------
        canvas_box = page.locator("#tools-canvas").bounding_box()
        page.mouse.move(canvas_box["x"] + 50, canvas_box["y"] + 50)
        page.keyboard.down("Alt")
        page.mouse.wheel(0, -200)
        page.keyboard.up("Alt")
        expect(page.locator("#tools-canvas")).to_have_class(re.compile("zoomed"))
        assert page.evaluate("window.zoomCalls.length") == 0  # Alt + wheel never touches the UI zoom
        for _ in range(25):  # zoom all the way in: single pixels, like Photoshop (3200%)
            page.keyboard.down("Alt")
            page.mouse.wheel(0, -200)
            page.keyboard.up("Alt")
        closest = page.evaluate("""() => {
          const c = document.getElementById('tools-canvas');
          return { scale: parseFloat(c.style.width) / c.width, rendering: getComputedStyle(c).imageRendering };
        }""")
        assert abs(closest["scale"] - 32) < 0.05, closest
        assert closest["rendering"] == "pixelated", closest  # crisp pixels, no smoothing
        expect(page.locator("#tools-zoom")).to_have_value("32")
        # a single pixel can be painted at 3200%: the smallest brushes snap to pixel centres
        page.locator('[data-editor-view="mask"]').click()

        def pixels():
            return page.evaluate("""() => {
              const c = document.getElementById('tools-canvas');
              const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
              let strong = 0, peak = 0;
              for (let index = 0; index < c.width * c.height; index++) {
                const v = data[index * 4];
                if (v > 32) strong++;
                peak = Math.max(peak, v);
              }
              return { strong, peak };
            }""")

        def click_middle(times=1):
            page.evaluate("document.getElementById('tools-canvas-scroll').scrollIntoView({ block: 'center' })")
            frame = page.locator("#tools-canvas-scroll").bounding_box()
            for _ in range(times):
                page.mouse.click(frame["x"] + frame["width"] / 2, frame["y"] + frame["height"] / 2)

        page.locator("#tools-brush-size").fill("1")
        page.locator("#tools-op-clear").click()
        click_middle()
        one = pixels()
        assert one["strong"] == 1 and one["peak"] > 128, one  # a 1 px brush paints exactly one pixel
        page.locator("#tools-brush-size").fill("0.5")
        expect(page.locator("#tools-brush-size")).to_have_value("0.5")  # half-pixel brush
        page.locator("#tools-op-clear").click()
        click_middle()
        faint = pixels()
        assert faint["strong"] <= 1 and faint["peak"] < 128, faint  # one click is only a faint dab...
        click_middle(6)
        built_up = pixels()
        assert built_up["strong"] == 1 and built_up["peak"] >= 128, built_up  # ...that builds up with repeated clicks
        page.locator('[data-editor-view="overlay"]').click()
        page.locator("#tools-brush-size").fill("32")
        page.locator("#tools-zoom").select_option("1")
        page.keyboard.down("Alt")
        page.mouse.wheel(0, 200)
        page.keyboard.up("Alt")
        assert page.locator("#tools-canvas").bounding_box()["width"] < page.evaluate("document.getElementById('tools-canvas').width") * 2
        page.keyboard.down("Control")
        page.mouse.wheel(0, -200)  # Ctrl + wheel over the picture now zooms the whole UI
        page.keyboard.up("Control")
        page.wait_for_function("window.zoomCalls.length > 0")
        page.mouse.move(5, 5)
        page.keyboard.down("Control")
        page.mouse.wheel(0, -200)
        page.keyboard.up("Control")
        page.wait_for_function("window.zoomCalls.length > 0")
        assert page.evaluate("window.zoomCalls.at(-1)") > 1
        page.keyboard.press("Control+0")
        page.wait_for_function("window.zoomCalls.at(-1) === 1")

        # --- dataset check: results are cached, tags filter the list, bulk fixes can be undone --------
        def previews():
            return page.evaluate("window.calls.filter((call) => call.name === 'preview_image').length")

        page.locator("#tools-check").click()
        expect(page.locator("#tools-check-panel")).to_be_visible()
        expect(page.locator("#tools-check-status")).to_contain_text("Checked 3 images", timeout=15000)
        assert page.locator("#tools-check-tags .check-tag").count() >= 5
        assert page.locator("#tools-check-summary .check-chip").count() >= 3
        shot(page, "check")
        loaded = previews()
        page.locator("#tools-check").click()  # nothing changed: no image is analysed again
        expect(page.locator("#tools-check-status")).to_contain_text("No changes")
        assert previews() == loaded, (loaded, previews())
        page.locator("#tools-op-invert").click()  # changing a mask re-analyses only that image
        page.locator("#tools-check").click()
        expect(page.locator("#tools-check-status")).to_contain_text("1 analysed")
        assert previews() == loaded + 1, (loaded, previews())
        page.locator("#tools-check-force").click()  # "Re-check all" ignores the cache
        expect(page.locator("#tools-check-status")).to_contain_text("3 analysed")
        page.locator("#tools-op-invert").click()
        # click a tag: only the images that use it are shown (and selected), caption highlighted
        page.locator('#tools-check-tags .check-tag[data-tag="one"] .tag-name').click()
        expect(page.locator(".tool-image-item")).to_have_count(1)
        expect(page.locator("#tools-filter-bar")).to_be_visible()
        expect(page.locator(".tool-image-item mark")).to_have_text("one")
        page.locator("#tools-filter-clear").click()
        expect(page.locator(".tool-image-item")).to_have_count(3)
        expect(page.locator("#tools-filter-bar")).to_be_hidden()
        # x removes the tag from every caption; Undo brings it back
        page.locator('#tools-check-tags .check-tag[data-tag="two"] .tag-x').click()
        expect(page.locator('#tools-check-tags .check-tag[data-tag="two"]')).to_have_count(0)
        expect(page.locator("#tools-caption-text")).not_to_have_value(re.compile("two"))
        page.locator("#tools-check-undo").click()
        expect(page.locator('#tools-check-tags .check-tag[data-tag="two"]')).to_have_count(1)
        expect(page.locator("#tools-caption-text")).to_have_value(re.compile("two"))
        # duplicate tags are reduced to one
        page.locator("#tools-check-fixdup").click()
        expect(page.locator("#tools-check-fixdup")).to_be_disabled()
        page.locator(".tool-image-item").nth(1).click()
        expect(page.locator("#tools-caption-text")).to_have_value("trig, x, y")
        page.locator(".tool-image-item").first.click()
        page.locator("#tools-check-close").click()
        expect(page.locator("#tools-check-panel")).to_be_hidden()

        # --- job bar: always visible; shows the phase, download, counts and failures ------------------
        page.locator("#tab-tools").click()
        page.locator("#tools-caption-model").select_option("wd14")
        page.locator("#tools-caption-all").click()
        bar = page.locator("#job-bar")
        expect(bar).to_be_visible()
        expect(page.locator("#job-bar-title")).to_have_text("Caption generation")

        def send(**data):
            page.evaluate("(data) => window.handlers['job-event']({ payload: { jobId: 'job-1', data } })", data)

        send(message="Checking model files…", phase="check")
        expect(page.locator("#job-bar-phase")).to_contain_text("Checking model files")
        send(message="Downloading", phase="download")
        send(message="model.safetensors:  34%|███▍      | 1.19G/3.50G [00:30<01:00, 40.1MB/s]")
        expect(page.locator("#job-bar-percent")).to_have_text("34%")
        expect(page.locator("#job-bar-note")).to_contain_text("1.19G / 3.50G")
        assert "1.19G" not in page.locator("#logs").inner_text()  # progress bars do not flood the log
        send(message="Loading", phase="load")
        expect(page.locator("#job-bar-phase")).to_contain_text("Loading the model")
        send(message="Caption: a.png", phase="run", current=3, total=45, image="a.png")
        expect(page.locator("#job-bar-phase")).to_have_text("Captioning 3 / 45 — a.png")
        expect(page.locator("#job-bar-percent")).to_have_text("7%")
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        assert page.locator("#job-bar").bounding_box()["y"] <= 1, "the bar stays visible while scrolling"
        shot(page, "job-bar")
        send(level="error", message="Boom")
        send(status="failed")
        expect(bar).to_have_attribute("data-tone", "error")
        expect(page.locator("#job-bar-note")).to_contain_text("Boom")
        expect(page.locator("#job-bar-stop")).to_be_hidden()
        page.locator("#job-bar-dismiss").click()
        expect(bar).to_be_hidden()
        page.evaluate("window.scrollTo(0, 0)")

        # --- auto-save: edits reach the files a few seconds after you stop editing --------------------
        def saved_captions():
            return page.evaluate("window.calls.filter((call) => call.name === 'save_tool_caption').map((call) => call.args.request.content)")

        page.locator("#tab-tools").click()
        expect(page.locator("#tools-autosave")).to_be_checked()  # on by default
        page.locator("#tools-mask-dir").fill("C:/masks")  # earlier steps left mask drafts; auto-save needs the mask output folder
        page.evaluate("window.__autosaveDelay = 300")
        page.locator(".tool-image-item").first.click()
        expect(page.locator("#tools-image-name")).to_have_text("a.png")
        page.locator("#tools-caption-text").fill("trig, auto saved caption")
        page.wait_for_function("window.calls.some((call) => call.name === 'save_tool_caption' && call.args.request.content.includes('auto saved caption'))", timeout=8000)
        expect(page.locator("#tools-autosave-status")).to_contain_text("Auto-saved")
        expect(page.locator(".tool-image-item.has-draft")).to_have_count(0)  # nothing is left unsaved
        page.locator("#tools-autosave").uncheck()  # off: edits stay drafts
        expect(page.locator("#tools-autosave-status")).to_contain_text("off")
        page.locator("#tools-caption-text").fill("trig, manual only")
        page.wait_for_timeout(1200)
        assert not any("manual only" in text for text in saved_captions())
        expect(page.locator(".tool-image-item.has-draft")).to_have_count(1)
        page.locator("#tools-autosave").check()  # on again: the pending edit is written
        page.wait_for_function("window.calls.some((call) => call.name === 'save_tool_caption' && call.args.request.content.includes('manual only'))", timeout=8000)
        page.locator("#tools-caption-text").fill("")  # an empty caption is never auto-saved
        page.wait_for_timeout(1200)
        assert "" not in saved_captions()
        page.locator("#tools-caption-text").fill("trig, auto saved caption")
        page.locator("#tools-mask-dir").fill("")
        page.locator("#tools-op-invert").click()  # a mask edit needs the mask output folder
        expect(page.locator("#tools-autosave-status")).to_contain_text("paused", timeout=8000)
        masks_before = page.evaluate("window.calls.filter((call) => call.name === 'save_tool_mask').length")
        page.locator("#tools-mask-dir").fill("C:/masks")  # once it is set, the paused auto-save resumes by itself
        page.wait_for_function("(before) => window.calls.filter((call) => call.name === 'save_tool_mask').length > before", arg=masks_before, timeout=8000)
        expect(page.locator("#tools-autosave-status")).to_contain_text("Auto-saved")
        page.evaluate("window.__autosaveDelay = 600000")

        # --- training selection: uncheck images in Tools, train on the checked ones only -------------
        page.locator("#tab-tools").click()
        expect(page.locator(".train-check")).to_have_count(3)
        for box in page.locator(".train-check").all():
            expect(box).to_be_checked()  # every image is used by default
        expect(page.locator("#tools-count")).to_contain_text("3 for training")
        page.locator(".tool-image-row").nth(1).locator(".train-check").uncheck()  # b.png
        expect(page.locator(".tool-image-row").nth(1)).to_have_class(re.compile("excluded"))
        expect(page.locator("#tools-count")).to_contain_text("2 for training")
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("t")  # T toggles the open image (a.png)
        expect(page.locator("#tools-count")).to_contain_text("1 for training")
        page.keyboard.press("t")
        expect(page.locator("#tools-count")).to_contain_text("2 for training")
        page.locator("#tools-train-none").click()
        expect(page.locator("#tools-count")).to_contain_text("0 for training")
        page.locator("#tools-train-all").click()
        expect(page.locator("#tools-count")).to_contain_text("3 for training")
        page.locator("#tools-train-none").click()
        page.locator(".tool-image-row").nth(1).locator(".train-check").check()
        page.locator("#tools-train-invert").click()  # used = {b} -> used = {a, c}: only b.png is left out
        expect(page.locator("#tools-count")).to_contain_text("2 for training")
        expect(page.locator(".tool-image-row").nth(1)).to_have_class(re.compile("excluded"))
        # the Train tab explains it and sends the unchecked images with the job
        page.locator("#tab-train").click()
        expect(page.locator("#tools-selection-summary")).to_contain_text("Training will use 2 of 3 images")
        page.locator("#checkpoint").fill("C:/models/sd15.safetensors")
        page.locator("#train-dataset").fill("C:/datasets/processed")
        page.locator("#train-output").fill("C:/outputs/run01")
        page.locator("#validate-training").click()
        page.wait_for_function("window.calls.some((call) => call.name === 'start_job' && call.args.kind === 'validate')")
        sent = page.evaluate("window.calls.filter((call) => call.name === 'start_job' && call.args.kind === 'validate').at(-1).args")
        assert sent["payload"]["excluded_sources"] == ["b.png"], sent
        send(status="succeeded")
        page.locator("#job-bar-dismiss").click()
        page.locator("#use-tools-selection").uncheck()  # ignore the Tools selection: everything is trained
        expect(page.locator("#tools-selection-summary")).to_contain_text("ignored")
        page.locator("#validate-training").click()
        page.wait_for_function("window.calls.filter((call) => call.name === 'start_job' && call.args.kind === 'validate').length === 2")
        sent = page.evaluate("window.calls.filter((call) => call.name === 'start_job' && call.args.kind === 'validate').at(-1).args")
        assert "excluded_sources" not in sent["payload"], sent
        send(status="succeeded")
        page.locator("#job-bar-dismiss").click()
        page.locator("#use-tools-selection").check()
        page.locator("#tab-tools").click()
        page.locator("#tools-train-all").click()

        # --- training parameters: dropdowns, built-in presets, repeats, and the total steps / time summary ---
        page.locator("#tab-train").click()
        expect(page.locator("#optimizer option")).to_have_count(9)
        expect(page.locator("#scheduler option")).to_have_count(6)
        expect(page.locator("#training-profile optgroup")).to_have_count(4)  # Recommended, Community, Basic (+ hidden My presets)
        expect(page.locator("#sum-images")).to_have_text("3")  # every image is checked in Tools again
        expect(page.locator("#summary-formula")).to_contain_text("Max train steps is set")
        page.locator("#training-profile").select_option("builtin:clothing-masked")  # applies as soon as it is picked
        expect(page.locator("#preset-description")).to_contain_text("Masked loss")
        for field, value in (("optimizer", "AdamW8bit"), ("scheduler", "cosine"), ("rank", "32"), ("alpha", "16"), ("repeats", "8"),
                             ("batch-size", "2"), ("epochs", "10"), ("steps", "0"), ("text-encoder-lr", "0.00005")):
            expect(page.locator("#" + field)).to_have_value(value)
        expect(page.locator("#use-masks")).to_be_checked()
        expect(page.locator("#training-mode-label")).to_have_text("SD1.5 · Masked LoRA")
        expect(page.locator("#sum-spe")).to_have_text("12")  # 3 images x 8 repeats / batch 2
        expect(page.locator("#sum-total")).to_have_text("120")
        expect(page.locator("#sum-time")).to_contain_text("about")
        expect(page.locator("#summary-note")).to_contain_text("rough guess")
        page.locator("#training-profile").select_option("builtin:clothing-nomask")
        expect(page.locator("#use-masks")).not_to_be_checked()
        for field, value in (("rank", "16"), ("alpha", "8"), ("repeats", "6"), ("epochs", "8")):
            expect(page.locator("#" + field)).to_have_value(value)
        expect(page.locator("#training-mode-label")).to_contain_text("no masks")
        assert page.evaluate("document.getElementById('train-masks').required") is False  # no mask folder is needed
        expect(page.locator("#sum-total")).to_have_text("72")  # 3 x 6 / 2 = 9 steps per epoch x 8 epochs
        page.locator("#repeats").fill("10")  # repeats are set in the GUI and the summary follows
        expect(page.locator("#sum-repeats")).to_have_text("10")
        expect(page.locator("#sum-spe")).to_have_text("15")
        expect(page.locator("#sum-total")).to_have_text("120")
        page.locator("#steps").fill("50")
        expect(page.locator("#sum-total")).to_have_text("50")
        expect(page.locator("#summary-formula")).to_contain_text("stops at 50 steps")
        page.locator("#steps").fill("0")
        expect(page.locator("#lr-cycles")).to_be_disabled()
        page.locator("#scheduler").select_option("cosine_with_restarts")
        expect(page.locator("#lr-cycles")).to_be_enabled()
        page.locator("#optimizer").select_option("Prodigy")
        expect(page.locator("#optimizer-hint")).to_contain_text("prodigyopt")
        expect(page.locator("#optimizer-hint")).to_contain_text("set Learning rate to 1")
        page.locator("#optimizer-args").fill("oops")
        page.locator("#validate-training").click()
        expect(page.locator("#notice")).to_contain_text("Optimizer arguments")
        page.locator("#optimizer-args").fill("weight_decay=0.01 d_coef=1.0")
        page.locator("#learning-rate").fill("1")
        page.locator("#validate-training").click()
        page.wait_for_function("window.calls.filter((call) => call.name === 'start_job' && call.args.kind === 'validate').length === 3")
        sent = page.evaluate("window.calls.filter((call) => call.name === 'start_job' && call.args.kind === 'validate').at(-1).args")["payload"]
        assert (sent["optimizer"], sent["lr_scheduler"], sent["repeats"], sent["epochs"], sent["steps"], sent["rank"], sent["resolution"]) == ("Prodigy", "cosine_with_restarts", 10, 8, 0, 16, 512), sent
        assert sent["use_masks"] is False and "mask_dir" not in sent and sent["optimizer_args"] == "weight_decay=0.01 d_coef=1.0", sent
        send(message="Dataset verified: 7 images", type="validated", samples=7)
        assert "7" in page.evaluate("Object.values(JSON.parse(localStorage.getItem('costume-train-images') || '{}')).join(',')")  # remembered for next time
        send(status="succeeded")
        page.locator("#job-bar-dismiss").click()
        page.locator("#training-profile").select_option("builtin:clothing-masked")
        page.locator("#train-form button[type=submit]").click()  # a real run teaches the time estimate
        page.wait_for_function("window.calls.some((call) => call.name === 'start_job' && call.args.kind === 'train')")
        sent = page.evaluate("window.calls.filter((call) => call.name === 'start_job' && call.args.kind === 'train').at(-1).args")["payload"]
        assert sent["use_masks"] is True and sent["mask_dir"] == "C:/datasets/processed/masks" and sent["batch_size"] == 2, sent
        send(message="steps:  10%|█         | 12/120 [00:06<00:54,  2.00it/s, avr_loss=0.1]")
        expect(page.locator("#summary-note")).to_contain_text("last training run")
        send(status="succeeded")
        page.locator("#job-bar-dismiss").click()
        page.locator("#training-profile").select_option("standard")
        page.locator("#load-profile").click()
        expect(page.locator("#steps")).to_have_value("1000")
        page.locator("#tab-tools").click()

        # --- model type, model files per type, and downloads ------------------------------------------
        def last_job(kind):
            return page.evaluate("(kind) => window.calls.filter((call) => call.name === 'start_job' && call.args.kind === kind).at(-1)?.args", kind)

        def finish_job():
            send(status="succeeded")
            page.locator("#job-bar-dismiss").click()

        page.locator("#tab-train").click()
        expect(page.locator("#model-family option")).to_have_count(7)
        expect(page.locator("#model-family")).to_have_value("sd15")
        page.locator("#checkpoint").fill("C:/models/sd15.safetensors")
        page.locator("#model-family").select_option("flux")
        expect(page.locator("#checkpoint")).to_have_value("")  # every type remembers its own files
        expect(page.locator('[data-component="clip_l"]')).to_be_visible()
        expect(page.locator('[data-component="gemma2"]')).to_be_hidden()
        expect(page.locator("#train-resolution")).to_have_value("1024")  # the type's recommended preset is applied
        expect(page.locator("#training-mode-label")).to_contain_text("FLUX.1")
        expect(page.locator("#training-profile optgroup[data-builtin] option")).to_have_count(4)
        for field in ("min-snr", "noise-offset", "clip-skip", "shuffle-caption", "text-encoder-lr"):
            expect(page.locator("#" + field)).to_be_disabled()  # flow-matching models do not use these
        expect(page.locator("#blocks-to-swap")).to_be_enabled()
        expect(page.locator("#download-info")).to_contain_text("4 files")
        page.locator("#model-family").select_option("anima")
        expect(page.locator("#fp8-base")).to_be_disabled()  # Anima has no fp8 base
        page.locator("#model-family").select_option("sdxl")
        expect(page.locator("#min-snr")).to_be_enabled()
        expect(page.locator("#blocks-to-swap")).to_be_disabled()
        page.locator("#model-family").select_option("flux")
        # bundle download: sends every missing file and the Hugging Face token
        page.locator("#tab-settings").click()
        page.locator("#hf-token").fill("hf_test_token")
        page.locator("#tab-train").click()
        page.locator("#download-source").select_option("flux-dev")
        expect(page.locator("#download-info")).to_contain_text("Gated")
        page.locator("#download-start").click()
        page.wait_for_function("window.calls.some((call) => call.name === 'start_job' && call.args.kind === 'download')")
        sent = last_job("download")["payload"]
        assert sent["model_family"] == "flux" and sent["hf_token"] == "hf_test_token" and len(sent["items"]) == 4, sent
        assert sent["items"][0]["url"].endswith("/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"), sent
        expect(page.locator("#job-bar-title")).to_have_text("Model download")
        send(message="flux1-dev.safetensors:  30%|███       | 7.1G/23.8G [01:15<02:50, 50MiB/s]")
        expect(page.locator("#job-bar-percent")).to_have_text("30%")
        send(message="Downloaded 4 files", type="downloaded", files={"checkpoint": "C:\\models\\base_models\\flux\\flux1-dev.safetensors", "ae": "C:/models/base_models/flux/ae.safetensors",
                                                                   "clip_l": "C:/models/base_models/flux/clip_l.safetensors", "t5xxl": "C:/models/base_models/flux/t5xxl_fp16.safetensors"}, base_model="")
        finish_job()
        expect(page.locator("#checkpoint")).to_have_value("C:/models/base_models/flux/flux1-dev.safetensors")  # filled in, slashes normalized
        expect(page.locator("#comp-ae")).to_have_value("C:/models/base_models/flux/ae.safetensors")
        expect(page.locator("#download-info")).to_contain_text("already set")
        # the training payload carries the type and only that type's files
        page.locator("#validate-training").click()
        page.wait_for_function("window.calls.some((call) => call.name === 'start_job' && call.args.kind === 'validate' && call.args.payload.model_family === 'flux')")
        sent = last_job("validate")["payload"]
        assert sent["checkpoint"].endswith("flux1-dev.safetensors") and sent["clip_l"].endswith("clip_l.safetensors") and sent["ae"].endswith("ae.safetensors"), sent
        assert "gemma2" not in sent and sent["resolution"] == 1024 and sent["use_masks"] is True, sent
        finish_job()
        # a pasted link or Civitai ID downloads as the base model and a mismatching base model is flagged
        page.locator("#download-url").fill("123")
        expect(page.locator("#download-info")).to_contain_text("Downloads the link")
        page.locator("#download-start").click()
        page.wait_for_function("window.calls.filter((call) => call.name === 'start_job' && call.args.kind === 'download').length === 2")
        sent = last_job("download")["payload"]
        assert sent["items"] == [{"key": "checkpoint", "url": "https://civitai.com/models/123"}], sent
        send(message="Downloaded 1 file", type="downloaded", files={"checkpoint": "C:/models/base_models/flux/civ.safetensors"}, base_model="SD 1.5")
        finish_job()
        expect(page.locator("#checkpoint")).to_have_value("C:/models/base_models/flux/civ.safetensors")
        expect(page.locator("#notice")).to_contain_text("SD 1.5")
        expect(page.locator("#download-url")).to_have_value("")
        page.locator("#download-url").fill("ftp://x/y")
        page.locator("#download-start").click()
        expect(page.locator("#notice")).to_contain_text("https://")
        page.locator("#download-url").fill("")
        # going back restores the SD1.5 files
        page.locator("#model-family").select_option("sd15")
        expect(page.locator("#checkpoint")).to_have_value("C:/models/sd15.safetensors")
        expect(page.locator('[data-component="clip_l"]')).to_be_hidden()
        expect(page.locator("#train-resolution")).to_have_value("512")
        expect(page.locator("#training-mode-label")).to_contain_text("SD1.5")
        page.locator("#tab-tools").click()

        # --- projects: autosave, switching, restore after reload --------------------------------
        page.locator("#tools-trigger").fill("alpha-trigger")
        page.wait_for_function("document.getElementById('project-status').textContent.startsWith('Autosaved')")
        page.locator("#project-new").click()
        page.locator("#project-name").fill("Second")
        page.locator("#project-dialog-ok").click()
        expect(page.locator("#project-select option")).to_have_count(2)
        expect(page.locator("#project-select")).to_have_value(re.compile(".+"))
        assert page.locator("#tools-trigger").input_value() == ""
        expect(page.locator("#page-train")).to_be_visible()  # a new project starts on the first page
        page.locator("#tab-tools").click()
        page.evaluate("document.querySelectorAll('#page-tools details').forEach((item) => { item.open = true; })")
        page.locator("#tools-trigger").fill("beta-trigger")
        first_id = page.evaluate("JSON.parse(localStorage.getItem('costume-projects')).projects[0].id")
        page.locator("#project-select").select_option(first_id)
        expect(page.locator("#tools-trigger")).to_have_value("alpha-trigger")
        page.locator("#tab-tools").click()
        page.reload()
        page.wait_for_function("document.getElementById('python-path').value !== ''")
        expect(page.locator("#tools-trigger")).to_have_value("alpha-trigger")
        expect(page.locator("#tools-root")).to_have_value("C:/raw")
        expect(page.locator("#page-tools")).to_be_visible()
        expect(page.locator(".tool-image-item")).to_have_count(3)  # folder reopened automatically
        saved = json.loads(page.evaluate("localStorage.getItem('costume-projects')"))
        assert [item["name"] for item in saved["projects"]] == ["My project", "Second"]

        # --- Mask Creation: opacity, split, full screen -----------------------------------------
        page.locator("#tab-mask").click()
        page.locator("#refresh-preview").click()
        expect(page.locator("#preview-canvas")).to_be_visible()
        page.locator("#preview-image-opacity").fill("40")
        page.locator('[data-preview="split"]').click()
        expect(page.locator("#preview-split")).to_be_enabled()
        page.locator("#preview-canvas").hover()
        expect(page.locator("#preview-fullscreen")).to_be_visible()
        page.locator("#preview-fullscreen").click()
        expect(page.locator(".preview-panel")).to_have_class(re.compile("fullscreen"))
        shot(page, "preview-fullscreen")
        page.keyboard.press("Escape")
        expect(page.locator(".preview-panel")).not_to_have_class(re.compile("fullscreen"))

        assert not errors, errors
        browser.close()
    print("UI features: tools shortcuts, mask ops, painting, review, full screen, zoom, dataset check, projects, preview: PASS")


if __name__ == "__main__":
    main()
