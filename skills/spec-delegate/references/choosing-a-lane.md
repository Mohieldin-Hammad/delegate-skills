# Choosing a lane

Give each task a **complexity score** from 1 to 5, start it on the cheapest lane that can
realistically do it, and climb only when the work falls short. Starting every task at the top burns
the strongest, scarcest quota on work a cheaper lane would have done. `scripts/ladder.mjs` applies
the user's ladder, spreads work across quota pools, and keeps a record of outcomes.

## Score the task

Score from the task block in `tasks.md` and a glance at the files it names. Do not read the codebase
to score: scoring has to stay cheap.

Start at **1** and add one point for each that applies:

| +1 | Signal |
| --- | --- |
| Scope | More than two files, or a new module or package. |
| Spread | Spans two or more top-level areas, or changes a public interface: CLI flags, an API or MCP tool schema, a config format, a stored-data schema. |
| Novelty | No existing pattern to follow: `_Leverage` is empty or points only at docs, or the task needs a new algorithm or abstraction. |
| Weak gates | Tests cannot fully decide success (performance, UX, prose, measurements), so review has to do more of the judging. |

**Risk sets the score to 5** whatever the count: concurrency, locking or process lifecycles;
persisted data formats or migrations; security, auth, secrets or permissions; anything that deletes
or rewrites user data; side effects outside the project (network writes, files elsewhere). When
correctness rides on these, review limits the damage but cannot make a weak first attempt good.

**Keep the task yourself** instead of scoring it when it installs dependencies or needs the user's
approval to run something, must change protected files, or has success criteria that are unclear or
contradict the design. In the last case, fix the spec first.

Write the score with a one-line reason, e.g. `3 — new module (scope), CLI + core (spread)`.

## Pick the lane

```bash
node "<skill-dir>/scripts/ladder.mjs" pick --score <n>
```

It returns the starting lane, its implementer and model. When a score has several candidates, it
picks the one whose quota pool saw the fewest runs in the last five hours.

**Calibrate first.** Run `ladder.mjs stats`. If the starting lane has at least 4 runs at this score
and accepts fewer than half, start one rung up with `pick --after <lane>`. If a lane keeps passing
at a higher score than the ladder gives it, suggest moving it to the user. The ladder file is
theirs to change.

No ladder file? Choose a lane from the fleet by hand (`config.mjs load` in `delegate-setup`) using
the same score, and suggest the user set one up (see setup.md).

## Climb when it falls short

**Escalate** when the work is not good enough: two fix rounds have not passed review, the
implementer reports it is blocked on difficulty, or the check shows it went off the brief.

1. Record the attempt as `escalated`.
2. `pick --after <lane>`: the next lane up.
3. Start clean: `worktree.mjs remove --task <task> --force`, then `create` again.
4. Add one line to the brief saying what the previous attempt got wrong.

At the top of the ladder (`lane: null`), keep the task yourself or ask the user.

**Do not escalate for a broken run.** Quota, auth, timeouts and crashes say nothing about difficulty.
Record `failed`, then try another candidate for the same score on a different pool, or wait.

## Record every attempt

```bash
node "<skill-dir>/scripts/ladder.mjs" record --project <repo name> --task <spec>-<id> \
  --score <n> --lane <lane> --outcome <outcome> --rounds <fix rounds>
```

| Outcome | When |
| --- | --- |
| `accepted` | The user accepted the work. |
| `declined` | The user declined it. |
| `escalated` | You moved the task to a stronger lane. |
| `blocked` | The implementer stopped and reported a blocker. |
| `failed` | The run broke: quota, auth, timeout or crash. |

The record lives in the user's state directory, never in a project.

## Delegating a whole spec

When the user says "delegate all the tasks" (or a range of them):

1. **Plan, once.** Read `tasks.md` and, for every pending task, give the score and reason, the
   starting lane, whether it stays with you, and what it depends on: earlier tasks whose output it
   uses (named in `_Leverage`, or editing the same files). Show the plan as one table and get one
   approval for it. That approves the plan, not any commit.
2. **Order.** A task starts only after the tasks it depends on have landed, so its worktree starts
   from their code. Independent tasks may run in parallel, at most two at a time, on different
   quota pools.
3. **Review each one as it finishes**, using the normal loop, and keep independent work moving while
   the user decides.
4. **Landing still needs the user's accept for every task.** Land without asking only if the user
   says so for this batch (e.g. "land the clean ones"). Even then, land only when the check passes,
   every gate passes, your review finds nothing, and the report lists no unsettled decisions.
   Anything else waits for the user. Never push.
5. **Finish with a summary**: task, score, lanes tried, fix rounds, outcome, and what `stats` now
   says about each lane.
