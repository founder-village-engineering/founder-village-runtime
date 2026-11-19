from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts/check_app.py"
SPEC = importlib.util.spec_from_file_location("check_app", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ContractDigestTest(unittest.TestCase):
    def test_jsonc_comments_and_trailing_commas_are_supported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wrangler.jsonc"
            path.write_text(
                '{\n  // Pages only\n  "name": "commas,} stay",\n  "pages_build_output_dir": "./dist",\n}\n',
                encoding="utf-8",
            )
            self.assertEqual(
                MODULE.read_jsonc(path),
                {"name": "commas,} stay", "pages_build_output_dir": "./dist"},
            )

    def test_digest_is_stable_and_path_sensitive(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "a.ts").write_text("export const a = 1;\n", encoding="utf-8")
            first = MODULE.contract_digest(root)
            second = MODULE.contract_digest(root)
            self.assertEqual(first, second)
            self.assertEqual(first[1], ["a.ts"])
            (root / "b.ts").write_text("export const b = 2;\n", encoding="utf-8")
            self.assertNotEqual(first[0], MODULE.contract_digest(root)[0])

    def test_non_typescript_source_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "secret.env").write_text("nope", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "TypeScript"):
                MODULE.contract_digest(root)


if __name__ == "__main__":
    unittest.main()
