import base64
from io import BytesIO
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

    def add_dataset_image(self, payload, name):
        """Copy the single prepared image into extra records so selections can be tested."""
        import shutil

        dataset = Path(payload["dataset_dir"])
        metadata_path = dataset / "metadata.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        first = metadata["images"][0]
        relative = Path(first["image"]).relative_to("images")
        for folder, suffixes in (("images", (".png", ".txt")), ("masks", (".png",))):
            for suffix in suffixes:
                shutil.copy2(dataset / folder / relative.with_suffix(suffix), dataset / folder / (name + suffix))
        metadata["images"].append({**first, "source": name + ".png", "image": "images/" + name + ".png", "mask": "masks/" + name + ".png"})
        metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    def prepared_relative(self, payload):
        """Path of the first prepared image under images/ (datasets group files into hash-named folders)."""
        metadata = json.loads((Path(payload["dataset_dir"]) / "metadata.json").read_text(encoding="utf-8"))
        return Path(metadata["images"][0]["image"]).relative_to("images")

    @staticmethod
    def files_under(folder):
        return sorted(path.relative_to(folder).as_posix() for path in folder.rglob("*") if path.is_file())

    def test_unchecked_images_are_left_out_and_only_the_rest_is_linked_for_training(self):
        payload = self.training_payload()
        first = self.prepared_relative(payload)
        self.add_dataset_image(payload, "second")
        self.add_dataset_image(payload, "third")
        everything = desktop.training_plan(payload)
        self.assertEqual((everything["samples"], everything["left_out"], everything["selection"]), (3, 0, None))
        payload["excluded_sources"] = ["SECOND.png"]  # matched ignoring case
        plan = desktop.training_plan(payload)
        self.assertEqual((plan["samples"], plan["left_out"]), (2, 1))
        root = plan["selection"]["root"]
        subsets = tomllib.loads(plan["dataset_toml"])["datasets"][0]["subsets"]
        self.assertTrue(all(Path(item["image_dir"]).is_relative_to(root / "images") for item in subsets))
        self.assertTrue(all(Path(item["conditioning_data_dir"]).is_relative_to(root / "masks") for item in subsets))
        self.assertFalse(plan["output"].exists())  # planning never writes
        desktop.materialize_selection(plan["selection"])
        self.assertEqual(self.files_under(root / "images"), sorted([first.as_posix(), first.with_suffix(".txt").as_posix(), "third.png", "third.txt"]))
        self.assertEqual(self.files_under(root / "masks"), sorted([first.as_posix(), "third.png"]))
        self.assertTrue((Path(payload["dataset_dir"]) / "images" / "second.png").is_file())  # the dataset is untouched

    def test_training_start_builds_the_selection_folder_and_reports_it(self):
        payload = self.training_payload()
        first = self.prepared_relative(payload)
        self.add_dataset_image(payload, "second")
        payload["excluded_sources"] = ["second.png"]
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        seen = {}

        def training_stub(command, **kwargs):
            config = tomllib.loads(Path(command[-1]).read_text(encoding="utf-8"))
            dataset_toml = tomllib.loads(Path(config["dataset_config"]).read_text(encoding="utf-8"))
            seen["files"] = sorted(path.name for item in dataset_toml["datasets"][0]["subsets"] for path in Path(item["image_dir"]).rglob("*") if path.is_file())
            Path(payload["output_dir"], payload["output_name"] + ".safetensors").touch()
            return SimpleNamespace(returncode=0)

        with patch.dict("sys.modules", {"torch": torch_stub, "transformers": SimpleNamespace(CLIPTokenizer=Mock())}):
            with patch("desktop_backend.subprocess.run", side_effect=training_stub), patch("desktop_backend.emit") as emitted:
                desktop.train(payload)
        self.assertEqual(seen["files"], sorted([first.name, first.with_suffix(".txt").name]))  # the unchecked image never reaches the trainer
        self.assertTrue(any("using 1 of 2 images" in call.args[0] for call in emitted.call_args_list))

    def test_selecting_no_image_or_a_malformed_list_is_rejected(self):
        payload = self.training_payload()
        payload["excluded_sources"] = ["sample.png"]
        with self.assertRaisesRegex(ValueError, "No images are selected"):
            desktop.training_plan(payload)
        for bad in ("sample.png", [1, 2], {"a": 1}):
            payload["excluded_sources"] = bad
            with self.assertRaisesRegex(ValueError, "excluded_sources"):
                desktop.training_plan(payload)

    def test_a_selected_image_without_a_mask_is_named_in_the_error_but_an_unchecked_one_is_not(self):
        payload = self.training_payload()
        self.add_dataset_image(payload, "second")
        (Path(payload["mask_dir"]) / "second.png").unlink()
        with self.assertRaisesRegex(ValueError, "No mask for second.png"):
            desktop.training_plan(payload)
        payload["excluded_sources"] = ["second.png"]
        self.assertEqual(desktop.training_plan(payload)["samples"], 1)

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
                captured["exclude"] = args.exclude_prompt
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
        self.assertEqual(captured["exclude"], "face, hair")
        self.assertEqual(captured["points"][0]["x"], 100)
        self.assertTrue(emitted.call_args.kwargs["preview_mask"].startswith("data:image/png;base64,"))
        # Empty exclude_prompt is allowed (no exclusion) + painted guide_mask PNG data URL is decoded
        guide = Image.new("L", (256, 128), 0)
        guide.paste(255, (80, 40, 160, 100))
        buf = BytesIO()
        guide.save(buf, format="PNG")
        guide_url = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        class GuideSegmenter(Segmenter):
            def __init__(self, args):
                super().__init__(args)
                captured["guide_mask"] = args.guide_mask
        with patch("desktop_backend.emit"):
            desktop.mask_image({**payload, "exclude_prompt": "   ", "guide_mask": guide_url}, GuideSegmenter)
        self.assertEqual(captured["exclude"], "")
        self.assertIsNotNone(captured["guide_mask"])
        self.assertEqual(captured["guide_mask"].size, (256, 128))
        with self.assertRaisesRegex(ValueError, "guide_mask"):
            desktop.mask_image({**payload, "guide_mask": "not-a-data-url"}, GuideSegmenter)

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

    def test_new_training_parameters_reach_the_trainer_config(self):
        payload = self.training_payload()
        legacy = tomllib.loads(desktop.training_plan(payload)["training_toml"])
        self.assertEqual((legacy["optimizer_type"], legacy["lr_scheduler"], legacy["max_train_steps"]), ("AdamW", "constant", 1000))
        self.assertNotIn("max_train_epochs", legacy)
        self.assertEqual(tomllib.loads(desktop.training_plan(payload)["dataset_toml"])["datasets"][0]["subsets"][0]["num_repeats"], 1)
        self.add_dataset_image(payload, "second")
        payload.update({
            "repeats": 8, "epochs": 10, "steps": 0, "save_every_n_epochs": 2, "batch_size": 2, "optimizer": "AdamW8bit", "optimizer_args": "weight_decay=0.01 betas=(0.9,0.99)",
            "learning_rate": 0.0001, "text_encoder_lr": 0.00005, "lr_scheduler": "cosine_with_restarts", "lr_warmup_percent": 5,
            "lr_scheduler_num_cycles": 3, "rank": 32, "alpha": 16, "min_snr_gamma": 5, "noise_offset": 0.05, "clip_skip": 2,
            "shuffle_caption": True, "keep_tokens": 1, "gradient_checkpointing": False,
        })
        plan = desktop.training_plan(payload)
        config = tomllib.loads(plan["training_toml"])
        dataset = tomllib.loads(plan["dataset_toml"])
        self.assertEqual((plan["steps_per_epoch"], plan["total_steps"]), (8, 80))  # 2 images x 8 repeats / batch 2
        self.assertEqual(config["max_train_epochs"], 10)
        self.assertEqual(config["save_every_n_epochs"], 2)
        self.assertNotIn("save_every_n_steps", config)
        self.assertNotIn("max_train_steps", config)
        self.assertEqual((config["optimizer_type"], config["optimizer_args"], config["lr_scheduler"]), ("AdamW8bit", ["weight_decay=0.01", "betas=(0.9,0.99)"], "cosine_with_restarts"))
        self.assertEqual((config["lr_warmup_steps"], config["lr_scheduler_num_cycles"], config["min_snr_gamma"], config["noise_offset"], config["clip_skip"]), (4, 3, 5, 0.05, 2))
        self.assertEqual((config["text_encoder_lr"], config["unet_lr"], config["network_dim"], config["network_alpha"]), (0.00005, 0.0001, 32, 16))
        self.assertNotIn("network_train_unet_only", config)
        self.assertFalse(config["gradient_checkpointing"])
        self.assertTrue(config["masked_loss"])
        self.assertEqual((dataset["general"]["shuffle_caption"], dataset["general"]["keep_tokens"]), (True, 1))
        self.assertTrue(all(item["num_repeats"] == 8 for item in dataset["datasets"][0]["subsets"]))
        payload["steps"] = 50  # an explicit step limit wins over the epochs
        limited = desktop.training_plan(payload)
        self.assertEqual(limited["total_steps"], 50)
        self.assertEqual(tomllib.loads(limited["training_toml"])["max_train_steps"], 50)
        # Alpha greater than Rank is allowed (matches kohya sd-scripts, e.g. dim 8 / alpha 16)
        boosted = tomllib.loads(desktop.training_plan({**payload, "rank": 8, "alpha": 16})["training_toml"])
        self.assertEqual((boosted["network_dim"], boosted["network_alpha"]), (8, 16))

    def test_training_without_masks_needs_no_mask_files(self):
        payload = self.training_payload()
        payload["use_masks"] = False
        payload["mask_dir"] = str(self.root / "no-such-masks")
        plan = desktop.training_plan(payload)
        config = tomllib.loads(plan["training_toml"])
        self.assertFalse(config["masked_loss"])
        self.assertTrue(all("conditioning_data_dir" not in item for item in tomllib.loads(plan["dataset_toml"])["datasets"][0]["subsets"]))
        payload["excluded_sources"] = []
        self.add_dataset_image(payload, "second")
        payload["excluded_sources"] = ["second.png"]
        selection = desktop.training_plan(payload)
        self.assertEqual(selection["samples"], 1)
        desktop.materialize_selection(selection["selection"])  # no masks are linked
        self.assertFalse((selection["selection"]["root"] / "masks").exists())
        self.assertTrue(any((selection["selection"]["root"] / "images").rglob("*.png")))

    def test_invalid_training_parameters_are_rejected_with_the_key_name(self):
        payload = self.training_payload()
        for patch_values, pattern in (
            ({"optimizer": "SGD"}, "optimizer"), ({"lr_scheduler": "step"}, "lr_scheduler"), ({"repeats": 0}, "repeats"),
            ({"epochs": 1.5}, "epochs"), ({"save_every_n_epochs": -1}, "save_every_n_epochs"), ({"save_every_n_epochs": 1.5}, "save_every_n_epochs"), ({"clip_skip": 3}, "clip_skip"), ({"use_masks": "no"}, "use_masks"),
            ({"optimizer_args": "oops"}, "optimizer_args"), ({"alpha": 600, "rank": 512}, "alpha"), ({"batch_size": 17}, "batch_size"),
            ({"lr_warmup_percent": 60}, "lr_warmup_percent"), ({"shuffle_caption": 1}, "shuffle_caption"),
        ):
            with self.subTest(patch_values):
                with self.assertRaisesRegex(ValueError, pattern):
                    desktop.training_plan({**payload, **patch_values})

    def test_missing_optimizer_package_is_reported_with_a_pip_hint(self):
        self.assertIsNone(desktop.optimizer_package_problem("AdamW"))
        with patch("desktop_backend.importlib.util.find_spec", return_value=None):
            self.assertIn("pip install prodigyopt", desktop.optimizer_package_problem("Prodigy"))
            self.assertIn("pip install bitsandbytes", desktop.optimizer_package_problem("AdamW8bit"))
        payload = {**self.training_payload(), "optimizer": "Prodigy", "learning_rate": 1}
        with patch("desktop_backend.importlib.util.find_spec", return_value=None), patch("desktop_backend.emit"):
            with self.assertRaisesRegex(ValueError, "prodigyopt"):
                desktop.train(payload)
        self.assertFalse(Path(payload["output_dir"]).exists())

    def test_validated_event_carries_the_counts_and_adaptive_optimizers_warn_about_the_learning_rate(self):
        payload = {**self.training_payload(), "optimizer": "Prodigy", "learning_rate": 0.0001, "repeats": 4, "epochs": 3, "steps": 0}
        self.assertEqual(len(desktop.training_plan(payload)["warnings"]), 1)
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
        with patch.dict("sys.modules", {"torch": torch_stub, "transformers": SimpleNamespace(CLIPTokenizer=Mock())}):
            with patch("desktop_backend.importlib.util.find_spec", return_value=object()), patch("desktop_backend.emit") as emitted:
                with self.assertRaisesRegex(ValueError, "CUDA"):
                    desktop.train(payload)
        validated = next(call for call in emitted.call_args_list if call.kwargs.get("type") == "validated")
        self.assertEqual((validated.kwargs["samples"], validated.kwargs["steps_per_epoch"], validated.kwargs["total_steps"]), (1, 4, 12))
        self.assertTrue(any("Warning" in call.args[0] and "Learning rate" in call.args[0] for call in emitted.call_args_list))

    def family_payload(self, family_id, base=None):
        """A training payload for another model family, with empty stand-in model files and the family's script."""
        payload = dict(base) if base else self.training_payload()
        family = desktop.FAMILIES[family_id]
        engine = Path(payload["engine_dir"])
        (engine / family["script"]).touch()
        (engine / (family["modules"][0].replace(".", "/") + ".py")).touch()
        payload["model_family"] = family_id
        for key in family["required"] + family["optional"]:
            if key != "checkpoint":
                path = self.root / (key + ".safetensors")
                path.touch()
                payload[key] = str(path)
        payload.update({"epochs": 10, "steps": 0, "repeats": 4, "resolution": 1024})
        return payload

    def test_every_family_builds_its_own_script_arguments_and_network_module(self):
        base = self.training_payload()
        for family_id, family in desktop.FAMILIES.items():
            with self.subTest(family_id):
                payload = self.family_payload(family_id, base)
                plan = desktop.training_plan(payload)
                config = tomllib.loads(plan["training_toml"])
                self.assertEqual((plan["family"], plan["script"]), (family_id, family["script"]))
                self.assertEqual(config["network_module"], family["modules"][0])
                self.assertEqual(config["pretrained_model_name_or_path"], Path(payload["checkpoint"]).as_posix())
                for key in family["required"]:
                    if key != "checkpoint":
                        self.assertEqual(config[key], Path(payload[key]).as_posix())
                self.assertEqual("tokenizer_cache_dir" in config, family_id == "sd15")
                self.assertEqual(tomllib.loads(plan["dataset_toml"])["datasets"][0]["resolution"], 1024)
                for key, value in family["extra"].items():
                    self.assertEqual(config[key], value)

    def test_flow_models_train_the_main_network_only_and_drop_unsupported_options(self):
        base = self.training_payload()
        payload = {**self.family_payload("flux", base), "shuffle_caption": True, "keep_tokens": 1, "min_snr_gamma": 5, "noise_offset": 0.05,
                   "clip_skip": 2, "text_encoder_lr": 0.00005, "fp8_base": True, "blocks_to_swap": 18}
        plan = desktop.training_plan(payload)
        config = tomllib.loads(plan["training_toml"])
        dataset = tomllib.loads(plan["dataset_toml"])
        self.assertTrue(config["network_train_unet_only"])
        for key in ("min_snr_gamma", "noise_offset", "clip_skip", "text_encoder_lr"):
            self.assertNotIn(key, config)
        self.assertEqual((config["fp8_base"], config["blocks_to_swap"], config["guidance_scale"]), (True, 18, 1.0))
        self.assertFalse(dataset["general"]["shuffle_caption"])
        self.assertEqual(len(plan["warnings"]), 3)  # shuffle, unsupported options, text encoder LR
        anima = tomllib.loads(desktop.training_plan({**self.family_payload("anima", base), "fp8_base": True})["training_toml"])
        self.assertNotIn("fp8_base", anima)  # Anima has no fp8 base
        hunyuan = tomllib.loads(desktop.training_plan({**self.family_payload("hunyuan", base), "fp8_base": True})["training_toml"])
        self.assertTrue(hunyuan["fp8_scaled"])
        sdxl = desktop.training_plan({**self.family_payload("sdxl", base), "blocks_to_swap": 4})
        self.assertNotIn("blocks_to_swap", tomllib.loads(sdxl["training_toml"]))
        self.assertTrue(any("Block swap" in item for item in sdxl["warnings"]))

    def test_sdxl_uses_the_engines_text_encoder_option_names_and_keeps_the_vae_in_fp32_for_fp16(self):
        payload = {**self.family_payload("sdxl"), "text_encoder_lr": 0.00001, "mixed_precision": "fp16"}
        config = tomllib.loads(desktop.training_plan(payload)["training_toml"])
        self.assertEqual(config["text_encoder_lr"], [0.00001, 0.00001])
        self.assertTrue(config["no_half_vae"])
        self.assertNotIn("network_train_unet_only", config)
        (Path(payload["engine_dir"]) / "train_network.py").write_text('p.add_argument("--text_encoder_lr1")\n--pretrained_model_name_or_path', encoding="utf-8")
        config = tomllib.loads(desktop.training_plan(payload)["training_toml"])
        self.assertEqual((config["text_encoder_lr1"], config["text_encoder_lr2"]), (0.00001, 0.00001))
        unet_only = tomllib.loads(desktop.training_plan({**payload, "text_encoder_lr": 0})["training_toml"])
        self.assertTrue(unet_only["network_train_unet_only"] and unet_only["cache_text_encoder_outputs"])

    def test_missing_components_wrong_files_and_old_engines_are_explained(self):
        base = self.training_payload()
        payload = self.family_payload("flux", base)
        for key, pattern in (("clip_l", "clip_l: choose the CLIP-L file"), ("ae", "ae: choose the AutoEncoder")):
            with self.subTest(key):
                with self.assertRaisesRegex(ValueError, pattern):
                    desktop.training_plan({**payload, key: ""})
        with self.assertRaisesRegex(ValueError, "t5xxl: file not found"):
            desktop.training_plan({**payload, "t5xxl": str(self.root / "missing.safetensors")})
        ckpt = self.root / "model.ckpt"
        ckpt.touch()
        with self.assertRaisesRegex(ValueError, "checkpoint: choose a .safetensors"):
            desktop.training_plan({**payload, "checkpoint": str(ckpt)})
        with self.assertRaisesRegex(ValueError, "model_family"):
            desktop.training_plan({**payload, "model_family": "sd9"})
        (Path(payload["engine_dir"]) / "flux_train_network.py").unlink()
        with self.assertRaisesRegex(ValueError, "flux_train_network.py"):
            desktop.training_plan(payload)
        sd3 = self.family_payload("sd3", base)  # SD3 text encoders are optional, and the module falls back to networks.lora
        for key in ("clip_l", "clip_g", "t5xxl"):
            sd3.pop(key)
        (Path(sd3["engine_dir"]) / "networks" / "lora_sd3.py").unlink()
        self.assertEqual(tomllib.loads(desktop.training_plan(sd3)["training_toml"])["network_module"], "networks.lora")

    def test_an_engine_that_lacks_an_option_gets_a_warning(self):
        payload = self.family_payload("flux")
        (Path(payload["engine_dir"]) / "train_network.py").write_text("--pretrained_model_name_or_path --network_module --dataset_config", encoding="utf-8")
        warnings = desktop.training_plan(payload)["warnings"]
        self.assertTrue(any("guidance_scale" in item for item in warnings))

    def test_non_sd15_families_skip_the_offline_tokenizer_check(self):
        payload = self.family_payload("flux")
        payload["tokenizer_dir"] = str(self.root / "nowhere")
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))
        with patch.dict("sys.modules", {"torch": torch_stub}), patch("desktop_backend.emit"):
            with self.assertRaisesRegex(ValueError, "FLUX.1 training needs a CUDA"):
                desktop.train(payload)

    def test_dataset_toml_uses_only_option_names_sd_scripts_accepts(self):
        # sd-scripts rejects unknown keys ("extra keys not allowed"); names from library/config_util.py
        general = {"caption_extension", "shuffle_caption", "keep_tokens"}
        datasets = {"resolution", "batch_size", "enable_bucket", "bucket_no_upscale", "bucket_reso_steps", "min_bucket_reso", "max_bucket_reso", "subsets"}
        subsets = {"image_dir", "conditioning_data_dir", "alpha_mask", "num_repeats"}
        payload = {**self.training_payload(), "shuffle_caption": True, "keep_tokens": 1, "epochs": 2, "steps": 0}
        for variant in ({}, {"use_masks": False}):
            config = tomllib.loads(desktop.training_plan({**payload, **variant})["dataset_toml"])
            self.assertLessEqual(set(config["general"]), general)
            for dataset in config["datasets"]:
                self.assertLessEqual(set(dataset), datasets)
                for subset in dataset["subsets"]:
                    self.assertLessEqual(set(subset), subsets)

    def test_a_finished_lora_is_copied_to_the_comfyui_lora_folder(self):
        payload = {**self.training_payload(), "lora_output_dir": str(self.root / "shared" / "loras")}
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))

        def training_stub(command, **kwargs):
            for name in ("costume.safetensors", "costume-step00000250.safetensors"):
                Path(payload["output_dir"], name).touch()
            return SimpleNamespace(returncode=0)

        with patch.dict("sys.modules", {"torch": torch_stub, "transformers": SimpleNamespace(CLIPTokenizer=Mock())}):
            with patch("desktop_backend.subprocess.run", side_effect=training_stub), patch("desktop_backend.emit") as emitted:
                desktop.train(payload)
        published = next(call for call in emitted.call_args_list if call.kwargs.get("type") == "published")
        target = self.root / "shared" / "loras" / "costume"
        self.assertEqual(published.kwargs["lora_dir"], target.as_posix())
        self.assertEqual((published.kwargs["name"], published.kwargs["family"]), ("costume", "sd15"))
        self.assertTrue((target / "costume.safetensors").is_file() and (target / "costume-step00000250.safetensors").is_file())

    def test_training_rejects_missing_masks(self):
        payload = self.training_payload()
        mask = next(Path(payload["mask_dir"]).rglob("*.png"))
        mask.unlink()
        with self.assertRaisesRegex(ValueError, "No mask for"):
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
            self.assertIs(kwargs.get("stdout"), desktop.sys.stdout)
            self.assertIs(kwargs.get("stderr"), desktop.sys.stderr)
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


@unittest.skipUnless(HAS_IMAGES, "Pillow / numpy required")
class RawFolderTrainingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.img = self.root / "img"
        self.mask = self.root / "mask"
        self.img.mkdir()
        self.mask.mkdir()
        Image.new("RGB", (256, 128), "red").save(self.img / "keep_a.jpg")
        (self.img / "keep_a.txt").write_text("costume, standing", encoding="utf-8")
        mask_a = Image.new("L", (256, 128), 0)
        mask_a.paste(255, (64, 32, 192, 96))
        mask_a.save(self.mask / "keep_a.png")
        Image.new("RGB", (256, 128), "blue").save(self.img / "keep_b.png")
        (self.img / "keep_b.txt").write_text("costume, sitting", encoding="utf-8")
        mask_b = Image.new("L", (256, 128), 0)
        mask_b.paste(255, (32, 16, 128, 96))
        mask_b.save(self.mask / "keep_b.png")
        # Excluded image intentionally has no mask
        Image.new("RGB", (256, 128), "green").save(self.img / "skip_nomask.png")
        (self.img / "skip_nomask.txt").write_text("costume, excluded", encoding="utf-8")
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
        self.base_payload = {
            "dataset_dir": str(self.img),
            "mask_dir": str(self.mask),
            "engine_dir": str(engine),
            "checkpoint": str(checkpoint),
            "tokenizer_dir": str(tokenizer.parent),
            "output_dir": str(self.root / "lora"),
            "output_name": "costume_raw",
        }

    def test_raw_folder_trains_with_jpg_images_png_masks_and_excluded_sources(self):
        payload = {**self.base_payload, "excluded_sources": ["skip_nomask.png"]}
        plan = desktop.training_plan(payload)
        self.assertEqual((plan["samples"], plan["left_out"]), (2, 1))
        self.assertIsNotNone(plan["selection"])
        desktop.materialize_selection(plan["selection"])
        root = plan["selection"]["root"]
        self.assertEqual(sorted(p.name for p in (root / "images").iterdir()), ["keep_a.jpg", "keep_a.txt", "keep_b.png", "keep_b.txt"])
        self.assertEqual(sorted(p.name for p in (root / "masks").iterdir()), ["keep_a.png", "keep_b.png"])
        subsets = tomllib.loads(plan["dataset_toml"])["datasets"][0]["subsets"]
        self.assertEqual(len(subsets), 1)
        self.assertEqual(Path(subsets[0]["image_dir"]), root / "images")
        self.assertEqual(Path(subsets[0]["conditioning_data_dir"]), root / "masks")

    def test_raw_folder_without_exclusions_points_directly_and_supports_separate_captions(self):
        (self.img / "skip_nomask.png").unlink()
        (self.img / "skip_nomask.txt").unlink()
        plan = desktop.training_plan(self.base_payload)
        self.assertEqual((plan["samples"], plan["left_out"], plan["selection"]), (2, 0, None))
        subsets = tomllib.loads(plan["dataset_toml"])["datasets"][0]["subsets"]
        self.assertEqual(Path(subsets[0]["image_dir"]), self.img.resolve())
        self.assertEqual(Path(subsets[0]["conditioning_data_dir"]), self.mask.resolve())
        captions = self.root / "captions"
        captions.mkdir()
        for stem in ("keep_a", "keep_b"):
            (self.img / f"{stem}.txt").replace(captions / f"{stem}.txt")
        separate = desktop.training_plan({**self.base_payload, "caption_dir": str(captions)})
        self.assertIsNotNone(separate["selection"])
        desktop.materialize_selection(separate["selection"])
        self.assertEqual(sorted(p.name for p in (separate["selection"]["root"] / "images").iterdir()), ["keep_a.jpg", "keep_a.txt", "keep_b.png", "keep_b.txt"])

    def test_raw_folder_rejects_empty_dir_empty_enter_and_stem_collisions(self):
        empty = self.root / "empty"
        empty.mkdir()
        with self.assertRaisesRegex(ValueError, "No images found"):
            desktop.training_plan({**self.base_payload, "dataset_dir": str(empty)})
        with self.assertRaisesRegex(ValueError, "dataset_dir"):
            desktop.training_plan({**self.base_payload, "dataset_dir": "\n"})
        Image.new("RGB", (256, 128), "red").save(self.img / "keep_a.png")
        with self.assertRaisesRegex(ValueError, "same filename stem"):
            desktop.training_plan({**self.base_payload, "excluded_sources": ["skip_nomask.png"]})

    def test_sample_images_support_native_and_custom_model_strength_modes(self):
        payload = {**self.base_payload, "excluded_sources": ["skip_nomask.png"], "epochs": 6, "steps": 0}
        # Native mode: training checkpoint at strength 1.0, same clip skip
        native = desktop.training_plan({
            **payload, "sample_every_n_epochs": 2, "sample_prompt": "costume, 1girl\ncostume, from behind",
            "sample_negative": "worst quality", "sample_lora_strength": 1.0, "sample_width": 512, "sample_height": 680,
            "sample_steps": 20, "sample_cfg": 7.0, "sample_sampler": "dpmsolver++", "sample_clip_skip": 0, "sample_seed": 42,
        })
        self.assertEqual(native["sample"]["mode"], "native")
        self.assertEqual(native["sample"]["out_dir"], Path(payload["output_dir"]).resolve() / "sample")
        cfg = tomllib.loads(native["training_toml"])
        self.assertEqual((cfg["sample_every_n_epochs"], cfg["sample_sampler"]), (2, "dpmsolver++"))
        self.assertIn("--n worst quality --w 512 --h 680 --s 20 --l 7 --d 42", native["sample"]["prompts_text"])
        # Default save_every_n_epochs is 1 (save every epoch)
        default_cfg = tomllib.loads(desktop.training_plan(payload)["training_toml"])
        self.assertEqual(default_cfg["save_every_n_epochs"], 1)
        # Custom mode: separate sample checkpoint + LoRA strength 0.8 + Clip skip 2 (with save_every_n_epochs=0 auto-enabled)
        (Path(payload["engine_dir"]) / "gen_img.py").touch()
        other_ckpt = self.root / "kimchimix.safetensors"
        other_ckpt.touch()
        custom_payload = {
            **payload, "save_every_n_epochs": 0, "sample_every_n_epochs": 2, "sample_checkpoint": str(other_ckpt),
            "sample_prompt": "costume, standing", "sample_negative": "low quality",
            "sample_lora_strength": 0.8, "sample_width": 512, "sample_height": 680,
            "sample_steps": 18, "sample_cfg": 6.5, "sample_sampler": "euler_a", "sample_clip_skip": 2, "sample_seed": 99,
        }
        custom = desktop.training_plan(custom_payload)
        self.assertEqual(custom["sample"]["mode"], "gen_img")
        self.assertEqual(custom["sample"]["out_dir"], Path(payload["output_dir"]).resolve() / "sample")
        custom_cfg = tomllib.loads(custom["training_toml"])
        self.assertEqual(custom_cfg["save_every_n_epochs"], 2)  # auto-enabled for epoch sampling
        self.assertNotIn("sample_every_n_epochs", custom_cfg)
        # End-to-end mocked train() invokes gen_img.py for each matching epoch checkpoint + final
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))
        seen_cmds = []

        def run_stub(command, **kwargs):
            seen_cmds.append(command)
            if command[2].endswith("train_network.py"):
                for name in ("costume_raw-000002.safetensors", "costume_raw-000003.safetensors", "costume_raw-000004.safetensors", "costume_raw.safetensors"):
                    (Path(payload["output_dir"]) / name).touch()
            else:
                outdir = Path(command[command.index("--outdir") + 1])
                Image.new("RGB", (64, 64), "white").save(outdir / "im_000001.png")
            return SimpleNamespace(returncode=0)

        with patch.dict("sys.modules", {"torch": torch_stub, "transformers": SimpleNamespace(CLIPTokenizer=Mock())}):
            with patch("desktop_backend.subprocess.run", side_effect=run_stub), patch("desktop_backend.emit"):
                desktop.train(custom_payload)
        gen_cmds = [cmd for cmd in seen_cmds if cmd[2].endswith("gen_img.py")]
        self.assertEqual(len(gen_cmds), 3)  # epoch 2, epoch 4, final (epoch 3 skipped)
        self.assertIn("--v1", gen_cmds[0])
        self.assertEqual(gen_cmds[0][gen_cmds[0].index("--network_mul") + 1], "0.8")
        self.assertEqual(gen_cmds[0][gen_cmds[0].index("--ckpt") + 1], str(other_ckpt.resolve()))
        saved_samples = sorted(p.name for p in (Path(payload["output_dir"]) / "sample").glob("*.png"))
        self.assertEqual(saved_samples, ["costume_raw-000002_p01.png", "costume_raw-000004_p01.png", "costume_raw_final_p01.png"])
        # Empty / Enter-only prompt and non-multiple-of-8 size are rejected
        fresh_out = {**custom_payload, "output_dir": str(self.root / "lora2")}
        with self.assertRaisesRegex(ValueError, "sample_prompt"):
            desktop.training_plan({**fresh_out, "sample_prompt": "\n  "})
        with self.assertRaisesRegex(ValueError, "multiples of 8"):
            desktop.training_plan({**fresh_out, "sample_width": 515})

    def test_overwrite_output_allows_reusing_folder_and_cleans_only_matching_lora_artifacts(self):
        payload = {**self.base_payload, "excluded_sources": ["skip_nomask.png"]}
        out = Path(payload["output_dir"])
        out.mkdir()
        (out / "costume_raw.safetensors").write_bytes(b"old-final")
        (out / "costume_raw-000002.safetensors").write_bytes(b"old-e2")
        (out / "keep_unrelated.txt").write_text("keep", encoding="utf-8")
        sample_dir = out / "sample"
        sample_dir.mkdir()
        (sample_dir / "costume_raw-000002_p01.png").write_bytes(b"old-sample-e2")
        (sample_dir / "costume_raw_final_p01.png").write_bytes(b"old-sample-final")
        (sample_dir / "other_lora-000001_p01.png").write_bytes(b"keep-other-sample")
        with self.assertRaisesRegex(ValueError, "must be new or empty"):
            desktop.training_plan(payload)
        torch_stub = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))

        def run_stub(command, **kwargs):
            self.assertFalse((out / "costume_raw-000002.safetensors").exists())
            self.assertFalse((sample_dir / "costume_raw-000002_p01.png").exists())
            self.assertFalse((sample_dir / "costume_raw_final_p01.png").exists())
            (out / "costume_raw.safetensors").write_bytes(b"new-final")
            return SimpleNamespace(returncode=0)

        with patch.dict("sys.modules", {"torch": torch_stub, "transformers": SimpleNamespace(CLIPTokenizer=Mock())}):
            with patch("desktop_backend.subprocess.run", side_effect=run_stub), patch("desktop_backend.emit"):
                desktop.train({**payload, "overwrite_output": True})
        self.assertEqual((out / "costume_raw.safetensors").read_bytes(), b"new-final")
        self.assertEqual((out / "keep_unrelated.txt").read_text(encoding="utf-8"), "keep")
        self.assertEqual((sample_dir / "other_lora-000001_p01.png").read_bytes(), b"keep-other-sample")
