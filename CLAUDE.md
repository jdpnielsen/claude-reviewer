# Claude Code Guidelines

## Code Style

- **Do not put imports inside functions.** All imports should be at the top of the file.
- Follow PEP 8 and the project's existing style.
- Use type hints consistently.

## Code Review Workflow

When making significant changes, use the local review system:

1. Create a PR for review:
   ```bash
   claude-reviewer create --title "Description of changes"
   ```

2. Wait for review:
   ```bash
   claude-reviewer watch <pr-id>
   ```
   (Default waits for any feedback - approval or changes_requested)

3. Address feedback by replying to comments:
   ```bash
   claude-reviewer comments <pr-id>
   claude-reviewer reply <pr-id> <comment-uuid> "Fixed by doing X"
   ```

4. Update the PR after fixes:
   ```bash
   claude-reviewer update <pr-id>
   ```

5. If approved, merge:
   ```bash
   claude-reviewer merge <pr-id>
   ```

## Bundled Skills

`claude-reviewer-cli/claude_reviewer/skills/` ships two Claude Code skills
(`claude-reviewer`, `claude-reviewer-always`) that document this CLI's commands for
use in *other* projects. They're hand-written, not generated from `cli.py`, so they
go stale silently. Whenever you add, rename, remove, or change the behavior of a
`claude-reviewer` CLI command, update the relevant `SKILL.md` file(s) and the CLI
reference tables in `README.md` / `claude-reviewer-cli/README.md` in the same change.

## Development

- Start web UI: `claude-reviewer serve --dev`
- Stop web UI: `claude-reviewer stop`
- Run tests: `cd claude-reviewer-cli && make test`
- Type checking: `cd claude-reviewer-cli && make typecheck`

## Test Database Isolation

Both sides of this app can silently write to your **real** `~/.claude-reviewer/data.db` if test isolation is set up wrong. Before any manual/exploratory testing, verify isolation actually worked (e.g. check `~/.claude-reviewer/data.db`'s row counts before/after) rather than assuming an env var took effect.

- **Web (TS/Vitest)**: `lib/database.ts` resolves `DATABASE_DIR`/`DATABASE_PATH` lazily inside `getDatabase()` (`getDbDir()`/`getDbPath()` functions), not as frozen module-level `const`s. This is required, not stylistic: ES module import hoisting means a test file's own `process.env.DATABASE_PATH = ...` line runs *after* an `import ... from "../lib/database"` statement's side effects, so a frozen top-level const would always resolve to the real path regardless of the env var. Do not revert this to a top-level const.
- **CLI (Python)**: `claude_reviewer/database.py` has **no env var override** for the database path — `DATABASE_PATH`/`DATABASE_DIR` only exist on the Node/Docker side. Setting them before running `python -m claude_reviewer.cli ...` does nothing; the CLI will use the real database. To isolate a Python test or ad-hoc script, monkeypatch `db.DEFAULT_DB_PATH` directly before calling `db.init_db()` — see the `temp_db` fixture in `claude-reviewer-cli/tests/conftest.py` for the pattern.
