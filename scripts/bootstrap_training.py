"""First-run setup of everything training needs on a new PC (called by start.cmd):
kohya sd-scripts in vendor/sd-scripts, the .training-env Python environment, and the offline CLIP tokenizer."""

from __future__ import annotations

import argparse
from pathlib import Path
import subprocess
import sys
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT))

import comfy_setup  # noqa: E402  (shares the safe zip extraction)

ENGINE_ZIP = "https://github.com/kohya-ss/sd-scripts/archive/refs/heads/main.zip"
TOKENIZER_REPO = "https://huggingface.co/openai/clip-vit-large-patch14/resolve/main/"
TOKENIZER_FILES = ("vocab.json", "merges.txt", "tokenizer_config.json", "special_tokens_map.json")


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": comfy_setup.USER_AGENT}), timeout=600) as response:
        return response.read()


def ensure_engine(engine: Path) -> bool:
    if (engine / "train_network.py").is_file():
        return False
    if engine.exists() and any(engine.iterdir()):
        raise SystemExit(f"{engine} exists but has no train_network.py. Move it away and run again.")
    print("[setup] Downloading kohya sd-scripts…", flush=True)
    comfy_setup.extract_release(fetch(ENGINE_ZIP), engine)
    return True


def ensure_environment(engine: Path, torch_index: str | None) -> bool:
    python = PROJECT / ".training-env" / ".venv" / "Scripts" / "python.exe"
    if python.is_file():
        return False
    command = [sys.executable, str(PROJECT / "scripts" / "setup_training.py"), "--engine", str(engine)]
    if torch_index:
        command += ["--torch-index", torch_index]
    print("[setup] Creating the training environment (PyTorch, several GB)…", flush=True)
    subprocess.run(command, check=True)
    return True


def ensure_tokenizer(folder: Path) -> bool:
    target = folder / "openai_clip-vit-large-patch14"
    missing = [name for name in TOKENIZER_FILES if not (target / name).is_file()]
    if not missing:
        return False
    target.mkdir(parents=True, exist_ok=True)
    for name in missing:
        print(f"[setup] Downloading tokenizer file {name}…", flush=True)
        (target / name).write_bytes(fetch(TOKENIZER_REPO + name))
    return True


def main(argv=None) -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--engine", type=Path, default=PROJECT / "vendor" / "sd-scripts")
    cli.add_argument("--tokenizers", type=Path, default=PROJECT / "models" / "tokenizers")
    cli.add_argument("--torch-index", default=None, help="PyTorch wheel index for the training environment")
    args = cli.parse_args(argv)
    ensure_engine(args.engine.resolve())
    ensure_environment(args.engine.resolve(), args.torch_index)
    ensure_tokenizer(args.tokenizers.resolve())
    print("[setup] Training environment ready.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
