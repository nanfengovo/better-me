"""Reproduce local speech assets from two pinned, operator-provided upstream archives.
No network and no extraction of archive paths to disk; no microphone or user data."""
import argparse
import base64
import gzip
import hashlib
import io
from pathlib import Path
import tarfile
import zipfile

MODEL = "3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba"
ENGINE = "df9MuChirUGKxP/+4k8tBV6hJOic8IRdJXv64+ET0Ue5CddOzLZINiHOWCka765gBzHJWNtQKgaYakS0FXZIJA=="
BASE = "vosk-model-small-cn-0.22/"


def emit(target, data):
    if target.is_symlink():
        raise ValueError("Refusing symlink output")
    if target.exists():
        if target.read_bytes() != data:
            raise ValueError("Existing output differs; choose an empty staging directory")
    else:
        with target.open("xb") as out:
            out.write(data)
    print(target.name, len(data), hashlib.sha256(data).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ("library", "model", "out"):
        parser.add_argument("--" + key, type=Path, required=True)
    args = parser.parse_args()
    lib, model = args.library.read_bytes(), args.model.read_bytes()
    if base64.b64encode(hashlib.sha512(lib).digest()).decode() != ENGINE or hashlib.sha256(model).hexdigest() != MODEL:
        raise ValueError("Pinned upstream archive integrity mismatch")
    if not args.out.is_dir() or args.out.is_symlink():
        raise ValueError("Output must be an existing non-symlink directory")
    with tarfile.open(fileobj=io.BytesIO(lib), mode="r:gz") as npm:
        emit(args.out / "vosk.js", npm.extractfile("package/dist/vosk.js").read())
    buffer=io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(model)) as archive, gzip.GzipFile(fileobj=buffer,mode="wb",mtime=0,compresslevel=9) as gz, tarfile.open(fileobj=gz,mode="w|",format=tarfile.USTAR_FORMAT) as tar:
        for name in sorted(archive.namelist()):
            if not name.startswith(BASE) or ".." in name.split("/"):
                raise ValueError("Unexpected archive member")
            item=tarfile.TarInfo("model/"+name[len(BASE):])
            if name.endswith("/"):
                item.type=tarfile.DIRTYPE;item.mode=0o755;tar.addfile(item)
            else:
                data=archive.read(name);item.size=len(data);item.mode=0o644;tar.addfile(item,io.BytesIO(data))
    emit(args.out / "small-cn-0.22.tar.gz",buffer.getvalue())


if __name__ == "__main__":
    main()
