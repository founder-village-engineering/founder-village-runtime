#!/usr/bin/env python3
"""Read-only orientation for the two Founder Village application repositories."""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path


def git_status(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "status", "--short"],
        cwd=root,
        check=False,
        capture_output=True,
        text=True,
    )
    return result.stdout.splitlines() if result.returncode == 0 else ["not a git checkout"]


def instruction_files(root: Path) -> list[str]:
    return sorted(
        str(path.relative_to(root))
        for path in root.rglob("AGENTS.md")
        if "node_modules" not in path.parts and ".git" not in path.parts
    )


def load_json(path: Path) -> object | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def audit(runtime: Path, frontends: Path) -> dict[str, object]:
    runtime = runtime.resolve(strict=True)
    frontends = frontends.resolve(strict=True)
    return {
        "runtime": {
            "root": str(runtime),
            "instructions": instruction_files(runtime),
            "status": git_status(runtime),
            "applications": load_json(runtime / "config/applications.json"),
            "frontends": load_json(runtime / "config/frontends.json"),
        },
        "frontends": {
            "root": str(frontends),
            "instructions": instruction_files(frontends),
            "status": git_status(frontends),
            "apps": sorted(
                path.parent.name
                for path in (frontends / "apps").glob("*/founder-village-app.json")
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--frontends", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.runtime, args.frontends), indent=2))


if __name__ == "__main__":
    main()
