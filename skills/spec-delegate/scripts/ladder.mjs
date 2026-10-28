#!/usr/bin/env node
/**
 * ladder.mjs — pick a lane by task complexity, and learn from outcomes.
 *
 * Usage:
 *   node ladder.mjs pick --score <1-5>
 *   node ladder.mjs pick --after <lane>
 *   node ladder.mjs record --task <id> --score <1-5> --lane <lane> --outcome <outcome>
 *                          [--rounds <n>] [--project <name>]
 *   node ladder.mjs stats
 *   node ladder.mjs --help
 *
 * The ladder (`<config>/delegate-skills/ladder.json`) maps each complexity
 * score to candidate lanes, orders all lanes for escalation, and groups lanes
 * by the quota pool they draw on. `pick --score` returns the candidate whose
 * pool saw the fewest runs in the last five hours, so work spreads across
 * quotas; ties go to the earlier candidate. `pick --after` returns the next
 * lane up the escalation order, or null at the top.
 *
 * `record` appends one line per attempt to `<state>/delegate-skills/ledger.jsonl`;
 * `stats` summarizes acceptance per lane and score, which is what the
 * orchestrator calibrates its starting rung against.
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
const OUTCOMES = new Set(["accepted", "declined", "escalated", "blocked", "failed"]);
const POOL_WINDOW_MS = 5 * 60 * 60 * 1000;

const HELP = `ladder.mjs — pick a lane by task complexity, and learn from outcomes

Usage:
  node ladder.mjs pick --score <1-5>      starting lane for a task of this score
  node ladder.mjs pick --after <lane>     next lane up after <lane> fell short
  node ladder.mjs record --task <id> --score <1-5> --lane <lane> --outcome <outcome>
                         [--rounds <n>] [--project <name>]
  node ladder.mjs stats                   acceptance per lane and score

Outcomes: accepted, declined, escalated, blocked, failed.
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

function readJson(path, what) {
  if (!existsSync(path)) throw new Error(`no ${what} at ${path}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: ${err.message}`);
  }
}

/** Loads the ladder and the global fleet, and checks they agree. */
export function loadLadder() {
  const path = join(configDir(), "ladder.json");
  const ladder = readJson(path, "ladder");
  const fleet = readJson(join(configDir(), "config.json"), "global fleet config (run delegate-setup)");
  const lanes = fleet.lanes ?? {};
  const bad = (msg) => new Error(`${path}: ${msg}`);
  if (ladder.version !== LADDER_VERSION) throw bad(`"version" must be "${LADDER_VERSION}"`);

  const known = (lane, where) => {
    if (!(lane in lanes)) throw bad(`${where} names lane "${lane}", which the fleet does not have`);
  };
  const start = ladder.start ?? {};
  for (const score of SCORES) {
    const list = start[score];
    if (!Array.isArray(list) || list.length === 0) throw bad(`"start" needs a non-empty list for score ${score}`);
    list.forEach((lane) => known(lane, `start.${score}`));
  }
  const escalate = ladder.escalate;
  if (!Array.isArray(escalate) || escalate.length === 0) throw bad(`"escalate" must list lanes, weakest first`);
  escalate.forEach((lane) => known(lane, "escalate"));
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
      known(lane, `pools.${pool}`);
      if (lane in poolOf) throw bad(`lane "${lane}" is in two pools`);
      poolOf[lane] = pool;
    }
  }
  return { start, escalate, lanes, pool: (lane) => poolOf[lane] ?? lane };
}

function readLedger() {
  const path = ledgerPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function describe(ladder, lane) {
  const { implementer, model } = ladder.lanes[lane];
  return { lane, implementer, model: model ?? null, pool: ladder.pool(lane) };
}

export function pick({ score, after }, now = Date.now()) {
  const ladder = loadLadder();
  if (after != null) {
    const at = ladder.escalate.indexOf(after);
    if (at === -1) throw new Error(`lane "${after}" is not in the ladder's "escalate" list`);
    const next = ladder.escalate[at + 1];
    if (!next) return { ok: true, lane: null, reason: `"${after}" is the top of the ladder: keep the task yourself` };
    return { ok: true, ...describe(ladder, next), reason: `next lane up after "${after}"` };
  }
  if (!SCORES.includes(String(score))) throw new Error("--score must be 1, 2, 3, 4 or 5");
  const recent = {};
  for (const entry of readLedger()) {
    if (now - Date.parse(entry.time) > POOL_WINDOW_MS || !(entry.lane in ladder.lanes)) continue;
    const pool = ladder.pool(entry.lane);
    recent[pool] = (recent[pool] ?? 0) + 1;
  }
  const candidates = ladder.start[String(score)].map((lane) => ({
    ...describe(ladder, lane),
    recentRuns: recent[ladder.pool(lane)] ?? 0,
  }));
  const best = candidates.reduce((a, b) => (b.recentRuns < a.recentRuns ? b : a));
  const reason =
    candidates.length === 1
      ? `only candidate for score ${score}`
      : `fewest runs in the last 5h on its pool (${best.pool}: ${best.recentRuns})`;
  return { ok: true, ...describe(ladder, best.lane), reason, candidates };
}

export function record({ task, score, lane, outcome, rounds = "0", project }, now = new Date()) {
  const ladder = loadLadder();
  if (!task) throw new Error("--task is required");
  if (!SCORES.includes(String(score))) throw new Error("--score must be 1, 2, 3, 4 or 5");
  if (!(lane in ladder.lanes)) throw new Error(`unknown lane "${lane}"`);
  if (!OUTCOMES.has(outcome)) throw new Error(`--outcome must be one of ${[...OUTCOMES].join(", ")}`);
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
  mkdirSync(dirname(ledgerPath()), { recursive: true });
  appendFileSync(ledgerPath(), `${JSON.stringify(entry)}\n`);
  return { ok: true, recorded: entry };
}

export function stats() {
  const lanes = {};
  for (const e of readLedger()) {
    const s = (lanes[e.lane] ??= { runs: 0, accepted: 0, rounds: 0, byScore: {} });
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
      acceptRate: Math.round((s.accepted / s.runs) * 100) / 100,
      avgRounds: Math.round((s.rounds / s.runs) * 10) / 10,
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
