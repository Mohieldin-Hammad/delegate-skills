---
name: spec-delegate
description: >-
  Implement spec-workflow tasks through delegated implementers (any `*-delegate` skill) while you stay
  the orchestrator: pick a task from a spec's tasks.md, dispatch a brief built from its _Prompt into an
  isolated git worktree, review the result, and land it only after the user accepts. Use this whenever
  the user says "delegate task 3.2", "have an implementer do the next task", "run the next spec task
  through Cursor/Antigravity", "implement this spec with delegation", or asks to set up spec delegation
  in a project ("set up spec-delegate here"). DO NOT USE for design or spec-writing work, for tasks
  that install dependencies, or when the user wants you to write the code yourself.
license: MIT
compatibility: Requires git, Node.js 18+, a spec-workflow MCP server connected to the orchestrator, and at least one installed and authenticated `*-delegate` implementer skill. Shell examples assume bash/zsh.
metadata:
  version: 0.1.0
---

# Spec Delegate

You are the **orchestrator**. Specs from the spec-workflow MCP say *what* to build; a `*-delegate`
skill's relay sends a **brief** to an **implementer** CLI that does the typing. You own the judgment:
which task goes out, what the brief says, whether the work is right, and you **land** it only after
the user accepts.

Three guardrails make this safe to run against real projects. Never skip them:

1. **Worktree isolation.** Each task runs in its own worktree on branch `delegate/<task>`. The user's
   tree, and everything gitignored in it (databases, `.env`, local config), is out of the
   implementer's reach.
2. **A ref guard.** A `reference-transaction` hook refuses every ref change (commit, stash, reset,
   branch, checkout -b) while `DELEGATE_WORKER` is set, and `--no-verify` does not skip it. It guards
   history, not files.
3. **A check after every run.** `worktree.mjs check` confirms HEAD and the branch did not move and
   lists every changed file against the task's allowed and protected paths.

Scripts live in this skill's `scripts/` folder (`<skill-dir>` below). They print JSON and need only Node.

## Is the project set up?

```bash
node "<skill-dir>/scripts/init.mjs" --cd <repo>
```

Ready means: `configFile` is `exists`, `hook.installed` is true, `agentsMd` is `has-rules`, and no
note asks for a fix. If not, follow [references/setup.md](references/setup.md) first, then come back.

## The loop (one task)

### 1. Pick the task

Use the spec-workflow `spec-status` tool, or read `.spec-workflow/specs/<spec>/tasks.md`. Take the
task the user named, or the next `[ ]` one. Keep these for yourself instead of delegating: tasks that
add dependencies or need the user's approval to run something, tasks that must change protected files
(see the config), and design or spec work.

Score the task's complexity (1–5) and pick its lane with
[references/choosing-a-lane.md](references/choosing-a-lane.md):
`node "<skill-dir>/scripts/ladder.mjs" pick --score <n>`. Use the `*-delegate` skill of the lane's
implementer.

### 2. Start it

- Mark the task `[-]` in the **user's** `tasks.md` (the real one, not a copy).
- Create the worktree. Use `<spec>-<task id>` as the task name so ids from different specs never clash:

```bash
node "<skill-dir>/scripts/worktree.mjs" create --cd <repo> --task <spec>-<id>
```

It copies the gitignored `snapshot` paths (usually the specs) into the worktree and runs the `setup`
commands. On failure it says why; fix the cause, `remove`, and create again.

### 3. Write the brief

Fill in [references/brief.md](references/brief.md) from the task block. It carries the task's
`_Prompt`, the allowed files, the gates from the config, the implementer rules and a short report
contract. The brief is the implementer's only context, so make it complete. Save it under the run
directory: `$(git -C <repo> rev-parse --path-format=absolute --git-common-dir)/spec-delegate/runs/<task>/<n>/`.

### 4. Dispatch

Follow the chosen `*-delegate` skill for its relay. Always add these:

```bash
DELEGATE_WORKER=1 node "<implementer-skill-dir>/scripts/relay.mjs" \
  --brief <run-dir>/brief.md --cd <worktree> --lane <lane> --out-dir <run-dir> \
  <relayFlags for this implementer from the config, if any>
```

`DELEGATE_WORKER=1` arms the ref guard for everything the implementer runs. Add the config's
`relayFlags` for that implementer and nothing else that loosens permissions. Those flags are on record
because the user approved them for this project. Run it in the background (in Claude Code:
`run_in_background: true`) and wait for completion.

### 5. Review — re-verify, do not trust the report

Keep this cheap: read the result before the code, and the code only where it matters.

1. Read `result.json`: `status`, `touchedFiles`, and the short report at the end of `finalMessage`.
2. Run the guard check, with `--allow` for every file or folder the brief allowed:

   ```bash
   node "<skill-dir>/scripts/worktree.mjs" check --cd <repo> --task <task> --allow <path> ...
   ```

   A failed check is a stop: tell the user what it found. Do not land, and do not quietly repair it.
3. Run every gate from the config yourself, inside the worktree, **without** `DELEGATE_WORKER`.
4. Read `git -C <worktree> diff` against the brief's Success criteria and the design: did it do what
   was asked, nothing more and nothing less?

### 6. Fix loop

If something needs changing, write a short delta brief (only what is wrong, and the expected
result) and resume the same conversation through the relay's resume option. Prefer the explicit id
from `result.json` (e.g. `--conversation <id>`, `--session <id>`) over `--resume-last`. Allow two
rounds. After that, climb the ladder as described in
[references/choosing-a-lane.md](references/choosing-a-lane.md). At the top, keep the task yourself
or ask the user.

### 7. The user decides

Show the user: the task, the changed files, the gate results, your review (including any decisions
the implementer made that the brief did not settle), and ask: **accept, decline, or change?**
Nothing lands without an explicit accept.

### 8. Land or discard

**Accept:**

1. Commit in the worktree, without `DELEGATE_WORKER`, with a message in the project's style.
2. Bring it into the user's branch: `git -C <repo> merge --ff-only delegate/<task>`. If the user's
   branch moved meanwhile, rebase the worktree branch onto it, re-run the gates, then fast-forward.
3. Mark the task `[x]` in the user's `tasks.md`.
4. Call the spec-workflow `log-implementation` tool with the summary, files, statistics and
   **artifacts** (functions, classes, endpoints, components, integrations) taken from the landed diff.
5. `node "<skill-dir>/scripts/worktree.mjs" remove --cd <repo> --task <task>`.

**Decline:** `worktree.mjs remove --task <task> --force`, and set the task back to `[ ]`.

Either way, record the attempt with `ladder.mjs record` so the next pick is better informed.

## Delegating a whole spec

When the user asks to delegate all tasks (or a range), plan the batch once, get one approval for the
plan, then run the loop per task in dependency order. Every task still needs its own accept to land,
unless the user says otherwise for that batch. See "Delegating a whole spec" in
[references/choosing-a-lane.md](references/choosing-a-lane.md).

## What stays with the orchestrator

The implementer never marks tasks, never writes implementation logs and never commits. Logging after
acceptance is deliberate: a declined attempt must not appear in the log that future tasks search.
The spec-workflow MCP therefore stays connected to the orchestrator only; implementers read the specs
as files from the snapshot.

## References

- [references/setup.md](references/setup.md) — set up a new project, and the one-time machine setup.
- [references/brief.md](references/brief.md) — the brief template.
- [references/choosing-a-lane.md](references/choosing-a-lane.md) — complexity scores, the ladder,
  escalation, the outcome record and batches.
- The `*-delegate` skill of each implementer — relay flags, `result.json`, resume, permissions.
