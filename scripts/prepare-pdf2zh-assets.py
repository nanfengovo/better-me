"""Explicit operator-only preparation; never called by a document request.

Run with the dedicated PDF2zh interpreter. --plan is offline and is the default.
--download retrieves public, hash-pinned assets only; it never imports the
converter, touches Path.home(), opens a PDF or calls a language model.
"""
import argparse
import concurrent.futures
import hashlib
import importlib.metadata as metadata
import json
import os
from pathlib import Path
import re
import runpy
import tempfile
import time
import urllib.error
import urllib.request

LIMIT = 512 * 1024 * 1024


def plan(model_upstream="huggingface"):
    if metadata.version("pdf2zh-next") != "2.10.2" or metadata.version("babeldoc") != "0.7.1":
        raise RuntimeError("Only PDF2zh-next 2.10.2 / BabelDOC 0.7.1 is reviewed")
    source = metadata.distribution("babeldoc").locate_file("babeldoc/assets/embedding_assets_metadata.py")
    data = runpy.run_path(str(source))
    entries = []
    for name in sorted(set(f for family in data["ALL_FONT_FAMILY"]["EN"].values() for f in family)):
        item = data["EMBEDDING_FONT_METADATA"][name]
        entries.append(dict(path="fonts/" + name, sha3_256=item["sha3_256"], size=item["size"],
                            url=data["FONT_URL_BY_UPSTREAM"]["github"](name)))
    for name, item in data["CMAP_METADATA"].items():
        entries.append(dict(path="cmap/" + name, sha3_256=item["sha3_256"], size=item["size"],
                            url=data["CMAP_URL_BY_UPSTREAM"]["github"](name)))
    entries.append(dict(path="models/doclayout_yolo_docstructbench_imgsz1024.onnx",
                        sha3_256=data["DOCLAYOUT_YOLO_DOCSTRUCTBENCH_IMGSZ1024ONNX_SHA3_256"],
                        size=None, maxBytes=128 * 1024 * 1024, url=data["DOC_LAYOUT_ONNX_MODEL_URL"][model_upstream]))
    for name, digest in data["TIKTOKEN_CACHES"].items():
        entries.append(dict(path="tiktoken/" + name, sha3_256=digest, size=None, maxBytes=8 * 1024 * 1024,
                            url="https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken"))
    return entries


def digest(filename):
    value = hashlib.sha3_256()
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def ranged_model(entry, target):
    # Optional bounded acceleration for the public layout weight only. Never
    # used by a converter/private document. Require exact ranges, then verify
    # the full pinned digest before the file can become an admitted asset.
    # Some reviewed mirrors omit Content-Length on HEAD. A one-byte exact
    # Content-Range obtains a bounded length without accepting a whole body.
    request = urllib.request.Request(entry["url"], headers={"Range": "bytes=0-0", "Cache-Control": "no-cache"})
    with urllib.request.urlopen(request, timeout=30) as response:
        match = re.fullmatch(r"bytes 0-0/([1-9][0-9]{0,8})", response.headers.get("Content-Range", ""))
        if response.status != 206 or not match or len(response.read(2)) != 1:
            raise RuntimeError("Invalid layout range metadata")
        length = int(match[1])
    if not 0 < length <= entry["maxBytes"]:
        raise RuntimeError("Invalid layout resource length")

    def part_once(start):
        end = min(start + 1024 * 1024, length) - 1
        request = urllib.request.Request(entry["url"], headers={"Range": f"bytes={start}-{end}", "Cache-Control": "no-cache"})
        with urllib.request.urlopen(request, timeout=45) as response:
            if response.status != 206 or response.headers.get("Content-Range") != f"bytes {start}-{end}/{length}":
                raise RuntimeError("Layout server did not honor exact range")
            value = response.read(end - start + 2)
            if len(value) != end - start + 1:
                raise RuntimeError("Incomplete layout range")
        return start, value

    def part(start):
        for attempt in range(3):
            try:
                return part_once(start)
            except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
                if isinstance(error, urllib.error.HTTPError) and error.code not in (408, 425, 429, 500, 502, 503, 504):
                    raise
                if attempt == 2:
                    raise
                # Public binary retry only, never a model/document retry. The
                # exact requested range and final expected digest do not change.
                print(json.dumps({"layoutRangeRetry": start, "attempt": attempt + 1}), flush=True)
                time.sleep(attempt + 1)

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        futures = [pool.submit(part, start) for start in range(0, length, 1024 * 1024)]
        received = 0
        try:
            for future in concurrent.futures.as_completed(futures):
                start, value = future.result()
                target.seek(start)
                target.write(value)
                received += len(value)
                print(json.dumps({"layoutBytesReceived": received, "total": length}), flush=True)
        except BaseException as error:
            # Don't leave dozens of queued transfers running after one range
            # is refused. Running reads keep their bounded socket timeout.
            for future in futures:
                future.cancel()
            print(json.dumps({"layoutRangeRejected": type(error).__name__}), flush=True)
            raise
    return length


def download(root, entry, parallel_model=False):
    filename = root / entry["path"]
    filename.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if filename.parent.is_symlink() or filename.parent.resolve().parent != root:
        raise RuntimeError("Unsafe asset directory")
    if filename.exists():
        info = filename.lstat()
        if filename.is_symlink() or not filename.is_file() or info.st_nlink != 1:
            raise RuntimeError("Unsafe existing asset: " + entry["path"])
        if info.st_size <= LIMIT and digest(filename) == entry["sha3_256"]:
            return dict(entry, bytes=info.st_size)
        raise RuntimeError("Existing asset differs; do not overwrite: " + entry["path"])
    descriptor, temporary = tempfile.mkstemp(prefix=".betterme-download-", dir=filename.parent)
    try:
        size = 0
        # Public resources only, with a bounded read and a pinned content digest.
        with os.fdopen(descriptor, "wb") as target:
            if parallel_model and entry["path"].startswith("models/"):
                size = ranged_model(entry, target)
            else:
                with urllib.request.urlopen(entry["url"], timeout=45) as response:
                    for block in iter(lambda: response.read(1024 * 1024), b""):
                        size += len(block)
                        if size > (entry["size"] if entry["size"] is not None else entry["maxBytes"]):
                            raise RuntimeError("Asset exceeds its finite size: " + entry["path"])
                        target.write(block)
        if (entry["size"] is not None and size != entry["size"]) or digest(Path(temporary)) != entry["sha3_256"]:
            raise RuntimeError("Asset digest/size mismatch: " + entry["path"])
        # No overwrite, even if a second preparer raced this one.
        os.link(temporary, filename)
        print(json.dumps({"verified": entry["path"], "bytes": size}), flush=True)
        return dict(entry, bytes=size)
    finally:
        Path(temporary).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--parallel-model", action="store_true", help="Up to 8 exact HTTPS ranges for the public layout weight only")
    parser.add_argument("--model-upstream", choices=("huggingface", "modelscope", "hf-mirror"), default="huggingface",
                        help="Only pinned-upstream URLs; the content hash never changes")
    args = parser.parse_args()
    entries = plan(args.model_upstream)
    known = sum(item["size"] or 0 for item in entries)
    print(json.dumps({"engine": "PDF2zh-next 2.10.2 / BabelDOC 0.7.1", "files": len(entries),
                      "knownBytes": known, "unknownSizeFiles": sum(item["size"] is None for item in entries),
                      "maxBytes": LIMIT, "download": args.download}), flush=True)
    if not args.download:
        return
    root = args.assets
    if not root.is_absolute() or root == Path(root.anchor) or root.is_symlink():
        raise RuntimeError("Choose a new absolute, private assets directory")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if root.resolve() != root or sum(item["size"] if item["size"] is not None else item["maxBytes"] for item in entries) > LIMIT:
        raise RuntimeError("Unsafe path or resource plan exceeds ceiling")
    if set(item.name for item in root.iterdir()) - {"fonts", "cmap", "models", "tiktoken"}:
        raise RuntimeError("Assets-only directory required")
    # Six resource workers; optional layout ranges have a separate hard cap of 8.
    # This explicit operator command receives no private document.
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        complete = list(pool.map(lambda item: download(root, item, args.parallel_model), entries))
    total = sum(item["bytes"] for item in complete)
    if total > LIMIT:
        raise RuntimeError("Resource ceiling exceeded")
    print(json.dumps({"files": len(complete), "bytes": total, "assets": complete}, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
