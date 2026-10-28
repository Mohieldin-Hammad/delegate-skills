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
picks the available one whose quota pool saw the fewest runs in the last five hours. When none is
available it climbs to the next available lane up (`fallback: true`); see "When a lane is out of
quota or gone" below. Pass its `warnings` on to the user.

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

**Do not escalate for a broken run.** Quota, a missing model, auth, timeouts and crashes say
nothing about difficulty. Handle them as below instead.

## When a lane is out of quota or gone

When a run fails, read `stderrTail` and `finalMessage` in `result.json` and classify it:

| What the error says | Record | Effect |
| --- | --- | --- |
| Quota, usage or rate limit, 429, "exhausted" | `limited`, with `--until` when the error gives a reset time | The lane's whole **pool** is skipped until then. Without `--until`, the pool's `cooldown` from the ladder applies (default 5h). |
| Unknown, invalid or retired model | `unavailable` | That implementer **and model** are skipped until the lane's model changes or someone runs `clear`. Tell the user and suggest removing the lane or replacing its model with `delegate-setup`; the choice is theirs. |
| Auth, timeout, crash, anything else | `failed` | Nothing is skipped. Fix the cause (e.g. ask the user to log in) or retry once. |

Then start the task again in a fresh worktree (`remove --force`, `create`) with a new `pick --score`.
It now skips the blocked lanes and returns another candidate, or climbs.

**Never step down on your own.** When `pick` returns `lane: null`, everything at this score and above
is blocked. Tell the user the `earliestReset` and let them choose: wait, use a weaker lane (name
it), or have you write it yourself.

`ladder.mjs status` shows every lane as `ok`, `limited` (with the reset time), `unavailable` or
`stale` (named by the ladder but missing from the fleet), and warns about fleet lanes the ladder
never uses. Check it before a batch. `ladder.mjs clear --lane <lane>` lifts a limit or an
unavailable mark early, for instance when the user says the quota has reset or the model is back.

**Removing a lane on purpose:** remove it with `delegate-setup`, then take it out of the ladder's
`start`, `escalate`, `pools` and `cooldown`. A lane you miss only causes a warning; `pick` skips it.

**Cursor:** depending on the user's Cursor settings, running out of included usage either stops
requests or switches to paid on-demand usage. In the second case no error ever appears. Mention
this once when setting up a Cursor lane.

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
| `limited` | The run hit a quota or rate limit. |
| `unavailable` | The model is unknown, invalid or retired. |
| `failed` | The run broke for another reason: auth, timeout, crash. |

`stats` counts only the first four for acceptance; the last three appear as `broken`. Recent-run
balancing counts only runs that reached a working model.

The record lives in the user's state directory, never in a project.

## Delegating a whole spec

When the user says "delegate all the tasks" (or a range of them):

1. **Plan, once.** Read `tasks.md` and, for every pending task, give the score and reason, the
   starting lane, whether it stays with you, and what it depends on: earlier tasks whose output it
   uses (named in `_Leverage`, or editing the same files). Show the plan as one table and get one
   approval for it. That approves the plan, not any commit.
2. **Order.** A task starts only after the tasks it depends on have landed, so its worktree starts
   from their code. Independent tasks may run in parallel, at most two at a time, on different
   quota pools. Run `ladder.mjs status` first, and again whenever a run comes back `limited`.
   A task whose lanes are all blocked **pauses**. Keep the others moving, and list paused tasks with
   their `earliestReset` in the summary.
3. **Review each one as it finishes**, using the normal loop, and keep independent work moving while
   the user decides.
4. **Landing still needs the user's accept for every task.** Land without asking only if the user
   says so for this batch (e.g. "land the clean ones"). Even then, land only when the check passes,
   every gate passes, your review finds nothing, and the report lists no unsettled decisions.
   Anything else waits for the user. Never push.
5. **Finish with a summary**: task, score, lanes tried, fix rounds, outcome, and what `stats` now
   says about each lane.
