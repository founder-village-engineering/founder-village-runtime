#!/usr/bin/env python3
"""Verify cross-repository invariants for one Founder Village frontend."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


SLUG = re.compile(r"^[a-z][a-z0-9-]{0,62}$")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonc(path: Path) -> Any:
    source = path.read_text(encoding="utf-8")
    uncommented: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(source):
        character = source[index]
        following = source[index + 1] if index + 1 < len(source) else ""
        if in_string:
            uncommented.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            uncommented.append(character)
            index += 1
        elif character == "/" and following == "/":
            index += 2
            while index < len(source) and source[index] not in "\r\n":
                index += 1
        elif character == "/" and following == "*":
            end = source.find("*/", index + 2)
            if end < 0:
                raise ValueError(f"unterminated JSONC comment: {path}")
            index = end + 2
        else:
            uncommented.append(character)
            index += 1
    cleaned = "".join(uncommented)
    output: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(cleaned):
        character = cleaned[index]
        if in_string:
            output.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
        if character == ",":
            lookahead = index + 1
            while lookahead < len(cleaned) and cleaned[lookahead].isspace():
                lookahead += 1
            if lookahead < len(cleaned) and cleaned[lookahead] in "}]":
                index += 1
                continue
        output.append(character)
        index += 1
    return json.loads("".join(output))


def source_files(source: Path) -> dict[str, Path]:
    files = sorted(path for path in source.rglob("*") if path.is_file())
    if not files:
        raise ValueError(f"empty contract source: {source}")
    paths: dict[str, Path] = {}
    for path in files:
        if path.is_symlink() or path.suffix != ".ts":
            raise ValueError(f"contract source must contain real TypeScript files: {path}")
        paths[path.relative_to(source).as_posix()] = path
    return paths


def contract_files(source: Path, dependencies: dict[str, Path]) -> dict[str, Path]:
    files = source_files(source)
    for slug, root in dependencies.items():
        for name, path in source_files(root).items():
            name = f"features/{slug}/{name}"
            if name in files:
                raise ValueError(f"duplicate contract file: {name}")
            files[name] = path
    return files


def digest_files(files: dict[str, Path]) -> tuple[str, list[str]]:
    names = sorted(files)
    digest = hashlib.sha256()
    for name in names:
        digest.update(name.encode())
        digest.update(b"\0")
        digest.update(files[name].read_bytes())
        digest.update(b"\0")
    return digest.hexdigest(), names


def contract_digest(source: Path) -> tuple[str, list[str]]:
    return digest_files(source_files(source))


def check_app(runtime: Path, frontends: Path, app: str) -> dict[str, object]:
    if not SLUG.fullmatch(app):
        raise ValueError("app must be a lowercase slug")
    runtime = runtime.resolve(strict=True)
    frontends = frontends.resolve(strict=True)
    app_root = frontends / "apps" / app
    manifest = read_json(app_root / "founder-village-app.json")
    catalog = {item["id"]: item for item in read_json(runtime / "config/frontends.json")}
    registration = catalog[app]
    application = next(
        item
        for item in read_json(runtime / "config/applications.json")
        if item["id"] == registration["application"]
    )
    expected_origin = f"https://{manifest['pagesProject']}.pages.dev"
    expected_source = f"packages/frontend-contracts/{app}"
    assertions = {
        "manifest slug": manifest["slug"] == app,
        "pages origin": manifest["productionOrigin"] == expected_origin,
        "additional Pages projects": manifest.get("additionalPagesProjects", []) == registration.get("additionalPagesProjects", []),
        "exact custom origin": manifest.get("customOrigin") == registration.get("customOrigin"),
        "exact custom origins": manifest.get("customOrigins", []) == registration.get("customOrigins", []),
        "runtime pages origin": registration["productionOrigin"] == expected_origin,
        "application mapping": manifest["application"] == registration["application"],
        "feature mappings": manifest.get("featureFrontends", []) == registration.get("featureFrontends", []),
        "application database identity": application["database"] == manifest["application"],
        "exact Hasura source": application["hasuraSource"] == manifest["application"],
        "contract source": manifest["contractSource"] == expected_source,
        "runtime contract source": registration["contractSource"] == expected_source,
        "frontend path": registration["frontendPath"] == f"apps/{app}",
        "migration directory": (runtime / "database/applications" / manifest["application"]).is_dir(),
        "Hasura metadata": (runtime / "hasura/applications" / manifest["application"] / "tables.json").is_file(),
    }
    wrangler = read_jsonc(app_root / "wrangler.jsonc")
    assertions.update(
        {
            "Pages output configured": wrangler.get("pages_build_output_dir") == "./dist",
            "no Worker main": "main" not in wrangler,
            "no Pages Functions": not (app_root / "functions").exists(),
            "no Worker output": not any(app_root.glob("**/_worker.*")),
        }
    )
    source = runtime / expected_source
    dependencies = {slug: runtime / catalog[slug]["contractSource"] for slug in registration.get("featureFrontends", [])}
    expected_files = contract_files(source, dependencies)
    sha256, files = digest_files(expected_files)
    generated = app_root / "src/generated/contracts"
    marker = read_json(generated / "contract-source.json")
    assertions.update(
        {
            "contract marker owner": marker["frontend"] == app,
            "contract marker source": marker["source"] == expected_source,
            "contract marker digest": marker["sha256"] == sha256,
            "contract marker files": marker["files"] == files,
            "contract bytes": all(
                (generated / name).read_bytes() == expected_files[name].read_bytes()
                for name in files
            ),
        }
    )
    failures = [name for name, passed in assertions.items() if not passed]
    if failures:
        raise ValueError("invariant failures: " + ", ".join(failures))
    return {
        "app": app,
        "application": manifest["application"],
        "database": application["database"],
        "pagesOrigin": expected_origin,
        "contractSha256": sha256,
        "checks": len(assertions),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", type=Path, required=True)
    parser.add_argument("--frontends", type=Path, required=True)
    parser.add_argument("--app", required=True)
    args = parser.parse_args()
    print(json.dumps(check_app(args.runtime, args.frontends, args.app), indent=2))


if __name__ == "__main__":
    main()
