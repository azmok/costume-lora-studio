"""ComfyUI integration for desktop_backend: copy a finished LoRA to the shared LoRA folder, and install ComfyUI
(Windows, uv-managed) when the PC does not have one yet."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import zipfile

RELEASE_API = "https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest"
DEFAULT_TORCH_INDEX = "https://download.pytorch.org/whl/cu130"
USER_AGENT = "costume-lora-studio/1.0"


def publish_lora(output: Path, name: str, lora_root: str, overwrite: bool = False) -> dict:
    """Copies <name>.safetensors and its step/epoch versions to <lora_root>/<name>/ (overwrites if requested, else uses a timestamped folder)."""
    files = sorted(output.glob(f"{name}*.safetensors"))
    if not files:
        raise ValueError(f"No LoRA files named {name}*.safetensors in {output}")
    root = Path(lora_root)
    target = root / name
    if target.exists() and any(target.iterdir()):
        if overwrite:
            for existing in target.glob(f"{name}*.safetensors"):
                existing.unlink(missing_ok=True)
        else:
            target = root / f"{name}_{time.strftime('%Y%m%d-%H%M%S')}"
    target.mkdir(parents=True, exist_ok=True)
    for path in files:
        shutil.copy2(path, target / path.name)
    final = target / f"{name}.safetensors"
    return {"lora_dir": target.as_posix(), "subfolder": target.name, "files": [path.name for path in files],
            "final": final.as_posix() if final.is_file() else (target / files[-1].name).as_posix()}


def _get(url: str, timeout: int = 60):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"}), timeout=timeout)


def latest_release() -> tuple[str, str]:
    """(tag, zip url) of the newest ComfyUI release."""
    try:
        with _get(RELEASE_API) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, OSError, ValueError) as error:
        raise ValueError(f"Could not ask GitHub for the latest ComfyUI release: {error}") from error
    tag, url = data.get("tag_name"), data.get("zipball_url")
    if not tag or not url:
        raise ValueError("GitHub did not return a ComfyUI release")
    return tag, url


def extract_release(archive: bytes, target: Path) -> None:
    """Unpacks a GitHub source zip (one top folder) into target, refusing paths that leave it."""
    target.mkdir(parents=True, exist_ok=True)
    root = target.resolve()
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        for member in bundle.infolist():
            parts = member.filename.split("/", 1)
            if len(parts) < 2 or not parts[1]:
                continue
            destination = (root / parts[1]).resolve()
            if not destination.is_relative_to(root):
                raise ValueError(f"Unsafe path in the ComfyUI archive: {member.filename}")
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_bytes(bundle.read(member))


def install_comfyui(payload: dict, emit) -> None:
    target = Path(str(payload.get("comfy_install_dir") or ""))
    if not str(payload.get("comfy_install_dir") or "").strip():
        raise ValueError("comfy_install_dir is missing")
    uv = shutil.which("uv")
    if not uv:
        raise ValueError("uv was not found. Install uv first (https://docs.astral.sh/uv/) and try again.")
    if (target / "main.py").is_file():
        emit(f"ComfyUI is already in {target}; checking its Python environment", phase="check")
    else:
        if target.exists() and any(target.iterdir()):
            raise ValueError(f"{target} exists but is not a ComfyUI folder. Move it away and try again.")
        tag, url = latest_release()
        emit(f"Downloading ComfyUI {tag}…", phase="download")
        try:
            with _get(url, timeout=300) as response:
                archive = response.read()
        except (urllib.error.URLError, TimeoutError, OSError) as error:
            raise ValueError(f"Could not download ComfyUI: {error}") from error
        extract_release(archive, target)
        if not (target / "main.py").is_file():
            raise ValueError("The downloaded ComfyUI has no main.py")
    python = target / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    run = lambda command, message: (emit(message, phase="load"), subprocess.run(command, cwd=target, check=True))
    if not python.is_file():
        run([uv, "venv", "--python", "3.12", str(target / ".venv")], "Creating the ComfyUI Python environment…")
    index = str(payload.get("torch_index") or DEFAULT_TORCH_INDEX)
    run([uv, "pip", "install", "--python", str(python), "torch", "torchvision", "torchaudio", "--index-url", index],
        "Installing PyTorch with CUDA (several GB, first time only)…")
    run([uv, "pip", "install", "--python", str(python), "-r", str(target / "requirements.txt")], "Installing ComfyUI requirements…")
    emit(f"ComfyUI installed in {target}", type="comfy_installed", root=target.as_posix())
