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

    def test_new_training_parameters_reach_the_trainer_config(self):
        payload = self.training_payload()
        legacy = tomllib.loads(desktop.training_plan(payload)["training_toml"])
        self.assertEqual((legacy["optimizer_type"], legacy["lr_scheduler"], legacy["max_train_steps"]), ("AdamW", "constant", 1000))
        self.assertNotIn("max_train_epochs", legacy)
        self.assertEqual(tomllib.loads(desktop.training_plan(payload)["dataset_toml"])["datasets"][0]["subsets"][0]["num_repeats"], 1)
        self.add_dataset_image(payload, "second")
        payload.update({
            "repeats": 8, "epochs": 10, "steps": 0, "batch_size": 2, "optimizer": "AdamW8bit", "optimizer_args": "weight_decay=0.01 betas=(0.9,0.99)",
            "learning_rate": 0.0001, "text_encoder_lr": 0.00005, "lr_scheduler": "cosine_with_restarts", "lr_warmup_percent": 5,
            "lr_scheduler_num_cycles": 3, "rank": 32, "alpha": 16, "min_snr_gamma": 5, "noise_offset": 0.05, "clip_skip": 2,
            "shuffle_caption": True, "keep_tokens": 1, "gradient_checkpointing": False,
        })
        plan = desktop.training_plan(payload)
        config = tomllib.loads(plan["training_toml"])
        dataset = tomllib.loads(plan["dataset_toml"])
        self.assertEqual((plan["steps_per_epoch"], plan["total_steps"]), (8, 80))  # 2 images x 8 repeats / batch 2
        self.assertEqual(config["max_train_epochs"], 10)
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
            ({"epochs": 1.5}, "epochs"), ({"clip_skip": 3}, "clip_skip"), ({"use_masks": "no"}, "use_masks"),
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
