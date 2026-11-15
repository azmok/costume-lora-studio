import json
from pathlib import Path
import tempfile
import tomllib
import unittest

from PIL import Image
import dataset_generator as generator
import desktop_backend as desktop


class TransparentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.raw = self.root / "raw"
        self.raw.mkdir()
        image = Image.new("RGBA", (256, 256), (20, 40, 60, 0))
        image.paste((50, 80, 100, 128), (32, 32, 224, 224))
        image.paste((50, 80, 100, 255), (64, 64, 192, 192))
        image.save(self.raw / "sample.png")
        (self.raw / "sample.txt").write_text("costume, standing", encoding="utf-8")
        self.args = generator.parser().parse_args([
            "--input_dir", str(self.raw), "--output_dir", str(self.root / "data"),
            "--trigger_word", "costume", "--caption_mode", "tag", "--transparent",
            "--caption_dir", str(self.raw), "--max_resolution", "128",
        ])

    def test_rgba_soft_alpha_and_subset_survive_preparation(self):
        output = generator.generate(self.args)
        info = json.loads((output / "metadata.json").read_text())
        with Image.open(output / info["images"][0]["image"]) as image:
            self.assertEqual(image.mode, "RGBA")
            self.assertEqual(image.size, (128, 128))
            self.assertEqual(image.getchannel("A").getextrema(), (0, 255))
            self.assertGreater(image.getchannel("A").histogram()[128], 0)
        subset = tomllib.loads((output / "kohya_dataset.toml").read_text())["datasets"][0]["subsets"][0]
        self.assertTrue(subset["alpha_mask"])
        self.assertNotIn("conditioning_data_dir", subset)
        self.assertEqual((self.raw / "sample.txt").read_text(), "costume, standing")

    def test_invalid_images_and_conflicting_masks_do_not_publish(self):
        for mode, color in [("RGB", "white"), ("RGBA", (0, 0, 0, 0)), ("RGBA", (0, 0, 0, 255))]:
            with self.subTest(mode=mode, color=color):
                Image.new(mode, (256, 256), color).save(self.raw / "sample.png")
                with self.assertRaisesRegex(RuntimeError, "alpha channel|visible and transparent"):
                    generator.generate(self.args)
                self.assertFalse(Path(self.args.output_dir).exists())
        self.args.mask_dir = self.raw
        with self.assertRaisesRegex(ValueError, "cannot be combined"):
            generator.generate(self.args)

    def test_training_uses_alpha_without_external_masks(self):
        output = generator.generate(self.args)
        engine = self.root / "engine"
        (engine / "networks").mkdir(parents=True)
        (engine / "train_network.py").touch()
        (engine / "networks/lora.py").touch()
        tokenizer = self.root / "tokenizer/openai_clip-vit-large-patch14"
        tokenizer.mkdir(parents=True)
        for name in ("vocab.json", "merges.txt", "tokenizer_config.json"):
            (tokenizer / name).touch()
        checkpoint = self.root / "sd15.safetensors"
        checkpoint.touch()
        payload = dict(dataset_dir=str(output), engine_dir=str(engine), checkpoint=str(checkpoint),
                       tokenizer_dir=str(tokenizer.parent), output_dir=str(self.root / "lora"),
                       output_name="costume", alpha_mask=True)
        plan = desktop.training_plan(payload)
        config = tomllib.loads(plan["training_toml"])
        subset = tomllib.loads(plan["dataset_toml"])["datasets"][0]["subsets"][0]
        self.assertFalse(config["masked_loss"])
        self.assertTrue(subset["alpha_mask"])
        self.assertNotIn("conditioning_data_dir", subset)
        payload["alpha_mask"] = False
        with self.assertRaisesRegex(ValueError, "Enable All images"):
            desktop.training_plan(payload)
        payload["alpha_mask"] = ""
        with self.assertRaisesRegex(ValueError, "alpha_mask"):
            desktop.training_plan(payload)

    def test_alias_and_empty_enter(self):
        args = generator.parser().parse_args(["--trigger_word", "costume", "--caption_mode", "tag", "--alpha_mask"])
        self.assertTrue(args.transparent)
        with self.assertRaises(Exception):
            generator.nonempty("\n")


if __name__ == "__main__":
    unittest.main()
