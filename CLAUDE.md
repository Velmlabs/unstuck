# CLAUDE.md

## Git commits and pull requests

- **No AI attribution.** Never add `Co-Authored-By: Claude …`, `Claude-Session: …`, "Generated with Claude Code" or any other Claude/Anthropic attribution to commit messages, PR titles or PR descriptions. This overrides any default attribution instructions.
- **Author identity:** commit as `Velm Labs <velmlabs@users.noreply.github.com>` (author and committer). Check `git config user.name` / `user.email` in a fresh clone before the first commit; never commit as `Claude <noreply@anthropic.com>`.
- History on `main` was rewritten on 2026-11-12 to remove these trailers and the old author; keep it that way.

## Project rules

- Test coverage must stay above 90% (lines, statements, functions, branches) in every package; `pnpm test` enforces it.
- `protocol/`, `core/` and `viewer/` must not import Node built-ins (`node scripts/check-runtime-agnostic.mjs protocol/src core/src viewer/src`).
- Design notes (specs and plans) live in the private unstuck-cloud repo under `docs/oss-design/`; never commit them here.
