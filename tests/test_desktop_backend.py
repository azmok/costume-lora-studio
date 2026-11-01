import json
from pathlib import Path
import tempfile
import tomllib
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import desktop_backend as desktop
import dataset_generator as generator

try:
    from PIL import Image
    import numpy
    HAS_IMAGES = True
except ImportError:
    HAS_IMAGES = False


class ValidationTests(unittest.TestCase):
    def test_caption_preview_does_not_replace_an_existing_text_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            output = root / "captions"
            raw.mkdir()
            output.mkdir()
            image = raw / "sample.png"
            image.touch()
            caption = output / "sample.txt"
            caption.write_text("user edit", encoding="utf-8")
            payload = {"input_dir": str(raw), "output_dir": str(output), "models_dir": str(root / "models"),
                       "image_path": str(image), "trigger_word": "costume", "caption_prompt": "Describe pose."}
            engine = Mock()
            engine.caption.return_value = "standing outdoors"
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit") as emitted:
                desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual(caption.read_text(), "user edit")
            self.assertEqual(emitted.call_args.kwargs["caption"], "costume, standing outdoors")

    def test_caption_batch_writes_matching_names_and_keeps_source_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir()
            source = raw / "sample.png"
            source.write_bytes(b"unchanged")
            payload = {"input_dir": str(raw), "output_dir": str(root / "captions"),
                       "models_dir": str(root / "models"), "trigger_word": "costume", "caption_prompt": "Describe pose."}
            engine = Mock()
            engine.caption.return_value = "sitting"
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit"):
                output = desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual((output / "sample.txt").read_text().strip(), "costume, sitting")
            self.assertEqual(source.read_bytes(), b"unchanged")

    def test_caption_batch_with_blank_output_writes_beside_images_and_keeps_existing(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir()
            (raw / "a.png").write_bytes(b"a")
            (raw / "b.png").write_bytes(b"b")
            (raw / "b.txt").write_text("my own caption", encoding="utf-8")
            payload = {"input_dir": str(raw), "output_dir": "",
                       "models_dir": str(root / "models"), "trigger_word": "costume", "caption_prompt": "Describe pose."}
            engine = Mock()
            engine.caption.return_value = "sitting"
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit"):
                desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual((raw / "a.txt").read_text().strip(), "costume, sitting")
            self.assertEqual((raw / "b.txt").read_text(), "my own caption")
            self.assertEqual(engine.caption.call_count, 1)
            self.assertEqual(sorted(path.name for path in root.iterdir()), ["raw"])

    def test_blank_instruction_is_allowed_for_taggers_but_not_for_qwen(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir()
            (raw / "a.png").write_bytes(b"a")
            payload = {"input_dir": str(raw), "output_dir": "", "models_dir": str(root / "models"),
                       "trigger_word": "costume", "caption_prompt": "", "caption_model": "qwen2-vl"}
            with self.assertRaises(ValueError):
                desktop.generate_captions(payload)
            engine = Mock()
            engine.caption.return_value = "tag_a"
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit"):
                desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual((raw / "a.txt").read_text().strip(), "costume, tag_a")

    def _caption_fixture(self, root, output_dir):
        raw = root / "raw"
        raw.mkdir()
        for name in ("a", "b", "c"):
            (raw / f"{name}.png").write_bytes(name.encode())
            (raw / f"{name}.txt").write_text(f"old {name}", encoding="utf-8")
        payload = {"input_dir": str(raw), "output_dir": output_dir, "models_dir": str(root / "models"),
                   "trigger_word": "costume", "caption_prompt": "Describe."}
        engine = Mock()
        engine.caption.return_value = "new"
        return raw, payload, engine

    def test_overwrite_replaces_only_the_chosen_images(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw, payload, engine = self._caption_fixture(root, "")
            payload.update(image_paths=[str(raw / "a.png"), str(raw / "b.png")], overwrite=True)
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit"):
                desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual((raw / "a.txt").read_text().strip(), "costume, new")
            self.assertEqual((raw / "b.txt").read_text().strip(), "costume, new")
            self.assertEqual((raw / "c.txt").read_text(), "old c")
            self.assertEqual(engine.caption.call_count, 2)

    def test_without_overwrite_existing_captions_are_kept_and_all_skipped_is_an_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw, payload, engine = self._caption_fixture(root, "")
            (raw / "c.txt").unlink()
            payload.update(image_paths=[str(raw / "b.png"), str(raw / "c.png")], overwrite=False)
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit"):
                desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual((raw / "b.txt").read_text(), "old b")
            self.assertEqual((raw / "c.txt").read_text().strip(), "costume, new")
            payload["image_paths"] = [str(raw / "a.png")]
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit"):
                with self.assertRaises(ValueError):
                    desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual((raw / "a.txt").read_text(), "old a")

    def test_separate_folder_merges_and_rejects_images_outside_the_source(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw, payload, engine = self._caption_fixture(root, str(root / "captions"))
            captions = root / "captions"
            captions.mkdir()
            (captions / "a.txt").write_text("kept", encoding="utf-8")
            payload["overwrite"] = False
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit"):
                desktop.generate_captions(payload, lambda args: engine)
            self.assertEqual((captions / "a.txt").read_text(), "kept")
            self.assertEqual((captions / "b.txt").read_text().strip(), "costume, new")
            payload.update(image_paths=[str(root / "elsewhere.png")], overwrite=True)
            with self.assertRaises(ValueError):
                desktop.generate_captions(payload, lambda args: engine)
            payload.update(image_paths=[str(raw / "a.png")], overwrite="yes")
            with self.assertRaises(ValueError):
                desktop.generate_captions(payload, lambda args: engine)

    def test_caption_job_reports_its_phases_in_order_with_counts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            raw = root / "raw"
            raw.mkdir()
            for name in ("a", "b"):
                (raw / f"{name}.png").write_bytes(name.encode())
            payload = {"input_dir": str(raw), "output_dir": "", "models_dir": str(root / "models"),
                       "trigger_word": "costume", "caption_prompt": "Describe."}
            engine = Mock()
            engine.caption.return_value = "x"
            with patch("dataset_generator.load_image", return_value=object()), patch("desktop_backend.emit") as emitted:
                desktop.generate_captions(payload, lambda args: engine)
            events = [call.kwargs for call in emitted.call_args_list]
            phases = [event["phase"] for event in events if "phase" in event]
            self.assertEqual(phases[:3], ["check", "load", "run"])
            counted = [event for event in events if event.get("phase") == "run" and event.get("total")]
            self.assertEqual([(event["current"], event["total"]) for event in counted], [(0, 2), (1, 2), (2, 2)])
            self.assertEqual(counted[-1]["image"], "b.png")

    def test_model_download_is_announced_through_the_event_sink(self):
        events = []
        with patch.object(desktop.generator, "EVENT_SINK", lambda message, **details: events.append((message, details))), \
                patch("dataset_generator.subprocess.run") as run:
            run.return_value.returncode = 0
            desktop.generator.download_model(Path("models") / "qwen2-vl")
        self.assertEqual(events[0][1]["phase"], "download")
        self.assertIn("Downloading", events[0][0])

    def test_japanese_mask_targets_and_exclusions(self):
        self.assertEqual(desktop.segmentation_prompt("赤いジャケットだけ、スカート"), "red jacket, skirt")
        self.assertEqual(desktop.segmentation_prompt("顔、髪、手、肌"), "face, hair, hands, exposed skin")
        self.assertEqual(desktop.segmentation_prompt("blue coat, outfit"), "blue coat, outfit")
        with self.assertRaises(ValueError):
            desktop.segmentation_prompt("、 ")

    def test_empty_inputs_and_numeric_boundaries(self):
        for value in ("", "  ", "\n", None, 5):
            with self.assertRaises(ValueError):
                desktop.text({"input": value}, "input")
        for value in ("", "nan", "inf", -1, 1.5, True, None):
            with self.assertRaises(ValueError):
                desktop.number({"rank": value}, "rank", 16, 1, 128, True)

    def test_metadata_cannot_escape_directory(self):
        root = Path(tempfile.gettempdir()).resolve() / "dataset"
        with self.assertRaises(ValueError):
            desktop.contained(root, "../outside")
        self.assertEqual(desktop.contained(root, "images/sample.png"), root / "images/sample.png")

    def test_unknown_job_returns_failure(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "request.json"
            path.write_text(json.dumps({"kind": "shell", "payload": {}}), encoding="utf-8")
            with patch("builtins.print"):
                self.assertEqual(desktop.main(["--request", str(path)]), 1)


@unittest.skipUnless(HAS_IMAGES, "Pillow / numpy required")
class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        Image.new("RGB", (256, 128), "red").save(self.raw / "sample.png")

    def tearDown(self):
        self.directory.cleanup()

    def create_separate_masks(self):
        class Segmenter:
            def __init__(self, args):
                pass

            def segment(self, image):
                mask = Image.new("L", image.size)
                mask.paste(255, (64, 32, 192, 96))
                return mask

        payload = {
            "input_dir": str(self.raw), "output_dir": str(self.root / "masks"),
            "models_dir": str(self.root / "models"), "mask_prompt": "clothes",
            "exclude_prompt": "face",
        }
        with patch("builtins.print"):
            return desktop.generate_masks(payload, Segmenter)

    def make_dataset(self):
        class Captioner:
            def __init__(self, args, patterns):
                pass

            def caption(self, image):
                return "sitting"

        masks = self.create_separate_masks()
        args = generator.parser().parse_args([
            "--input_dir", str(self.raw), "--output_dir", str(self.root / "processed"),
            "--mask_dir", str(masks), "--caption_mode", "tag", "--trigger_word", "costume",
        ])
        return generator.generate(args, Captioner)

    def training_payload(self):
        dataset = self.make_dataset()
        engine = self.root / "engine"
        (engine / "networks").mkdir(parents=True)
        (engine / "train_network.py").touch()
        (engine / "networks" / "lora.py").touch()
        checkpoint = self.root / "sd15.safetensors"
        checkpoint.touch()
        tokenizer = self.root / "tokenizers" / "openai_clip-vit-large-patch14"
        tokenizer.mkdir(parents=True)
        for name in ("vocab.json", "merges.txt", "tokenizer_config.json"):
            (tokenizer / name).touch()
        return {
            "dataset_dir": str(dataset), "mask_dir": str(dataset / "masks"),
            "engine_dir": str(engine), "checkpoint": str(checkpoint),
            "tokenizer_dir": str(tokenizer.parent), "output_dir": str(self.root / "lora"),
            "output_name": "costume",
        }

    def test_separate_masks_reused_without_loading_sam(self):
        dataset = self.make_dataset()
        metadata = json.loads((dataset / "metadata.json").read_text())
        self.assertEqual(len(metadata["images"]), 1)
        self.assertEqual((self.root / "masks/sample.png").exists(), True)
        self.assertFalse((self.root / "lora").exists())

    def test_edited_captions_and_masks_reused_without_caption_models(self):
        masks = self.create_separate_masks()
        captions = self.root / "captions"
        captions.mkdir()
        (captions / "sample.txt").write_text("costume, sitting outside.\n", encoding="utf-8")
        args = generator.parser().parse_args([
            "--input_dir", str(self.raw), "--output_dir", str(self.root / "processed"),
            "--mask_dir", str(masks), "--caption_dir", str(captions),
            "--caption_mode", "tag", "--trigger_word", "costume",
        ])
        dataset = generator.generate(args)
        caption = next((dataset / "images").rglob("*.txt")).read_text(encoding="utf-8").strip()
        self.assertEqual(caption, "costume, sitting outside.")

    def test_caption_tool_preview_preserves_existing_caption(self):
        class Captioner:
            def __init__(self, args):
                pass
            def caption(self, image):
                return "sitting outside"
        output = self.root / "captions"
        output.mkdir()
        original = output / "sample.txt"
        original.write_text("original caption", encoding="utf-8")
        payload = {"input_dir": str(self.raw), "output_dir": str(output),
                   "models_dir": str(self.root / "models"), "trigger_word": "costume",
                   "caption_prompt": "Describe pose.", "image_path": str(self.raw / "sample.png")}
        with patch("desktop_backend.emit") as emitted:
            self.assertIsNone(desktop.generate_captions(payload, Captioner))
        self.assertEqual(original.read_text(), "original caption")
        self.assertEqual(emitted.call_args.kwargs["caption"], "costume, sitting outside")

    def test_single_mask_preview_uses_mouse_points_and_never_writes(self):
        captured = {}
        class Segmenter:
            def __init__(self, args):
                captured["prompt"] = args.mask_prompt
                captured["points"] = args.mask_points
            def segment(self, image):
                mask = Image.new("L", image.size)
                mask.paste(255, (64, 32, 192, 96))
                return mask
        output = self.root / "masks"
        payload = {"input_dir": str(self.raw), "image_path": str(self.raw / "sample.png"),
                   "output_dir": str(output), "models_dir": str(self.root / "models"),
                   "mask_prompt": "赤いジャケット", "exclude_prompt": "顔、髪",
                   "points": [{"x": 100, "y": 50, "label": 1}]}
        with patch("desktop_backend.emit") as emitted:
            desktop.mask_image(payload, Segmenter)
        self.assertFalse(output.exists())
        self.assertEqual(captured["prompt"], "red jacket")
        self.assertEqual(captured["points"][0]["x"], 100)
        self.assertTrue(emitted.call_args.kwargs["preview_mask"].startswith("data:image/png;base64,"))

    def test_training_plan_masked_loss_and_offline_tokenizer(self):
        payload = self.training_payload()
        plan = desktop.training_plan(payload)
        config = tomllib.loads(plan["training_toml"])
        self.assertTrue(config["masked_loss"])
        self.assertTrue(config["network_train_unet_only"])
        self.assertEqual(config["network_dim"], 16)
        self.assertEqual(plan["samples"], 1)
        self.assertFalse(plan["output"].exists())
        self.assertEqual(tomllib.loads(plan["dataset_toml"])["datasets"][0]["subsets"][0]["conditioning_data_dir"],
                         str(Path(payload["mask_dir"]) / Path(json.loads((Path(payload["dataset_dir"]) / "metadata.json").read_text())["images"][0]["image"]).relative_to("images").parent).replace("\\", "/"))

    def test_training_rejects_missing_masks(self):
        payload = self.training_payload()
        mask = next(Path(payload["mask_dir"]).rglob("*.png"))
        mask.unlink()
        with self.assertRaises(FileNotFoundError):
            desktop.training_plan(payload)

    def test_training_rejects_empty_captions(self):
        payload = self.training_payload()
        caption = next((Path(payload["dataset_dir"]) / "images").rglob("*.txt"))
        caption.write_text("\n", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "Caption"):
            desktop.training_plan(payload)

    def test_training_requires_cuda_before_writing_outputs(self):
        payload = self.training_payload()
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
        with patch.dict("sys.modules", {"torch": torch_stub, "transformers": SimpleNamespace(CLIPTokenizer=Mock())}):
            with self.assertRaisesRegex(ValueError, "CUDA"):
                desktop.train(payload)
        self.assertFalse(Path(payload["output_dir"]).exists())

    def test_training_launch_uses_local_config_and_verifies_lora_output(self):
        payload = self.training_payload()
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        tokenizer = Mock()

        def training_stub(command, **kwargs):
            self.assertEqual(command[-2], "--config_file")
            config = tomllib.loads(Path(command[-1]).read_text(encoding="utf-8"))
            self.assertTrue(config["masked_loss"])
            self.assertNotIn("shell", kwargs)
            Path(payload["output_dir"], payload["output_name"] + ".safetensors").touch()
            return SimpleNamespace(returncode=0)

        with patch.dict("sys.modules", {"torch": torch_stub, "transformers": SimpleNamespace(CLIPTokenizer=tokenizer)}):
            with patch("desktop_backend.subprocess.run", side_effect=training_stub), patch("builtins.print"):
                desktop.train(payload)
        self.assertTrue(tokenizer.from_pretrained.call_args.kwargs["local_files_only"])

    def test_training_rejects_non_binary_mask(self):
        payload = self.training_payload()
        mask = next(Path(payload["mask_dir"]).rglob("*.png"))
        Image.new("L", (256, 128), 127).save(mask)
        with self.assertRaisesRegex(ValueError, "binary"):
            desktop.training_plan(payload)

    def test_mask_resolution_mismatch_rejected(self):
        masks = self.create_separate_masks()
        Image.new("L", (2, 2), 255).save(masks / "sample.png")
        class Captioner:
            def __init__(self, args, patterns):
                pass
            def caption(self, image):
                return "standing"
        args = generator.parser().parse_args([
            "--input_dir", str(self.raw), "--output_dir", str(self.root / "processed"),
            "--mask_dir", str(masks), "--caption_mode", "tag", "--trigger_word", "costume",
        ])
        with self.assertRaisesRegex(RuntimeError, "resolution differs"):
            generator.generate(args, Captioner)
        self.assertFalse(Path(args.output_dir).exists())


@unittest.skipUnless(HAS_IMAGES, "Pillow / numpy required")
class MaskJobSkipTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        Image.new("RGB", (256, 128), "red").save(self.raw / "a_ok.png")
        cutout = Image.new("RGBA", (256, 128), (0, 0, 0, 0))
        cutout.paste((200, 0, 0, 255), (100, 40, 160, 100))
        cutout.save(self.raw / "b_transparent.png")
        Image.new("RGB", (256, 128), "blue").save(self.raw / "c_empty_mask.png")
        Image.new("RGB", (256, 128), "green").save(self.raw / "d_ok.png")

    def tearDown(self):
        self.directory.cleanup()

    def run_job(self, raw=None):
        calls = []

        class Segmenter:
            def __init__(self, args):
                pass

            def segment(self, image):
                calls.append(image.size)
                mask = Image.new("L", image.size)
                # the blue image gets no clothing (empty mask -> abnormal area)
                if image.getpixel((0, 0)) != (0, 0, 255):
                    mask.paste(255, (64, 32, 192, 96))
                return mask

        events = []
        payload = {
            "input_dir": str(raw or self.raw), "output_dir": str(self.root / "masks"),
            "models_dir": str(self.root / "models"), "mask_prompt": "clothes", "exclude_prompt": "face",
        }
        with patch.object(desktop, "emit", side_effect=lambda message, **details: events.append((message, details))):
            destination = desktop.generate_masks(payload, Segmenter)
        return destination, events, calls

    def test_transparent_and_bad_images_are_skipped_and_the_job_continues(self):
        destination, events, calls = self.run_job()
        self.assertEqual(sorted(path.name for path in destination.glob("*.png")), ["a_ok.png", "d_ok.png"])
        skips = [message for message, _ in events if message.startswith("[SKIP]")]
        self.assertEqual(len(skips), 2)
        self.assertIn("b_transparent.png", skips[0])
        self.assertIn("transparent", skips[0])
        self.assertIn("c_empty_mask.png", skips[1])
        self.assertEqual(len(calls), 3)  # the transparent image never reaches the model
        metadata = json.loads((destination / "mask_metadata.json").read_text(encoding="utf-8"))
        self.assertEqual([item["source"] for item in metadata["skipped"]], ["b_transparent.png", "c_empty_mask.png"])

    def test_each_finished_mask_is_offered_for_live_preview(self):
        _, events, _ = self.run_job()
        previews = [details for _, details in events if "preview_mask" in details]
        self.assertEqual([item["preview_source"] for item in previews], ["a_ok.png", "d_ok.png"])
        self.assertTrue(previews[0]["preview_mask"].startswith("data:image/png;base64,"))

    def test_job_fails_clearly_when_every_image_is_skipped(self):
        only = self.root / "only_transparent"
        only.mkdir()
        (self.raw / "b_transparent.png").replace(only / "b_transparent.png")
        with self.assertRaises(ValueError) as caught:
            self.run_job(only)
        self.assertIn("skipped", str(caught.exception))


@unittest.skipUnless(HAS_IMAGES, "Pillow / numpy required")
class ExistingMaskTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.raw = self.root / "raw"
        (self.raw / "sub").mkdir(parents=True)
        for name in ("one.png", "two.png", "sub/three.png"):
            Image.new("RGB", (256, 128), "red").save(self.raw / name)
        self.masks = self.root / "masks"

    def tearDown(self):
        self.directory.cleanup()

    def run_job(self):
        created = []

        class Segmenter:
            def __init__(self, args):
                created.append("loaded")

            def segment(self, image):
                mask = Image.new("L", image.size)
                mask.paste(255, (64, 32, 192, 96))
                return mask

        events = []
        payload = {
            "input_dir": str(self.raw), "output_dir": str(self.masks),
            "models_dir": str(self.root / "models"), "mask_prompt": "clothes", "exclude_prompt": "face",
        }
        with patch.object(desktop, "emit", side_effect=lambda message, **details: events.append((message, details))):
            desktop.generate_masks(payload, Segmenter)
        return events, created

    def test_existing_masks_are_skipped_never_overwritten_and_new_ones_are_added(self):
        self.masks.mkdir()
        original = Image.new("L", (256, 128), 0)
        original.paste(255, (0, 0, 10, 10))
        original.save(self.masks / "one.png")
        before = (self.masks / "one.png").read_bytes()
        events, created = self.run_job()
        self.assertEqual((self.masks / "one.png").read_bytes(), before)
        self.assertTrue((self.masks / "two.png").is_file())
        self.assertTrue((self.masks / "sub" / "three.png").is_file())
        skips = [message for message, _ in events if message.startswith("[SKIP]")]
        self.assertEqual(len(skips), 1)
        self.assertIn("one.png", skips[0])
        self.assertIn("same name", skips[0])
        metadata = json.loads((self.masks / "mask_metadata.json").read_text(encoding="utf-8"))
        self.assertEqual(sorted(item["source"] for item in metadata["images"]), ["sub/three.png", "two.png"])
        self.assertEqual(metadata["existing"], ["one.png"])
        self.assertFalse(list(self.root.glob(".mask-job-*")))

    def test_second_run_creates_nothing_and_does_not_load_the_model(self):
        self.run_job()
        snapshot = {path.name: path.read_bytes() for path in self.masks.rglob("*.png")}
        events, created = self.run_job()
        self.assertEqual(created, [])
        self.assertEqual({path.name: path.read_bytes() for path in self.masks.rglob("*.png")}, snapshot)
        self.assertEqual(len([m for m, _ in events if m.startswith("[SKIP]")]), 3)
