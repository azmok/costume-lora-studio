"""JSON job entry point for the desktop app. No HTTP server is used."""

from __future__ import annotations

import argparse
import base64
from io import BytesIO
import importlib.util
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib

import dataset_generator as generator
import model_download
import comfy_setup


def emit(message: str, **details) -> None:
    print(json.dumps({"message": message, **details}, ensure_ascii=False), flush=True)


generator.EVENT_SINK = emit


def text(payload: dict, key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip() or "\x00" in value:
        raise ValueError(f"{key}: enter a value")
    return value.strip()


def local_path(payload: dict, key: str, kind: str = "directory") -> Path:
    path = Path(text(payload, key)).resolve()
    if kind == "directory" and not path.is_dir():
        raise ValueError(f"{key}: folder not found: {path}")
    if kind == "file" and not path.is_file():
        raise ValueError(f"{key}: file not found: {path}")
    return path


def number(payload: dict, key: str, default, minimum, maximum, integer=False):
    value = payload.get(key, default)
    if isinstance(value, bool):
        raise ValueError(f"{key}: enter a number")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{key}: enter a number") from error
    if not math.isfinite(result) or not minimum <= result <= maximum or (integer and not result.is_integer()):
        raise ValueError(f"{key}: enter {'an integer' if integer else 'a number'} from {minimum} to {maximum}")
    return int(result) if integer else result


def options(payload: dict) -> argparse.Namespace:
    args = generator.parser().parse_args(["--trigger_word", "mask_job", "--caption_mode", "tag"])
    args.input_dir = str(local_path(payload, "input_dir"))
    args.output_dir = text(payload, "output_dir")
    args.device = payload.get("device", "auto")
    if args.device not in ("auto", "cpu", "cuda"):
        raise ValueError("device: use auto, cpu or cuda")
    models = Path(text(payload, "models_dir"))
    generator.LOGGER.info("models_dir=%s (resolved=%s, cwd=%s)", models, models.resolve(), Path.cwd())
    args.wd_model_dir = models / "wd14"
    args.vlm_model_dir = models / "qwen2-vl"
    args.dino_model_dir = models / "grounding-dino"
    args.sam_model_dir = models / "sam"
    args.max_resolution = number(payload, "max_resolution", 512, 64, 4096, integer=True)
    return args


class SkipImage(ValueError):
    """An image that cannot be masked; the job skips it and continues."""


def mask_data_url(mask, limit: int = 1024) -> str:
    """Small PNG data URL of a binary mask for the live preview (nearest-neighbour keeps it binary)."""
    from PIL import Image

    scale = min(1.0, limit / max(mask.size))
    small = mask if scale == 1.0 else mask.resize((max(1, round(mask.width * scale)), max(1, round(mask.height * scale))), Image.Resampling.NEAREST)
    stream = BytesIO()
    small.save(stream, format="PNG")
    return "data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii")


def generate_masks(payload: dict, segmenter_factory=None) -> Path:
    import numpy as np

    args = options(payload)
    args.mask_prompt = text(payload, "mask_prompt")
    args.exclude_prompt = text(payload, "exclude_prompt")
    # An existing mask folder is allowed: masks that already exist are never overwritten, only skipped.
    paths = generator.validate_inputs(args, allow_existing_output=True)
    if segmenter_factory is None:
        emit("Checking model files…", phase="check")
        generator.require_snapshot(args.dino_model_dir, download=True)
        generator.require_snapshot(args.sam_model_dir, download=True)
        segmenter_factory = generator.GroundedSAM
    source = Path(args.input_dir).resolve()
    destination = Path(args.output_dir).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".mask-job-", dir=destination.parent))
    try:
        segmenter = None
        records = []
        skipped = []
        existing = []
        for current, path in enumerate(paths, 1):
            relative = path.relative_to(source)
            if (destination / relative.with_suffix(".png")).is_file():
                existing.append(relative.as_posix())
                emit(f"[SKIP] {relative.as_posix()}: a mask with the same name already exists", current=current, total=len(paths))
                continue
            try:
                share = generator.transparent_fraction(path)
                if share >= generator.TRANSPARENT_LIMIT:
                    raise SkipImage(f"Background is already transparent (transparent {share:.0%})")
                image = generator.load_image(path)
                if segmenter is None:
                    emit("Loading the segmentation models… (the first load can take a few minutes)", phase="load")
                    segmenter = segmenter_factory(args)
                    emit("Models ready — creating masks", phase="run", current=current - 1, total=len(paths))
                mask = segmenter.segment(image)
                _, mask = generator.resize_pair(image, mask, image.size)
                fraction = float(np.count_nonzero(np.asarray(mask)) / (mask.width * mask.height))
                if not args.min_mask_fraction <= fraction <= args.max_mask_fraction:
                    raise SkipImage(f"Mask area is abnormal ({fraction:.1%})")
            except (SkipImage, ValueError, OSError) as error:
                skipped.append({"source": relative.as_posix(), "reason": str(error)})
                emit(f"[SKIP] {relative.as_posix()}: {error}", current=current, total=len(paths))
                continue
            target = staging / relative.with_suffix(".png")
            target.parent.mkdir(parents=True, exist_ok=True)
            mask.save(target)
            records.append({"source": relative.as_posix(), "mask": relative.with_suffix(".png").as_posix(), "width": mask.width, "height": mask.height, "mask_fraction": fraction})
            emit(f"Mask created: {relative}", current=current, total=len(paths),
                 preview_source=relative.as_posix(), preview_mask=mask_data_url(mask))
        if not records and not existing:
            raise ValueError("No usable masks. Every image was skipped (see [SKIP] in the log).")
        emit(f"{len(records)} masks created; skipped {len(existing)} existing and {len(skipped)} others")
        if not records:
            return destination
        metadata = {"schema_version": 1, "source_dir": str(source), "images": records, "skipped": skipped, "existing": existing}
        if not destination.exists():
            (staging / "mask_metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            staging.rename(destination)
            return destination
        # Merge into the existing folder without ever replacing a file.
        for record in records:
            target = destination / record["mask"]
            if not target.exists():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(staging / record["mask"]), str(target))
        metadata_path = destination / "mask_metadata.json"
        try:
            previous = json.loads(metadata_path.read_text(encoding="utf-8"))
            kept = [item for item in previous.get("images", []) if item.get("source") not in {record["source"] for record in records}]
            metadata["images"] = kept + records
        except (OSError, ValueError, AttributeError):
            pass
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return destination
    finally:
        if staging.exists():
            shutil.rmtree(staging)


def create_dataset(payload: dict) -> Path:
    args = options(payload)
    args.transparent = flag(payload, "transparent", False)
    args.mask_dir = None if args.transparent else local_path(payload, "mask_dir")
    if payload.get("caption_dir"):
        args.caption_dir = local_path(payload, "caption_dir")
    args.trigger_word = text(payload, "trigger_word")
    args.caption_mode = payload.get("caption_mode", "tag")
    if args.caption_mode not in ("tag", "vlm"):
        raise ValueError("caption_mode: use tag or vlm")
    args.precision = payload.get("precision", "bf16")
    if args.precision not in ("bf16", "fp16", "fp32", "4bit", "8bit"):
        raise ValueError("precision: invalid value")
    return generator.generate(args)


def segmentation_prompt(value: str) -> str:
    words = {"衣装": "outfit", "服": "clothing", "上着": "jacket", "ジャケット": "jacket",
             "スカート": "skirt", "ズボン": "pants", "パンツ": "pants", "ドレス": "dress",
             "シャツ": "shirt", "靴": "shoes", "顔": "face", "髪": "hair", "手": "hands",
             "肌": "exposed skin", "素肌": "exposed skin", "腕": "bare arms", "脚": "bare legs"}
    colors = {"赤い": "red", "青い": "blue", "黒い": "black", "白い": "white", "緑の": "green"}
    converted = []
    for term in re.split(r"[,、;\n]+", value):
        term = re.sub(r"(だけ|のみ)$", "", term.strip())
        if not term:
            continue
        prefix = ""
        for japanese, english in colors.items():
            if term.startswith(japanese):
                prefix = english + " "
                term = term[len(japanese):]
                break
        if term in words:
            converted.append(prefix + words[term])
        elif term.isascii():
            converted.append(prefix + term)
        else:
            raise ValueError("For Japanese, use short clothing names such as 服, 上着 or 赤いジャケット. Use English for anything more complex.")
    if not converted:
        raise ValueError("Enter what to mask")
    return ", ".join(converted)


def mask_image(payload: dict, segmenter_factory=None) -> None:
    args = options(payload)
    root = Path(args.input_dir).resolve()
    path = local_path(payload, "image_path", "file")
    if not path.is_relative_to(root) or path.suffix.lower() not in generator.EXTENSIONS:
        raise ValueError("The selected image is outside the source folder")
    image = generator.load_image(path)
    args.mask_prompt = segmentation_prompt(text(payload, "mask_prompt"))
    args.exclude_prompt = segmentation_prompt(text(payload, "exclude_prompt"))
    points = payload.get("points", [])
    if not isinstance(points, list) or len(points) > 64:
        raise ValueError("Use at most 64 mouse points")
    args.mask_points = []
    for point in points:
        if not isinstance(point, dict) or point.get("label") not in (0, 1):
            raise ValueError("Invalid mouse point format")
        args.mask_points.append({
            "x": number(point, "x", -1, 0, image.width - 1),
            "y": number(point, "y", -1, 0, image.height - 1),
            "label": point["label"],
        })
    if segmenter_factory is None:
        emit("Checking model files…", phase="check")
        generator.require_snapshot(args.dino_model_dir, download=True)
        generator.require_snapshot(args.sam_model_dir, download=True)
        segmenter_factory = generator.GroundedSAM
    mask = segmenter_factory(args).segment(image)
    _, mask = generator.resize_pair(image, mask, image.size)
    if mask.getextrema() != (0, 255):
        raise ValueError("No target area found. Change the text prompt or the mouse points.")
    stream = BytesIO()
    mask.save(stream, format="PNG")
    emit("Auto mask previewed. Review it, then save.",
         image=str(path), preview_mask="data:image/png;base64," + base64.b64encode(stream.getvalue()).decode("ascii"))


def generate_captions(payload: dict, captioner_factory=None) -> Path | None:
    # Blank output_dir = write each caption beside its image (in place).
    in_place = not str(payload.get("output_dir") or "").strip()
    if in_place:
        source = local_path(payload, "input_dir")
        # options()/validate_inputs() need a non-overlapping placeholder; it is never created.
        payload = {**payload, "output_dir": str(source.parent / (source.name + ".captions-unused"))}
    args = options(payload)
    args.trigger_word = text(payload, "trigger_word")
    # Batches merge into an existing caption folder; existing files are only replaced with overwrite=true.
    paths = generator.validate_inputs(args, allow_existing_output=True)
    root = Path(args.input_dir).resolve()
    selected = payload.get("image_path")
    subset = payload.get("image_paths")
    overwrite = payload.get("overwrite", False)
    if not isinstance(overwrite, bool):
        raise ValueError("overwrite must be true or false")
    if selected:
        path = local_path(payload, "image_path", "file")
        if path not in paths:
            raise ValueError("The selected image is outside the source folder")
        paths = [path]
    elif subset is not None:
        if not isinstance(subset, list) or not subset or not all(isinstance(item, str) and item.strip() and "\x00" not in item for item in subset):
            raise ValueError("image_paths: provide a list of image paths")
        known = set(paths)
        chosen = []
        for item in subset:
            path = Path(item).resolve()
            if path not in known:
                raise ValueError("The selected image is outside the source folder")
            if path not in chosen:
                chosen.append(path)
        paths = chosen
    args.exclude_clothing = payload.get("exclude_clothing", True)
    if not isinstance(args.exclude_clothing, bool):
        raise ValueError("exclude_clothing must be true or false")
    args.caption_prompt = str(payload.get("caption_prompt") or "").strip()
    if "\x00" in args.caption_prompt:
        raise ValueError("caption_prompt contains unsupported characters")
    if len(args.caption_prompt) > 4000:
        raise ValueError("The caption instruction must be 4000 characters or fewer")
    args.precision = payload.get("precision", "bf16")
    if args.precision not in ("4bit", "8bit", "bf16", "fp16", "fp32"):
        raise ValueError("Invalid precision value")
    emit("Checking model files…", phase="check")
    provider = payload.get("caption_model", "qwen2-vl")
    models = Path(payload["models_dir"])
    if captioner_factory is None:
        if provider in ("wd14", "wd-eva02-large-tagger-v3"):
            args.wd_model_dir = models / provider
            generator.require_snapshot(args.wd_model_dir, ("model.onnx", "selected_tags.csv"), download=True)
            args.tag_threshold = number(payload, "tag_threshold", 0.35 if provider == "wd14" else 0.53, 0, 1)
            captioner_factory = lambda options: generator.WD14Captioner(options, generator.DEFAULT_BLACKLIST if options.exclude_clothing else ())
        elif provider == "qwen2-vl":
            if not args.caption_prompt:
                raise ValueError("caption_prompt: Qwen2-VL needs a generation instruction")
            args.vlm_model_dir = models / provider
            generator.require_snapshot(args.vlm_model_dir, download=True)
            captioner_factory = generator.QwenCaptioner
        else:
            raise ValueError("Unsupported caption model")
    if selected:
        emit("Loading the caption model… (the first load can take a few minutes)", phase="load")
        captioner = captioner_factory(args)
        emit("Model ready — generating the caption", phase="run", current=0, total=len(paths))
        for path in paths:
            caption = captioner.caption(generator.load_image(path)).strip()
            caption = args.trigger_word + (", " + caption if caption else "")
            emit("Caption generated. You can edit and save it.", image=str(path), caption=caption, phase="run", current=len(paths), total=len(paths))
        return None
    base = root if in_place else Path(args.output_dir).resolve()

    def target_for(path: Path) -> Path:
        return (base / path.relative_to(root)).with_suffix(".txt")

    def has_caption(target: Path) -> bool:
        return target.is_file() and bool(target.read_text(encoding="utf-8", errors="replace").strip())

    # Images outside the chosen set are never touched; existing captions are kept unless overwrite=true.
    pending = [path for path in paths if overwrite or not has_caption(target_for(path))]
    skipped = len(paths) - len(pending)
    if skipped:
        emit(f"Skipped {skipped} images that already have a caption (not overwritten)")
    if not pending:
        raise ValueError("Every target image already has a caption (to regenerate, choose “Overwrite existing captions”).")
    emit("Loading the caption model… (the first load can take a few minutes)", phase="load")
    captioner = captioner_factory(args)
    emit(f"Model ready — captioning {len(pending)} images", phase="run", current=0, total=len(pending))
    for current, path in enumerate(pending, 1):
        caption = captioner.caption(generator.load_image(path)).strip()
        caption = args.trigger_word + (", " + caption if caption else "")
        target = target_for(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(target.name + ".tmp")
        temporary.write_text(caption + "\n", encoding="utf-8")
        temporary.replace(target)
        emit(f"Caption: {path.name}", current=current, total=len(pending), phase="run", image=path.name)
    return base


def contained(root: Path, relative: str) -> Path:
    if not isinstance(relative, str):
        raise ValueError("Invalid path in metadata")
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError("A path in the metadata points outside the folder")
    return path


def normalize_source(value: str) -> str:
    text_value = str(value).replace("\\", "/").strip()
    return text_value.removeprefix("./").casefold()


def excluded_sources(payload: dict) -> set:
    """Images unchecked in the Tools tab (paths relative to the source folder); empty = use everything."""
    value = payload.get("excluded_sources")
    if value is None:
        return set()
    if not isinstance(value, list) or len(value) > 200000 or not all(isinstance(item, str) for item in value):
        raise ValueError("excluded_sources must be a list of image paths")
    return {normalize_source(item) for item in value}


def materialize_selection(selection: dict) -> None:
    """Build the folder the trainer reads when some images are unchecked: links (or copies) of the chosen
    images, captions and masks only. The prepared dataset itself is never touched."""
    root = selection["root"]
    for image_path, mask_path, caption_path, relative in selection["files"]:
        image_target = root / "images" / relative
        pairs = [(image_path, image_target), (caption_path, image_target.with_suffix(".txt"))]
        if mask_path is not None:
            pairs.append((mask_path, root / "masks" / relative))
        for source, target in pairs:
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                continue
            try:
                os.link(source, target)
            except OSError:
                shutil.copy2(source, target)


OPTIMIZER_PACKAGES = {
    "AdamW": None, "AdamW8bit": ("bitsandbytes", "bitsandbytes"), "PagedAdamW8bit": ("bitsandbytes", "bitsandbytes"),
    "Lion": ("lion_pytorch", "lion-pytorch"), "SGDNesterov": None,
    "DAdaptAdam": ("dadaptation", "dadaptation"), "DAdaptation": ("dadaptation", "dadaptation"),
    "Prodigy": ("prodigyopt", "prodigyopt"), "Adafactor": None,
}
ADAPTIVE_OPTIMIZERS = ("DAdaptAdam", "DAdaptation", "Prodigy")
LR_SCHEDULERS = ("constant", "constant_with_warmup", "linear", "cosine", "cosine_with_restarts", "polynomial")


def choice(payload: dict, key: str, default, allowed):
    value = payload.get(key, default)
    if isinstance(value, bool) or value not in allowed:
        raise ValueError(f"{key}: choose one of {', '.join(str(item) for item in allowed)}")
    return value


def flag(payload: dict, key: str, default: bool) -> bool:
    value = payload.get(key, default)
    if not isinstance(value, bool):
        raise ValueError(f"{key}: must be true or false")
    return value


def optimizer_args(payload: dict) -> list:
    value = payload.get("optimizer_args", "")
    if not isinstance(value, str) or len(value) > 300:
        raise ValueError("optimizer_args: enter key=value pairs separated by spaces")
    tokens = value.split()
    for token in tokens:
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=[^ ]+", token):
            raise ValueError("optimizer_args: use the form key=value key2=value2")
    return tokens


def optimizer_package_problem(name: str):
    """Returns a message when the optimizer needs a Python package that is not installed, else None."""
    package = OPTIMIZER_PACKAGES.get(name)
    if package and importlib.util.find_spec(package[0]) is None:
        return f"Optimizer {name} needs the Python package {package[0]}. Install it with: pip install {package[1]} (or pick another optimizer)"
    return None


COMPONENT_LABELS = {
    "checkpoint": "Base model", "clip_l": "CLIP-L", "clip_g": "CLIP-G", "t5xxl": "T5-XXL", "ae": "AutoEncoder (ae)", "vae": "VAE",
    "text_encoder": "Qwen2.5-VL text encoder", "byt5": "byT5", "gemma2": "Gemma 2", "qwen3": "Qwen3",
}
COMPONENT_ARGS = {"checkpoint": "pretrained_model_name_or_path"}  # every other component uses its own key as the option name
_CACHES = {"cache_text_encoder_outputs": True, "cache_latents": True}
# One entry per model family (the UI list in ui/model-families.mjs must name the same ids and components).
FAMILIES = {
    "sd15": {"label": "SD1.5", "script": "train_network.py", "modules": ("networks.lora",), "required": ("checkpoint",), "optional": (),
             "flow": False, "fp8": "fp8_base", "swap": False, "extra": {}},
    "sdxl": {"label": "SDXL", "script": "sdxl_train_network.py", "modules": ("networks.lora",), "required": ("checkpoint",), "optional": (),
             "flow": False, "fp8": "fp8_base", "swap": False, "extra": {"cache_latents": True}},
    "sd3": {"label": "SD3.5", "script": "sd3_train_network.py", "modules": ("networks.lora_sd3", "networks.lora"), "required": ("checkpoint",),
            "optional": ("clip_l", "clip_g", "t5xxl", "vae"), "flow": True, "fp8": "fp8_base", "swap": True,
            "extra": {"weighting_scheme": "uniform", "sdpa": True, **_CACHES}},
    "flux": {"label": "FLUX.1", "script": "flux_train_network.py", "modules": ("networks.lora_flux",), "required": ("checkpoint", "clip_l", "t5xxl", "ae"),
             "optional": (), "flow": True, "fp8": "fp8_base", "swap": True,
             "extra": {"guidance_scale": 1.0, "timestep_sampling": "flux_shift", "model_prediction_type": "raw", "sdpa": True, **_CACHES}},
    "lumina": {"label": "Lumina Image 2.0", "script": "lumina_train_network.py", "modules": ("networks.lora_lumina",), "required": ("checkpoint", "gemma2", "ae"),
               "optional": (), "flow": True, "fp8": "fp8_base", "swap": True,
               "extra": {"timestep_sampling": "nextdit_shift", "discrete_flow_shift": 6.0, "model_prediction_type": "raw", **_CACHES}},
    "hunyuan": {"label": "HunyuanImage 2.1", "script": "hunyuan_image_train_network.py", "modules": ("networks.lora_hunyuan_image",),
                "required": ("checkpoint", "text_encoder", "byt5", "vae"), "optional": (), "flow": True, "fp8": "fp8_scaled", "swap": True,
                "extra": {"model_prediction_type": "raw", "discrete_flow_shift": 5.0, "attn_mode": "torch", "split_attn": True, **_CACHES}},
    "anima": {"label": "Anima", "script": "anima_train_network.py", "modules": ("networks.lora_anima",), "required": ("checkpoint", "qwen3", "vae"),
              "optional": (), "flow": True, "fp8": None, "swap": True,
              "extra": {"timestep_sampling": "sigmoid", "discrete_flow_shift": 1.0, "vae_chunk_size": 64, "vae_disable_cache": True, **_CACHES}},
}


def model_family(payload: dict):
    family_id = payload.get("model_family", "sd15")
    if not isinstance(family_id, str) or family_id not in FAMILIES:
        raise ValueError("model_family: choose one of " + ", ".join(FAMILIES))
    return family_id, FAMILIES[family_id]


def family_components(payload: dict, family: dict) -> dict:
    """The model files of the family as paths: the required ones must exist, the optional ones only if given."""
    found = {}
    for key in family["required"] + family["optional"]:
        value = payload.get(key)
        if not isinstance(value, str) or not value.strip():
            if key in family["required"]:
                raise ValueError(f"{key}: choose the {COMPONENT_LABELS[key]} file for {family['label']}")
            continue
        path = local_path(payload, key, "file") if key != "qwen3" or not Path(value).is_dir() else local_path(payload, key)
        if path.is_file() and path.suffix.lower() != ".safetensors":
            raise ValueError(f"{key}: choose a .safetensors file ({COMPONENT_LABELS[key]})")
        found[key] = path
    return found


def engine_args(engine: Path) -> set:
    """Option names the installed sd-scripts knows, read from its sources (empty when they cannot be read)."""
    known = set()
    for folder in (engine, engine / "library", engine / "networks"):
        for path in folder.glob("*.py"):
            try:
                known.update(re.findall(r"--([A-Za-z0-9_]+)", path.read_text(encoding="utf-8", errors="ignore")))
            except OSError:
                continue
    return known


def training_plan(payload: dict) -> dict:
    try:
        from PIL import Image
    except ModuleNotFoundError as error:
        raise ValueError(f"The Training Python ({sys.executable}) is not the training environment (missing {error.name}). In Environment, set Training Python to .training-env/.venv/Scripts/python.exe (see DESKTOP.md).") from error

    alpha_mask = flag(payload, "alpha_mask", False)
    use_masks = flag(payload, "use_masks", True) and not alpha_mask
    dataset = local_path(payload, "dataset_dir")
    engine = local_path(payload, "engine_dir")
    family_id, family = model_family(payload)
    components = family_components(payload, family)
    tokenizer = local_path(payload, "tokenizer_dir") if family_id == "sd15" else None
    module = next((item for item in family["modules"] if (engine / (item.replace(".", "/") + ".py")).is_file()), None)
    if not (engine / family["script"]).is_file() or module is None:
        raise ValueError(f"engine_dir: set it to the root of kohya sd-scripts (a version that has {family['script']} and {family['modules'][0].replace('.', '/')}.py for {family['label']})")
    if tokenizer is not None:
        for name in ("vocab.json", "merges.txt", "tokenizer_config.json"):
            if not (tokenizer / "openai_clip-vit-large-patch14" / name).is_file():
                raise ValueError(f"Offline CLIP tokenizer is missing: {name}")
    metadata = json.loads((dataset / "metadata.json").read_text(encoding="utf-8"))
    if metadata.get("settings", {}).get("transparent") and not alpha_mask:
        raise ValueError("This dataset uses transparency. Enable All images use transparency (alpha mask).")
    masks = local_path(payload, "mask_dir") if use_masks else None
    records = metadata.get("images", [])
    if not isinstance(records, list) or not records:
        raise ValueError("The dataset is empty")
    unchecked = excluded_sources(payload)
    left_out = 0
    if unchecked:
        kept = [record for record in records if normalize_source(record.get("source", "")) not in unchecked]
        left_out = len(records) - len(kept)
        if not kept:
            raise ValueError("No images are selected for training. Check at least one image in Tools, or turn off “Use only the images selected in Tools”.")
        records = kept
    groups = set()
    chosen = []
    for record in records:
        image_path = contained(dataset, record["image"])
        image_relative = image_path.relative_to(dataset / "images")
        mask_path = None
        if use_masks:
            mask_path = contained(masks, image_relative.as_posix())
            if not mask_path.is_file():
                raise ValueError(f"No mask for {record.get('source', image_relative.as_posix())}: {mask_path} (create the mask, uncheck this image in Tools, or turn off “Use masks”)")
        caption = image_path.with_suffix(".txt")
        if not caption.is_file() or not caption.read_text(encoding="utf-8").strip():
            raise ValueError(f"Caption is empty or missing: {caption}")
        with Image.open(image_path) as image:
            if alpha_mask:
                generator.load_transparent_image(image_path)
            if min(image.size) < 64:
                raise ValueError(f"Image short side is too small: {image_path}")
            if mask_path is not None:
                with Image.open(mask_path) as mask:
                    if mask.format != "PNG" or mask.mode != "L" or image.size != mask.size:
                        raise ValueError(f"Masks must be 8-bit L PNGs with the same resolution: {mask_path}")
                    if any(mask.histogram()[1:255]) or mask.getextrema() != (0, 255):
                        raise ValueError(f"Masks must be binary images containing both white and black: {mask_path}")
        groups.add(image_relative.parent.as_posix())
        chosen.append((image_path, mask_path, caption, image_relative))
    output = Path(text(payload, "output_dir")).resolve()
    if output == dataset or output.is_relative_to(dataset) or dataset.is_relative_to(output):
        raise ValueError("Keep the training output and the dataset in separate folders")
    if output.exists() and (not output.is_dir() or any(output.iterdir())):
        raise ValueError("The training output folder must be new or empty")
    name = text(payload, "output_name")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,79}", name):
        raise ValueError("LoRA name must start with a letter or digit and use up to 80 letters, digits, _ or -")
    resolution = number(payload, "resolution", 1024 if family_id != "sd15" else 512, 256, 2048, True)
    if resolution % 64:
        raise ValueError("resolution: use a multiple of 64")
    rank = number(payload, "rank", 16, 1, 512, True)
    alpha = number(payload, "alpha", 16, 0.1, rank)
    batch = number(payload, "batch_size", 1, 1, 16, True)
    repeats = number(payload, "repeats", 1, 1, 200, True)
    epochs = number(payload, "epochs", 10, 1, 1000, True)
    steps = number(payload, "steps", 1000, 0 if "epochs" in payload else 1, 1000000, True)
    learning_rate = number(payload, "learning_rate", 0.0001, 0.0000001, 10)
    text_encoder_lr = number(payload, "text_encoder_lr", 0, 0, 10)
    warmup_percent = number(payload, "lr_warmup_percent", 0, 0, 50)
    cycles = number(payload, "lr_scheduler_num_cycles", 1, 1, 20, True)
    seed = number(payload, "seed", 42, 0, 2147483647, True)
    min_snr = number(payload, "min_snr_gamma", 0, 0, 20)
    noise_offset = number(payload, "noise_offset", 0, 0, 1)
    keep_tokens = number(payload, "keep_tokens", 0, 0, 10, True)
    swap_blocks = number(payload, "blocks_to_swap", 0, 0, 60, True)
    clip_skip = choice(payload, "clip_skip", 1, (1, 2))
    shuffle = flag(payload, "shuffle_caption", False)
    checkpointing = flag(payload, "gradient_checkpointing", True)
    fp8 = flag(payload, "fp8_base", False)
    optimizer = choice(payload, "optimizer", "AdamW", tuple(OPTIMIZER_PACKAGES))
    scheduler = choice(payload, "lr_scheduler", "constant", LR_SCHEDULERS)
    extra_args = optimizer_args(payload)
    precision = payload.get("mixed_precision", "fp16")
    if precision not in ("fp16", "bf16", "no"):
        raise ValueError("mixed_precision: use fp16, bf16 or no")
    steps_per_epoch = math.ceil(len(records) * repeats / batch)
    by_epochs = "epochs" in payload and steps == 0
    total_steps = steps_per_epoch * epochs if by_epochs else (steps or steps_per_epoch * epochs)
    warnings = []
    if optimizer in ADAPTIVE_OPTIMIZERS and learning_rate < 0.1:
        warnings.append(f"{optimizer} adapts the learning rate by itself: set Learning rate to 1 (now {learning_rate:g}).")
    flow = family["flow"]
    if flow:  # these models cache the text encoder outputs, so captions cannot be shuffled and only the main network is trained
        if shuffle:
            warnings.append(f"{family['label']} caches the text encoder outputs, so “Shuffle caption tags” is ignored.")
        shuffle, keep_tokens = False, 0
        ignored = [label for label, value in (("Min SNR gamma", min_snr), ("Noise offset", noise_offset), ("Clip skip", clip_skip != 1)) if value]
        if ignored:
            warnings.append(f"{family['label']} does not use: {', '.join(ignored)}.")
        if text_encoder_lr > 0:
            warnings.append(f"{family['label']} trains the main network only: the Text encoder LR is ignored.")
        min_snr = noise_offset = text_encoder_lr = 0
        clip_skip = 1
    quote = lambda value: json.dumps(str(value), ensure_ascii=False)
    dataset_toml = (
        f'[general]\ncaption_extension = ".txt"\nshuffle_caption = {str(shuffle).lower()}\n'
        + (f"keep_tokens = {keep_tokens}\n" if shuffle and keep_tokens else "")
        + f'\n[[datasets]]\nresolution = {resolution}\nbatch_size = {batch}\nenable_bucket = true\n'
        'bucket_no_upscale = true\nbucket_reso_steps = 64\nmin_bucket_reso = 64\n'
        f'max_bucket_reso = {resolution * 2}\n\n'
    )
    selection = {"root": output / "selected_dataset", "files": chosen} if left_out else None
    image_base = selection["root"] / "images" if selection else dataset / "images"
    mask_base = (selection["root"] / "masks" if selection else masks) if use_masks else None
    for group in sorted(groups):
        dataset_toml += f'[[datasets.subsets]]\nimage_dir = {quote((image_base / group).as_posix())}\n'
        if use_masks:
            dataset_toml += f'conditioning_data_dir = {quote((mask_base / group).as_posix())}\n'
        if alpha_mask:
            dataset_toml += 'alpha_mask = true\n'
        dataset_toml += f'num_repeats = {repeats}\n\n'
    config = {COMPONENT_ARGS.get(key, key): path.as_posix() for key, path in components.items()}
    config.update({
        "dataset_config": (output / "dataset.toml").as_posix(),
        "output_dir": output.as_posix(),
        "output_name": name,
    })
    if tokenizer is not None:
        config["tokenizer_cache_dir"] = tokenizer.as_posix()
    config.update({"network_module": module, "network_dim": rank, "network_alpha": alpha, "learning_rate": learning_rate})
    if by_epochs:
        config["max_train_epochs"] = epochs
    else:
        config["max_train_steps"] = total_steps
    config.update({
        "mixed_precision": precision, "save_precision": "float" if precision == "no" else precision,
        "save_model_as": "safetensors", "optimizer_type": optimizer,
        "lr_scheduler": scheduler, "seed": seed,
        "masked_loss": use_masks, "gradient_checkpointing": checkpointing,
        "max_data_loader_n_workers": 0,
        "save_every_n_steps": max(1, min(250, total_steps)),
    })
    known = engine_args(engine)
    if flow or text_encoder_lr <= 0:
        config["network_train_unet_only"] = True
    elif family_id == "sdxl":
        if "text_encoder_lr1" in known:
            config.update({"text_encoder_lr1": text_encoder_lr, "text_encoder_lr2": text_encoder_lr, "unet_lr": learning_rate})
        else:
            config.update({"text_encoder_lr": [text_encoder_lr, text_encoder_lr], "unet_lr": learning_rate})
    else:
        config.update({"text_encoder_lr": text_encoder_lr, "unet_lr": learning_rate})
    config.update(family["extra"])
    if family_id == "sdxl":
        if precision == "fp16":
            config["no_half_vae"] = True  # the SDXL VAE is unstable in fp16
        if config.get("network_train_unet_only") and not shuffle:
            config["cache_text_encoder_outputs"] = True
    if fp8:
        if family["fp8"]:
            config[family["fp8"]] = True
        else:
            warnings.append(f"{family['label']} does not support fp8 base weights: the option is ignored.")
    if swap_blocks:
        if family["swap"]:
            config["blocks_to_swap"] = swap_blocks
        else:
            warnings.append(f"Block swap is not available for {family['label']}: the option is ignored.")
    if extra_args:
        config["optimizer_args"] = extra_args
    warmup_steps = round(total_steps * warmup_percent / 100)
    if warmup_steps:
        config["lr_warmup_steps"] = warmup_steps
    if scheduler == "cosine_with_restarts":
        config["lr_scheduler_num_cycles"] = cycles
    if min_snr:
        config["min_snr_gamma"] = min_snr
    if noise_offset:
        config["noise_offset"] = noise_offset
    if clip_skip != 1:
        config["clip_skip"] = clip_skip
    if "pretrained_model_name_or_path" in known:  # a readable sd-scripts: warn about options it does not have
        unknown = sorted(key for key in config if key not in known)
        if unknown:
            warnings.append("This sd-scripts does not list the option(s) " + ", ".join(unknown) + ". Update sd-scripts if training stops with an argument error.")
    training_toml = "\n".join(f"{key} = {str(value).lower() if isinstance(value, bool) else json.dumps(value, ensure_ascii=False)}" for key, value in config.items()) + "\n"
    tomllib.loads(training_toml)
    tomllib.loads(dataset_toml)
    return {"output": output, "engine": engine, "dataset_toml": dataset_toml, "training_toml": training_toml,
            "samples": len(records), "left_out": left_out, "selection": selection,
            "total_steps": total_steps, "steps_per_epoch": steps_per_epoch, "optimizer": optimizer, "warnings": warnings,
            "family": family_id, "label": family["label"], "script": family["script"]}


def train(payload: dict, check_only=False) -> None:
    plan = training_plan(payload)
    counts = {"samples": plan["samples"], "total_steps": plan["total_steps"], "steps_per_epoch": plan["steps_per_epoch"]}
    if plan["left_out"]:
        emit(f"Dataset verified: using {plan['samples']} of {plan['samples'] + plan['left_out']} images ({plan['left_out']} unchecked in Tools)", type="validated", **counts)
    else:
        emit(f"Dataset verified: {plan['samples']} images", type="validated", **counts)
    for warning in plan["warnings"]:
        emit("Warning: " + warning)
    problem = optimizer_package_problem(plan["optimizer"])
    if problem:
        raise ValueError(problem)
    import torch

    if not torch.cuda.is_available():
        raise ValueError(f"{plan['label']} training needs a CUDA-capable GPU and a matching PyTorch")
    if payload.get("mixed_precision", "fp16") == "bf16" and not torch.cuda.is_bf16_supported():
        raise ValueError("This GPU does not support bf16. Choose fp16.")
    if plan["family"] == "sd15":
        from transformers import CLIPTokenizer

        CLIPTokenizer.from_pretrained(str(Path(payload["tokenizer_dir"]) / "openai_clip-vit-large-patch14"), local_files_only=True)
    else:
        emit(f"Note: {plan['label']} loads its tokenizers through sd-scripts; the first run may download them from Hugging Face.")
    if check_only:
        emit(f"GPU: {torch.cuda.get_device_name(0)} / settings{' and local tokenizer' if plan['family'] == 'sd15' else ''} verified")
        return
    output = plan["output"]
    output.mkdir(parents=True, exist_ok=True)
    if plan["selection"]:
        materialize_selection(plan["selection"])
    (output / "dataset.toml").write_text(plan["dataset_toml"], encoding="utf-8")
    config_path = output / "training.toml"
    config_path.write_text(plan["training_toml"], encoding="utf-8")
    command = [sys.executable, "-u", str(plan["engine"] / plan["script"]), "--config_file", str(config_path)]
    emit(f"Starting {plan['label']} LoRA training", command=command, phase="run")
    result = subprocess.run(command, cwd=plan["engine"], creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
    if result.returncode:
        raise RuntimeError(f"Training process stopped with exit code {result.returncode}")
    if not (output / (payload["output_name"].strip() + ".safetensors")).is_file():
        raise RuntimeError("The training process ended but the final LoRA file was not found")
    emit(f"LoRA saved: {output}")
    lora_root = str(payload.get("lora_output_dir") or "").strip()
    if lora_root:
        try:
            published = comfy_setup.publish_lora(output, payload["output_name"].strip(), lora_root)
        except (OSError, ValueError) as error:
            emit(f"Warning: could not copy the LoRA to {lora_root}: {error}")
        else:
            emit(f"LoRA copied for ComfyUI: {published['lora_dir']} ({len(published['files'])} files)", type="published",
                 name=payload["output_name"].strip(), family=plan["family"], **published)


def main(argv=None) -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--request", type=Path, required=True)
    args = cli.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
    try:
        request = json.loads(args.request.read_text(encoding="utf-8-sig"))
        kind = request["kind"]
        payload = request["payload"]
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")
        if kind == "mask":
            result = generate_masks(payload)
            emit(f"Mask saved: {result}", output=str(result))
        elif kind == "caption":
            result = generate_captions(payload)
            if result:
                emit(f"Caption saved: {result}", output=str(result))
        elif kind == "mask_image":
            mask_image(payload)
        elif kind == "dataset":
            result = create_dataset(payload)
            emit(f"Dataset saved: {result}", output=str(result))
        elif kind == "comfy_install":
            comfy_setup.install_comfyui(payload, emit)
        elif kind == "download":
            args.request.unlink(missing_ok=True)  # the request carries access tokens: do not leave it on disk
            model_download.download_items(payload, emit)
        elif kind in ("train", "validate"):
            train(payload, check_only=kind == "validate")
        else:
            raise ValueError(f"Unsupported job: {kind}")
    except model_download.DownloadError as error:
        emit(str(error), level="error")
        return 1
    except Exception as error:
        emit(str(error), level="error")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
