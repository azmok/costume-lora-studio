# Costume LoRA Studio

服の画像から、AI に服を覚えさせるデータ（LoRA＝追加学習データ）を作る Windows アプリです。
通信せず、パソコンの中だけで動きます。

## できること

1. 画像に説明文（キャプション）を自動でつける
2. 服の部分だけを白く塗った画像（マスク）を自動で作る
3. 学習して LoRA を作る（SD1.5 / SDXL / SD3.5 / FLUX.1 / Lumina 2 / HunyuanImage 2.1 / Anima）
4. できた LoRA を ComfyUI で試す（別ウィンドウで、試し生成のワークフロー付き）

## 起動

`start.cmd` をダブルクリックします。
初回だけ、必要なものを自動で入れるので時間がかかります。
学習エンジン（kohya sd-scripts）、学習用 Python、トークナイザーも初回に自動で入ります。

必要なもの: Windows 11 / NVIDIA のグラフィックボード / [Node.js](https://nodejs.org/) と [pnpm](https://pnpm.io/) / [uv](https://docs.astral.sh/uv/) / [Rust](https://rustup.rs/)

## 使い方

画面上部のタブを、左から順に使います。

| タブ | 内容 |
|---|---|
| **Tools** | 画像を読み込み、説明文とマスクを作って直す |
| **Dataset Preparation** | 学習用データにまとめる |
| **LoRA** | 学習する |
| **ComfyUI** | ComfyUI を起動して、作った LoRA を試す |
| **Environment** | ファイルの場所を設定する |

- マスクは「白＝覚えさせる服、黒＝それ以外」です。
- AI が作ったマスクは、ブラシで直せます。
- 別の画像に移る前に、保存してください。

## ComfyUI との連携と settings.yaml

学習が終わると、LoRA は `G:/sd/sharedModels/loras/<LoRA名>/` に途中保存の版ごとコピーされます。
ComfyUI タブの「Try in ComfyUI」で ComfyUI が起動し、その LoRA とトリガーワード入りのワークフローが開きます。

場所を変えたいときは、`settings.example.yaml` を `settings.yaml` という名前でコピーして、アプリのフォルダー（またはこのリポジトリの直下）に置きます。

| 項目 | 内容 |
|---|---|
| `lora_output_dir` | LoRA のコピー先 |
| `comfyui.mode` | `wsl`（WSL の中の ComfyUI）か `windows` |
| `comfyui.root` | ComfyUI のフォルダー（main.py がある場所） |
| `comfyui.python` / `distro` / `port` / `extra_args` | 必要なときだけ |

ComfyUI が無いパソコンでは、ComfyUI タブの「Install ComfyUI」で、このアプリ用の ComfyUI が自動で入ります。

## モデルの置き場所

AI の頭脳にあたるファイル（モデル）は `models` フォルダーに入れます。自動では入りません。
取得方法は [CLI.md](CLI.md)、おすすめは [MODEL_REPORT.md](MODEL_REPORT.md) を見てください。

## 現在の状況

- 使える: Stable Diffusion 1.5 の学習、説明文とマスクの作成
- 準備中: Krea 2 の学習
- 未確認: 本物のモデルでの精度と、学習を最後まで実行できるか（[QA_REPORT.md](QA_REPORT.md)）

## 関連ドキュメント

- [READINESS.md](READINESS.md): パソコンの準備状況
- [DESKTOP.md](DESKTOP.md): 配布用アプリの作り方（開発者向け）
- [CLI.md](CLI.md): コマンドでの使い方（上級者向け）
