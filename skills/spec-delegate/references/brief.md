# Brief template

Fill in every `<…>`. The implementer sees only this text and the worktree, so put everything it needs
here. Copy the task block from `tasks.md` exactly. From the `_Prompt`, drop the sentence that tells
the implementer to mark the task or call `log-implementation`: the orchestrator does those after the
user accepts.

`<allowed paths>` are the task's `Files:` plus the tests it needs. Pass the same list to
`worktree.mjs check --allow`.

```markdown
# Task <id>: <title> (spec "<spec>")

You are an implementer. An orchestrator reviews your work, and the user decides whether it lands.

## Where you are

- Your worktree: <worktree path>, on branch `delegate/<task>`. Work only here.
- The specs, as read-only copies: `.spec-workflow/specs/<spec>/requirements.md`, `design.md` and
  `tasks.md`.
- What earlier tasks built: `.spec-workflow/specs/<spec>/Implementation Logs/`.

## The task

<the task block from tasks.md, exactly as written, including Files, _Leverage and _Requirements>

### Prompt

<the task's _Prompt: Role | Task | Restrictions | Success, without the marking/logging instructions>

## How to work

1. Read the requirements this task names (`_Requirements`) and the parts of `design.md` it touches.
2. Before writing code, search the implementation logs for functions, classes and patterns you can
   reuse, e.g. `grep -ri "<keyword>" ".spec-workflow/specs/<spec>/Implementation Logs/"`. Reuse them
   instead of writing duplicates.
3. Implement it. Change only these paths: <allowed paths>.
4. Run every gate until it passes:
<one line per gate from the config>

## Rules

<the "Rules for delegated implementers" section from the project's AGENTS.md>

## Report

End with this report and nothing after it. Keep it under 15 lines.

STATUS: done | blocked
CHANGED: <files>
GATES: <each command: pass or fail>
DECISIONS: <choices this brief did not settle, or "none">
BLOCKERS: <what stopped you, or "none">
```

## Delta brief (fix round)

Send only what changes, through the relay's resume option for the same conversation:

```markdown
Review of your work on task <id>. Fix these, change nothing else, re-run the gates, and end with the
same report:

1. <file:line — what is wrong — what it should be>
```
