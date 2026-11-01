"""Create an isolated uv environment from a local kohya sd-scripts checkout."""

import argparse
from pathlib import Path
import subprocess


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--engine", type=Path, required=True)
    args = cli.parse_args()
    engine = args.engine.resolve()
    if not (engine / "train_network.py").is_file():
        raise ValueError("sd-scripts のルートを指定してください")
    project = Path(__file__).resolve().parents[1]
    environment = project / ".training-env"
    if environment.exists():
        raise ValueError(".training-env は既にあります。既存環境の uv sync を使ってください")
    subprocess.run(["uv", "init", "--bare", "--python", "3.12", str(environment)], check=True)
    requirements = []
    for line in (engine / "requirements.txt").read_text(encoding="utf-8-sig").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped in ("-e .", "--editable .", "."):
            continue
        if stripped.startswith(("-", ".", "/")) or "://" in stripped:
            raise ValueError(f"ローカル参照や追加オプションは個別に確認してください: {line}")
        requirements.append(line)
    filtered = environment / "requirements-sd.txt"
    filtered.write_text("\n".join(requirements) + "\n", encoding="utf-8")
    subprocess.run(["uv", "add", "--project", str(environment), "--python", "3.12", "--no-sync", "--requirements", str(filtered)], check=True)
    subprocess.run(["uv", "add", "--project", str(environment), "--python", "3.12", "torch", "torchvision", "pillow"], check=True)
    print(f"学習用 Python: {environment / '.venv' / 'Scripts' / 'python.exe'}")
    print("CUDA availability must be checked before training.")


if __name__ == "__main__":
    main()
