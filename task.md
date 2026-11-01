2026.11.02-00:19

あずま、キャラクターLoRA用に最適化したプロンプトテンプレートを、「SD1.5用（Danbooruタグ形式）」**と**「Flux / SD3等の近代モデル用（自然言語キャプション形式）」の2パターン組んだで。

どちらもQwen2-VLにそのままコピペして使える英語仕様や。

---

### 1. SD1.5用プロンプト（Danbooruタグ形式）

SD1.5は表情、ポーズ、アングル、背景をタグとしてしっかり吐き出させて、キャラの本体特徴と癒着させへんのが最大のキモや。

```text
You are an expert anime/manga image tagger specializing in Danbooru-style tags for Stable Diffusion 1.5 character LoRA training.
Analyze the provided image and generate a concise, comma-separated list of Danbooru tags following these strict rules:

1. VARIABLE ELEMENTS (MUST TAG TO PREVENT OVERFITTING):
- Pose & Action: standing, sitting, arms behind back, peace sign, crossed arms, looking back, etc.
- Expression & Eyes: smile, open mouth, blushing, closed eyes, looking at viewer, looking away, etc.
- Framing & Camera: full body, cowboy shot, upper body, close-up, from behind, from side, profile, straight-on, from above, from below, dutch angle.
- Background & Lighting: simple background, white background, bedroom, outdoors, street, sunset, depth of field, etc.

2. CLOTHING (CONTEXT-DEPENDENT):
- Describe the current visible outfit, shoes, and accessories in detail (e.g., sailor uniform, pleated skirt, black thighhighs, loafers, ribbon, hair ornament). Tagging outfits allows swapping clothes later.

3. CHARACTER FEATURES:
- Include tags for hair color, hair style, eye color, and notable body features (e.g., long hair, twintails, blonde hair, blue eyes).

4. STRICT EXCLUSIONS:
- Do NOT output quality tags (e.g., masterpiece, best quality, highly detailed).
- Do NOT output artist names, copyright names, or meta tags.

5. OUTPUT FORMAT:
- Output ONLY lowercase, comma-separated tags.
- No conversational text, no markdown backticks, just raw comma-separated tags.

```

---

### 2. タグスタイルじゃないモデル用プロンプト（Flux / SD3 / 自然言語系）

Fluxなどの近代モデルは、Danbooruタグではなく「論理的で客観的な短編〜中編の英文（2〜4文程度）」で学習させるのが最も破綻せえへん。装飾語（beautifulとかmasterpiece）を排除して、構造・構図・照明を淡々と記述させるプロンプトや。

```text
You are an AI captioning specialist creating natural language training datasets for modern text-to-image diffusion models (such as Flux and SD3).
Analyze the provided image and write a concise, dense, and objective description of the character and scene.

Follow this structural flow:
1. Subject & Appearance: Gender/identity, hair color, hairstyle, eye color, and facial expression.
2. Pose & Action: Exact body posture, arm/leg placement, and direction the character is facing or looking.
3. Attire & Accessories: Detailed garments, fabrics, colors, footwear, and any worn accessories.
4. Environment & Lighting: Setting (interior/exterior), background elements, atmosphere, and light source/direction.
5. Framing & Camera: Shot distance (close-up, medium shot, full-body shot) and angle (eye-level, low angle, high angle, side profile).

Rules:
- Write in neutral, direct English prose (2 to 4 sentences).
- Avoid subjective praise, emotional adjectives, or quality fluff (e.g., DO NOT write "stunning artwork", "intricate details", "masterpiece").
- Describe only what is visually confirmed in the image.
- Output ONLY the raw caption text without introductory phrases, bullet points, quotes, or markdown code blocks.

```

---

### キャプション運用時の使い分けのコツ

* **トリガーワードの付与方法：**
どちらのモデルでも、トリガーワード（例: `azuma_char`）はQwenに考えさせず、キャプション出力後にスクリプト側で機械的に先頭へ挿入するのが一番事故らへん。
* **SD1.5:** `azuma_char, 1girl, blonde hair, ...`
* **自然言語モデル:** `A photo/illustration of azuma_char, a young woman with blonde hair...`（※先頭に `[トリガーワード], ` と置くだけでも十分に機能するで）


* **衣装を固定したいキャラの場合：**
「このキャラといえば絶対にこの制服！」という固定キャラを作るなら、SD1.5用プロンプトの `2. CLOTHING` の項目を削って衣装タグを敢えて出力させず、トリガーワードに衣装ごと吸わせるのが手っ取り早い。逆に色んな服を着せ替えたいなら、上のテンプレート通り服のタグを細かく拾わせるのが正解や。



こんな感じで今、キャラクターLoRAのテンプレ文を考えてもらったから、それもさっきのテンプレプリセットに追加お願い