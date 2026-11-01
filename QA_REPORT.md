# 最新: マスク作成の改善 / 2026-11-02

- 透過済み画像（透過率1%以上）は事前に判定してスキップ。衣装未検出・面積異常など1枚の不良でもジョブ全体は止めず、`[SKIP]` をログに出して続行。
- 同名マスクが保存先に既にある場合はスキップ（上書きしない）。マスク入りの保存先も指定可能に（新規分だけ追加・`mask_metadata.json` を統合）。全て既存ならモデルを読み込まない。
- 1枚できるごとに縮小マスクを送り、ジョブ完了前にプレビューへ反映（手動で画像を切り替えると自動追従を停止）。
- `.venv` の torch が CPU 専用版（2.15.0+cpu）だった問題を修正: pyproject.toml に Windows 用の CUDA 13.0 index を追加し 2.14.1+cu130 に入れ替え。GPU 認識 OK（RTX 4060 Ti）。
- GroundingDINO の引数名（transformers 4.x `box_threshold` / 5.x `threshold`）の差を吸収。
- 検証: Python 50件 OK、JS 8件 OK、Tools UI 実ブラウザテスト PASS（途中プレビュー・スキップ表示を追加）。
- 本物のモデル（GPU）で、透過画像3枚のスキップを確認。成功パスの実画像確認は未実施（合成画像は除外検出が全面にかかるため）。実写真での確認が必要。

---

# 最新: 再検証と修正 / 2026-11-01

- バグ修正: Undo / Redo で AI マスク用の指定点が消える問題。`MaskHistory` が指定点も保持し、一緒に復元する (ui/tools-state.mjs, ui/tools.js)。回帰テスト追加。
- `node scripts/check_tools_ui.mjs`（Edge headless・実マウス操作）: 修正前は `points[0]` 未定義で失敗、修正後 PASS。
- Python: NumPy / Pillow を既存 uv キャッシュ経由で PYTHONPATH に渡して実行 → 42 tests / OK / skipped 0（画像関連18件も成功）。
- JS 8件、Rust 3件、cargo fmt、Tauri debug ビルド成功。
- 空白画面: 通常の PowerShell から `.qa-temp/kohya-build/debug/costume-lora-studio.exe` を起動すると LoRA 画面が正常表示（`.qa-temp/native-check.png`）。空白はエージェントのサンドボックス側 WebView2 の問題で、アプリ側の不具合ではない。
- 未検証のまま: ネイティブ窓での Tools タブ手動操作、実モデル推論、16GB GPU 使用量、実学習。

---

# 最新: Tools タブ / 2026-11-01

画像一覧、キャプション編集、ブラシ・消しゴム・四角選択、Undo / Redo、
言語と指定点によるマスク下書き、二値 PNG / TXT 保存を追加しました。
README.md と MODEL_REPORT.md を更新しました。

## 実行結果

プロジェクトのルートで以下を実行しました。

```powershell
pnpm test
node --check ui/app.js
node --check ui/tools.js
$env:PYTHONPATH = (Get-Location).Path
uv --cache-dir .uv-cache --offline run --no-project --python 3.12 python -m unittest discover -s tests
$env:CARGO_TARGET_DIR = "$PWD\.qa-temp\kohya-build"
cargo test --offline --manifest-path src-tauri/Cargo.toml
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
$env:UV_CACHE_DIR = "$PWD\.uv-cache"
$env:UV_OFFLINE = '1'
$env:CARGO_NET_OFFLINE = 'true'
pnpm tauri build --debug --no-bundle
```

```text
JavaScript: tests 7 / pass 7 / fail 0
Python: Ran 42 tests / OK (skipped=18): 24 passed
Rust: 3 passed / 0 failed
Windows debug build: Finished dev profile / exit code 0
```

空入力・Enter のみでジョブを開始できないこと、ペイント座標と Undo / Redo、
空パス・不正 PNG の拒否、L8 二値 PNG への変換と保存先更新を単体テストで確認しました。
Python の画像関連18件は NumPy / Pillow 不在でスキップしました。
依存の追加取得は PyPI 接続の OS error 10013 で失敗しています。
この結果は全画像処理が検証済みという意味ではありません。

## 起動と残っている確認

成果物: `dist/tools/CostumeLoRAStudio.exe`。
起動を実行し、応答する `Costume LoRA Studio` ウィンドウを確認しました。
WebView2 の保存先をプロセス限定で `.qa-temp/webview-tools-profile` に指定したところ
ウィンドウタイトルは表示されましたが、内容は空白でした。
キャプチャ: `.qa-temp/tools-native-launch.png`。画面の表示・操作確認は未完了です。

Edge による GUI 自動テストも Page.enable でタイムアウトしました。
レジストリ・DPAPI・ブラウザプロセス周辺のエラーがあり、環境制約の影響が疑われますが、
原因の確定には至っていません。OS の権限やレジストリは変更していません。
実モデル、AI 指定点の精度、16GB GPU での使用量、実学習は未検証です。

## セルフチェック

- ✅ 宣言範囲のソース・テスト・説明書のみ変更。保護ファイルへの変更なし。
- ✅ UTF-8 / NUL 不在、構文・空白を確認。uv / pnpm / Cargo のみ使用。
- ✅ 実行できた単体テストと Windows ビルドは成功。
- ❌ GUI 表示・操作、依存不足の画像テスト、実モデルの推論は検証未完了。

以下は過去の検証記録です。現在の Tools タブを検証した結果ではありません。

---

# 前回: kohya-ss 風 GUI / 準備確認

2026-10-24。今回の変更は画面・設定保存・UI 検証・準備確認スクリプトと説明書です。
Python の学習処理と Rust のプロセス管理は変更していません。

## 準備確認の結果

- NVIDIA GeForce RTX 4060 Ti / 16380 MiB / driver 610.88 を nvidia-smi で確認。
- 前処理用 Python 3.12 の .venv は作成済みですが、依存は未導入。
- 学習用 Python・sd-scripts・前処理モデル・CLIP tokenizer・SD1.5 checkpoint は未準備。
- uv sync は PyPI 接続で OS error 10013、git ls-remote は GitHub 接続失敗。
- これはエージェント実行環境からの通信結果であり、通常の PowerShell での通信は未確認。

正確な診断コマンド:

~~~powershell
uv --cache-dir C:\Users\genta\projects\training-lora-clothing\.uv-cache --offline run --no-project --python 3.12 python C:\Users\genta\projects\training-lora-clothing\scripts\check_readiness.py --output C:\Users\genta\projects\training-lora-clothing\.qa-temp\readiness.json
~~~

ready: false、終了コード1。不足検出の期待した結果です。
詳細は [READINESS.md](READINESS.md)。

## GUI / 回帰テスト

~~~powershell
pnpm --dir C:\Users\genta\projects\training-lora-clothing test
pnpm --dir C:\Users\genta\projects\training-lora-clothing check
~~~

~~~text
tests 5
pass 5
fail 0
skipped 0
exit code: 0
~~~

設定の保存・復元、数値の正規化、不正な保存設定拒否を追加検証しました。

~~~powershell
$env:PYTHONPATH = 'C:\Users\genta\projects\training-lora-clothing;C:\Users\genta\AppData\Local\uv\cache\archive-v0\I2D7sQuLVJiOkin26fbQW;C:\Users\genta\AppData\Local\uv\cache\archive-v0\w8iDDaPiUEFZMQ_cnImnp'
uv --cache-dir C:\Users\genta\projects\training-lora-clothing\.uv-cache --offline run --no-project --python 3.12 python -m unittest discover -s C:\Users\genta\projects\training-lora-clothing\tests
~~~

~~~text
Ran 36 tests in 0.853s
OK
exit code: 0
~~~

~~~powershell
$env:PYTHONPATH = 'C:\Users\genta\AppData\Local\uv\cache\archive-v0\sqH72rnwy5kzv9bjVrYTz;C:\Users\genta\AppData\Local\uv\cache\archive-v0\5M1YRteRE-BdLEZqycyrZ;C:\Users\genta\AppData\Local\uv\cache\archive-v0\SW4nelRW0CfhH92zbVU_D'
uv --cache-dir C:\Users\genta\projects\training-lora-clothing\.uv-cache --offline run --no-project --python 3.12 python C:\Users\genta\projects\training-lora-clothing\scripts\check_ui.py
~~~

~~~text
UI: kohya-style tabs, profiles, empty input, folded validation, keyboard navigation, mask reuse, cancellation, 800px/375px layout: PASS
exit code: 0
~~~

Edge headless + テスト用 native bridge を使用。折りたたみ内の空入力へのフォーカス、
設定の保存・復元、キーボードタブ移動、375px / 800px 表示を追加確認しました。
キャプチャ .qa-temp/desktop-train.png を目視確認しています。
実モデルの推論や実学習を検証した結果ではありません。

## 更新版バイナリ

既存 GUI が起動していたため、プロセスを終了せず別 target にビルドしました。

~~~powershell
$env:UV_CACHE_DIR = 'C:\Users\genta\projects\training-lora-clothing\.uv-cache'
$env:UV_OFFLINE = '1'
$env:CARGO_NET_OFFLINE = 'true'
$env:CARGO_TARGET_DIR = 'C:\Users\genta\projects\training-lora-clothing\.qa-temp\kohya-build'
pnpm --dir C:\Users\genta\projects\training-lora-clothing tauri build --debug --no-bundle
~~~

~~~text
Finished dev profile [unoptimized + debuginfo] target(s) in 4.00s
Built application at: C:\Users\genta\projects\training-lora-clothing\.qa-temp\kohya-build\debug\costume-lora-studio.exe
exit code: 0
~~~

コピー先: dist/kohya-style/CostumeLoRAStudio.exe、13,854,720 bytes。
Python と学習器を同梱した配布完成品ではありません。

## セルフチェック

- ✅ 宣言範囲内のみ変更。保護ファイルへの変更なし。
- ✅ UTF-8、NUL 不在、Python AST / JSON / TOML、差分の空白を確認。
- ✅ パッケージ操作は uv / pnpm / Cargo のみ。
- ✅ Python36件・JS5件・画面操作・Windowsビルド成功。
- ✅ 起動中の旧 GUI は強制終了・上書きしていません。

Git 未初期化のため、git diff --no-index --check でテキストを比較しています。
ready: false は環境の不足状態であり、上記 UI / 回帰テストの失敗ではありません。

---

# 前回: GUI / backend 検証記録

2026-10-24。Windows x64、Python 3.12.12、NumPy 2.4.1、Pillow 12.1.0、
Node.js 24.14.0、pnpm 10.30.3、Tauri CLI 2.11.4、Cargo 1.96.0。

## Python: 36 tests / OK / skipped 0

実行した正確なコマンド:

~~~powershell
$env:PYTHONPATH = 'C:\Users\genta\projects\training-lora-clothing;C:\Users\genta\AppData\Local\uv\cache\archive-v0\I2D7sQuLVJiOkin26fbQW;C:\Users\genta\AppData\Local\uv\cache\archive-v0\w8iDDaPiUEFZMQ_cnImnp'
uv --cache-dir C:\Users\genta\projects\training-lora-clothing\.uv-cache --offline run --no-project --python 3.12 python -m unittest discover -s C:\Users\genta\projects\training-lora-clothing\tests
~~~

~~~text
Ran 36 tests in 0.795s
OK
exit code: 0
~~~

既存25件に加えて JSON ジョブ、別工程のマスク再利用、学習設定 TOML、
寸法不一致・非二値マスク・欠損マスク・空キャプション拒否、CUDA 要件、
ローカル tokenizer、シェルを使わない学習コマンド構築を検証しました。
推論と学習はテスト用実装です。実モデルを使う学習ではありません。
既存キャッシュの Python 3.12 対応 NumPy / Pillow を読み取り専用で参照しました。

## JavaScript: 3 tests / pass 3 / fail 0

~~~powershell
pnpm --dir C:\Users\genta\projects\training-lora-clothing test
pnpm --dir C:\Users\genta\projects\training-lora-clothing check
~~~

空・Enter のみの入力、学習設定の境界、他ジョブの遅延イベントを検証。
3 件成功・スキップ0・終了コード0。app.js の構文チェックも成功。

## GUI 操作: PASS

~~~powershell
$env:PYTHONPATH = 'C:\Users\genta\AppData\Local\uv\cache\archive-v0\sqH72rnwy5kzv9bjVrYTz;C:\Users\genta\AppData\Local\uv\cache\archive-v0\5M1YRteRE-BdLEZqycyrZ;C:\Users\genta\AppData\Local\uv\cache\archive-v0\SW4nelRW0CfhH92zbVU_D'
uv --cache-dir C:\Users\genta\projects\training-lora-clothing\.uv-cache --offline run --no-project --python 3.12 python C:\Users\genta\projects\training-lora-clothing\scripts\check_ui.py
~~~

~~~text
UI: empty input, navigation, path sync, mask reuse, job lock, cancellation, training validation, compact layout: PASS
exit code: 0
~~~

ローカル Edge headless を使用し、Tauri bridge はテスト用に置き換えています。
通信は intercept しローカルファイルを返すため、外部サーバーは使いません。
全画面切り替え、空入力拒否、パス同期、マスク再利用、実行中ロック、中止要求、
Alpha > Rank 拒否、横スクロールのない800px表示を確認。pageerror はありません。

キャプチャは .qa-temp/desktop-mask.png、desktop-train.png、desktop-compact.png。
マスク画面は目視確認済み。native WebView2 操作・実ジョブ中止の検証ではありません。

## Rust / Windows バイナリ: PASS

~~~powershell
cargo check --offline --manifest-path C:\Users\genta\projects\training-lora-clothing\src-tauri\Cargo.toml
cargo fmt --manifest-path C:\Users\genta\projects\training-lora-clothing\src-tauri\Cargo.toml -- --check
$env:UV_CACHE_DIR = 'C:\Users\genta\projects\training-lora-clothing\.uv-cache'
$env:UV_OFFLINE = '1'
$env:CARGO_NET_OFFLINE = 'true'
pnpm --dir C:\Users\genta\projects\training-lora-clothing tauri build --debug --no-bundle
~~~

~~~text
Finished dev profile [unoptimized + debuginfo] target(s) in 5.95s
Built application at: C:\Users\genta\projects\training-lora-clothing\src-tauri\target\debug\costume-lora-studio.exe
exit code: 0
~~~

PE ヘッダーの Windows x64 / GUI subsystem も確認。13,852,160 bytes。
これは開発用 GUI バイナリで、Python・学習器・重みを含む完成配布物ではありません。

pnpm offline install は既存キャッシュの2パッケージを SHA-512 検証後に
ワークスペース store へ複製して成功。Rust 依存もキャッシュで解決しました。
Cargo.lock / pnpm-lock.yaml を生成しています。

## セルフチェック

- ✅ 宣言した既存 Python・テスト・説明書、新規 UI / Rust / 配布設定の範囲内。
- ✅ 保護ファイルは存在せず、グローバル規約・外部ソースへの変更なし。
- ✅ UTF-8 / NUL 不在、Python AST、JSON / TOML を検証。
- ✅ パッケージ操作は uv / pnpm / Cargo のみ。
- ✅ Python・JS・画面操作・Rust check・整形・Windows ビルド成功。
- ✅ git diff --no-index --check で空白を検証。

Git 未初期化のため各ソースを NUL と比較しています。
生成アイコン・バイナリ・キャッシュ・キャプチャは文字コード検証の対象外です。

## 未検証・未完了

GitHub clone は接続制限で失敗:

~~~text
Failed to connect to github.com port 443
~~~

sd-scripts 本体の取得、完全な推論・学習環境の構築、実モデル推論、GPU / bf16 /
bitsandbytes、SD1.5 学習完走、実ジョブ中止、portable runtime の組み立てと移動先での
動作、NSIS 配布は未検証です。同梱スクリプトと手順は DESKTOP.md にあります。

---

# 初期 CLI 版の検証記録

2026-10-24 実施。Python 3.12.12、NumPy 2.4.1、Pillow 12.1.0。

## 実行したテストコマンド

この環境ではネットワークが拒否され、uv の既定キャッシュへの書き込みも不可のため、
既存キャッシュ内の Python 3.12 対応パッケージを読み取り専用で参照しました。
外部キャッシュの内容は変更していません。

~~~powershell
$env:PYTHONPATH = 'C:\Users\genta\projects\training-lora-clothing;C:\Users\genta\AppData\Local\uv\cache\archive-v0\I2D7sQuLVJiOkin26fbQW;C:\Users\genta\AppData\Local\uv\cache\archive-v0\w8iDDaPiUEFZMQ_cnImnp'
uv --cache-dir C:\Users\genta\projects\training-lora-clothing\.uv-cache --offline run --no-project --python 3.12 python -m unittest discover -s C:\Users\genta\projects\training-lora-clothing\tests -v
~~~

結果:

~~~text
Ran 25 tests in 0.826s
OK
exit code: 0
~~~

18 件の基本テストと 7 件の画像・統合テストがすべて成功し、スキップはありません。
壊れた画像・衣装未検出を意図的に発生させるテストでは ERROR ログを出しますが、
除外処理を検証するための期待した動作です。

検証対象:

- Enter のみ・空白のみ・必須引数欠落・不正しきい値。
- 入出力の重複、同一 stem、既存出力保護、ローカル重み欠落。
- アスペクト比維持、長辺 / 短辺、拡大抑制、極細画像。
- 衣装タグ除外、髪型・ポーズ・背景の保持。
- WD14 の float32 / NHWC / BGR と rating / character 除外。
- EXIF 回転、透過の白背景合成、8bit 二値 PNG、画像との寸法同期。
- ソケット禁止状態でのテスト用モデルによる一括生成。
- 全失敗時の一時ファイル除去、部分失敗時の画像・キャプション除去。
- Kohya TOML と ai-toolkit JSON の構文・マスク参照。

## セルフチェック

- ✅ 新規フォルダーの変更ファイルを宣言範囲と照合。
- ✅ 保護ファイルは存在せず、既存ユーザーファイルへの変更なし。
- ✅ UTF-8 デコードと NUL 不在を確認。
- ✅ Python AST と pyproject.toml を標準ライブラリで検証。
- ✅ パッケージ操作は uv のみ使用。
- ✅ テスト 25 件成功。
- ✅ Git diff の空白チェックを各新規ファイルと NUL の比較で実施。

このフォルダーは Git 未初期化です。通常の git diff は使えないため、
新規ファイルを git diff --no-index --check で検証しました。

## 未検証

推論用依存の新規インストール、uv.lock の生成、実モデルの推論、GPU / bf16 /
bitsandbytes、学習器本体の実行は未実施です。モデル重みを用意した実機で確認してください。
画像統合テストは推論モデルをテスト用実装に置き換えており、
衣装の意味的な分離精度は保証しません。
