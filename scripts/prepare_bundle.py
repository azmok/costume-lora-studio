"""Assemble two portable Python runtimes and a local sd-scripts checkout."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import shutil
import subprocess
import sys


def inspect_python(executable: Path) -> dict:
    command = [
        str(executable), "-c",
        "import json,sys,sysconfig; print(json.dumps({'version':list(sys.version_info[:2]),'base':sys.base_prefix,'site':sysconfig.get_path('purelib')}))",
    ]
    return json.loads(subprocess.check_output(command, text=True))


def copy_runtime(executable: Path, target: Path, modules: list[str]) -> None:
    details = inspect_python(executable)
    if details["version"] != [3, 12]:
        raise ValueError("配布用 Python は、両環境とも Python 3.12 にしてください")
    base = Path(details["base"])
    if not (base / "python.exe").is_file() or not (base / "Lib" / "os.py").is_file():
        raise ValueError("Windows の uv 管理 Python standalone を使ってください")
    subprocess.run([str(executable), "-c", "; ".join(f"import {module}" for module in modules)], check=True)
    shutil.copytree(base, target, ignore=shutil.ignore_patterns("__pycache__", "site-packages"))
    shutil.copytree(details["site"], target / "Lib" / "site-packages", dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__"))
    (target / "python312._pth").write_text(
        "python312.zip\n.\nDLLs\nLib\nLib/site-packages\n../../backend\n../../engine/sd-scripts\nimport site\n",
        encoding="utf-8",
    )
    for path in target.rglob("*.pth"):
        content = path.read_text(encoding="utf-8-sig")
        if any(line and not line.startswith(("#", "import ")) and Path(line).is_absolute() for line in content.splitlines()):
            raise ValueError(f"移動不能な絶対パスを含む .pth があります: {path}")
    subprocess.run([str(target / "python.exe"), "-c", "; ".join(f"import {module}" for module in modules)], check=True)
    packages = subprocess.check_output([str(executable), "-c", "import importlib.metadata,json; print(json.dumps(sorted((dist.metadata['Name'],dist.version) for dist in importlib.metadata.distributions())))"], text=True)
    (target / "installed-packages.json").write_text(packages, encoding="utf-8")


def main(argv=None) -> int:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--inference-python", type=Path, required=True)
    cli.add_argument("--training-python", type=Path, required=True)
    cli.add_argument("--engine", type=Path, required=True)
    args = cli.parse_args(argv)
    project = Path(__file__).resolve().parents[1]
    target = project / "bundle-resources"
    config_path = project / "src-tauri" / "tauri.bundle.conf.json"
    if target.exists() or config_path.exists():
        raise ValueError("bundle-resources または配布設定が既にあります。別途退避してから作成してください")
    engine = args.engine.resolve()
    if not (engine / "train_network.py").is_file() or not (engine / "networks" / "lora.py").is_file():
        raise ValueError("sd-scripts のローカル checkout を指定してください")
    licenses = list(engine.glob("LICENSE*"))
    if not licenses:
        raise ValueError("学習エンジンの LICENSE が必要です")
    try:
        target.mkdir()
        backend = target / "backend"
        backend.mkdir()
        for name in ("dataset_generator.py", "desktop_backend.py"):
            shutil.copy2(project / name, backend / name)
        shutil.copytree(engine, target / "engine" / "sd-scripts",
                        ignore=shutil.ignore_patterns(".git", ".venv", "__pycache__", "logs", "outputs"))
        copy_runtime(args.inference_python.resolve(), target / "runtime" / "inference",
                     ["PIL.Image", "numpy", "torch", "torchvision", "transformers", "onnxruntime"])
        copy_runtime(args.training_python.resolve(), target / "runtime" / "training",
                     ["torch", "torchvision", "accelerate", "transformers", "diffusers", "PIL.Image", "safetensors"])
        revision = subprocess.run(["git", "-C", str(engine), "rev-parse", "HEAD"], capture_output=True, text=True)
        manifest = {"python": "3.12", "engine_revision": revision.stdout.strip() if revision.returncode == 0 else "local-copy", "model_weights_bundled": False}
        (target / "bundle-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        config_path.write_text(json.dumps({"bundle": {"resources": {"../bundle-resources/": "bundle"}}}, indent=2) + "\n", encoding="utf-8")
    except BaseException:
        if target.exists():
            shutil.rmtree(target)
        config_path.unlink(missing_ok=True)
        raise
    print(f"Bundle resources prepared: {target}")
    print("Run: pnpm build:bundled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
