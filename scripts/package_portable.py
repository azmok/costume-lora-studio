"""Package a built Tauri executable alongside the prepared portable runtimes."""

import argparse
from pathlib import Path
import shutil


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--exe", type=Path, required=True)
    args = cli.parse_args()
    project = Path(__file__).resolve().parents[1]
    resources = project / "bundle-resources"
    if not args.exe.is_file() or not (resources / "bundle-manifest.json").is_file():
        raise ValueError("ビルド済み exe と prepare_bundle.py で用意したリソースが必要です")
    target = project / "dist" / "CostumeLoRAStudio"
    if target.exists():
        raise ValueError("配布先が既にあります。既存の dist/CostumeLoRAStudio を退避してください")
    try:
        target.mkdir(parents=True)
        shutil.copy2(args.exe, target / "CostumeLoRAStudio.exe")
        shutil.copytree(resources, target / "bundle")
        shutil.copy2(project / "DESKTOP.md", target / "DESKTOP.md")
    except BaseException:
        if target.exists():
            shutil.rmtree(target)
        raise
    print(f"Portable app: {target}")


if __name__ == "__main__":
    main()
