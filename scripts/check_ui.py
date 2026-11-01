"""Exercise frontend interactions using a mocked native bridge in headless Edge."""

from pathlib import Path
import mimetypes
from urllib.parse import urlparse

from playwright.sync_api import sync_playwright, expect


MOCK_BRIDGE = """
window.calls = [];
window.handlers = {};
window.__TAURI__ = {
  event: { listen: async (name, callback) => { window.handlers[name] = callback; return () => {}; } },
  core: { invoke: async (name, args) => {
    window.calls.push({ name, args });
    if (name === 'load_settings') return {
      python_path:'C:/runtime/inference/python.exe', training_python:'C:/runtime/training/python.exe',
      engine_dir:'C:/engine', models_dir:'C:/models', tokenizer_dir:'C:/tokenizers'
    };
    if (name === 'job_status') return { snapshot: null, logs: [] };
    if (name === 'choose_path') return 'C:/raw';
    if (name === 'start_job') return 'test-job';
    if (name === 'scan_images') return [];
    return null;
  } }
};
window.finish = (status) => window.handlers['job-event']({
  payload: {jobId:'test-job', data:{status, message:status}}
});
"""


def main():
    project = Path(__file__).resolve().parents[1]
    artifacts = project / ".qa-temp"
    artifacts.mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
            headless=True,
        )
        page = browser.new_page(viewport={"width": 1440, "height": 1100}, reduced_motion="reduce")
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
        expect(page.locator("#page-train")).to_be_visible()
        page.locator("#steps").fill("1500")
        page.locator("#save-profile").click()
        page.locator("#steps").fill("1000")
        page.locator("#load-profile").click()
        expect(page.locator("#steps")).to_have_value("1500")
        page.locator("#training-profile").select_option("standard")
        page.locator("#load-profile").click()
        expect(page.locator("#steps")).to_have_value("1000")
        page.locator('[data-page="mask"]').click()
        page.locator("#mask-form button[type=submit]").click()
        assert not page.evaluate("window.calls.some(call => call.name === 'start_job')")
        page.locator('[data-target="raw-dir"]').click()
        expect(page.locator("#raw-dir")).to_have_value("C:/raw")
        page.locator("#mask-dir").fill("C:/masks")
        page.screenshot(path=str(artifacts / "desktop-mask.png"), full_page=True)
        page.locator("#mask-form button[type=submit]").click()
        expect(page.locator("#cancel-job")).to_be_enabled()
        expect(page.locator("#mask-form button[type=submit]")).to_be_disabled()
        page.locator("#cancel-job").click()
        assert page.evaluate("window.calls.some(call => call.name === 'cancel_job' && call.args.jobId === 'test-job')")
        page.evaluate("window.finish('cancelled')")
        expect(page.locator("#job-status")).to_have_text("Cancelled")
        page.locator('[data-page="dataset"]').click()
        expect(page.locator("#dataset-raw")).to_have_value("C:/raw")
        page.locator("#dataset-out").fill("C:/processed")
        page.locator("#trigger-word").fill(" ")
        page.locator("#dataset-form button[type=submit]").click()
        expect(page.locator("#notice")).to_contain_text("Trigger word")
        page.locator("#trigger-word").fill("my_costume")
        page.locator("#dataset-form button[type=submit]").click()
        page.wait_for_function("window.calls.some(call => call.name === 'start_job' && call.args.kind === 'dataset')")
        request = page.evaluate("window.calls.filter(call => call.name === 'start_job').at(-1).args")
        assert request["payload"]["mask_dir"] == "C:/masks"
        assert request["payload"]["max_resolution"] == 512
        page.evaluate("window.finish('succeeded')")
        page.locator('[data-page="train"]').click()
        page.locator("#checkpoint").fill("C:/models/sd15.safetensors")
        page.locator("#train-output").fill("C:/output")
        page.locator("#alpha").fill("17")
        page.locator("#validate-training").click()
        expect(page.locator("#notice")).to_contain_text("Alpha")
        page.locator("#alpha").fill("16")
        page.locator('[data-section="advanced-section"]').click()
        page.locator("#seed").fill("")
        page.locator("#advanced-section").evaluate("(node) => node.open = false")
        page.locator("#validate-training").click()
        expect(page.locator("#advanced-section")).to_have_attribute("open", "")
        expect(page.locator("#seed")).to_be_focused()
        page.locator("#seed").fill("42")
        page.locator("#validate-training").click()
        page.wait_for_function("window.calls.some(call => call.name === 'start_job' && call.args.kind === 'validate')")
        page.evaluate("window.finish('succeeded')")
        page.locator("#advanced-section").evaluate("(node) => node.open = false")
        page.screenshot(path=str(artifacts / "desktop-train.png"), full_page=True)
        for tab in ("mask", "dataset", "train", "settings"):
            page.locator(f'[data-page="{tab}"]').click()
            assert page.locator(f"#page-{tab}").is_visible()
        page.locator("#tab-train").focus()
        page.keyboard.press("ArrowRight")
        expect(page.locator("#tab-dataset")).to_have_attribute("aria-selected", "true")
        expect(page.locator("#page-dataset")).to_be_visible()
        page.keyboard.press("Home")
        expect(page.locator("#page-train")).to_be_visible()
        page.set_viewport_size({"width": 800, "height": 700})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path=str(artifacts / "desktop-compact.png"), full_page=True)
        page.set_viewport_size({"width": 375, "height": 812})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.locator('[data-page="settings"]').click()
        expect(page.locator("#page-settings")).to_be_visible()
        page.screenshot(path=str(artifacts / "kohya-mobile.png"), full_page=True)
        assert not errors, errors
        browser.close()
    print("UI: kohya-style tabs, profiles, empty input, folded validation, keyboard navigation, mask reuse, cancellation, 800px/375px layout: PASS")


if __name__ == "__main__":
    main()
