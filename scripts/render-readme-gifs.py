#!/usr/bin/env python3
"""Compile Playwright frame sequences into crisp, compact GitHub README GIFs."""

import glob
import json
import os
import shutil
import numpy as np
from PIL import Image

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.abspath(os.environ.get("SHOWCASE_OUT_DIR", os.path.join(ROOT_DIR, "docs/media/showcase-20261116")))
TMP_DIR = os.path.abspath(os.environ.get("SHOWCASE_TMP_DIR", os.path.join(ROOT_DIR, "tmp/showcase-capture")))

CLIPS = [
    ("clip-resume-copilot", "showcase-resume-copilot.gif", 840, 525, 115, 96),
    ("clip-atlas-3d", "showcase-atlas-3d-radar.gif", 840, 525, 115, 96),
    ("clip-agent-autopilot", "showcase-agent-autopilot.gif", 840, 525, 120, 96),
]


def frames_to_gif(frame_paths, out_path, width, height, duration_ms, colors):
    deduped = []
    durations = []
    prev_arr = None

    for fp in frame_paths:
        with Image.open(fp) as img:
            rgb = img.convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
            arr = np.asarray(rgb, dtype=np.int16)
            if prev_arr is not None and np.mean(np.abs(arr - prev_arr)) < 0.015:
                durations[-1] += duration_ms
                continue
            prev_arr = arr
            quantized = rgb.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            deduped.append(quantized)
            durations.append(duration_ms)

    if not deduped:
        return None

    durations[0] += 350
    durations[-1] += 750
    deduped[0].save(
        out_path,
        save_all=True,
        append_images=deduped[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=2,
    )
    return {
        "file": os.path.basename(out_path),
        "rawFrames": len(frame_paths),
        "frames": len(deduped),
        "width": width,
        "height": height,
        "bytes": os.path.getsize(out_path),
    }


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

    gifs = []
    for clip_dir, gif_name, width, height, duration_ms, colors in CLIPS:
        pattern = os.path.join(TMP_DIR, clip_dir, "frame_*.jpg")
        frame_paths = sorted(glob.glob(pattern))
        if not frame_paths:
            print(f"[warn] no frames found for {clip_dir}")
            continue
        out_path = os.path.join(OUT_DIR, gif_name)
        meta = frames_to_gif(frame_paths, out_path, width, height, duration_ms, colors)
        if meta:
            gifs.append(meta)
            print(f"Generated {gif_name}: {meta['frames']}/{meta['rawFrames']} frames, {meta['width']}x{meta['height']}, {meta['bytes']/1024/1024:.2f} MB")

    overview_frames = []
    for clip_dir, _, _, _, _, _ in CLIPS:
        paths = sorted(glob.glob(os.path.join(TMP_DIR, clip_dir, "frame_*.jpg")))
        if not paths:
            continue
        step = max(1, len(paths) // 9)
        overview_frames.extend(paths[::step][:9])
    if overview_frames:
        overview_path = os.path.join(OUT_DIR, "showcase-overview.gif")
        meta = frames_to_gif(overview_frames, overview_path, 840, 525, 165, 96)
        if meta:
            gifs.insert(0, meta)
            print(f"Generated showcase-overview.gif: {meta['frames']} frames, {meta['bytes']/1024/1024:.2f} MB")

    manifest["gifs"] = gifs
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    if os.path.exists(TMP_DIR):
        shutil.rmtree(TMP_DIR, ignore_errors=True)
        print(f"Cleaned temporary capture frames: {TMP_DIR}")


if __name__ == "__main__":
    main()
