# SD1.5 衣装 LoRA — 準備確認

2026-10-24 に実機で確認しました。**現時点では学習準備は未完了です。**

| 項目 | 結果 | 確認内容 |
| --- | --- | --- |
| NVIDIA GPU | 確認済み | GeForce RTX 4060 Ti、16380 MiB（16GB）、driver 610.88 |
| 前処理用 Python | 環境だけ作成済み | .venv の Python 3.12.12。依存パッケージは未導入 |
| 学習用 Python | 未準備 | .training-env/.venv/Scripts/python.exe が存在しない |
| 学習用 PyTorch / CUDA | 未確認 | 学習用 Python と PyTorch が未導入のため未確認 |
| kohya sd-scripts | 未準備 | vendor/sd-scripts に学習器なし |
| WD14 | 未配置 | model.onnx / selected_tags.csv なし |
| GroundingDINO / SAM | 未配置 | ローカル snapshot なし |
| CLIP tokenizer | 未配置 | tokenizer cache なし |
| SD1.5 checkpoint | 未準備 | 既存のモデルは残っていないと確認済み |

GUI の起動とテスト用データによる検証は成功していますが、
実画像のマスク生成・実モデルでの学習はまだ実行していません。

## 取得を試した結果

前処理環境:

~~~powershell
uv --cache-dir C:\Users\genta\projects\training-lora-clothing\.uv-cache sync --project C:\Users\genta\projects\training-lora-clothing --python 3.12 --extra inference
~~~

Python 3.12 の仮想環境は作成されましたが、PyPI 接続時に失敗しました。

~~~text
Failed to fetch: https://pypi.org/simple/pillow/
An attempt was made to access a socket in a way forbidden by its access permissions. (os error 10013)
~~~

学習器の接続確認:

~~~powershell
git ls-remote https://github.com/kohya-ss/sd-scripts.git HEAD
~~~

~~~text
Failed to connect to github.com port 443
~~~

これは、このエージェントの実行環境からの通信結果です。
Windows 本体やユーザーの通常の PowerShell でも同じ制限があるとは確認していません。

## 準備する順番

取得可能なオンライン環境、または通常の PowerShell で依存・学習器・重みを準備します。
その後の推論・学習はローカルで実行できます。

1. プロジェクトルートで uv sync --python 3.12 --extra inference を実行。
2. [kohya sd-scripts](https://github.com/kohya-ss/sd-scripts) を vendor/sd-scripts に取得。
3. uv run --no-project scripts/setup_training.py --engine vendor/sd-scripts で学習環境を作成。
4. [README](README.md) の手順で WD14 / GroundingDINO / SAM を models 内に配置。
5. [DESKTOP.md](DESKTOP.md) の手順で CLIP tokenizer を配置。
6. SD1.5 の .safetensors を用意して、GUI の Model に指定。
   [SD1.5 の配布ページ](https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5)
   に checkpoint があります。配布元のモデルカードとライセンスも確認してください。
7. 環境設定を保存し、衣装画像・マスク・データセットを作成して学習前チェックを実行。

## 再確認用コマンド

依存の少ない診断スクリプトです。ネットワーク通信やインストールは行いません。

~~~powershell
uv run --offline --no-project --python 3.12 scripts/check_readiness.py --checkpoint C:\models\sd15.safetensors --output .qa-temp/readiness.json
~~~

保存済みのアプリ環境設定を優先し、なければプロジェクト標準の配置を確認します。
終了コード0は全項目の初期確認成功、1は不足ありです。
これは初期確認であり、モデルファイルの完全性・学習品質・学習完走を保証しません。
今回の実行結果は .qa-temp/readiness.json に保存済みで、ready は false です。
