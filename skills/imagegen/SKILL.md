---
name: imagegen
description: >-
  Generate or edit images with AI image models — Gemini Nano Banana 2 by
  default, OpenAI GPT Image 2 optionally. Flexible, brand-agnostic drawing
  skill — any subject, style, size, or aspect ratio. Use whenever the user
  wants an image created or modified: "draw", "generate an image", "make a
  picture / illustration / logo / icon / poster / banner / wallpaper /
  thumbnail / hero image / concept art", "visualize this", "edit this photo",
  "restyle this image", "combine these images", or when a deliverable needs
  AI-generated visuals (e.g. artwork for a doc, deck, or post). Do NOT
  use for charts/diagrams from data (use code or SVG instead).
---

# Image Generation (Nano Banana 2 / GPT Image 2)

Generate or edit images via `scripts/generate_image.py`, which calls the
Gemini image models (default) or the OpenAI Images API.

## Requirements

- `GEMINI_API_KEY` must be set for the default provider; `OPENAI_API_KEY` for
  `--provider openai`. If the needed key is missing, ask the user for it and
  export it for the run.
- No Python dependencies — the script uses only the standard library.

## Workflow

1. **Interpret the request.** Decide on subject, style, aspect ratio, size,
   and whether this is generation or an edit of user-provided image(s). Pick
   sensible defaults from context instead of interrogating the user:
   - Logo/icon/avatar → `1:1`; poster/phone wallpaper → `9:16` or `2:3`;
     banner/hero/thumbnail → `16:9` or `21:9`; print/poster → `2K`+.
   - Omit `--aspect-ratio` when editing, so the output matches the input image.
   - Default size is 1K; use 2K/4K only when the user needs large output
     (slower and pricier).
2. **Write the prompt** (see prompting guide below).
3. **Run the script** from the skill directory:

   ```bash
   python3 scripts/generate_image.py --prompt "..." --aspect-ratio 16:9 --out hero.png
   ```

   Key flags: `--input-image PATH` (repeatable, for edits/composition),
   `--count N` (variations), `--size 512|1K|2K|4K`, `--model nb2|pro`,
   `--provider gemini|openai`.
4. **Look at the result** (Read the image file) before delivering. If it
   misses the brief, revise the prompt and regenerate — or do a follow-up
   *edit* pass by feeding the output back with `--input-image` and a targeted
   instruction ("same image, but make the sky dusk orange"). Editing preserves
   what already works; regenerating rerolls everything.
5. **Deliver the file(s)** to the user.

## Provider & model choice

- **Gemini `nb2`** (default, `gemini-3.1-flash-image` = Nano Banana 2): fast
  and cheap; right for nearly everything. Only option supporting 512px output.
- **Gemini `pro`** (`gemini-3-pro-image` = Nano Banana Pro): when the user asks
  for maximum quality, or the image needs dense/accurate text rendering
  (infographics, menus, UI mockups with real copy).
- **OpenAI** (`--provider openai`, `gpt-image-2`): use when the user explicitly
  asks for OpenAI/GPT Image/DALL·E, or when Gemini repeatedly fails or blocks a
  reasonable request. Aspect ratio + size are translated to pixel dimensions
  automatically; `--model` is ignored. Does not support transparent
  backgrounds.

## Prompting guide

Describe the scene in flowing narrative sentences, not keyword lists — these
models parse language deeply, and "cat, cute, 4k, trending" wastes that.
A strong prompt covers:

- **Subject & action** — what is happening, specifically.
- **Style/medium** — "watercolor", "flat vector illustration", "35mm film
  photo", "isometric 3D render", "charcoal sketch". If the user gave no style,
  infer one that fits the purpose; don't default everything to photorealism.
- **Composition & camera** — close-up, wide shot, low angle, centered subject
  with negative space (useful when text will be overlaid later).
- **Lighting & mood** — golden hour, soft studio light, neon noir, overcast.
- **Text in the image** — put exact wording in quotes: `the sign reads "OPEN
  24/7"`. Keep in-image text short; use `pro` for text-heavy images.

**Example 1**
Input: "draw me a cozy coffee shop logo"
Prompt: `A minimal flat-vector logo for a cozy coffee shop: a steaming coffee
cup nestled inside a circular badge, warm terracotta and cream palette, soft
rounded shapes, plain off-white background, no text.` (`--aspect-ratio 1:1`)

**Example 2** (edit)
Input: "make this product photo look like it's on a beach"
Prompt: `Keep the product exactly as-is, but replace the background with a
sunny beach scene: soft-focus sand and turquoise sea, late-afternoon light
matching the product's existing shadows.` (`--input-image product.jpg`, no
aspect ratio flag)

## Multiple images

- **Variations of one idea**: same prompt with `--count N`.
- **A set of distinct images** (e.g. 4 illustrations for a blog post): run the
  script once per image with individually crafted prompts. Keep style wording
  identical across prompts so the set looks cohesive; for stronger consistency,
  generate the first image, then create the rest as edits of it
  (`--input-image first.png` + "same style and palette, now showing ...").

## Troubleshooting

- *"No image in response"* / safety block → rephrase: remove real people's
  names, brands, or violent/explicit phrasing, and retry. If a reasonable
  request keeps getting blocked, try the other provider.
- API error 400/401 with key message → key missing/invalid; re-check with user.
- 429 → rate limited; wait briefly and retry.
- Aspect ratios available: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9,
  21:9, and extreme strips 1:4, 4:1, 1:8, 8:1.
