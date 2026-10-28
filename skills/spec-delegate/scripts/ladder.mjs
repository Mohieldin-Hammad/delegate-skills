#!/usr/bin/env node
/**
 * ladder.mjs — pick a lane by task complexity, and learn from outcomes.
 *
 * Usage:
 *   node ladder.mjs pick --score <1-5>
 *   node ladder.mjs pick --after <lane>
 *   node ladder.mjs record --task <id> --score <1-5> --lane <lane> --outcome <outcome>
 *                          [--rounds <n>] [--project <name>] [--until <time|duration>]
 *   node ladder.mjs clear --lane <lane>
 *   node ladder.mjs status
 *   node ladder.mjs stats
 *   node ladder.mjs --help
 *
 * The ladder (`<config>/delegate-skills/ladder.json`) maps each complexity
 * score to candidate lanes, orders all lanes for escalation, groups lanes by
 * the quota pool they draw on, and sets how long a pool rests after hitting
 * its limit. `pick --score` returns the available candidate whose pool saw
 * the fewest runs in the last five hours; ties go to the earlier candidate.
 * When every candidate is blocked it climbs to the next available lane up,
 * never down, and returns lane null when nothing is left.
 *
 * A lane is blocked when its pool is `limited` (until the reset time) or its
 * implementer and model are `unavailable` (until that lane's model changes,
 * or `clear`). Lanes the ladder names but the fleet lacks are skipped with a
 * warning. `record` appends one line per attempt to
 * `<state>/delegate-skills/ledger.jsonl`; `stats` counts only outcomes that
 * say something about a lane's ability, not quota or crashes.
 *
 * <config> is $XDG_CONFIG_HOME or ~/.config; <state> is $XDG_STATE_HOME or
 * ~/.local/state. Lanes come from the global delegate-fleet.v1 config.
 * Prints JSON. Exit codes: 0 ok, 2 usage or config error. Node built-ins only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const LADDER_VERSION = "spec-delegate-ladder.v1";
const SCORES = ["1", "2", "3", "4", "5"];
// Outcomes that say something about a lane's ability.
const VERDICTS = new Set(["accepted", "declined", "escalated", "blocked"]);
// Runs that broke for reasons outside the task.
const BROKEN = new Set(["failed", "limited", "unavailable"]);
const OUTCOMES = new Set([...VERDICTS, ...BROKEN]);
const POOL_WINDOW_MS = 5 * 60 * 60 * 1000;
const DEFAULT_COOLDOWN = "5h";
const DURATION = /^(\d+)(m|h|d)$/;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

const HELP = `ladder.mjs — pick a lane by task complexity, and learn from outcomes

Usage:
  node ladder.mjs pick --score <1-5>      starting lane for a task of this score
  node ladder.mjs pick --after <lane>     next available lane up after <lane> fell short
  node ladder.mjs record --task <id> --score <1-5> --lane <lane> --outcome <outcome>
                         [--rounds <n>] [--project <name>] [--until <time|duration>]
  node ladder.mjs clear --lane <lane>     lift a limit or unavailable mark early
  node ladder.mjs status                  every lane: ok, limited, unavailable or stale
  node ladder.mjs stats                   acceptance per lane and score

Outcomes: accepted, declined, escalated, blocked (the implementer's work), and
failed, limited, unavailable (the run broke). --until goes with limited: an ISO
time or a duration like 90m, 5h, 2d; without it the pool's cooldown applies.
Files: ${"$"}XDG_CONFIG_HOME/delegate-skills/{ladder,config}.json (default ~/.config),
       ${"$"}XDG_STATE_HOME/delegate-skills/ledger.jsonl (default ~/.local/state).
`;

function fail(message) {
  process.stderr.write(`ladder.mjs: ${message}\n`);
  process.exit(2);
}

const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "delegate-skills");
const ledgerPath = () =>
  join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "delegate-skills", "ledger.jsonl");

export function parseDuration(text) {
  const m = DURATION.exec(String(text));
  return m ? Number(m[1]) * UNIT_MS[m[2]] : null;
}

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}

/** Loads the ladder and the global fleet. Lanes the fleet lacks become `stale`, not errors. */
export function loadLadder() {
  const path = join(configDir(), "ladder.json");
  const ladder = readJson(path, "ladder");
  const fleet = readJson(join(configDir(), "config.json"), "global fleet config (run delegate-setup)");
  const lanes = fleet.lanes ?? {};
  const bad = (msg) => new Error(`${path}: ${msg}`);
  if (ladder.version !== LADDER_VERSION) throw bad(`"version" must be "${LADDER_VERSION}"`);

  const start = ladder.start ?? {};
  for (const score of SCORES) {
    if (!Array.isArray(start[score]) || start[score].length === 0) {
      throw bad(`"start" needs a non-empty list for score ${score}`);
    }
  }
  const escalate = ladder.escalate;
  if (!Array.isArray(escalate) || escalate.length === 0) throw bad(`"escalate" must list lanes, weakest first`);
  for (const score of SCORES) {
    for (const lane of start[score]) {
      if (!escalate.includes(lane)) throw bad(`start.${score} lane "${lane}" is missing from "escalate"`);
    }
  }
  // A lane in no pool is its own pool.
  const poolOf = {};
  for (const [pool, members] of Object.entries(ladder.pools ?? {})) {
    if (!Array.isArray(members)) throw bad(`pools.${pool} must be a list of lanes`);
    for (const lane of members) {
      if (lane in poolOf) throw bad(`lane "${lane}" is in two pools`);
      poolOf[lane] = pool;
    }
  }
  const pool = (lane) => poolOf[lane] ?? lane;
  const referenced = new Set([...escalate, ...SCORES.flatMap((s) => start[s]), ...Object.keys(poolOf)]);
  const poolNames = new Set([...referenced].map(pool));
  const cooldown = ladder.cooldown ?? {};
  for (const [name, value] of Object.entries(cooldown)) {
    if (!poolNames.has(name)) throw bad(`cooldown names "${name}", which is not a pool`);
    if (parseDuration(value) == null) throw bad(`cooldown.${name} must look like 90m, 5h or 2d`);
  }
  return {
    start,
    escalate,
    lanes,
    referenced,
    stale: [...referenced].filter((lane) => !(lane in lanes)),
    pool,
    cooldownMs: (name) => parseDuration(cooldown[name] ?? DEFAULT_COOLDOWN),
  };
}

function readLedger() {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const modelKey = (implementer, model) => `${implementer}\u0000${model ?? null}`;

/**
 * Replays the ledger in order. A `limited` entry blocks its pool until its
 * `until`; an `unavailable` entry blocks that implementer and model until a
 * later entry for the same pair says otherwise. `cleared` lifts both.
 */
function laneStates(ladder, entries, now) {
  const poolUntil = {};
  const lastByModel = {};
  for (const e of entries) {
    const known = e.lane in ladder.lanes;
    if (e.outcome === "cleared") {
      if (known) delete poolUntil[ladder.pool(e.lane)];
      lastByModel[modelKey(e.implementer, e.model)] = "cleared";
    } else if (e.outcome === "limited") {
      if (known) {
        const p = ladder.pool(e.lane);
        poolUntil[p] = Math.max(poolUntil[p] ?? 0, Date.parse(e.until));
      }
    } else if (e.outcome === "unavailable" || VERDICTS.has(e.outcome)) {
      lastByModel[modelKey(e.implementer, e.model)] = e.outcome;
    }
  }
  return (lane) => {
    if (!(lane in ladder.lanes)) return { state: "stale" };
    const { implementer, model } = ladder.lanes[lane];
    if (lastByModel[modelKey(implementer, model)] === "unavailable") return { state: "unavailable" };
    const until = poolUntil[ladder.pool(lane)];
    if (until > now) return { state: "limited", until: new Date(until).toISOString() };
    return { state: "ok" };
  };
}

function describe(ladder, lane) {
  if (!(lane in ladder.lanes)) return { lane, implementer: null, model: null, pool: ladder.pool(lane) };
  const { implementer, model } = ladder.lanes[lane];
  return { lane, implementer, model: model ?? null, pool: ladder.pool(lane) };
}

const staleWarnings = (ladder) =>
  ladder.stale.map((lane) => `lane "${lane}" is in the ladder but not in the fleet; skipping it`);

export function pick({ score, after }, now = Date.now()) {
  const ladder = loadLadder();
  const entries = readLedger();
  const stateOf = laneStates(ladder, entries, now);
  const warnings = staleWarnings(ladder);
  const view = (lane) => ({ ...describe(ladder, lane), ...stateOf(lane) });

  // Walks up the escalation order from index `from`, never down.
  const climb = (from) => {
    const skipped = [];
    for (const lane of ladder.escalate.slice(from + 1)) {
      if (stateOf(lane).state === "ok") return { lane, skipped };
      skipped.push(view(lane));
    }
    return { lane: null, skipped };
  };
  const nothing = (reason, blocked) => {
    const resets = blocked.map((b) => b.until).filter(Boolean).sort();
    return {
      ok: true,
      lane: null,
      reason,
      ...(resets.length ? { earliestReset: resets[0] } : {}),
      blocked,
      warnings,
    };
  };

  if (after != null) {
    const at = ladder.escalate.indexOf(after);
    if (at === -1) throw new Error(`lane "${after}" is not in the ladder's "escalate" list`);
    const { lane, skipped } = climb(at);
    if (!lane) {
      return nothing(
        skipped.length
          ? `every lane above "${after}" is limited, unavailable or stale`
          : `"${after}" is the top of the ladder: keep the task yourself`,
        skipped,
      );
    }
    return {
      ok: true,
      ...describe(ladder, lane),
      reason: `next ${skipped.length ? "available " : ""}lane up after "${after}"`,
      ...(skipped.length ? { skipped } : {}),
      warnings,
    };
  }

  if (!SCORES.includes(String(score))) throw new Error("--score must be 1, 2, 3, 4 or 5");
  // Only runs that reached a working model spent quota; limit and
  // unavailable marks are states, not usage.
  const recent = {};
  for (const e of entries) {
    if (!(VERDICTS.has(e.outcome) || e.outcome === "failed") || !(e.lane in ladder.lanes)) continue;
    if (now - Date.parse(e.time) > POOL_WINDOW_MS) continue;
    const p = ladder.pool(e.lane);
    recent[p] = (recent[p] ?? 0) + 1;
  }
  const names = ladder.start[String(score)];
  const candidates = names.map((lane) => ({ ...view(lane), recentRuns: recent[ladder.pool(lane)] ?? 0 }));
  const open = candidates.filter((c) => c.state === "ok");
  if (open.length) {
    const best = open.reduce((a, b) => (b.recentRuns < a.recentRuns ? b : a));
    let reason = `fewest runs in the last 5h on its pool (${best.pool}: ${best.recentRuns})`;
    if (candidates.length === 1) reason = `only candidate for score ${score}`;
    else if (open.length === 1) reason = `the only available candidate for score ${score}`;
    return { ok: true, ...describe(ladder, best.lane), reason, candidates, warnings };
  }

  // Every candidate is blocked: climb from the strongest of them.
  const anchor = Math.max(...names.map((lane) => ladder.escalate.indexOf(lane)));
  const { lane, skipped } = climb(anchor);
  if (!lane) {
    return nothing(
      `no lane is available for score ${score}: wait, use a weaker lane, or keep the task yourself`,
      [...candidates, ...skipped],
    );
  }
  return {
    ok: true,
    ...describe(ladder, lane),
    reason: `every candidate for score ${score} is limited, unavailable or stale; next available lane up`,
    fallback: true,
    candidates,
    ...(skipped.length ? { skipped } : {}),
    warnings,
  };
}

function resolveUntil(until, now, fallbackMs) {
  if (until == null) return new Date(now.getTime() + fallbackMs);
  const ms = parseDuration(until);
  if (ms != null) return new Date(now.getTime() + ms);
  const at = Date.parse(until);
  if (Number.isNaN(at)) throw new Error("--until must be an ISO time or a duration like 90m, 5h or 2d");
  return new Date(at);
}

export function record({ task, score, lane, outcome, rounds = "0", project, until }, now = new Date()) {
  const ladder = loadLadder();
  if (!task) throw new Error("--task is required");
  if (!SCORES.includes(String(score))) throw new Error("--score must be 1, 2, 3, 4 or 5");
  if (!(lane in ladder.lanes)) throw new Error(`unknown lane "${lane}"`);
  if (!OUTCOMES.has(outcome)) throw new Error(`--outcome must be one of ${[...OUTCOMES].join(", ")}`);
  if (until != null && outcome !== "limited") throw new Error("--until goes only with --outcome limited");
  const n = Number(rounds);
  if (!Number.isInteger(n) || n < 0) throw new Error("--rounds must be a whole number");
  const { implementer, model } = ladder.lanes[lane];
  const entry = {
    time: now.toISOString(),
    project: project ?? null,
    task,
    score: Number(score),
    lane,
    implementer,
    model: model ?? null,
    outcome,
    rounds: n,
  };
  if (outcome === "limited") {
    entry.until = resolveUntil(until, now, ladder.cooldownMs(ladder.pool(lane))).toISOString();
  }
  append(entry);
  return { ok: true, recorded: entry };
}

export function clear({ lane }, now = new Date()) {
  const ladder = loadLadder();
  if (!(lane in ladder.lanes)) throw new Error(`unknown lane "${lane}"`);
  const { implementer, model } = ladder.lanes[lane];
  const entry = { time: now.toISOString(), lane, implementer, model: model ?? null, outcome: "cleared" };
  append(entry);
  return { ok: true, cleared: lane, pool: ladder.pool(lane) };
}

function append(entry) {
  mkdirSync(dirname(ledgerPath()), { recursive: true });
  appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`);
}

export function status(now = Date.now()) {
  const ladder = loadLadder();
  const stateOf = laneStates(ladder, readLedger(), now);
  const names = [...new Set([...Object.keys(ladder.lanes), ...ladder.referenced])];
  const warnings = staleWarnings(ladder);
  const lanes = names.map((lane) => {
    const inLadder = ladder.referenced.has(lane);
    if (!inLadder) warnings.push(`lane "${lane}" is not in the ladder, so pick never chooses it`);
    return { ...describe(ladder, lane), ...stateOf(lane), inLadder };
  });
  return { ok: true, lanes, warnings };
}

export function stats() {
  const lanes = {};
  for (const e of readLedger()) {
    if (!VERDICTS.has(e.outcome) && !BROKEN.has(e.outcome)) continue;
    const s = (lanes[e.lane] ??= { runs: 0, accepted: 0, rounds: 0, broken: 0, byScore: {} });
    if (BROKEN.has(e.outcome)) {
      s.broken += 1;
      continue;
    }
    const b = (s.byScore[e.score] ??= { runs: 0, accepted: 0 });
    s.runs += 1;
    b.runs += 1;
    s.rounds += e.rounds;
    if (e.outcome === "accepted") {
      s.accepted += 1;
      b.accepted += 1;
    }
  }
  const out = {};
  for (const [lane, s] of Object.entries(lanes)) {
    out[lane] = {
      runs: s.runs,
      accepted: s.accepted,
      acceptRate: s.runs ? Math.round((s.accepted / s.runs) * 100) / 100 : null,
      avgRounds: s.runs ? Math.round((s.rounds / s.runs) * 10) / 10 : null,
      broken: s.broken,
      byScore: s.byScore,
    };
  }
  return { ok: true, ledger: ledgerPath(), lanes: out };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        score: { type: "string" },
        after: { type: "string" },
        task: { type: "string" },
        lane: { type: "string" },
        outcome: { type: "string" },
        rounds: { type: "string" },
        project: { type: "string" },
        until: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return;
  }
  let result;
  try {
    switch (positionals[0]) {
      case "pick":
        if ((values.score == null) === (values.after == null)) throw new Error("pick needs --score or --after");
        result = pick(values);
        break;
      case "record":
        result = record(values);
        break;
      case "clear":
        if (!values.lane) throw new Error("clear needs --lane");
        result = clear(values);
        break;
      case "status":
        result = status();
        break;
      case "stats":
        result = stats();
        break;
      default:
        throw new Error(`unknown command ${positionals[0]}; see --help`);
    }
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
