#!/usr/bin/env python3
"""
Generate or edit images via the Gemini API (Nano Banana 2 / Pro, default) or
the OpenAI Images API (GPT Image 2).

Auth (env vars):
  GEMINI_API_KEY  - for --provider gemini (default)
  OPENAI_API_KEY  - for --provider openai

Usage:
  # Text-to-image (Nano Banana 2 by default)
  python3 generate_image.py --prompt "a watercolor fox in a misty forest" \
      --aspect-ratio 3:2 --size 1K --out fox.png

  # OpenAI GPT Image 2 instead
  python3 generate_image.py --provider openai --prompt "..." --aspect-ratio 1:1 --out logo.png

  # Image editing / remixing (repeat --input-image for multi-image composition)
  python3 generate_image.py --prompt "make it nighttime, add fireflies" \
      --input-image photo.jpg --out night.png

  # Multiple variations (separate calls, numbered suffixes)
  python3 generate_image.py --prompt "minimal line-art cat logo" --count 3 --out cat.png

Models:
  --provider gemini: --model nb2 -> gemini-3.1-flash-image (default, fast/cheap)
                     --model pro -> gemini-3-pro-image (max quality, dense text)
  --provider openai: gpt-image-2

Exit codes: 0 success, 1 error (message on stderr).
"""

import argparse
import base64
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request
import uuid

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
OPENAI_GEN_URL = "https://api.openai.com/v1/images/generations"
OPENAI_EDIT_URL = "https://api.openai.com/v1/images/edits"
OPENAI_MODEL = "gpt-image-2"

GEMINI_MODELS = {"nb2": "gemini-3.1-flash-image", "pro": "gemini-3-pro-image"}

ASPECT_RATIOS = [
    "1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3",
    "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
]
SIZES = ["512", "1K", "2K", "4K"]
SIZE_PX = {"512": 512, "1K": 1024, "2K": 2048, "4K": 4096}

EXT_FOR_MIME = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def http_json(url, data, headers):
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:
            msg = body[:500]
        sys.exit(f"API error {e.code}: {msg}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error: {e.reason}")


def save_image(raw_bytes, out_path, mime="image/png"):
    root, cur_ext = os.path.splitext(out_path)
    final = root + (cur_ext if cur_ext else EXT_FOR_MIME.get(mime, ".png"))
    os.makedirs(os.path.dirname(os.path.abspath(final)), exist_ok=True)
    with open(final, "wb") as f:
        f.write(raw_bytes)
    return final


# ---------------------------------------------------------------- Gemini ----

def gemini_generate(args, key, out_path):
    parts = []
    for path in args.input_image or []:
        mime = mimetypes.guess_type(path)[0] or "image/png"
        with open(path, "rb") as f:
            parts.append({"inline_data": {
                "mime_type": mime, "data": base64.b64encode(f.read()).decode()}})
    parts.append({"text": args.prompt})

    config = {"responseModalities": ["TEXT", "IMAGE"]}
    image_config = {}
    if args.aspect_ratio:
        image_config["aspectRatio"] = args.aspect_ratio
    if args.size:
        image_config["imageSize"] = args.size
    if image_config:
        config["imageConfig"] = image_config

    payload = {"contents": [{"role": "user", "parts": parts}],
               "generationConfig": config}
    model = GEMINI_MODELS[args.model]
    response = http_json(
        GEMINI_URL.format(model=model),
        json.dumps(payload).encode(),
        {"x-goog-api-key": key, "Content-Type": "application/json"},
    )

    candidates = response.get("candidates") or []
    if not candidates:
        feedback = response.get("promptFeedback", {})
        sys.exit(f"No candidates returned. Prompt feedback: {json.dumps(feedback)}")

    cand = candidates[0]
    for part in cand.get("content", {}).get("parts", []):
        blob = part.get("inlineData") or part.get("inline_data")
        if blob:
            mime = blob.get("mimeType") or blob.get("mime_type") or "image/png"
            return save_image(base64.b64decode(blob["data"]), out_path, mime)
        if part.get("text"):
            print(f"[model text] {part['text'].strip()}", file=sys.stderr)

    sys.exit(
        f"No image in response (finishReason={cand.get('finishReason', '')}). "
        "The request may have been blocked by safety filters - try rephrasing the prompt."
    )


# ---------------------------------------------------------------- OpenAI ----

def openai_pixel_size(aspect_ratio, size):
    """Map aspect ratio + size tier to a WxH string (long side = tier pixels)."""
    if not aspect_ratio:
        return "auto"
    w_r, h_r = (int(x) for x in aspect_ratio.split(":"))
    long_side = SIZE_PX[size or "1K"]
    if w_r >= h_r:
        w, h = long_side, max(256, round(long_side * h_r / w_r / 32) * 32)
    else:
        h, w = long_side, max(256, round(long_side * w_r / h_r / 32) * 32)
    return f"{w}x{h}"


def multipart(fields, files):
    """Encode multipart/form-data with stdlib. files: list of (name, path)."""
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in fields.items():
        body += (f"--{boundary}\r\nContent-Disposition: form-data; "
                 f'name="{name}"\r\n\r\n{value}\r\n').encode()
    for name, path in files:
        mime = mimetypes.guess_type(path)[0] or "image/png"
        with open(path, "rb") as f:
            data = f.read()
        body += (f"--{boundary}\r\nContent-Disposition: form-data; "
                 f'name="{name}"; filename="{os.path.basename(path)}"\r\n'
                 f"Content-Type: {mime}\r\n\r\n").encode() + data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return body, f"multipart/form-data; boundary={boundary}"


def openai_generate(args, key, out_path):
    size = openai_pixel_size(args.aspect_ratio, args.size)
    if args.input_image:
        fields = {"model": OPENAI_MODEL, "prompt": args.prompt}
        if size != "auto":
            fields["size"] = size
        body, content_type = multipart(
            fields, [("image[]", p) for p in args.input_image])
        response = http_json(OPENAI_EDIT_URL, body, {
            "Authorization": f"Bearer {key}", "Content-Type": content_type})
    else:
        payload = {"model": OPENAI_MODEL, "prompt": args.prompt, "size": size}
        response = http_json(OPENAI_GEN_URL, json.dumps(payload).encode(), {
            "Authorization": f"Bearer {key}", "Content-Type": "application/json"})

    data = response.get("data") or []
    if not data or not data[0].get("b64_json"):
        sys.exit(f"No image in response: {json.dumps(response)[:500]}")
    return save_image(base64.b64decode(data[0]["b64_json"]), out_path, "image/png")


# ------------------------------------------------------------------ main ----

def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--prompt", required=True, help="Full image description / edit instruction")
    p.add_argument("--out", default="image.png", help="Output file path (extension auto-corrected to returned MIME)")
    p.add_argument("--provider", choices=["gemini", "openai"], default="gemini",
                   help="gemini = Nano Banana (default), openai = GPT Image 2")
    p.add_argument("--aspect-ratio", choices=ASPECT_RATIOS, default=None,
                   help="Omit to let the model decide (or match input image when editing)")
    p.add_argument("--size", choices=SIZES, default=None,
                   help="Resolution tier: 512 (gemini nb2 only), 1K (default), 2K, 4K")
    p.add_argument("--model", choices=list(GEMINI_MODELS), default="nb2",
                   help="Gemini only: nb2 = Nano Banana 2 (default), pro = Nano Banana Pro")
    p.add_argument("--input-image", action="append", metavar="PATH",
                   help="Input image for editing/composition; repeatable")
    p.add_argument("--count", type=int, default=1, help="Number of images (separate calls, numbered files)")
    args = p.parse_args()

    env_var = "GEMINI_API_KEY" if args.provider == "gemini" else "OPENAI_API_KEY"
    key = os.environ.get(env_var)
    if not key:
        sys.exit(f"Set {env_var} first: export {env_var}=...")

    if args.provider == "gemini" and args.size == "512" and args.model == "pro":
        sys.exit("512px is only supported by nb2 (gemini-3.1-flash-image).")
    for path in args.input_image or []:
        if not os.path.isfile(path):
            sys.exit(f"Input image not found: {path}")

    generate = gemini_generate if args.provider == "gemini" else openai_generate

    for i in range(args.count):
        out = args.out
        if args.count > 1:
            root, ext = os.path.splitext(args.out)
            out = f"{root}-{i + 1}{ext or '.png'}"
        saved = generate(args, key, out)
        print(f"Saved: {saved}")


if __name__ == "__main__":
    main()
