"""Prepare trainer-independent costume datasets using local model snapshots."""

from __future__ import annotations

import argparse
import csv
import fnmatch
import gc
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

for variable in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
    os.environ[variable] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ["DO_NOT_TRACK"] = "1"

LOGGER = logging.getLogger("dataset_generator")
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff"}
CLOTHING = """
clothes clothing outfit costume uniform dress skirt shirt blouse jacket coat pants
trousers shorts jeans sweater cardigan hoodie vest suit blazer robe kimono yukata
hakama obi swimsuit bikini leotard bodysuit underwear lingerie bra panties
stockings pantyhose tights socks shoes boots sandals sneakers gloves mittens
hat cap bonnet helmet headdress headwear hairband hairclip hairpin ribbon bow
necktie tie scarf collar choker necklace earrings bracelet belt corset apron
armor cape cloak poncho shawl veil mask sleeves sleeve cuffs frills frilled
ruffles ruffled lace laces buttons button zipper pockets pocket lapels straps
strap suspenders garter cleavage midriff cutout plaid striped polka_dot
checkered argyle floral print logo embroidery brooch epaulettes backpack bag
handbag purse jewelry jewellery accessories accessory bare_shoulders off_shoulder
detached_sleeves thighhighs kneehighs kneehigh zettai_ryouiki school_uniform
sailor serafuku maid gothic_lolita lolita_fashion cross-laced puffy pleated
fur_trim gold_trim center_frills side_slit side-tie see-through skin_tight
crop_top tank_top tube_top halterneck turtleneck v-neck high_heels footwear
""".split()
DEFAULT_BLACKLIST = tuple(CLOTHING)
VLM_PROMPT = (
    "Describe only the person's pose, facial expression, hairstyle, camera angle, "
    "framing, and background in one or two natural English sentences. "
    "Do not describe or mention clothing, outfits, accessories, garment design, "
    "garment colors, fabrics, or patterns. Do not include introductions or lists."
)
CLOTHES_PROMPT = "clothes, clothing, dress, jacket, pants, skirt, outfit"
EXCLUDE_PROMPT = "face, hair, hands, bare arms, bare legs, bare feet, exposed skin"


def nonempty(value: str) -> str:
    result = value.strip()
    if not result:
        raise argparse.ArgumentTypeError("must not be empty or whitespace")
    return result


def positive(value: str) -> int:
    result = int(value)
    if result < 1:
        raise argparse.ArgumentTypeError("must be positive")
    return result


def probability(value: str) -> float:
    result = float(value)
    if not 0 <= result <= 1:
        raise argparse.ArgumentTypeError("must be between 0 and 1")
    return result


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--input_dir", type=nonempty, default="./dataset/raw_images")
    cli.add_argument("--output_dir", type=nonempty, default="./dataset/processed_dataset")
    cli.add_argument("--trigger_word", type=nonempty, required=True)
    cli.add_argument("--caption_mode", choices=("tag", "vlm"), required=True)
    cli.add_argument("--max_resolution", type=positive, default=1024)
    cli.add_argument("--resize_edge", choices=("long", "short"), default="long")
    cli.add_argument("--upscale", action="store_true")
    cli.add_argument("--wd_model_dir", type=Path, default=Path("models/wd14"))
    cli.add_argument("--vlm_model_dir", type=Path, default=Path("models/qwen2-vl"))
    cli.add_argument("--dino_model_dir", type=Path, default=Path("models/grounding-dino"))
    cli.add_argument("--sam_model_dir", type=Path, default=Path("models/sam"))
    cli.add_argument("--device", choices=("auto", "cpu", "cuda"), default="auto")
    cli.add_argument("--precision", choices=("bf16", "fp16", "fp32", "4bit", "8bit"), default="bf16")
    cli.add_argument("--tag_threshold", type=probability, default=0.35)
    cli.add_argument("--box_threshold", type=probability, default=0.3)
    cli.add_argument("--text_threshold", type=probability, default=0.25)
    cli.add_argument("--min_mask_fraction", type=probability, default=0.001)
    cli.add_argument("--max_mask_fraction", type=probability, default=0.95)
    cli.add_argument("--mask_prompt", type=nonempty, default=CLOTHES_PROMPT)
    cli.add_argument("--exclude_prompt", type=nonempty, default=EXCLUDE_PROMPT)
    cli.add_argument("--blacklist", type=Path, help="Additional UTF-8 glob patterns, one per line")
    cli.add_argument("--mask_dir", type=Path, help="Reuse separately generated masks, mirroring source paths as PNG")
    cli.add_argument("--caption_dir", type=Path, help="Reuse edited UTF-8 captions, mirroring source paths as TXT")
    cli.add_argument("--download_models", action="store_true", help="Download missing local models from Hugging Face")
    cli.add_argument("--continue_on_error", action="store_true")
    return cli


def load_image(path: Path) -> Image.Image:
    from PIL import Image, ImageOps

    with Image.open(path) as source:
        oriented = ImageOps.exif_transpose(source).convert("RGBA")
        background = Image.new("RGBA", oriented.size, "white")
        return Image.alpha_composite(background, oriented).convert("RGB")


TRANSPARENT_LIMIT = 0.01


def transparent_fraction(path: Path) -> float:
    """Share of pixels that are (nearly) transparent; images with a removed background score high."""
    from PIL import Image

    with Image.open(path) as source:
        has_alpha = source.mode in ("RGBA", "LA", "PA") or "transparency" in source.info
        if not has_alpha:
            return 0.0
        histogram = source.convert("RGBA").getchannel("A").histogram()
    return sum(histogram[:250]) / max(1, sum(histogram))


def target_size(size: tuple[int, int], resolution: int, edge: str, upscale: bool) -> tuple[int, int]:
    reference = max(size) if edge == "long" else min(size)
    scale = resolution / reference
    if not upscale:
        scale = min(1.0, scale)
    return tuple(max(1, round(dimension * scale)) for dimension in size)


def resize_pair(image: Image.Image, mask: Image.Image, size: tuple[int, int]) -> tuple[Image.Image, Image.Image]:
    from PIL import Image

    if image.size != mask.size:
        raise ValueError("Segmentation mask resolution differs from source image")
    image = image.resize(size, Image.Resampling.LANCZOS)
    mask = mask.convert("L").point(lambda value: 255 if value >= 128 else 0)
    mask = mask.resize(size, Image.Resampling.NEAREST)
    return image, mask


def filter_tags(tags: list[str], patterns: tuple[str, ...]) -> list[str]:
    result = []
    for tag in tags:
        normalized = tag.lower().replace(" ", "_")
        if not any(
            fnmatch.fnmatchcase(normalized, pattern)
            or f"_{pattern}_" in f"_{normalized}_"
            for pattern in patterns
        ):
            result.append(tag.replace("_", " "))
    return list(dict.fromkeys(result))


def validate_caption(text: str) -> str:
    text = " ".join(text.strip().split())
    if not text:
        raise ValueError("Caption model returned an empty description")
    return text


MODEL_REPOS = {
    "grounding-dino": ("IDEA-Research/grounding-dino-tiny", ("*.json", "*.safetensors", "*.txt", "*.model")),
    "sam": ("facebook/sam-vit-base", ("*.json", "*.safetensors")),
    "wd14": ("SmilingWolf/wd-v1-4-convnext-tagger-v2", ("model.onnx", "selected_tags.csv")),
    "wd-eva02-large-tagger-v3": ("SmilingWolf/wd-eva02-large-tagger-v3", ("model.onnx", "selected_tags.csv")),
    "qwen2-vl": ("Qwen/Qwen2-VL-2B-Instruct", ("*.json", "*.safetensors", "*.txt", "*.model", "*.jinja")),
}


def model_hint(path: Path) -> str:
    entry = MODEL_REPOS.get(path.name)
    return f" | fetch: hf download {entry[0]} --local-dir \"{path.as_posix()}\"" if entry else ""


EVENT_SINK = None  # set by the desktop backend to forward progress events to the GUI


def download_model(path: Path) -> None:
    """Fetch a known model into `path`. Runs in a child process so this process stays offline."""
    repo, patterns = MODEL_REPOS[path.name]
    LOGGER.info("Model missing. Downloading %s -> %s (first time only)", repo, path)
    if EVENT_SINK:
        EVENT_SINK(f"Downloading {repo} (first run only)…", phase="download", repo=repo)
    code = (
        "import sys; from huggingface_hub import snapshot_download; "
        "snapshot_download(sys.argv[1], local_dir=sys.argv[2], allow_patterns=sys.argv[3:])"
    )
    environment = {**os.environ, "HF_HUB_OFFLINE": "0", "TRANSFORMERS_OFFLINE": "0", "HF_XET_HIGH_PERFORMANCE": "1"}
    # stdout carries the GUI's JSON events, so send the child's output to stderr (the log view).
    result = subprocess.run([sys.executable, "-c", code, repo, str(path), *patterns], env=environment, stdout=sys.stderr, stderr=sys.stderr)
    if result.returncode != 0:
        raise ValueError(f"Model download failed ({repo}). Check your connection{model_hint(path)}")
    LOGGER.info("Downloaded %s", repo)


def require_snapshot(path: Path, files: tuple[str, ...] = ("config.json",), download: bool = False) -> None:
    def missing() -> bool:
        return not path.is_dir() or any(not (path / filename).is_file() for filename in files)

    LOGGER.info("Model check: %s (exists=%s)", path, path.is_dir())
    if missing() and download and path.name in MODEL_REPOS:
        download_model(path)
    if not path.is_dir():
        parent = path.parent
        found = sorted(entry.name for entry in parent.iterdir()) if parent.is_dir() else []
        raise ValueError(f"Local model directory missing: {path} | contents of {parent}: {found or 'empty'}{model_hint(path)}")
    for filename in files:
        if not (path / filename).is_file():
            raise ValueError(f"Required local model file missing: {path / filename}{model_hint(path)}")


def torch_device(requested: str) -> str:
    import torch

    if requested == "cuda" and not torch.cuda.is_available():
        raise ValueError("CUDA requested but unavailable")
    if requested == "auto":
        return "cuda" if torch.cuda.is_available() else "cpu"
    return requested


class WD14Captioner:
    def __init__(self, args: argparse.Namespace, patterns: tuple[str, ...]):
        import onnxruntime as ort

        self.patterns = patterns
        self.threshold = args.tag_threshold
        self.session = ort.InferenceSession(str(args.wd_model_dir / "model.onnx"), providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0]
        self.side = self.input.shape[1]
        if not isinstance(self.side, int) or self.input.shape[-1] != 3:
            raise ValueError("Expected WD14 NHWC model input")
        with (args.wd_model_dir / "selected_tags.csv").open(encoding="utf-8", newline="") as stream:
            self.tags = list(csv.DictReader(stream))

    def caption(self, image: Image.Image) -> str:
        import numpy as np
        from PIL import Image

        square = Image.new("RGB", (max(image.size), max(image.size)), "white")
        square.paste(image, ((square.width - image.width) // 2, (square.height - image.height) // 2))
        square = square.resize((self.side, self.side), Image.Resampling.BICUBIC)
        tensor = np.asarray(square, dtype=np.float32)[..., ::-1].copy()[None]
        scores = np.asarray(self.session.run(None, {self.input.name: tensor})[0]).reshape(-1)
        if len(scores) != len(self.tags):
            raise ValueError("WD14 model and selected_tags.csv have different output sizes")
        tags = [row["name"] for row, score in zip(self.tags, scores) if row["category"] == "0" and score >= self.threshold]
        return ", ".join(filter_tags(tags, self.patterns))


class QwenCaptioner:
    def __init__(self, args: argparse.Namespace):
        import torch
        from transformers import AutoProcessor, BitsAndBytesConfig, Qwen2VLForConditionalGeneration

        self.device = torch_device(args.device)
        self.prompt = getattr(args, "caption_prompt", VLM_PROMPT)
        self.exclude_clothing = getattr(args, "exclude_clothing", True)
        if args.precision in ("4bit", "8bit") and self.device != "cuda":
            raise ValueError("4bit/8bit VLM inference requires CUDA in this pipeline")
        if args.precision == "bf16" and self.device == "cuda" and not torch.cuda.is_bf16_supported():
            raise ValueError("GPU does not support bf16; select --precision fp16")
        dtype = {"bf16": torch.bfloat16, "fp16": torch.float16, "fp32": torch.float32}.get(args.precision, torch.float16)
        if self.device == "cpu":
            dtype = torch.float32
        options = {"local_files_only": True, "torch_dtype": dtype, "attn_implementation": "eager"}
        if args.precision in ("4bit", "8bit"):
            options["quantization_config"] = BitsAndBytesConfig(load_in_4bit=args.precision == "4bit", load_in_8bit=args.precision == "8bit")
            options["device_map"] = {"": 0}
        self.model = Qwen2VLForConditionalGeneration.from_pretrained(str(args.vlm_model_dir), **options).eval()
        if "device_map" not in options:
            self.model.to(self.device)
        self.processor = AutoProcessor.from_pretrained(str(args.vlm_model_dir), local_files_only=True, min_pixels=256 * 28 * 28, max_pixels=1024 * 28 * 28)

    def caption(self, image: Image.Image) -> str:
        import torch

        messages = [
            {"role": "system", "content": self.prompt},
            {"role": "user", "content": [{"type": "image"}, {"type": "text", "text": "Describe this image following the instructions."}]},
        ]
        prompt = self.processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.processor(text=[prompt], images=[image], return_tensors="pt").to(self.device)
        with torch.inference_mode():
            generated = self.model.generate(**inputs, max_new_tokens=128, do_sample=False)
        text = self.processor.batch_decode(generated[:, inputs.input_ids.shape[1]:], skip_special_tokens=True)[0]
        text = validate_caption(text)
        vocabulary = set(re.findall(r"[a-z]+", text.lower()))
        if self.exclude_clothing and vocabulary.intersection(CLOTHING):
            raise ValueError(f"VLM mentioned clothing; review prompt/image: {text}")
        return text


class GroundedSAM:
    """Lang-SAM architecture using HF GroundingDINO and SAM, without hub downloads."""

    def __init__(self, args: argparse.Namespace):
        from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, SamModel, SamProcessor

        self.args = args
        self.device = torch_device(args.device)
        self.detector_processor = AutoProcessor.from_pretrained(str(args.dino_model_dir), local_files_only=True)
        self.detector = AutoModelForZeroShotObjectDetection.from_pretrained(str(args.dino_model_dir), local_files_only=True).to(self.device).eval()
        self.sam_processor = SamProcessor.from_pretrained(str(args.sam_model_dir), local_files_only=True)
        self.sam = SamModel.from_pretrained(str(args.sam_model_dir), local_files_only=True).to(self.device).eval()

    def detect(self, image: Image.Image, prompt: str):
        import torch

        prompt = ". ".join(term.strip().lower().rstrip(".") for term in prompt.split(",")) + "."
        inputs = self.detector_processor(images=image, text=prompt, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            outputs = self.detector(**inputs)
        import inspect

        post_process = self.detector_processor.post_process_grounded_object_detection
        name = "box_threshold" if "box_threshold" in inspect.signature(post_process).parameters else "threshold"
        result = post_process(
            outputs, inputs.input_ids, **{name: self.args.box_threshold},
            text_threshold=self.args.text_threshold, target_sizes=[(image.height, image.width)],
        )[0]
        return result["boxes"].detach().cpu()

    def segment(self, image: Image.Image) -> Image.Image:
        import numpy as np
        import torch
        from PIL import Image

        clothes = self.detect(image, self.args.mask_prompt)
        if not len(clothes):
            raise ValueError("No clothing detected; adjust prompts or thresholds")
        excluded = self.detect(image, self.args.exclude_prompt)
        boxes = torch.cat([clothes, excluded])
        union = np.zeros((image.height, image.width), dtype=bool)
        protected = np.zeros_like(union)
        image_inputs = self.sam_processor(images=image, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            embeddings = self.sam.get_image_embeddings(image_inputs.pixel_values)
            for index, box in enumerate(boxes):
                prompts = {"images": image, "input_boxes": [[box.tolist()]], "return_tensors": "pt"}
                points = getattr(self.args, "mask_points", []) if index < len(clothes) else []
                positive = [point for point in points if point["label"] == 1]
                if positive and not any(box[0] <= point["x"] <= box[2] and box[1] <= point["y"] <= box[3] for point in positive):
                    continue
                if points:
                    prompts["input_points"] = [[[point["x"], point["y"]] for point in points]]
                    prompts["input_labels"] = [[point["label"] for point in points]]
                inputs = self.sam_processor(**prompts).to(self.device)
                outputs = self.sam(image_embeddings=embeddings, input_boxes=inputs.input_boxes, multimask_output=False)
                masks = self.sam_processor.image_processor.post_process_masks(
                    outputs.pred_masks.cpu(), inputs.original_sizes.cpu(), inputs.reshaped_input_sizes.cpu(),
                )
                region = masks[0][0, 0].numpy().astype(bool)
                if index < len(clothes):
                    union |= region
                else:
                    protected |= region
        return Image.fromarray((union & ~protected).astype(np.uint8) * 255)


def release_models() -> None:
    gc.collect()
    import torch

    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def validate_inputs(args: argparse.Namespace, allow_existing_output=False) -> list[Path]:
    source = Path(args.input_dir).resolve()
    destination = Path(args.output_dir).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Input and output directories must not overlap")
    if not source.is_dir():
        raise ValueError(f"Input directory missing: {source}")
    if destination.exists() and (not destination.is_dir() or (not allow_existing_output and any(destination.iterdir()))):
        raise ValueError("Output must be absent or empty; existing datasets are never overwritten")
    if args.min_mask_fraction >= args.max_mask_fraction:
        raise ValueError("min_mask_fraction must be less than max_mask_fraction")
    if any(character in args.trigger_word for character in ("\n", "\r", ",", "\x00")):
        raise ValueError("Trigger must be one line and contain no commas or NUL")
    images = sorted(path for path in source.rglob("*") if path.is_file() and path.suffix.lower() in EXTENSIONS)
    if not images:
        raise ValueError(f"No supported images in {source}")
    names = [path.relative_to(source).with_suffix("").as_posix().casefold() for path in images]
    if len(names) != len(set(names)):
        raise ValueError("Images with the same stem would overwrite captions; rename them first")
    return images


def export_configs(root: Path, final: Path, args: argparse.Namespace) -> None:
    images = (final / "images").as_posix()
    masks = (final / "masks").as_posix()
    config = (
        '[general]\ncaption_extension = ".txt"\nshuffle_caption = false\n\n'
        '[[datasets]]\n'
        f'resolution = {args.max_resolution}\nbatch_size = 1\nenable_bucket = true\n'
        'bucket_no_upscale = true\nbucket_reso_steps = 64\n'
        f'bucket_min_reso = 64\nbucket_max_reso = {max(1024, args.max_resolution * 2)}\n\n'
    )
    toolkit_datasets = []
    for image_dir in sorted((root / "images").rglob("*")):
        if image_dir.is_dir() and any(path.suffix.lower() == ".png" for path in image_dir.iterdir()):
            relative = image_dir.relative_to(root / "images").as_posix()
            image_group = images + "/" + relative
            mask_group = masks + "/" + relative
            config += f'[[datasets.subsets]]\nimage_dir = {json.dumps(image_group, ensure_ascii=False)}\nconditioning_data_dir = {json.dumps(mask_group, ensure_ascii=False)}\nnum_repeats = 1\n\n'
            toolkit_datasets.append({"folder_path": image_group, "mask_path": mask_group, "caption_ext": "txt", "resolution": [args.max_resolution], "default_caption": args.trigger_word, "mask_min_value": 0.0, "is_reg": False})
    (root / "kohya_dataset.toml").write_text(config, encoding="utf-8")
    (root / "ai_toolkit_dataset.json").write_text(json.dumps({"datasets": toolkit_datasets}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def generate(args: argparse.Namespace, captioner_factory=None, segmenter_factory=None) -> Path:
    paths = validate_inputs(args)
    real_models = captioner_factory is None and args.caption_dir is None
    if args.caption_dir is not None:
        if not args.caption_dir.is_dir():
            raise ValueError(f"Caption directory missing: {args.caption_dir}")
        for path in paths:
            caption_path = args.caption_dir / path.relative_to(Path(args.input_dir).resolve()).with_suffix(".txt")
            validate_caption(caption_path.read_text(encoding="utf-8"))
    if captioner_factory is None and args.caption_dir is None:
        if args.caption_mode == "tag":
            require_snapshot(args.wd_model_dir, ("model.onnx", "selected_tags.csv"), getattr(args, "download_models", False))
            captioner_factory = WD14Captioner
        else:
            require_snapshot(args.vlm_model_dir, download=getattr(args, "download_models", False))
            captioner_factory = lambda options, patterns: QwenCaptioner(options)
    if args.mask_dir is not None:
        mask_root = args.mask_dir.resolve()
        if not mask_root.is_dir():
            raise ValueError(f"Mask directory missing: {mask_root}")
        for path in paths:
            mask_path = mask_root / path.relative_to(Path(args.input_dir).resolve()).with_suffix(".png")
            if not mask_path.is_file():
                raise ValueError(f"Mask missing: {mask_path}")
    if segmenter_factory is None and args.mask_dir is None:
        require_snapshot(args.dino_model_dir, download=getattr(args, "download_models", False))
        require_snapshot(args.sam_model_dir, download=getattr(args, "download_models", False))
        segmenter_factory = GroundedSAM
    import numpy as np

    patterns = DEFAULT_BLACKLIST
    if args.blacklist:
        extra = [line.strip().lower().replace(" ", "_") for line in args.blacklist.read_text(encoding="utf-8").splitlines() if line.strip() and not line.lstrip().startswith("#")]
        patterns += tuple(extra)
    source = Path(args.input_dir).resolve()
    final = Path(args.output_dir).resolve()
    final.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".costume-dataset-", dir=final.parent))
    records = []
    errors = []
    try:
        captioner = captioner_factory(args, patterns) if args.caption_dir is None else None
        for path in paths:
            image_path = None
            try:
                image = load_image(path)
                if args.caption_dir is not None:
                    caption = validate_caption((args.caption_dir / path.relative_to(source).with_suffix(".txt")).read_text(encoding="utf-8"))
                else:
                    caption = captioner.caption(image).strip()
                if args.caption_mode == "vlm":
                    validate_caption(caption)
                if caption != args.trigger_word and not caption.startswith(args.trigger_word + ","):
                    caption = args.trigger_word + (", " + caption if caption else "")
                relative = path.relative_to(source)
                group = hashlib.sha256(relative.parent.as_posix().encode("utf-8")).hexdigest()[:16]
                name = Path(group) / relative.with_suffix(".png").name
                image_path = staging / "images" / name
                image_path.parent.mkdir(parents=True, exist_ok=True)
                image.save(image_path)
                image_path.with_suffix(".txt").write_text(caption + "\n", encoding="utf-8")
                records.append({"source": relative.as_posix(), "image": "images/" + name.as_posix(), "mask": "masks/" + name.as_posix(), "caption": caption, "original_size": list(image.size)})
                LOGGER.info("Caption: %s", relative)
            except Exception as error:
                if image_path is not None:
                    image_path.unlink(missing_ok=True)
                    image_path.with_suffix(".txt").unlink(missing_ok=True)
                if not args.continue_on_error:
                    raise RuntimeError(f"Caption failed for {path}: {error}") from error
                errors.append({"source": str(path), "stage": "caption", "error": str(error)})
                LOGGER.error("Caption failed: %s: %s", path, error)
        del captioner
        if real_models:
            release_models()
        if not records:
            raise ValueError("No images survived caption generation")
        segmenter = segmenter_factory(args) if args.mask_dir is None else None
        successful = []
        for record in records:
            image_path = staging / record["image"]
            try:
                image = load_image(image_path)
                if args.mask_dir is not None:
                    from PIL import Image

                    with Image.open(args.mask_dir / Path(record["source"]).with_suffix(".png")) as source_mask:
                        mask = source_mask.copy()
                else:
                    mask = segmenter.segment(image)
                size = target_size(image.size, args.max_resolution, args.resize_edge, args.upscale)
                image, mask = resize_pair(image, mask, size)
                coverage = float(np.count_nonzero(np.asarray(mask)) / (mask.width * mask.height))
                if not args.min_mask_fraction <= coverage <= args.max_mask_fraction:
                    raise ValueError(f"Suspicious mask coverage: {coverage:.4f}")
                image.save(image_path)
                mask_path = staging / record["mask"]
                mask_path.parent.mkdir(parents=True, exist_ok=True)
                mask.save(mask_path)
                record.update(width=image.width, height=image.height, mask_fraction=coverage)
                successful.append(record)
                LOGGER.info("Mask: %s (%dx%d, %.1f%%)", record["source"], image.width, image.height, coverage * 100)
            except Exception as error:
                if not args.continue_on_error:
                    raise RuntimeError(f"Mask failed for {record['source']}: {error}") from error
                image_path.unlink(missing_ok=True)
                image_path.with_suffix(".txt").unlink(missing_ok=True)
                (staging / record["mask"]).unlink(missing_ok=True)
                errors.append({"source": record["source"], "stage": "mask", "error": str(error)})
                LOGGER.error("Mask failed: %s: %s", record["source"], error)
        if not successful:
            raise ValueError("No usable masks; no dataset published")
        metadata = {"schema_version": 1, "caption_mode": args.caption_mode, "trigger_word": args.trigger_word, "settings": {key: str(value) if isinstance(value, Path) else value for key, value in vars(args).items()}, "images": successful, "errors": errors}
        (staging / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        export_configs(staging, final, args)
        if final.exists():
            final.rmdir()
        staging.rename(final)
        LOGGER.info("Published %d samples to %s; failed: %d", len(successful), final, len(errors))
        return final
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    args = parser().parse_args(argv)
    try:
        generate(args)
    except (ImportError, OSError, ValueError, RuntimeError) as error:
        LOGGER.error("%s", error)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
