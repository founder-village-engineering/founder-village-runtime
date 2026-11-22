---
name: public-repo-security
description: Prevent and investigate credential or private data exposure in the public Founder Village runtime repository. Use before commits, pushes, or public artifacts, or when asked to check the checkout, staged changes, or Git history for secrets.
---

# Public repository security

Keep real credentials, unredacted environment values, production data, and private artifacts in approved stores and ignored local paths. Use empty values, environment references, or unmistakably synthetic fixtures in tracked files. A provider test key is still a credential when it authorizes real access.

## Before a commit or push

1. Review the intended files with `git diff --cached --name-status`. Run `npm run security:scan -- --staged` after staging the intended changes and again after any change to the index. The check reads the complete staged versions of added, modified, and renamed files. A failed or unavailable scan blocks the commit.
2. Review staged changes locally for sensitive material that patterns can miss. Check secret defaults and fallback values, credential-bearing URLs, browser build inputs, logs, examples, fixtures, backups, and evidence files. Review the commit message and any public PR text as well. Share only safe excerpts or redacted locations.
3. For commits already made locally, run `npm run security:scan -- --history` before publishing if those commits have not been checked. Keep the pre-commit hook active and use GitHub push protection where enabled.

## Audit a checkout

- Run `npm run security:scan` for tracked and non-ignored untracked working files, `npm run security:scan -- --staged` for the index, and `npm run security:scan -- --history` for commit patches reachable from local refs. Confirm branch and tag coverage when reporting on a remote repository.
- Review ignore rules and example configuration without opening private state, credential stores, or real environment files. The scanner is pattern-based. Review opaque artifacts and encoded or unusual values before sharing them.
- Report the rule, relative path, line, commit SHA when relevant, and whether the finding is an exposure or a verified fixture. Keep raw matches, reports, environment output, authorization headers, and command traces out of tool output, chat, and public artifacts.

## Handle a finding

- Pause publishing while a suspected exposure is unresolved. Remove the value from proposed changes, move it to the approved store, and rescan the index. When a real credential may have left its intended boundary, arrange immediate provider-side revocation or rotation and review access from the first possible exposure.
- Check whether the value reached committed history, a fork, a CI log, or a release artifact. Coordinate history rewrites and external changes with the repository owner. Removing a file from the current checkout leaves earlier copies accessible.
- For a verified false positive, scope any exception in `.gitleaks.toml` to the exact synthetic value and file. Keep provider rules active. Use a disposable repository and synthetic data when testing the scanner or hook.
