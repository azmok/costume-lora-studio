import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import comfy_setup


def zip_bytes(files: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)
    return buffer.getvalue()


class Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class PublishTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.output = self.root / "run"
        self.output.mkdir()
        for name in ("look.safetensors", "look-step00000250.safetensors", "look-step00000500.safetensors", "other.safetensors", "look.toml"):
            (self.output / name).write_bytes(b"x")

    def test_the_lora_and_its_step_versions_go_to_a_subfolder_of_the_lora_folder(self):
        result = comfy_setup.publish_lora(self.output, "look", str(self.root / "loras"))
        target = self.root / "loras" / "look"
        self.assertEqual(result["lora_dir"], target.as_posix())
        self.assertEqual(result["subfolder"], "look")
        self.assertEqual(sorted(path.name for path in target.iterdir()), ["look-step00000250.safetensors", "look-step00000500.safetensors", "look.safetensors"])
        self.assertEqual(result["final"], (target / "look.safetensors").as_posix())
        self.assertTrue((self.output / "look.safetensors").is_file())  # the training output is kept

    def test_an_existing_folder_is_never_overwritten(self):
        first = comfy_setup.publish_lora(self.output, "look", str(self.root / "loras"))
        second = comfy_setup.publish_lora(self.output, "look", str(self.root / "loras"))
        self.assertNotEqual(first["lora_dir"], second["lora_dir"])
        self.assertTrue(second["subfolder"].startswith("look_"))

    def test_no_lora_file_is_an_error(self):
        with self.assertRaisesRegex(ValueError, "No LoRA files"):
            comfy_setup.publish_lora(self.output, "missing", str(self.root / "loras"))


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.target = Path(self.tmp.name) / "comfyui" / "ComfyUI"
        self.events = []

    def emit(self, message, **details):
        self.events.append({"message": message, **details})

    def test_release_zip_is_unpacked_without_its_top_folder_and_unsafe_paths_are_refused(self):
        comfy_setup.extract_release(zip_bytes({"Comfy-Org-ComfyUI-abc/main.py": "x", "Comfy-Org-ComfyUI-abc/comfy/a.py": "y"}), self.target)
        self.assertTrue((self.target / "main.py").is_file())
        self.assertTrue((self.target / "comfy" / "a.py").is_file())
        with self.assertRaisesRegex(ValueError, "Unsafe path"):
            comfy_setup.extract_release(zip_bytes({"top/../../evil.py": "x"}), Path(self.tmp.name) / "other")

    def test_install_downloads_the_latest_release_then_builds_its_environment_with_uv(self):
        release = json.dumps({"tag_name": "v9.9.9", "zipball_url": "https://api.github.com/zip"}).encode()
        archive = zip_bytes({"top/main.py": "x", "top/requirements.txt": "aiohttp\n"})
        commands = []

        def fake_get(url, timeout=60):
            return Response(release if url == comfy_setup.RELEASE_API else archive)

        def fake_run(command, cwd=None, check=False):
            commands.append(command)
            if command[1] == "venv":
                python = Path(command[-1]) / ("Scripts" if sys.platform == "win32" else "bin")
                python.mkdir(parents=True)
                (python / ("python.exe" if sys.platform == "win32" else "python")).touch()
            return SimpleNamespace(returncode=0)

        with patch.object(comfy_setup, "_get", side_effect=fake_get), patch.object(comfy_setup.subprocess, "run", side_effect=fake_run), \
                patch.object(comfy_setup.shutil, "which", return_value="uv"):
            comfy_setup.install_comfyui({"comfy_install_dir": str(self.target)}, self.emit)
        self.assertTrue((self.target / "main.py").is_file())
        self.assertEqual([command[1:3] for command in commands], [["venv", "--python"], ["pip", "install"], ["pip", "install"]])
        self.assertIn("https://download.pytorch.org/whl/cu130", commands[1])
        self.assertIn(str(self.target / "requirements.txt"), commands[2])
        self.assertEqual(self.events[-1]["type"], "comfy_installed")
        self.assertTrue(any("v9.9.9" in event["message"] for event in self.events))

    def test_install_needs_uv_and_never_overwrites_a_foreign_folder(self):
        with patch.object(comfy_setup.shutil, "which", return_value=None):
            with self.assertRaisesRegex(ValueError, "uv was not found"):
                comfy_setup.install_comfyui({"comfy_install_dir": str(self.target)}, self.emit)
        self.target.mkdir(parents=True)
        (self.target / "notes.txt").write_text("mine")
        with patch.object(comfy_setup.shutil, "which", return_value="uv"):
            with self.assertRaisesRegex(ValueError, "not a ComfyUI folder"):
                comfy_setup.install_comfyui({"comfy_install_dir": str(self.target)}, self.emit)


if __name__ == "__main__":
    unittest.main()
