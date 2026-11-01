# Costume LoRA Studio — Windows 11

Tauri 2 + Rust のデスクトップ GUI と Python バックエンドです。
SD1.5 の衣装 LoRA を優先し、マスク作成 → データセット作成 → 学習を分離しています。
元画像・マスク・データセット・LoRA の出力先は別々に選択します。

## kohya-ss 風の画面

初期画面は LoRA の Training です。上部タブで Dataset Preparation、
Mask Creation、Environment に切り替えます。
[kohya_ss の画面構成](https://github.com/bmaltais/kohya_ss/blob/master/kohya_gui/lora_gui.py)
を参考に、Configuration / Model / Folders / Parameters / Advanced の
折りたたみ設定へ変更しました。

Configuration の Save / Load は、このアプリ内にパスと学習パラメーターを保存・復元します。
標準 preset の Load はパラメーターだけを戻し、画像・モデル・出力先の指定は維持します。
kohya_ss の設定 JSON の互換読み込みではありません。
readonly 項目とチェック済みの無効な項目は、現在の処理に対応する固定設定です。
タブは左右キー・Home / End でも切り替えられます。

起動済みの旧版を終了せずビルドしたため、今回の更新版は
dist/kohya-style/CostumeLoRAStudio.exe に別途配置しています。
使うときは旧版を終了し、この更新版を開いてください。実行中の処理があれば先に中止します。

現在の実機の準備状況は [READINESS.md](READINESS.md) を参照してください。

## 現在の動作範囲

- マスク: GroundingDINO + SAM、白 255 / 黒 0 の 8bit PNG。
- データセット: 既存マスクを再利用。WD14 タグまたは Qwen2-VL キャプション。
- 学習: kohya sd-scripts の train_network.py を起動して SD1.5 LoRA を学習。
- 学習前チェック: パス、キャプション、二値マスク、寸法、CLIP tokenizer、CUDA、bf16 対応。
- 原画像 / マスク / 緑の重ね合わせプレビュー、画像切り替え、進捗・ログ、中止。
- 設定保存、直近ジョブの状態復元、実行中の二重起動防止。

GUI からの SDXL / Flux / Qwen-Image / Z-Image 学習はまだ実装していません。
既存 CLI はそれらの学習器にも渡せるデータセットを引き続き生成できます。
GPU の「16GB」だけでは型番を特定できないため、CUDA の利用可否は学習前チェックで確認します。

## 開発版の起動

必要なもの: Windows 11、WebView2 Runtime、MSVC の C++ ビルドツール、
Rust、Node.js（fnm で管理）、pnpm、uv、uv 管理の Python 3.12。

PowerShell でプロジェクトのルートに移動し、オンライン環境で依存を準備します。

~~~powershell
fnm use 24
pnpm install
uv sync --python 3.12 --extra inference
pnpm dev
~~~

量子化 VLM も使う場合は uv sync に --extra quantization を追加します。
初回セットアップ後、ランタイム側はローカルパスからのみ重みを読み込みます。
Node.js はビルド・開発時だけ必要です。配布アプリは Node.js やローカル HTTP サーバーを使いません。

既にビルド済みの場合は src-tauri/target/debug/costume-lora-studio.exe を開けます。
これは開発用バイナリで、Python・重み・学習エンジンを含む配布完成品ではありません。

## 重みと tokenizer

前処理用の重みは [CLI.md](CLI.md) の手順で配置します。
SD1.5 優先なら wd14・grounding-dino・sam を用意すれば十分です。

~~~text
models/
  wd14/model.onnx
  wd14/selected_tags.csv
  grounding-dino/   ← Hugging Face snapshot
  sam/             ← Hugging Face snapshot
  tokenizers/
    openai_clip-vit-large-patch14/
      tokenizer_config.json
      special_tokens_map.json
      vocab.json
      merges.txt
~~~

tokenizer の取得例（事前準備・オンライン）:

~~~powershell
uv run --no-project --with huggingface-hub hf download openai/clip-vit-large-patch14 --local-dir models/tokenizers/openai_clip-vit-large-patch14 --include tokenizer_config.json special_tokens_map.json vocab.json merges.txt
~~~

SD1.5 のベースモデルは .safetensors ファイルを別途用意して「SD1.5 学習」で選択します。
ベースモデルと前処理モデルの重みは配布物に含めません。

## 学習エンジンの準備

[kohya sd-scripts](https://github.com/kohya-ss/sd-scripts) を学習エンジンとして使います。
Tauri 内に専用 GUI を用意しているため、Gradio の kohya_ss GUI は同梱しません。
既存の kohya_ss がある場合は、その中の sd-scripts フォルダーを指定しても使えます。
実運用・配布では検証した commit を固定して保管してください。

~~~powershell
git clone https://github.com/kohya-ss/sd-scripts.git vendor/sd-scripts
uv run --no-project scripts/setup_training.py --engine vendor/sd-scripts
~~~

setup_training.py は学習器の requirements.txt を基に .training-env を作り、
uv のみで依存を解決・インストールします。前処理用とは別環境です。
学習スクリプトと library / networks はエンジンの checkout から直接実行します。
学習器自身への editable 指定は取り除きます。
外部 URL・追加インデックス・未知のローカル指定が requirements に含まれる場合は
自動処理を止め、個別の環境構築を求めます。

~~~powershell
uv run --project .training-env --no-sync python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
~~~

CUDA が False の場合は、使用する GPU・ドライバーに合う PyTorch wheel が必要です。
[PyTorch の公式手順](https://pytorch.org/get-started/locally/) にある対応インデックスを選び、
uv add で学習環境の torch / torchvision を入れ替えてください。

アプリの「環境設定」で次を指定します。

- 前処理用 Python: .venv/Scripts/python.exe。
- 学習用 Python: .training-env/.venv/Scripts/python.exe。
- kohya sd-scripts: vendor/sd-scripts。
- 前処理モデル: models。
- CLIP tokenizer キャッシュ: models/tokenizers。

学習器の必要バージョンは checkout ごとに異なります。前処理側の Transformers
4.51.3 と同じ環境に混ぜず、それぞれの uv.lock を保管してください。

## 画面の使い方

1. **マスク作成**: 元画像と空の出力フォルダーを選択。「画像を読み込む」で入力を確認し、
   「マスクを作成」。マスクは元画像と同じ寸法・相対パスで保存します。
2. **確認**: 元画像 / マスク / 重ね合わせを切り替え、顔や肌が白く残っていないか確認。
   修正する場合はプロンプトを変えて、新しい空フォルダーへ再生成してください。
3. **データセット**: 同じ元画像と保存済みマスク、空の出力先、トリガーワードを指定。
   SD1.5 では WD14 + 512px が初期値です。画像とマスクを同期リサイズします。
4. **SD1.5 学習**: ベースモデル、作成済みデータセット、その中の masks、
   空の LoRA 出力先を選びます。初期値は 1000 steps / batch 1 / rank 16 / alpha 16 /
   学習率 0.0001 / fp16 / UNet のみです。初期値が最適かは画像数などに依存します。
5. 「学習前チェック」で設定と GPU を確認し、「学習を開始」。
   学習の設定とデータセット TOML、生成 LoRA は指定した出力先に保存します。

原画像を再利用するマスクと、リサイズ済みの学習用 masks は寸法が異なる場合があります。
学習画面にはデータセット内の masks を指定してください。データセットの保存先を
入力すると学習用マスクのパスも自動入力されます。

実行中は「処理を中止」で Python とその子プロセスを終了します。
保存済みの checkpoint は残ります。強制終了なので、一時フォルダーが残る場合があります。
再開学習機能はまだ実装していません。再実行時は新しい空の出力先を選びます。
実行中はアプリの終了を防止し、先に中止するよう表示します。

プレビューは PNG / JPEG / WebP / BMP、1 枚 24MB 以下、一覧は最大5000枚です。
CLI とバックエンドの処理は TIFF にも対応しますが、GUI プレビューには表示しません。

## Python・学習エンジンを同梱する

Python 3.12 の両環境、学習エンジンのローカル checkout を先に準備します。
配布先と同じ Windows x64 / GPU 条件で、CUDA・実推論・学習の完走も確認してください。

~~~powershell
uv run --no-project scripts/prepare_bundle.py --inference-python .venv/Scripts/python.exe --training-python .training-env/.venv/Scripts/python.exe --engine vendor/sd-scripts
~~~

bundle-resources に以下を構築します。

~~~text
bundle-resources/
  backend/                  ← アプリの Python 処理
  runtime/inference/        ← Python 本体 + 前処理用依存
  runtime/training/         ← Python 本体 + 学習用依存
  engine/sd-scripts/         ← LICENSE を含む学習器
  bundle-manifest.json
~~~

uv の standalone Python を丸ごと複製し、各環境の site-packages を重ねます。
仮想環境の絶対パスには依存せず、._pth でアプリ内の backend と engine を参照します。
コピー前後に依存の import を確認し、絶対パスを含む .pth は拒否します。
PyTorch wheel や外部 DLL の実行時互換性は配布先でも確認が必要です。
各パッケージの dist-info / LICENSE と Python・学習器の LICENSE も同梱されます。

大きな PyTorch 環境を二つ含むため、まずはフォルダー形式の配布を推奨します。

~~~powershell
pnpm tauri build --no-bundle
uv run --no-project scripts/package_portable.py --exe src-tauri/target/release/costume-lora-studio.exe
~~~

dist/CostumeLoRAStudio フォルダー全体を配布します。
実行ファイルの隣に bundle フォルダーを置く必要があります。
同梱した Python と学習器を自動選択し、ユーザーはモデル重みの場所だけ設定します。
Windows 11 の WebView2 Runtime は別途インストール済みである必要があります。

NSIS 形式にする場合は、生成されたリソース設定を使います。
同梱ファイルがインストーラーの容量上限に収まることを確認してください。

~~~powershell
pnpm build:bundled
~~~

## 検証

~~~powershell
uv run --offline --no-sync python -m unittest discover -s tests -v
pnpm test
pnpm check
cargo check --offline --manifest-path src-tauri/Cargo.toml
~~~

画面の操作テスト（ローカル Edge と Playwright を使用）:

~~~powershell
uv run --no-project --with playwright scripts/check_ui.py
~~~

このテストは native bridge をテスト用に置き換えます。実際の推論や学習は行いません。
スクリーンショットは .qa-temp に保存します。最新の実行結果は [QA_REPORT.md](QA_REPORT.md)。
