# キャプション・対話的マスクの調査報告

調査日: 2026-11-01。公開モデルカードと作者のリポジトリを参照しました。
この PC で各モデルをダウンロードして比較推論した結果ではありません。

## 推奨

**採用: 自然文は Qwen2-VL-2B（初期要件どおり）。JoyCaption Beta One は調査のみで、現在は組み込んでいません。
調査時の推奨は、自然文・NSFW 対応を優先するなら JoyCaption Beta One の4bit、
SD1.5 のイラスト向けタグなら WD EVA02-Large Tagger v3 を第一候補にします。**
公開時期やモデル規模だけで最適性を断定せず、実データの誤記述・衣装語混入・速度で判断します。

| 候補 | 調査で確認できた特徴 | 今回の位置づけ |
| --- | --- | --- |
| [JoyCaption Beta One](https://huggingface.co/fancyfeast/llama-joycaption-beta-one-hf-llava) | 拡散モデル学習用 captioner。作者がSFW/NSFW両方への対応を明記。Llama 3.1 8B をベースとした公開ウェイト | 自然文の第一候補。今回ローカル読込アダプターを追加 |
| [WD EVA02-Large v3](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3) | 一般・キャラクター・rating のタグ推定。Apache-2.0 表示 | SD1.5 のタグ生成候補。衣装語・不要カテゴリは除外 |
| [Gliese-Qwen3.5-9B-Abliterated-Caption](https://huggingface.co/prithivMLmods/Gliese-Qwen3.5-9B-Abliterated-Caption) | Qwen3.5 世代の新しい caption 用公開モデル。作者が unfiltered / detailed caption を説明。Apache-2.0 表示 | 次の比較候補。今回のGUIには未追加 |
| [Camie Tagger v2](https://huggingface.co/Camais03/camie-tagger-v2) | アニメ向けの多カテゴリ ONNX / PyTorch タガー。GPL-3.0 表示 | アニメ画像中心の場合の比較候補。未追加 |

JoyCaption の [公式 README](https://github.com/fpgaminer/joycaption) は、
現在のリリースを Beta One と案内し、bf16 のモデルに約17GB VRAM、
低メモリー用に8bit / 4bit量子化を案内しています。
したがって RTX 4060 Ti 16GB では、まず4bit・1枚ずつ処理する設計です。
収まるか・どの程度速いかは実測前であり、保証はしていません。

JoyCaption は一般的な指示追従モデルとして完全ではなく、拒否や生成の乱れが起きることも
作者が説明しています。衣装説明を除く指示も必ず守るとは限らないため、
既知の衣装語の検出・プレビュー・手動修正を組み合わせます。
NSFW 対応の記載は作者の説明であり、あらゆる画像に対する品質保証ではありません。

Gliese は新しい世代の caption 用モデルですが、今回確認できた公開情報から
JoyCaption よりNSFW衣装学習用キャプションに優れるとする直接比較は確認できていません。
GGUF を使う場合は画像入力用 mmproj も必要で、ファイル容量と実行時VRAMは別物です。
元モデルを4bitに読み込む場合も、取得する元ウェイトのディスク容量は小さくなりません。

## ライセンスの扱い

公開ウェイトと、厳密な意味のオープンソースを同一扱いにはしません。
JoyCaption のモデルカードには Llama 3.1 と SigLIP2 がベースとして記載されています。
すべての候補が Apache-2.0 で配布されているとは扱わず、重みの取得・同梱時は
それぞれの配布元の条件を確認します。モデル重みは従来どおり別途配置します。

## マスク編集の方針

今回の実装は、既存の GroundingDINO + SAM を利用します。
言語で候補を検出し、ブラシ・四角指定から得た正／負の指定点を SAM に渡します。
日本語の短い衣類名と色は小さな辞書で英語に変換します。
任意の長い日本語を翻訳するVLMは今回組み込んでいません。
AI の結果は保存前のプレビューへ反映し、手描きで再修正できます。

[SAM 3](https://github.com/facebookresearch/sam3) はテキスト・点・ボックス・マスクによる指定に対応する新候補です。
ただし独自の SAM License、重み取得の承認、Python / PyTorch / CUDA の対応確認が必要です。
[SAM 3.1](https://huggingface.co/facebook/sam3.1) は主に複数物体の動画追跡を効率化した更新で、
公開ページでは Transformers 統合がないと説明されています。
今回は単画像編集を既存の安定した構成に追加し、SAM 3系への切り替えは将来の比較項目にします。

## 実データでの採用判定

手元のSFW/NSFW混在画像20〜30枚で、以下を確認してから既定モデルを確定します。

- 内容を見ていない要素や誤ったポーズを記述していないか。
- 衣装 LoRA モードで衣装の説明が混ざる割合。
- SD1.5 の短いキャプションとして使いやすいか。
- 拒否・空文・同じ文の繰り返しの割合。
- 16GB GPU 上での最大VRAM、1枚あたり時間、量子化による差。
- テキストとマウス指定で、衣装と肌の境界を適切に修正できるか。

## 実装・未検証の区別

GUI編集、Rustによる二値PNG保存、単独キャプション用ジョブ、
生成済みキャプション・マスクの再利用を実装しました。
JoyCaption / WD v3 / Qwen2-VL の実重みでの推論、Windowsでの量子化、
SAM への指定点を用いた実画像の抽出精度は未検証です。
現在の環境では依存取得がネットワーク制限で失敗し、画像用テスト依存も使えません。
