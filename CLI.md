# CLI 版リファレンス（上級者向け）

普段は GUI（[README](README.md)）で足ります。このページはコマンドラインで直接データセットを作る人向けです。

**Windows GUI 版を追加しました。** Tauri + Rust の画面からマスク作成・データセット作成・
SD1.5 LoRA 学習を別工程で操作できます。起動方法と Python / 学習エンジンの同梱手順は
[DESKTOP.md](DESKTOP.md) を参照してください。以下は引き続き使える CLI 版の説明です。

## Tools タブで画像を編集

Tools を開き、元画像フォルダーと、別々のキャプション・マスク保存先を指定してください。
「フォルダーを読み込む」で画像一覧が出ます。

- **キャプション**: 選択画像の生成、全画像の一括生成、テキストの手直しと保存。
  Qwen2-VL-2B（標準・自然文）/ WD14 / WD EVA02-Large v3（タグ）を選択できます。
- **マスク・ペイント**: 学習する領域を塗り、除外する領域を消します。
  四角選択、ブラシの太さ、Undo / Redo、100% / 200% 表示に対応しています。
- **言語＋マウス指定**: 「衣装」「赤いジャケット」などを指定して自動マスクを下書き。
  塗る／消すの指定点を SAM に渡し、生成後にもブラシで修正できます。
- **保存**: マスクは元画像と同じピクセル寸法の、白255・黒0の8bit単チャンネル PNG。
  キャプションは同名 .txt。元画像は変更しません。保存済みの出力は Save で更新します。
- **再利用**: Dataset Preparation の Edited captions directory とマスクフォルダーを指定すると、
  手直し済みファイルを使います。キャプション・マスクモデルの再実行は不要です。

手描き・キャプションの直接編集・保存には Python やモデルが不要です。
AI 生成には後述の依存とローカル重みが必要です。一括キャプションは空の出力先に保存し、
単画像の生成はプレビューだけを更新します。画像切り替え時は未保存の編集を確認します。
アプリ終了前には必ず保存してください。
全黒・全白のマスクは保存できますが、現在の学習前チェックでは拒否されます。

前処理モデルの追加配置例:

~~~text
models/
  wd-eva02-large-tagger-v3/    # model.onnx + selected_tags.csv
  wd14/                       # 既存モデル
  qwen2-vl/                   # Qwen/Qwen2-VL-2B-Instruct（標準）
  grounding-dino/
  sam/
~~~

Qwen2-VL-2B は bf16 で約5GBです。4bit / 8bit を使う場合だけ
uv sync --extra inference --extra quantization を実行します。

生成モデルには限界があり、NSFW を含む画像の語彙・衣装語除外・左右・ポーズの正確さは
実データで確認が必要です。モデル調査と採用理由は [MODEL_REPORT.md](MODEL_REPORT.md)。
今回のビルドは dist/tools/CostumeLoRAStudio.exe に配置します。

2026-11-01 の検証ではビルド・単体テストは成功しましたが、エージェント環境からの
起動はウィンドウ内が空白で、GUI の表示・操作確認は未完了です。
実モデルの推論も未確認です。現在の検証範囲は [QA_REPORT.md](QA_REPORT.md) を参照してください。

WD14 または Qwen2-VL で衣装以外のキャプションを作り、GroundingDINO + SAM
で衣装領域を抽出します。SD1.5 / SDXL / Flux / Qwen-Image / Z-Image などの
学習器へ渡す画像・マスク・キャプションを生成する前処理ツールです。
学習そのものやモデル固有の LoRA 設定は含みません。

## 環境構築

Python 3.11 / 3.12 と uv を用意し、このフォルダーで実行します。
依存パッケージ・重みは事前にオンライン環境で取得するか、
対象 OS / Python / GPU に適合するものをオフライン PC に転送します。

~~~shell
uv sync --extra inference
~~~

4bit / 8bit の Qwen 推論も使う場合:

~~~shell
uv sync --extra inference --extra quantization
~~~

CUDA 対応は PyTorch の wheel と環境に依存します。次で確認してください。

~~~shell
uv run --no-sync python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
~~~

## ローカル重みの事前配置

以下はオンライン環境で一度だけ行う準備です。生成スクリプトは自動取得しません。
出典とライセンスは各リンク先を確認してください。

- [WD14 ConvNext V2](https://huggingface.co/SmilingWolf/wd-v1-4-convnext-tagger-v2)
- [Qwen2-VL-2B-Instruct](https://huggingface.co/Qwen/Qwen2-VL-2B-Instruct)
- [GroundingDINO Tiny](https://huggingface.co/IDEA-Research/grounding-dino-tiny)
- [SAM ViT Base](https://huggingface.co/facebook/sam-vit-base)

~~~shell
uv run --no-project --with huggingface-hub hf download SmilingWolf/wd-v1-4-convnext-tagger-v2 --local-dir models/wd14 --include model.onnx selected_tags.csv
uv run --no-project --with huggingface-hub hf download Qwen/Qwen2-VL-2B-Instruct --local-dir models/qwen2-vl --include "*.json" "*.safetensors" "*.txt" "*.model" "*.jinja"
uv run --no-project --with huggingface-hub hf download IDEA-Research/grounding-dino-tiny --local-dir models/grounding-dino --include "*.json" "*.safetensors" "*.txt" "*.model"
uv run --no-project --with huggingface-hub hf download facebook/sam-vit-base --local-dir models/sam --include "*.json" "*.safetensors"
~~~

使わないキャプションモデルの取得は不要です。重みだけでなく config・processor・
tokenizer も必要です。Hugging Face 形式を使うため、単独の SAM .pth は直接読み込みません。
再現性が必要なら取得時に --revision COMMIT_ID を指定し、uv.lock も保管してください。

Lang-Segment-Anything と同じ GroundingDINO + SAM の構成を Transformers API で
実行します。自動取得する lang_sam ラッパーは使わず、SAM を採用しています。
MobileSAM は現在実装していません。

## 実行

元画像を dataset/raw_images に置きます。サブフォルダーも再帰探索します。
SD1.5 / SDXL / アニメ向け:

~~~shell
uv run --offline --no-sync dataset_generator.py --input_dir ./dataset/raw_images --output_dir ./dataset/processed_dataset --trigger_word my_costume --caption_mode tag --max_resolution 768
~~~

Flux / Qwen-Image / Z-Image などの自然文向け:

~~~shell
uv run --offline --no-sync dataset_generator.py --trigger_word my_costume --caption_mode vlm --max_resolution 1024 --device cuda --precision bf16
~~~

量子化は --precision 4bit または --precision 8bit。CUDA + bitsandbytes が必要です。
CPU では --device cpu --precision fp32 を指定します。量子化は VLM に適用し、
検出器と SAM は fp32、WD14 は ONNX Runtime の CPU で実行します。
bf16 非対応 GPU では --precision fp16 を使います。

推論時は HF_HUB_OFFLINE / TRANSFORMERS_OFFLINE を強制し、
すべての Hugging Face 読み込みで local_files_only=True を使います。
uv 自体の通信も止めるため --offline --no-sync を付けます。
API キーやクラウド推論は使用しません。

## 出力と正規化

~~~text
dataset/processed_dataset/
  images/<source-directory-id>/sample.png
  images/<source-directory-id>/sample.txt
  masks/<source-directory-id>/sample.png
  metadata.json
  kohya_dataset.toml
  ai_toolkit_dataset.json
~~~

マスクは別フォルダーの同名 PNG。衣装が白 255、それ以外が黒 0 の
8bit 単チャンネル L です。元ファイル名の stem を保ち、元の親フォルダーから
算出する ID で分類します。別フォルダーの同名画像も使えますが、
同一フォルダーの sample.jpg と sample.png は競合するため事前に拒否します。

EXIF 回転を反映し、画像を RGB PNG に統一、透明部分を白に合成します。
画像とマスクに同じリサイズ寸法を適用し、マスクは最近傍補間で二値を維持します。
既定は長辺を --max_resolution まで縮小し、拡大しません。
--resize_edge short では短辺を基準にするため長辺は上限値を超え得ます。
--upscale で拡大を許可します。

アスペクト比を保つため 64 倍数への丸めや事前の正方形クロップは行いません。
学習器のバケット機能が最終解像度に変換します。マスクを誤学習しないよう、
学習画像として指定するのは images 内の各グループです。

metadata.json は汎用処理記録で、入力との対応・キャプション・処理前後の寸法・
マスク面積率・実行設定・除外理由を含みます。学習器専用形式ではありません。

## 学習器への接続

[Kohya の Masked Loss 仕様](https://github.com/kohya-ss/sd-scripts/blob/main/docs/masked_loss_README.md)
に従い、kohya_dataset.toml の conditioning_data_dir でマスクを参照します。
DreamBooth 形式のデータセット設定として学習コマンドに指定します。

~~~shell
uv run --no-sync PATH_TO_SD_SCRIPTS/train_network.py --dataset_config ./dataset/processed_dataset/kohya_dataset.toml --masked_loss OTHER_TRAINING_ARGUMENTS
~~~

これは実行形式の例です。学習器側の uv 環境で実行し、SDXL 等では対応スクリプトへ
置き換え、必要な学習引数を指定してください。

[ai-toolkit のマスク読み込み](https://github.com/ostris/ai-toolkit/blob/main/toolkit/dataloader_mixins.py)
に合わせ、ai_toolkit_dataset.json の datasets 配列を、学習ジョブの
config.process[0].datasets に組み込みます。これはデータセット設定断片で、
完全な学習ジョブではありません。mask_path に同名マスクを参照し、
mask_min_value は 0.0 で黒領域の重みをゼロにします。
学習器側の補間・ぼかしにより、損失計算時の境界に中間値が生じる場合があります。

設定には絶対パスを含みます。出力を移動したら設定内のパスを更新してください。
モデルごとの Masked Loss 対応は学習器とそのバージョンに依存します。

## 調整と失敗処理

- --blacklist extra_blacklist.txt: UTF-8、1 行 1 語または glob で衣装除外語を追加。
  空行と # 行を無視。shirt は red_shirt も除外します。
- --tag_threshold 0.35: WD14 の一般タグのみ使用し、rating / character は除外。
  残ったタグの先頭にトリガーを付与。タグが残らなければトリガーのみです。
- VLM は衣装を記述しないシステムプロンプトを使用。既知の衣装語が出た場合、
  その画像をエラーにして混入を防止します。髪色・背景色の記述は許可します。
- --mask_prompt "clothes, clothing, dress, jacket, pants, skirt, outfit":
  カンマ区切りの衣装検出語。
- --exclude_prompt "face, hair, hands, bare arms, bare legs, bare feet, exposed skin":
  別途検出・分割して、衣装マスクから差し引く領域。
- --box_threshold 0.3 --text_threshold 0.25: 検出しきい値。
- --min_mask_fraction 0.001 --max_mask_fraction 0.95: 空・過大なマスクを拒否。
- --continue_on_error: 問題画像をスキップし、成功分を保存。
  部分成功は終了コード 0、除外はログと metadata の errors に記録します。
  成功画像がゼロなら終了コード 1 です。

--mask_dir PATH を指定すると、別工程で作ったマスクを再利用します。
この場合は GroundingDINO / SAM を読み込みません。マスクは元画像からの相対パスを保ち、
拡張子だけ .png に変更して配置してください。解像度は EXIF 回転反映後の元画像と一致する
必要があります。GUI の「マスク作成」はこの配置で保存します。

--caption_dir PATH を追加すると、元画像からの相対パスを維持した .txt を読み込みます。
Tools で保存したキャプションも再利用可能です。トリガーがすでに先頭にあれば重複付与しません。

通常は最初の失敗で停止します。既存出力は上書きせず、一時ディレクトリで処理し、
全工程が成功した場合だけ出力先へ移します。
キャプションモデルを解放してから検出器と SAM を読み込みます。
衣装マスクの品質と未知の衣装語の除外は推論精度に依存します。
特にアニメ・重なり・透けた服・肌に似た色では、学習前に PNG を目視確認してください。

## 検証

標準ライブラリの unittest を使い、推論重みなしで検証できます。

~~~shell
uv run --offline --no-sync python -m unittest discover -s tests -v
~~~

空入力・パス衝突・上書き拒否・タグ除外・設定を検証します。
Pillow / NumPy がある環境ではモデルをテスト用実装に置き換え、
二値 PNG・寸法同期・EXIF・透過・通信禁止の一括処理・失敗時の後始末も検証します。
画像依存がなければ画像関連テストはスキップします。
本物の重みでの推論精度・VRAM 消費・GPU 互換性は実機確認が必要です。
