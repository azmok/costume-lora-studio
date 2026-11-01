"""Inspect local prerequisites without downloading models or changing settings."""

from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess


def run(command: list[str], timeout=30):
    return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)


def probe_python(executable: str, modules: list[str]) -> dict:
    resolved = shutil.which(executable) if executable == "python" else executable
    if not resolved or not Path(resolved).is_file():
        return {"ok": False, "path": executable, "error": "Python 実行ファイルがありません"}
    code = (
        "import importlib.util,json,sys;"
        f"modules={modules!r};"
        "print(json.dumps({'python':sys.version.split()[0],'modules':{name:importlib.util.find_spec(name) is not None for name in modules}}))"
    )
    try:
        result = run([str(resolved), "-c", code])
        if result.returncode:
            return {"ok": False, "path": str(resolved), "error": result.stderr.strip()}
        report = json.loads(result.stdout)
        report["path"] = str(resolved)
        report["ok"] = all(report["modules"].values())
        if report["modules"].get("torch"):
            cuda = run([str(resolved), "-c", "import torch,json; print(json.dumps({'available':torch.cuda.is_available(),'torch':torch.__version__,'device':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None}))"], timeout=60)
            report["cuda"] = json.loads(cuda.stdout) if cuda.returncode == 0 else {"available": False, "error": cuda.stderr.strip()}
        return report
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        return {"ok": False, "path": str(resolved), "error": str(error)}


def snapshot_ready(path: Path) -> bool:
    if not (path / "config.json").is_file() or not (path / "preprocessor_config.json").is_file():
        return False
    return any(path.glob("*.safetensors")) or any(path.glob("pytorch_model*.bin"))


def inspect(project: Path, checkpoint: Path | None = None) -> dict:
    settings_path = Path(os.environ.get("APPDATA", str(project))) / "studio.azuma.costume-lora" / "settings.json"
    settings = {}
    if settings_path.is_file():
        settings = json.loads(settings_path.read_text(encoding="utf-8"))
    models = Path(settings.get("models_dir", project / "models"))
    engine = Path(settings.get("engine_dir", project / "vendor/sd-scripts"))
    tokenizer = Path(settings.get("tokenizer_dir", models / "tokenizers")) / "openai_clip-vit-large-patch14"
    inference = probe_python(str(settings.get("python_path", project / ".venv/Scripts/python.exe")),
                             ["numpy", "PIL", "torch", "torchvision", "transformers", "onnxruntime"])
    training = probe_python(str(settings.get("training_python", project / ".training-env/.venv/Scripts/python.exe")),
                            ["PIL", "torch", "torchvision", "transformers", "accelerate", "diffusers", "safetensors"])
    gpu = {"ok": False, "details": "nvidia-smi が見つかりません"}
    if shutil.which("nvidia-smi"):
        result = run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"])
        gpu = {"ok": result.returncode == 0, "details": result.stdout.strip() or result.stderr.strip()}
    checks = {
        "nvidia_gpu": gpu,
        "inference_python": inference,
        "training_python": training,
        "training_cuda": {"ok": training.get("cuda", {}).get("available", False)},
        "sd_scripts": {"ok": (engine / "train_network.py").is_file() and (engine / "networks/lora.py").is_file(), "path": str(engine)},
        "wd14": {"ok": all((models / "wd14" / name).is_file() for name in ("model.onnx", "selected_tags.csv")), "path": str(models / "wd14")},
        "grounding_dino": {"ok": bool(snapshot_ready(models / "grounding-dino")), "path": str(models / "grounding-dino")},
        "sam": {"ok": bool(snapshot_ready(models / "sam")), "path": str(models / "sam")},
        "clip_tokenizer": {"ok": all((tokenizer / name).is_file() for name in ("vocab.json", "merges.txt", "tokenizer_config.json")), "path": str(tokenizer)},
        "sd15_checkpoint": {"ok": checkpoint is not None and checkpoint.is_file() and checkpoint.suffix.lower() == ".safetensors", "path": str(checkpoint) if checkpoint else None},
    }
    return {"checked_at": datetime.now().astimezone().isoformat(), "ready": all(check["ok"] for check in checks.values()), "checks": checks}


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--checkpoint", type=Path)
    cli.add_argument("--output", type=Path)
    args = cli.parse_args()
    report = inspect(Path(__file__).resolve().parents[1], args.checkpoint)
    rendered = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)
    return 0 if report["ready"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
