import json
from pathlib import Path
import re
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import desktop_backend as desktop
import model_download as dl


class UrlAndNameTests(unittest.TestCase):
    def test_only_https_links_and_plain_safetensors_names_are_accepted(self):
        self.assertEqual(dl.check_url(" https://huggingface.co/a/b/resolve/main/x.safetensors "), "https://huggingface.co/a/b/resolve/main/x.safetensors")
        for bad in ("http://example.com/a", "file:///etc/passwd", "ftp://x/y", "", None, "https://", "x" * 2100):
            with self.assertRaises(dl.DownloadError, msg=str(bad)[:20]):
                dl.check_url(bad)
        self.assertEqual(dl.safe_name("../../evil name.safetensors"), "evil name.safetensors")
        self.assertEqual(dl.safe_name("a/b\\c:d.SAFETENSORS"), "c_d.SAFETENSORS")
        for bad in ("model.ckpt", "model.pt", "", "--x.safetensors", "..", "x.safetensors.exe"):
            with self.assertRaises(dl.DownloadError, msg=bad):
                dl.safe_name(bad)

    def test_access_tokens_go_only_to_their_own_host(self):
        self.assertEqual(dl.auth_headers("https://huggingface.co/x", "hf", "cv")["Authorization"], "Bearer hf")
        self.assertEqual(dl.auth_headers("https://civitai.com/api/download/models/1", "hf", "cv")["Authorization"], "Bearer cv")
        self.assertNotIn("Authorization", dl.auth_headers("https://cas-bridge.xethub.hf.co/file", "hf", "cv"))
        self.assertNotIn("Authorization", dl.auth_headers("https://huggingface.co/x", "", ""))

    def test_civitai_links(self):
        self.assertEqual(dl.parse_civitai("https://civitai.com/models/123/some-name"), ("123", None))
        self.assertEqual(dl.parse_civitai("https://civitai.com/models/123?modelVersionId=456"), ("123", "456"))
        self.assertEqual(dl.parse_civitai("https://civitai.com/api/download/models/789?type=Model"), (None, "789"))
        self.assertEqual(dl.parse_civitai("https://civitai.com/user/x"), (None, None))

    def test_civitai_item_picks_the_primary_safetensors_file_and_reports_the_base_model(self):
        version = {"id": 456, "baseModel": "Illustrious", "files": [
            {"name": "x.ckpt", "type": "Model", "downloadUrl": "https://civitai.com/api/download/models/456?type=Model&format=PickleTensor"},
            {"name": "x-pruned.safetensors", "type": "Pruned Model", "downloadUrl": "https://civitai.com/api/download/models/456?type=Pruned"},
            {"name": "x.safetensors", "type": "Model", "primary": True, "downloadUrl": "https://civitai.com/api/download/models/456"},
        ]}
        calls = []
        def fake_json(url, key=""):
            calls.append(url)
            return {"modelVersions": [version]} if "/models/123" in url else version
        with patch.object(dl, "http_json", side_effect=fake_json):
            info = dl.civitai_item("https://civitai.com/models/123/name", "KEY")
            self.assertEqual((info["name"], info["base_model"], info["url"]), ("x.safetensors", "Illustrious", "https://civitai.com/api/download/models/456"))
            self.assertEqual(dl.civitai_item("https://civitai.com/api/download/models/456", "")["name"], "x.safetensors")
        self.assertEqual(calls, ["https://civitai.com/api/v1/models/123", "https://civitai.com/api/v1/model-versions/456"])
        with patch.object(dl, "http_json", return_value={"id": 1, "files": [{"name": "a.ckpt"}]}):
            with self.assertRaisesRegex(dl.DownloadError, "no .safetensors"):
                dl.civitai_item("https://civitai.com/api/download/models/1")
        with self.assertRaises(dl.DownloadError):
            dl.civitai_item("https://civitai.com/user/x")


class ProgressTests(unittest.TestCase):
    def test_aria2_readout_becomes_a_tqdm_style_line_the_job_bar_understands(self):
        parsed = dl.parse_readout("[#2f3a1c 1.2GiB/4.0GiB(30%) CN:16 DL:50MiB ETA:1m2s]")
        self.assertEqual(parsed[2:], (30, "50MiB/s", "01:02"))
        self.assertAlmostEqual(parsed[0] / (1 << 30), 1.2, places=3)
        self.assertIsNone(dl.parse_readout("Download Results:"))
        line = dl.progress_line("model.safetensors", *parsed, 75)
        self.assertRegex(line, r"^model\.safetensors:  30%\|███       \| 1\.20G/4\.00G \[01:15<01:02, 50MiB/s\]$")
        self.assertEqual(dl.eta_clock("1h2m3s"), "1:02:03")
        self.assertEqual(dl.eta_clock("45s"), "00:45")
        self.assertEqual(dl.eta_clock(None), "?")


class FakeResponse:
    def __init__(self, headers):
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class ResolveTests(unittest.TestCase):
    def test_redirects_are_followed_by_hand_and_the_token_never_reaches_the_cdn(self):
        seen = []

        def fake_open(request, timeout=0):
            seen.append((request.full_url, request.headers.get("Authorization")))
            if "huggingface.co" in request.full_url:
                raise urllib.error.HTTPError(request.full_url, 302, "Found", {"Location": "https://cas-bridge.xethub.hf.co/signed?x=1"}, None)
            return FakeResponse({"Content-Range": "bytes 0-0/4265146880"})

        opener = Mock()
        opener.open.side_effect = fake_open
        with patch("model_download.urllib.request.build_opener", return_value=opener):
            final, size = dl.resolve_url("https://huggingface.co/a/b/resolve/main/x.safetensors", "hf_secret")
        self.assertEqual((final, size), ("https://cas-bridge.xethub.hf.co/signed?x=1", 4265146880))
        self.assertEqual(seen[0], ("https://huggingface.co/a/b/resolve/main/x.safetensors", "Bearer hf_secret"))
        self.assertIsNone(seen[1][1])

    def test_gated_missing_and_unreachable_files_have_clear_errors(self):
        def raising(code):
            opener = Mock()
            opener.open.side_effect = urllib.error.HTTPError("https://huggingface.co/x", code, "x", {}, None)
            return patch("model_download.urllib.request.build_opener", return_value=opener)

        with raising(401):
            with self.assertRaisesRegex(dl.DownloadError, "accept the license.*token"):
                dl.resolve_url("https://huggingface.co/x")
        with raising(404):
            with self.assertRaisesRegex(dl.DownloadError, "File not found"):
                dl.resolve_url("https://huggingface.co/x")
        opener = Mock()
        opener.open.side_effect = urllib.error.URLError("offline")
        with patch("model_download.urllib.request.build_opener", return_value=opener):
            with self.assertRaisesRegex(dl.DownloadError, "Could not reach huggingface.co"):
                dl.resolve_url("https://huggingface.co/x")


class DownloadJobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.models = Path(self.tmp.name) / "models"
        self.events = []

    def emit(self, message, **details):
        self.events.append({"message": message, **details})

    def payload(self, **extra):
        return {"model_family": "flux", "models_dir": str(self.models), "hf_token": "hf", "civitai_key": "",
                "items": [{"key": "checkpoint", "url": "https://huggingface.co/a/b/resolve/main/sub/m.safetensors", "name": "m.safetensors"},
                          {"key": "ae", "url": "https://huggingface.co/a/b/resolve/main/ae.safetensors", "name": "ae.safetensors"}], **extra}

    def test_files_are_downloaded_into_the_family_folder_and_reported_by_component(self):
        runs = []

        def fake_run(exe, url, target, expected, emit):
            runs.append((url, target.name, expected))
            target.write_bytes(b"x" * expected)

        with patch.object(dl, "resolve_url", side_effect=lambda url, *a, **k: ("https://cdn.example/" + Path(url).name, 10)), \
                patch.object(dl, "aria2_path", return_value="aria2c"), patch.object(dl, "run_aria2", side_effect=fake_run):
            dl.download_items(self.payload(), self.emit)
        folder = self.models / "base_models" / "flux"
        self.assertEqual([item[1] for item in runs], ["m.safetensors", "ae.safetensors"])
        self.assertTrue((folder / "m.safetensors").is_file())
        done = self.events[-1]
        self.assertEqual(done["type"], "downloaded")
        self.assertEqual(done["files"], {"checkpoint": (folder / "m.safetensors").resolve().as_posix(), "ae": (folder / "ae.safetensors").resolve().as_posix()})
        runs.clear()  # a second run finds both files complete and downloads nothing
        with patch.object(dl, "resolve_url", return_value=("https://cdn.example/x", 10)), patch.object(dl, "aria2_path", return_value="aria2c"), \
                patch.object(dl, "run_aria2", side_effect=fake_run):
            dl.download_items(self.payload(), self.emit)
        self.assertEqual(runs, [])
        self.assertTrue(any("Already downloaded" in event["message"] for event in self.events))

    def test_bad_input_and_too_little_disk_space_stop_before_anything_is_downloaded(self):
        for patch_values, pattern in (({"model_family": "nope"}, "model_family"), ({"items": []}, "nothing to download"),
                                      ({"models_dir": ""}, "Models folder"), ({"items": [{"url": "http://x/y.safetensors"}]}, "https")):
            with self.subTest(patch_values):
                with self.assertRaisesRegex(dl.DownloadError, pattern):
                    dl.download_items(self.payload(**patch_values), self.emit)
        with patch.object(dl, "resolve_url", return_value=("https://cdn.example/x", 5 << 40)), patch.object(dl, "aria2_path") as aria:
            with self.assertRaisesRegex(dl.DownloadError, "Not enough disk space"):
                dl.download_items(self.payload(), self.emit)
        aria.assert_not_called()
        with patch.object(dl, "resolve_url", return_value=("https://cdn.example/x", 10)), patch.object(dl, "aria2_path", return_value="aria2c"), \
                patch.object(dl, "run_aria2", side_effect=lambda *a: None):
            dl.download_items({**self.payload(), "items": [{"key": "checkpoint", "url": "https://huggingface.co/a/b/resolve/main/..%2f..%2fm.safetensors", "name": "../../m.safetensors"}]}, self.emit)
        self.assertFalse((self.models / "m.safetensors").exists())  # names never leave the family folder

    def test_a_civitai_link_is_resolved_through_its_api_and_reports_the_base_model(self):
        info = {"url": "https://civitai.com/api/download/models/456", "name": "civ.safetensors", "base_model": "SDXL 1.0"}
        payload = {"model_family": "sdxl", "models_dir": str(self.models), "civitai_key": "KEY", "items": [{"key": "checkpoint", "url": "https://civitai.com/models/123"}]}
        with patch.object(dl, "civitai_item", return_value=info), patch.object(dl, "resolve_url", return_value=("https://r2.example/f", 4)), \
                patch.object(dl, "aria2_path", return_value="aria2c"), patch.object(dl, "run_aria2", side_effect=lambda exe, url, target, size, emit: target.write_bytes(b"1234")):
            dl.download_items(payload, self.emit)
        self.assertEqual(self.events[-1]["base_model"], "SDXL 1.0")
        self.assertTrue((self.models / "base_models" / "sdxl" / "civ.safetensors").is_file())

    def test_aria2_is_taken_from_path_or_the_tools_folder(self):
        with patch("model_download.shutil.which", return_value="C:/tools/aria2c.exe"):
            self.assertEqual(dl.aria2_path(Path(self.tmp.name) / "t"), "C:/tools/aria2c.exe")
        tools = Path(self.tmp.name) / "t"
        tools.mkdir()
        (tools / "aria2c.exe").touch()
        with patch("model_download.shutil.which", return_value=None):
            self.assertEqual(dl.aria2_path(tools), str(tools / "aria2c.exe"))


class RegistryParityTests(unittest.TestCase):
    """The UI list (ui/model-families.mjs) and the backend list must describe the same families and components."""

    def test_ui_and_backend_families_agree(self):
        source = (Path(__file__).resolve().parents[1] / "ui" / "model-families.mjs").read_text(encoding="utf-8")
        body = source[source.index("export const FAMILIES"):source.index("export const DEFAULT_FAMILY")]
        ui = {}
        for chunk in re.split(r"\n  \{\n    id: ", body)[1:]:
            family_id = re.match(r'"(\w+)"', chunk).group(1)
            keys = re.findall(r'\{ key: "(\w+)", label: "[^"]*", required: (true|false)', chunk)
            ui[family_id] = ([key for key, required in keys if required == "true"], [key for key, required in keys if required == "false"])
        self.assertEqual(list(ui), list(desktop.FAMILIES))
        self.assertEqual(list(ui), list(dl.FAMILY_IDS))
        for family_id, (required, optional) in ui.items():
            self.assertEqual(tuple(required), desktop.FAMILIES[family_id]["required"], family_id)
            self.assertEqual(tuple(optional), desktop.FAMILIES[family_id]["optional"], family_id)


if __name__ == "__main__":
    unittest.main()
