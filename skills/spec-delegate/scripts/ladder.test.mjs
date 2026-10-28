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
  if (fleet) writeFileSync(join(env.XDG_CONFIG_HOME, "delegate-skills/config.json"), JSON.stringify(fleet));
  if (ladder) writeFileSync(join(env.XDG_CONFIG_HOME, "delegate-skills/ladder.json"), JSON.stringify(ladder));
  return (...args) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
    return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
  };
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
    byScore: { 1: { runs: 1, accepted: 1 }, 2: { runs: 1, accepted: 0 } },
  });
  assert.equal(lanes.impl.avgRounds, 2);
});

test("a ladder that disagrees with the fleet is refused", () => {
  const missingScore = setup({ ladder: { ...LADDER, start: { ...LADDER.start, 5: [] } } });
  assert.match(missingScore("pick", "--score", "1").stderr, /non-empty list for score 5/);
  const ghost = setup({ ladder: { ...LADDER, start: { ...LADDER.start, 4: ["ghost"] } } });
  assert.match(ghost("pick", "--score", "1").stderr, /names lane "ghost", which the fleet does not have/);
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
