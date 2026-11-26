# AGENTS.md — Costume LoRA Studio

このリポジトリで働く AI（Claude Code・Codex・Gemini など）への入口。アプリの説明は `README.md`。

## AI 共通の脳（ai-brains）— すべての AI・すべての端末で共通

AI の共通ルール・教訓・ミスの記録・引き継ぎは、非公開リポジトリ `azmok/ai-brains` にまとめてある。
このリポジトリは公開なので、失敗の記録・教訓・引き継ぎは置かない。全体の設計は ai-brains の `README.md`。

- **始めに** `node scripts/ai-learning.mjs sync` を実行する。手元の PC では `../ai-brains` を使い、無ければプロジェクトの中の `ai-brains/` にクローンする（クラウドはセッションに `azmok/ai-brains` を入れる。`../ai-brains` に置かれる）。
- 次に ai-brains の `common/rules.md`（共通ルール）を読み、それに従う。
- このプロジェクトの置き場所は `../ai-brains/projects/costume-lora-studio/`：
  - `handoff/tasks.md`（今の状態）→ `decisions.md`（あずまの決定）→ `log/` の最新月の末尾、の順に読む。
  - `memory/memories-archive.md`：2026-11-26 までの作業メモ（もとはこのリポジトリの `memories.md`）。読むだけ。
- **終わるとき**は `log/` に追記し、`tasks.md` を直す（書き方は ai-brains の `common/handoff.md`）。
- ミスの記録：`node scripts/ai-learning.mjs record --class <分類> --scope <範囲> --what "..." --cause "..." --fix "..."`
- `handoff/`・`memory/`・`mistakes/` の変更は、Claude Code では Stop フック（`node scripts/ai-learning.mjs push`）が自動で main に反映する。ほかの AI は、終わるときに自分で `push` を実行する。それ以外の変更は、作業ブランチ → プルリクエストにする。

## このプロジェクトの決まり

- パッケージ管理は Python = `uv`、JS = `pnpm`。pip と npm は使わない。
- アプリの画面の文字は英語だけにする（会話は日本語）。
