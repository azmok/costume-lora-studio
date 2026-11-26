import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import dataset_generator as generator


HAS_IMAGES = all(importlib.util.find_spec(module) for module in ("PIL", "numpy"))


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        self.output = self.root / "processed"
        self.args = generator.parser().parse_args([
            "--input_dir", str(self.raw), "--output_dir", str(self.output),
            "--trigger_word", "my_costume", "--caption_mode", "tag",
        ])

    def tearDown(self):
        self.directory.cleanup()

    def test_empty_cli_values_are_rejected(self):
        for argument in ("--trigger_word", "--input_dir", "--output_dir", "--mask_prompt"):
            with self.subTest(argument=argument), patch("sys.stderr"):
                with self.assertRaises(SystemExit) as caught:
                    generator.parser().parse_args([
                        "--trigger_word", "costume", "--caption_mode", "tag", argument, "   ",
                    ])
                self.assertEqual(caught.exception.code, 2)

    def test_empty_enter_input_is_rejected(self):
        with self.assertRaises(Exception):
            generator.nonempty("\n")

    def test_missing_arguments_do_not_prompt(self):
        result = subprocess.run([sys.executable, str(Path(generator.__file__)), ],
                                input="\n", capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--trigger_word", result.stderr)

    def test_empty_directory(self):
        with self.assertRaisesRegex(ValueError, "No supported images"):
            generator.validate_inputs(self.args)

    def test_missing_directory(self):
        self.args.input_dir = str(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "Input directory missing"):
            generator.validate_inputs(self.args)

    def test_overlapping_paths(self):
        self.args.output_dir = str(self.raw / "output")
        with self.assertRaisesRegex(ValueError, "must not overlap"):
            generator.validate_inputs(self.args)

    def test_existing_output_is_preserved(self):
        self.output.mkdir()
        sentinel = self.output / "keep.txt"
        sentinel.write_text("keep", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "never overwritten"):
            generator.validate_inputs(self.args)
        self.assertEqual(sentinel.read_text(), "keep")

    def test_same_stem_collision(self):
        for name in ("sample.jpg", "sample.png"):
            (self.raw / name).touch()
        with self.assertRaisesRegex(ValueError, "same stem"):
            generator.validate_inputs(self.args)

    def test_different_directories_allow_same_name(self):
        for name in ("front", "back"):
            (self.raw / name).mkdir()
            (self.raw / name / "sample.png").touch()
        self.assertEqual(len(generator.validate_inputs(self.args)), 2)

    def test_trigger_rejects_multiline_and_comma(self):
        for trigger in ("name\nother", "name,other"):
            self.args.trigger_word = trigger
            with self.assertRaisesRegex(ValueError, "Trigger"):
                generator.validate_inputs(self.args)

    def test_invalid_thresholds(self):
        for value in ("-0.1", "1.1", "nan", "inf"):
            with self.assertRaises(Exception):
                generator.probability(value)
        self.args.min_mask_fraction = 0.9
        self.args.max_mask_fraction = 0.1
        with self.assertRaisesRegex(ValueError, "min_mask_fraction"):
            generator.validate_inputs(self.args)

    def test_long_edge_and_no_upscale(self):
        self.assertEqual(generator.target_size((1600, 800), 512, "long", False), (512, 256))
        self.assertEqual(generator.target_size((200, 100), 512, "long", False), (200, 100))
        self.assertEqual(generator.target_size((200, 100), 512, "long", True), (512, 256))

    def test_short_edge_and_thin_image(self):
        self.assertEqual(generator.target_size((1600, 800), 512, "short", False), (1024, 512))
        self.assertEqual(generator.target_size((1, 10000), 512, "long", False), (1, 512))

    def test_blacklist_keeps_pose_hair_and_background(self):
        tags = ["red_dress", "long_sleeves", "blue_hair", "braid", "landscape", "bowing", "sitting", "sitting"]
        self.assertEqual(generator.filter_tags(tags, generator.DEFAULT_BLACKLIST),
                         ["blue hair", "braid", "landscape", "bowing", "sitting"])
        self.assertEqual(generator.filter_tags(["sitting", "standing"], ("sit*",)), ["standing"])

    def test_caption_validation(self):
        with self.assertRaises(ValueError):
            generator.validate_caption(" \n ")
        self.assertEqual(generator.validate_caption(" Standing\n outside. "), "Standing outside.")

    def test_local_snapshot_missing(self):
        with self.assertRaisesRegex(ValueError, "Local model directory missing"):
            generator.require_snapshot(self.root / "missing")
        with self.assertRaisesRegex(ValueError, "Required local model file missing"):
            generator.require_snapshot(self.raw)

    def test_offline_environment(self):
        for name in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
            self.assertEqual(os.environ[name], "1")

    def test_export_trainer_configs(self):
        image_dir = self.root / "images" / "group"
        image_dir.mkdir(parents=True)
        (image_dir / "sample.png").touch()
        generator.export_configs(self.root, self.output, self.args)
        kohya = tomllib.loads((self.root / "kohya_dataset.toml").read_text(encoding="utf-8"))
        subset = kohya["datasets"][0]["subsets"][0]
        self.assertTrue(subset["conditioning_data_dir"].endswith("/masks/group"))
        toolkit = json.loads((self.root / "ai_toolkit_dataset.json").read_text())
        self.assertEqual(toolkit["datasets"][0]["mask_min_value"], 0.0)
        self.assertTrue(toolkit["datasets"][0]["folder_path"].endswith("/images/group"))


@unittest.skipUnless(HAS_IMAGES, "Pillow and numpy required for pixel and integration tests")
class ImageTests(unittest.TestCase):
    def setUp(self):
        CoreTests.setUp(self)
        from PIL import Image

        Image.new("RGB", (80, 40), "red").save(self.raw / "sample.png")

    def tearDown(self):
        CoreTests.tearDown(self)

    def test_resize_binary_and_alignment(self):
        import numpy as np
        from PIL import Image

        image = Image.new("RGB", (80, 40))
        mask = Image.new("L", image.size)
        mask.paste(255, (20, 10, 60, 30))
        resized, binary = generator.resize_pair(image, mask, (40, 20))
        self.assertEqual(resized.size, binary.size)
        self.assertEqual(binary.mode, "L")
        self.assertEqual(set(np.unique(np.asarray(binary))), {0, 255})
        self.assertEqual(binary.getpixel((15, 10)), 255)
        with self.assertRaisesRegex(ValueError, "differs"):
            generator.resize_pair(image, Image.new("L", (1, 1)), (40, 20))

    def test_exif_and_transparency(self):
        from PIL import Image

        transparent = self.raw / "transparent.png"
        Image.new("RGBA", (10, 20), (255, 0, 0, 0)).save(transparent)
        self.assertEqual(generator.load_image(transparent).getpixel((0, 0)), (255, 255, 255))
        image = Image.new("RGB", (10, 20))
        exif = image.getexif()
        exif[274] = 6
        rotated = self.raw / "rotated.jpg"
        image.save(rotated, exif=exif)
        self.assertEqual(generator.load_image(rotated).size, (20, 10))

    def run_pipeline(self, mask_color=None):
        from PIL import Image

        class Captioner:
            def __init__(self, args, patterns):
                pass

            def caption(self, image):
                return "sitting, outdoors"

        class Segmenter:
            def __init__(self, args):
                pass

            def segment(self, image):
                mask = Image.new("L", image.size, mask_color or 0)
                if mask_color is None:
                    mask.paste(255, (20, 10, 60, 30))
                return mask

        return generator.generate(self.args, Captioner, Segmenter)

    def test_pipeline_without_network(self):
        import numpy as np
        from PIL import Image

        self.args.max_resolution = 40
        with patch("socket.socket", side_effect=AssertionError("Network is forbidden")):
            result = self.run_pipeline()
        metadata = json.loads((result / "metadata.json").read_text())
        record = metadata["images"][0]
        with Image.open(result / record["image"]) as image, Image.open(result / record["mask"]) as mask:
            self.assertEqual(image.size, (40, 20))
            self.assertEqual(image.size, mask.size)
            self.assertEqual(mask.mode, "L")
            self.assertEqual(set(np.unique(np.asarray(mask))), {0, 255})
        self.assertEqual((result / record["image"]).with_suffix(".txt").read_text().strip(), "my_costume, sitting, outdoors")

    def test_failure_does_not_publish(self):
        with self.assertRaisesRegex(RuntimeError, "Suspicious mask"):
            self.run_pipeline(mask_color=255)
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.root.glob(".costume-dataset-*")), [])

    def test_continue_on_corrupt_image(self):
        (self.raw / "broken.png").write_bytes(b"not an image")
        self.args.continue_on_error = True
        result = self.run_pipeline()
        metadata = json.loads((result / "metadata.json").read_text())
        self.assertEqual(len(metadata["images"]), 1)
        self.assertEqual(len(metadata["errors"]), 1)
        self.assertEqual(len(list((result / "images").rglob("*.png"))), 1)

    def test_wd14_bgr_input_and_category_filtering(self):
        import numpy as np
        from PIL import Image

        captured = {}

        class Session:
            def __init__(self, path, providers):
                captured["providers"] = providers

            def get_inputs(self):
                return [SimpleNamespace(name="input", shape=[None, 4, 4, 3])]

            def run(self, outputs, inputs):
                captured["input"] = inputs["input"]
                return [np.array([[0.99, 0.9, 0.9, 0.9, 0.1]])]

        model_dir = self.root / "wd14"
        model_dir.mkdir()
        (model_dir / "selected_tags.csv").write_text(
            "name,category\nsafe,9\nred_dress,0\nsitting,0\nsome_character,4\noutdoors,0\n",
            encoding="utf-8",
        )
        self.args.wd_model_dir = model_dir
        with patch.dict("sys.modules", {"onnxruntime": SimpleNamespace(InferenceSession=Session)}):
            engine = generator.WD14Captioner(self.args, generator.DEFAULT_BLACKLIST)
        self.assertEqual(engine.caption(Image.new("RGB", (4, 4), (255, 0, 0))), "sitting")
        self.assertEqual(captured["input"].shape, (1, 4, 4, 3))
        self.assertEqual(captured["input"].dtype, np.float32)
        self.assertEqual(captured["input"][0, 0, 0].tolist(), [0, 0, 255])

    def test_failed_mask_skipped_without_orphan_image(self):
        from PIL import Image

        Image.new("RGB", (80, 40), "blue").save(self.raw / "bad.png")
        self.args.continue_on_error = True

        class Captioner:
            def __init__(self, args, patterns):
                pass

            def caption(self, image):
                return "standing"

        class Segmenter:
            def __init__(self, args):
                pass

            def segment(self, image):
                if image.getpixel((0, 0)) == (0, 0, 255):
                    raise ValueError("No clothing detected")
                mask = Image.new("L", image.size)
                mask.paste(255, (20, 10, 60, 30))
                return mask

        result = generator.generate(self.args, Captioner, Segmenter)
        metadata = json.loads((result / "metadata.json").read_text())
        self.assertEqual(len(metadata["images"]), 1)
        self.assertEqual(metadata["errors"][0]["stage"], "mask")
        self.assertEqual(len(list((result / "images").rglob("*.png"))), 1)
        self.assertEqual(len(list((result / "images").rglob("*.txt"))), 1)
        self.assertEqual(len(list((result / "masks").rglob("*.png"))), 1)


if __name__ == "__main__":
    unittest.main()


class ModelHintTest(unittest.TestCase):
    def test_missing_model_error_lists_parent_and_download_command(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "wd14").mkdir()
            with self.assertRaises(ValueError) as caught:
                generator.require_snapshot(Path(root) / "grounding-dino")
            message = str(caught.exception)
            self.assertIn("wd14", message)
            self.assertIn("hf download IDEA-Research/grounding-dino-tiny", message)


class ModelDownloadTest(unittest.TestCase):
    def test_missing_model_is_downloaded_only_when_requested(self):
        with tempfile.TemporaryDirectory() as root:
            target = Path(root) / "sam"

            def fake_run(command, **kwargs):
                compile(command[2], "<child>", "exec")
                self.assertEqual(command[3:5], ["facebook/sam-vit-base", str(target)])
                self.assertEqual(kwargs["env"]["HF_HUB_OFFLINE"], "0")
                self.assertIs(kwargs["stdout"], sys.stderr)
                target.mkdir()
                (target / "config.json").write_text("{}")
                return SimpleNamespace(returncode=0)

            with patch.object(generator.subprocess, "run", side_effect=fake_run) as run:
                with self.assertRaises(ValueError):
                    generator.require_snapshot(target)
                run.assert_not_called()
                generator.require_snapshot(target, download=True)
                run.assert_called_once()
                generator.require_snapshot(target, download=True)
                run.assert_called_once()

    def test_failed_download_reports_clear_error(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(generator.subprocess, "run", return_value=SimpleNamespace(returncode=1)):
                with self.assertRaises(ValueError) as caught:
                    generator.require_snapshot(Path(root) / "grounding-dino", download=True)
            self.assertIn("download failed", str(caught.exception))


class GroundedSAMFixTest(unittest.TestCase):
    def test_defaults_use_buruma_safe_prompts(self):
        self.assertEqual(generator.CLOTHES_PROMPT, "white shirt, t-shirt, shorts, underwear, swimsuit")
        self.assertEqual(generator.EXCLUDE_PROMPT, "face, hair")

    def test_sam_receives_guide_points_and_ignores_giant_exclude_box(self):
        if not HAS_IMAGES or importlib.util.find_spec("torch") is None:
            self.skipTest("torch/PIL/numpy required")
        import numpy as np
        import torch
        from PIL import Image

        seg = object.__new__(generator.GroundedSAM)
        seg.device = "cpu"
        seg.args = SimpleNamespace(
            mask_prompt="white shirt, shorts, ",
            exclude_prompt="face, hair, background",
            mask_points=[{"x": 50, "y": 50, "label": 1}],
        )
        # Clothing box is 20..80 (36% area); giant exclude box is 0..100 (100% area -> must be ignored!)
        seg.detect = lambda image, prompt: (
            torch.tensor([[20.0, 20.0, 80.0, 80.0]]) if "shirt" in prompt
            else torch.tensor([[0.0, 0.0, 100.0, 100.0]])
        )
        sam_calls = []

        class FakeInputs(dict):
            def __getattr__(self, key):
                return self[key]
            def to(self, device):
                return self

        class FakeProc:
            def __call__(self, **kwargs):
                out = {"pixel_values": torch.zeros((1, 3, 4, 4)), "original_sizes": torch.tensor([[100, 100]]), "reshaped_input_sizes": torch.tensor([[100, 100]])}
                if "input_boxes" in kwargs:
                    out["input_boxes"] = torch.tensor(kwargs["input_boxes"])
                if "input_points" in kwargs:
                    out["input_points"] = torch.tensor(kwargs["input_points"])
                    out["input_labels"] = torch.tensor(kwargs["input_labels"])
                return FakeInputs(out)
            image_processor = SimpleNamespace(
                post_process_masks=lambda pred, orig, reshaped: [torch.ones((1, 1, 100, 100), dtype=torch.bool)]
            )

        class FakeSAM:
            def get_image_embeddings(self, pv):
                return torch.zeros((1, 1))
            def __call__(self, **kwargs):
                sam_calls.append(kwargs)
                return SimpleNamespace(pred_masks=torch.ones((1, 1, 100, 100)))

        seg.sam_processor = FakeProc()
        seg.sam = FakeSAM()
        result = seg.segment(Image.new("RGB", (100, 100), "white"))
        # Only the clothing box should have been passed to SAM (giant exclude box dropped), WITH input_points/input_labels!
        self.assertEqual(len(sam_calls), 1)
        self.assertIn("input_points", sam_calls[0])
        self.assertIn("input_labels", sam_calls[0])
        self.assertGreater(np.count_nonzero(np.asarray(result)), 0)

    def test_sam_detects_from_painted_guide_mask_even_when_text_detects_nothing(self):
        if not HAS_IMAGES or importlib.util.find_spec("torch") is None:
            self.skipTest("torch/PIL/numpy required")
        import numpy as np
        import torch
        from PIL import Image

        guide = Image.new("L", (120, 120), 0)
        guide.paste(255, (30, 40, 90, 95))
        seg = object.__new__(generator.GroundedSAM)
        seg.device = "cpu"
        seg.args = SimpleNamespace(
            mask_prompt="bloomers",
            exclude_prompt="",
            mask_points=[],
            guide_mask=guide,
        )
        # GroundingDINO finds 0 boxes, yet SAM must still run from the painted area!
        seg.detect = lambda image, prompt: torch.empty((0, 4), dtype=torch.float32)
        sam_calls = []

        class FakeInputs(dict):
            def __getattr__(self, key):
                return self[key]
            def to(self, device):
                return self

        class FakeProc:
            def __call__(self, **kwargs):
                out = {"pixel_values": torch.zeros((1, 3, 4, 4)), "original_sizes": torch.tensor([[120, 120]]), "reshaped_input_sizes": torch.tensor([[120, 120]])}
                if "input_boxes" in kwargs:
                    out["input_boxes"] = torch.tensor(kwargs["input_boxes"])
                if "input_points" in kwargs:
                    out["input_points"] = torch.tensor(kwargs["input_points"])
                    out["input_labels"] = torch.tensor(kwargs["input_labels"])
                return FakeInputs(out)
            image_processor = SimpleNamespace(
                post_process_masks=lambda pred, orig, reshaped: [torch.ones((1, 1, 120, 120), dtype=torch.bool)]
            )

        class FakeSAM:
            def get_image_embeddings(self, pv):
                return torch.zeros((1, 1))
            def __call__(self, **kwargs):
                sam_calls.append(kwargs)
                return SimpleNamespace(pred_masks=torch.ones((1, 1, 120, 120)))

        seg.sam_processor = FakeProc()
        seg.sam = FakeSAM()
        result = seg.segment(Image.new("RGB", (120, 120), "white"))
        self.assertEqual(len(sam_calls), 1)
        self.assertIn("input_points", sam_calls[0])
        self.assertEqual(sam_calls[0]["input_points"].shape[-2], 8)  # sampled interior points from painted area
        self.assertGreater(np.count_nonzero(np.asarray(result)), 0)
