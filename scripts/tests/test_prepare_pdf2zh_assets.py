"""Offline stdlib regressions for the explicit public-resource preparer."""
import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("asset_preparer", Path(__file__).resolve().parents[1] / "prepare-pdf2zh-assets.py")
preparer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preparer)


class Response(io.BytesIO):
    def __init__(self, data=b"", status=200, headers=None):
        super().__init__(data)
        self.status = status
        self.headers = headers or {}


class AssetTests(unittest.TestCase):
    def source(self, fault=None):
        content = bytes(range(256)) * 10_001

        def open_request(request, **_kwargs):
            if request.get_method() == "HEAD":
                return Response(headers={"Content-Length": str(129 * 1024 * 1024 if fault == "oversize" else len(content))})
            start, end = map(int, request.get_header("Range").removeprefix("bytes=").split("-"))
            value = content[start:end + 1]
            return Response(value[:-1] if fault == "short" else value,
                            status=200 if fault == "status" else 206,
                            headers={"Content-Range": "invalid" if fault == "range" else f"bytes {start}-{end}/{129 * 1024 * 1024 if fault == 'oversize' else len(content)}"})
        return content, open_request

    def test_exact_ranges_reassemble_the_complete_resource(self):
        content, network = self.source()
        target = io.BytesIO()
        with patch.object(preparer.urllib.request, "urlopen", network):
            self.assertEqual(preparer.ranged_model({"url": "https://public.invalid/layout", "maxBytes": 128 * 1024 * 1024}, target), len(content))
        self.assertEqual(target.getvalue(), content)

    def test_short_wrong_or_ignored_ranges_and_oversize_headers_are_rejected(self):
        for fault in ("short", "range", "status", "oversize"):
            with self.subTest(fault=fault):
                _content, network = self.source(fault)
                with patch.object(preparer.urllib.request, "urlopen", network), self.assertRaises(RuntimeError):
                    preparer.ranged_model({"url": "https://public.invalid/layout", "maxBytes": 128 * 1024 * 1024}, io.BytesIO())

    def test_transient_public_range_failures_retry_only_the_same_range_with_a_finite_limit(self):
        content, network = self.source()
        attempts = 0

        def unstable(request, **kwargs):
            nonlocal attempts
            if request.get_header("Range") == "bytes=0-1048575":
                attempts += 1
                if attempts < 3:
                    raise preparer.urllib.error.URLError("synthetic transient failure")
            return network(request, **kwargs)
        target = io.BytesIO()
        with patch.object(preparer.urllib.request, "urlopen", unstable), patch.object(preparer.time, "sleep"):
            preparer.ranged_model({"url": "https://public.invalid/layout", "maxBytes": 128 * 1024 * 1024}, target)
        self.assertEqual(attempts, 3)
        self.assertEqual(target.getvalue(), content)

    def test_a_truncated_or_wrong_digest_download_never_becomes_an_asset(self):
        for value in (b"partial", b"wrong-data"):
            with self.subTest(value=value), tempfile.TemporaryDirectory(prefix="betterme-assets-test-") as directory:
                root = Path(directory).resolve()
                entry = {"path": "fonts/example.ttf", "url": "https://public.invalid/font", "size": 10,
                         "sha3_256": hashlib.sha3_256(b"right-data").hexdigest()}
                with patch.object(preparer.urllib.request, "urlopen", lambda *_a, **_k: Response(value)), self.assertRaisesRegex(RuntimeError, "Asset digest/size mismatch"):
                    preparer.download(root, entry)
                self.assertEqual(list((root / "fonts").iterdir()), [])

    def test_valid_files_are_reused_without_network_and_wrong_files_are_not_overwritten(self):
        with tempfile.TemporaryDirectory(prefix="betterme-assets-test-") as directory:
            root = Path(directory).resolve()
            (root / "fonts").mkdir()
            original = b"public-resource"
            filename = root / "fonts/example.ttf"
            filename.write_bytes(original)
            entry = {"path": "fonts/example.ttf", "url": "https://public.invalid/font", "size": len(original),
                     "sha3_256": hashlib.sha3_256(original).hexdigest()}
            with patch.object(preparer.urllib.request, "urlopen", side_effect=AssertionError("network not allowed")):
                self.assertEqual(preparer.download(root, entry)["bytes"], len(original))
                with self.assertRaises(RuntimeError):
                    preparer.download(root, dict(entry, sha3_256="0" * 64))
            self.assertEqual(filename.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
