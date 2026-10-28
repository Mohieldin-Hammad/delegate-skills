# Setting up spec-delegate

Two parts: a one-time machine setup, and a short per-project setup. Every project is different, so
the project part is a procedure for you to follow with judgment, not a fixed table. Show the user
what you plan to write and get a yes before writing anything.

## Once per machine

1. **Implementer skills.** Install `delegate-setup` and the `*-delegate` skill of every implementer
   the user wants, plus this skill, from the same package and pinned to a release tag.
2. **Fleet lanes, global.** Run `delegate-setup` and write the lanes with `--scope global`. Project
   lanes are approved per worktree, so they fail closed in every fresh worktree spec-delegate makes.
   Global lanes do not.
3. **The ladder.** `~/.config/delegate-skills/ladder.json` (or under `$XDG_CONFIG_HOME`) maps each
   complexity score to starting lanes, lists lanes weakest first for escalation, and groups lanes by
   the quota pool they draw on. `cooldown` sets how long a pool rests after hitting its limit when the
   error gives no reset time (default 5h). Copy `templates/ladder.example.json` and use the user's
   lane names.
   Lanes from different pools (different CLIs, or a CLI's separate model quotas) on the same score let
   `ladder.mjs` spread the load.
4. **The spec-workflow MCP**, connected to the orchestrator at user scope, so every project has it.
5. **Tell the orchestrator.** A line in its user-level instructions (for Claude Code,
   `~/.claude/CLAUDE.md`) such as: "In projects with `.delegate/spec-delegate.json`, implement
   spec-workflow tasks through the spec-delegate skill; keep design and review yourself."

## Once per project

### 1. Look at what is there

```bash
node "<skill-dir>/scripts/init.mjs" --cd <repo>
```

It reports the config, the hook, AGENTS.md, the spec-workflow folder and the hooks directory, with
notes on anything to fix. It changes nothing.

### 2. Work out the config

Write `.delegate/spec-delegate.json`. Read the project to fill it in. **CI config is the best
evidence** (`.github/workflows/`, `.gitlab-ci.yml`, …): it shows how a clean checkout is prepared and
what must pass. Then lock files, manifests, the README and any `Makefile` or task runner.

| Field | What goes in it |
| --- | --- |
| `version` | `"spec-delegate.v1"` |
| `setup` | Commands that make a fresh checkout ready to build and test, **without resolving anything new**: frozen or locked installs from the existing lock file. Empty when nothing is needed. |
| `gates` | The checks every task must pass: tests, lint, type checks. Usually what CI runs. They must pass on the current commit and be fast enough to run per task. |
| `snapshot` | Gitignored paths the implementer must read, copied into each worktree. Usually `.spec-workflow/specs` and `.spec-workflow/steering` when `.spec-workflow/` is gitignored; nothing when it is committed. Never secrets or personal data. |
| `protected` | Paths the implementer must not change. Always `AGENTS.md`, `CLAUDE.md`, `.gitignore`, `.delegate/`, `.mcp.json`, and the hooks directory when `init.mjs` reports `hooksDir`. Add dependency manifests and lock files (this is what enforces "never install anything"), CI config, and documents the orchestrator owns, such as design docs. |
| `worktreeRoot` | Optional. Where worktrees go; default `../<repo-name>-wt`. |
| `relayFlags` | Optional. Extra relay flags per implementer key, e.g. `{"agy": ["--sandbox", "--dangerously-skip-permissions"]}`. **Only flags the user approved for this project**, since they loosen permissions. |

Starting points by stack. Confirm each against the project; these are examples, not rules:

| Stack | Typical `setup` | Typical `gates` | Protect |
| --- | --- | --- | --- |
| uv | `uv sync --frozen` (add `--extra X` the tests need) | `uv run --frozen pytest -q`, `uv run --frozen ruff check .` | `pyproject.toml`, `uv.lock` |
| Poetry | `poetry install` | `poetry run pytest -q` | `pyproject.toml`, `poetry.lock` |
| pip | `python3 -m venv .venv`, `.venv/bin/pip install -r requirements.txt` | `.venv/bin/python -m pytest -q` | `requirements*.txt` |
| npm / pnpm / yarn / bun | `npm ci` / `pnpm install --frozen-lockfile` / `yarn install --immutable` / `bun install --frozen-lockfile` | the `lint`, `typecheck` and `test` scripts in `package.json` | `package.json` and its lock file |
| Cargo | `cargo fetch --locked` | `cargo test --locked`, `cargo clippy -- -D warnings` | `Cargo.toml`, `Cargo.lock` |
| Go | `go mod download` | `go vet ./...`, `go test ./...` | `go.mod`, `go.sum` |
| Nothing to build (docs, scripts) | none | whatever checks exist; maybe none | — |

If a project has no gates, say so to the user: the implementer's work can then only be reviewed by
reading it.

### 3. Verify, then install

```bash
node "<skill-dir>/scripts/init.mjs" --cd <repo> --verify --write
```

`--verify` builds a throwaway worktree of HEAD, runs the snapshot, setup and every gate, then deletes
it. It fails when setup fails, when setup leaves files git can see (gitignore them, e.g. `.venv/`,
`node_modules/`, `target/`), or when a gate fails on the current commit, since a gate that already
fails cannot judge an implementer. `--write` runs only when verification passes. It installs the hook
and adds the implementer rules to `AGENTS.md`, creating it if missing. It never edits the config.

### 4. Commit, with the user's accept

Commit `.delegate/spec-delegate.json`, the `AGENTS.md` change and, when the hooks directory is
tracked, the hook. A hook inside the working tree reaches new worktrees only through a commit, and
`worktree.mjs create` refuses until it does. Run `init.mjs` again: it should report ready with no
notes.

## Safety notes

- The hook guards history, not files. `git checkout -- <file>`, `git restore`, `git clean` and the
  file half of `git reset --hard` still run. Inside a worktree they can only reach the implementer's
  own uncommitted work, which is why the worktree is the main guardrail.
- Hook managers that own the hooks directory (Husky's `.husky/_`, for one) may not run a
  `reference-transaction` hook, or may overwrite it. `install-hook` refuses to replace a hook it did
  not write. If the directory is gitignored, `init.mjs --write` fails because worktrees would never
  get the hook.
- Anything in `snapshot` is sent to the implementer's model provider along with the code. Keep
  personal data out of it.
