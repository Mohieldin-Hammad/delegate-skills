import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./ladder.mjs", import.meta.url));
const dirs = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const FLEET = {
  version: "delegate-fleet.v1",
  lanes: {
    cheap: { implementer: "cursor", model: "small" },
    tests: { implementer: "agy", model: "flash" },
    impl: { implementer: "cursor", model: "big" },
    hard: { implementer: "agy", model: "pro" },
  },
};

const LADDER = {
  version: "spec-delegate-ladder.v1",
  start: { 1: ["cheap", "tests"], 2: ["cheap", "tests"], 3: ["impl", "tests"], 4: ["impl"], 5: ["hard"] },
  escalate: ["cheap", "tests", "impl", "hard"],
  pools: { cursor: ["cheap", "impl"], gemini: ["tests", "hard"] },
};

/** Fresh XDG config and state dirs holding `fleet` and `ladder`. */
function setup({ fleet = FLEET, ladder = LADDER } = {}) {
  const base = mkdtempSync(join(tmpdir(), "spec-delegate-ladder-"));
  dirs.push(base);
  const env = { XDG_CONFIG_HOME: join(base, "config"), XDG_STATE_HOME: join(base, "state") };
  mkdirSync(join(env.XDG_CONFIG_HOME, "delegate-skills"), { recursive: true });
  const writeFleet = (doc) =>
    writeFileSync(join(env.XDG_CONFIG_HOME, "delegate-skills/config.json"), JSON.stringify(doc));
  if (fleet) writeFleet(fleet);
  if (ladder) writeFileSync(join(env.XDG_CONFIG_HOME, "delegate-skills/ladder.json"), JSON.stringify(ladder));
  const run = (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
  run.writeFleet = writeFleet;
  return run;
}

const record = (run, lane, outcome = "accepted", score = "2") =>
  run("record", "--task", `t-${lane}`, "--score", score, "--lane", lane, "--outcome", outcome);

test("pick prefers the first candidate when pools are equally fresh", () => {
  const run = setup();
  const r = run("pick", "--score", "2");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.lane, "cheap");
  assert.equal(r.json.implementer, "cursor");
  assert.equal(r.json.model, "small");
});

test("pick spreads work to the candidate on the less-used pool", () => {
  const run = setup();
  record(run, "impl");
  const r = run("pick", "--score", "2");
  assert.equal(r.json.lane, "tests", "cheap shares the cursor pool with impl, which just ran");
  assert.deepEqual(r.json.candidates.map((c) => [c.lane, c.recentRuns]), [["cheap", 1], ["tests", 0]]);
});

test("pick --after climbs the escalation order and stops at the top", () => {
  const run = setup();
  assert.equal(run("pick", "--after", "tests").json.lane, "impl");
  const top = run("pick", "--after", "hard").json;
  assert.equal(top.lane, null);
  assert.match(top.reason, /top of the ladder/);
  assert.match(run("pick", "--after", "nope").stderr, /not in the ladder/);
});

test("record validates its fields and stats sums them per lane and score", () => {
  const run = setup();
  record(run, "cheap", "accepted", "1");
  record(run, "cheap", "escalated", "2");
  run("record", "--task", "t", "--score", "3", "--lane", "impl", "--outcome", "accepted", "--rounds", "2");
  assert.match(record(run, "cheap", "great").stderr, /--outcome must be one of/);
  assert.match(record(run, "ghost").stderr, /unknown lane "ghost"/);
  const { lanes } = run("stats").json;
  assert.deepEqual(lanes.cheap, {
    runs: 2,
    accepted: 1,
    acceptRate: 0.5,
    avgRounds: 0,
    broken: 0,
    byScore: { 1: { runs: 1, accepted: 1 }, 2: { runs: 1, accepted: 0 } },
  });
  assert.equal(lanes.impl.avgRounds, 2);
});

test("a malformed ladder is refused", () => {
  const missingScore = setup({ ladder: { ...LADDER, start: { ...LADDER.start, 5: [] } } });
  assert.match(missingScore("pick", "--score", "1").stderr, /non-empty list for score 5/);
  const badCooldown = setup({ ladder: { ...LADDER, cooldown: { cursor: "soon" } } });
  assert.match(badCooldown("pick", "--score", "1").stderr, /cooldown.cursor must look like/);
  const ghostPool = setup({ ladder: { ...LADDER, cooldown: { nopool: "1h" } } });
  assert.match(ghostPool("pick", "--score", "1").stderr, /cooldown names "nopool", which is not a pool/);
  const unordered = setup({ ladder: { ...LADDER, escalate: ["cheap", "tests", "hard"] } });
  assert.match(unordered("pick", "--score", "1").stderr, /lane "impl" is missing from "escalate"/);
  const noFleet = setup({ fleet: null });
  assert.match(noFleet("pick", "--score", "1").stderr, /no global fleet config/);
});

test("pick needs exactly one of --score and --after", () => {
  const run = setup();
  assert.match(run("pick").stderr, /needs --score or --after/);
  assert.match(run("pick", "--score", "9").stderr, /--score must be 1, 2, 3, 4 or 5/);
});

const ISO_PAST = "2000-01-01T00:00:00.000Z";

test("a lane removed from the fleet is skipped with a warning, not an error", () => {
  const fleet = { ...FLEET, lanes: { ...FLEET.lanes } };
  delete fleet.lanes.cheap;
  const run = setup({ fleet });
  const r = run("pick", "--score", "1");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.lane, "tests");
  assert.deepEqual(r.json.warnings, ['lane "cheap" is in the ladder but not in the fleet; skipping it']);
  assert.equal(run("pick", "--after", "cheap").json.lane, "tests", "a stale lane still anchors --after");
});

test("a limited pool is skipped until it resets, then comes back", () => {
  const run = setup({ ladder: { ...LADDER, cooldown: { cursor: "2h" } } });
  const r = run("record", "--task", "t", "--score", "2", "--lane", "impl", "--outcome", "limited");
  const until = Date.parse(r.json.recorded.until) - Date.now();
  assert.ok(until > 115 * 60_000 && until <= 120 * 60_000, "the pool's cooldown sets the reset");
  const p = run("pick", "--score", "2").json;
  assert.equal(p.lane, "tests", "cheap shares the limited cursor pool");
  assert.equal(p.reason, "the only available candidate for score 2");
  assert.equal(p.candidates[0].state, "limited");
  const expired = setup();
  expired("record", "--task", "t", "--score", "2", "--lane", "cheap", "--outcome", "limited", "--until", ISO_PAST);
  assert.equal(expired("pick", "--score", "4").json.lane, "impl");
});

test("when every candidate is blocked, pick climbs up, never down", () => {
  const run = setup();
  run("record", "--task", "t", "--score", "4", "--lane", "impl", "--outcome", "limited", "--until", "3h");
  const r = run("pick", "--score", "4").json;
  assert.equal(r.lane, "hard");
  assert.equal(r.fallback, true);
  assert.match(r.reason, /every candidate for score 4 is limited/);
});

test("with nothing left, pick returns null and the earliest reset", () => {
  const run = setup();
  run("record", "--task", "t", "--score", "5", "--lane", "hard", "--outcome", "limited", "--until", "2099-01-01T00:00:00Z");
  const r = run("pick", "--score", "5").json;
  assert.equal(r.lane, null);
  assert.equal(r.earliestReset, "2099-01-01T00:00:00.000Z");
  assert.match(r.reason, /wait, use a weaker lane, or keep the task yourself/);
  assert.deepEqual(run("pick", "--after", "impl").json.blocked.map((b) => b.lane), ["hard"]);
});

test("unavailable sticks to the model, so changing the lane's model brings it back", () => {
  const run = setup();
  run("record", "--task", "t", "--score", "1", "--lane", "cheap", "--outcome", "unavailable");
  assert.equal(run("pick", "--score", "1").json.lane, "tests");
  const after = run("pick", "--after", "cheap").json;
  assert.equal(after.lane, "tests");
  run.writeFleet({ ...FLEET, lanes: { ...FLEET.lanes, cheap: { implementer: "cursor", model: "small-v2" } } });
  assert.equal(run("pick", "--score", "1").json.lane, "cheap");
});

test("clear lifts a limit and an unavailable mark early", () => {
  const run = setup();
  run("record", "--task", "t", "--score", "1", "--lane", "cheap", "--outcome", "limited", "--until", "1d");
  run("record", "--task", "t", "--score", "1", "--lane", "tests", "--outcome", "unavailable");
  assert.equal(run("pick", "--score", "1").json.lane, "hard", "impl shares the limited cursor pool");
  run("clear", "--lane", "cheap");
  run("clear", "--lane", "tests");
  assert.equal(run("pick", "--score", "1").json.lane, "cheap");
});

test("status shows every lane's state and lanes the ladder never uses", () => {
  const fleet = { ...FLEET, lanes: { ...FLEET.lanes, spare: { implementer: "agy", model: "x" } } };
  const run = setup({ fleet });
  run("record", "--task", "t", "--score", "1", "--lane", "tests", "--outcome", "limited", "--until", "1h");
  const r = run("status").json;
  const state = Object.fromEntries(r.lanes.map((l) => [l.lane, l.state]));
  assert.deepEqual(state, { cheap: "ok", tests: "limited", impl: "ok", hard: "limited", spare: "ok" });
  assert.ok(r.warnings.includes('lane "spare" is not in the ladder, so pick never chooses it'));
});

test("stats leaves broken runs out of acceptance", () => {
  const run = setup();
  record(run, "cheap", "accepted");
  record(run, "cheap", "failed");
  run("record", "--task", "t", "--score", "2", "--lane", "cheap", "--outcome", "limited");
  const cheap = run("stats").json.lanes.cheap;
  assert.equal(cheap.runs, 1);
  assert.equal(cheap.acceptRate, 1);
  assert.equal(cheap.broken, 2);
});

test("--until goes only with limited, and must parse", () => {
  const run = setup();
  const base = ["record", "--task", "t", "--score", "1", "--lane", "cheap"];
  assert.match(run(...base, "--outcome", "failed", "--until", "1h").stderr, /--until goes only with --outcome limited/);
  assert.match(run(...base, "--outcome", "limited", "--until", "later").stderr, /--until must be an ISO time/);
});
