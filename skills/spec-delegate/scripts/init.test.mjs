import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./init.mjs", import.meta.url));
const dirs = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const TASKS = { ".spec-workflow/specs/demo/tasks.md": "- [ ] 1. demo\n" };

/** A committed repo at <tmp>/repo holding `files`; `untracked` stay uncommitted. */
function makeRepo(files = {}, { hooksPath, untracked = TASKS } = {}) {
  const base = mkdtempSync(join(tmpdir(), "spec-delegate-init-"));
  dirs.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  if (hooksPath) git(repo, "config", "core.hooksPath", hooksPath);
  const put = (all) => {
    for (const [path, text] of Object.entries(all)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
  };
  put({ "README.md": "demo\n", ...files });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  put(untracked);
  return repo;
}

function init(repo, ...args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repo, encoding: "utf8" });
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
}

const CONFIG = '{ "version": "spec-delegate.v1", "gates": ["true"] }\n';
const IGNORED = { ".gitignore": ".spec-workflow/\n" };

test("a project without .spec-workflow/ is refused, pointing to the plain delegate skills", () => {
  const repo = makeRepo({}, { untracked: {} });
  for (const args of [[], ["--write"], ["--verify"]]) {
    const r = init(repo, ...args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no \.spec-workflow\/ .*spec-workflow MCP first, or use a plain \*-delegate skill/);
  }
});

test("a fresh project reports what is missing, and --verify needs the config", () => {
  const { json } = init(makeRepo(IGNORED, { untracked: { ".spec-workflow/steering/x.md": "x\n" } }));
  assert.equal(json.configFile, "missing");
  assert.equal(json.specWorkflow, "ignored");
  assert.ok(json.notes.some((n) => n.startsWith("No .spec-workflow/delegate.json yet")));
  assert.ok(json.notes.some((n) => n.startsWith("No spec with a tasks.md")));
  const r = init(makeRepo(IGNORED), "--verify");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no \.spec-workflow\/delegate\.json: write it first/);
});

test("a set-up project reports no notes", () => {
  const repo = makeRepo(IGNORED, { untracked: { ...TASKS, ".spec-workflow/delegate.json": CONFIG } });
  const { json } = init(repo);
  assert.equal(json.configFile, "exists");
  assert.deepEqual(json.notes, []);
});

test("--write gitignores .spec-workflow/ once, and only when git would see it", () => {
  const repo = makeRepo({ ".gitignore": ".venv/" });
  assert.equal(init(repo).json.specWorkflow, "untracked");
  const first = init(repo, "--write");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json.write.written, [".gitignore"]);
  assert.equal(first.json.specWorkflow, "ignored");
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".venv/\n.spec-workflow/\n");
  assert.deepEqual(init(repo, "--write").json.write.written, []);

  const tracked = makeRepo(TASKS, { untracked: {} });
  assert.equal(init(tracked).json.specWorkflow, "tracked");
  assert.deepEqual(init(tracked, "--write").json.write.written, [], "a committed spec folder stays as it is");
});

test("the project's hooks directory in the working tree must be in protected", () => {
  const configured = { ...TASKS, ".spec-workflow/delegate.json": CONFIG };
  const bare = init(makeRepo(IGNORED, { hooksPath: ".githooks", untracked: configured })).json;
  assert.equal(bare.hooksDir, ".githooks/");
  assert.ok(bare.notes.includes('Add ".githooks/" to "protected": the project keeps its hooks there.'));
  const ok = { ...TASKS, ".spec-workflow/delegate.json": '{ "version": "spec-delegate.v1", "protected": [".githooks/"] }' };
  const done = init(makeRepo(IGNORED, { hooksPath: ".githooks", untracked: ok })).json;
  assert.deepEqual(done.notes, []);
  assert.equal(init(makeRepo(IGNORED)).json.hooksDir, null, "the default hooks dir is in .git, not the tree");
});

test("--verify runs setup and every gate in a throwaway worktree", () => {
  const config = {
    version: "spec-delegate.v1",
    setup: ["mkdir -p .venv && touch .venv/ok"],
    gates: ["test -f .venv/ok", "false", "true"],
  };
  const repo = makeRepo(
    { ".gitignore": ".venv/\n.spec-workflow/\n" },
    { untracked: { ...TASKS, ".spec-workflow/delegate.json": JSON.stringify(config) } },
  );
  const r = init(repo, "--verify", "--write");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.verify.gates.map((g) => g.status), [0, 1, 0]);
  assert.deepEqual(r.json.verify.problems, ["gates fail on the base commit: false"]);
  assert.equal(r.json.write, undefined, "nothing is written when verification fails");
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "the probe worktree is gone");
});

test("--verify fails when setup leaves files git can see", () => {
  const config = { version: "spec-delegate.v1", setup: ["mkdir -p node_modules && touch node_modules/x"] };
  const repo = makeRepo(IGNORED, { untracked: { ...TASKS, ".spec-workflow/delegate.json": JSON.stringify(config) } });
  const r = init(repo, "--verify");
  assert.equal(r.status, 1);
  assert.match(r.json.verify.problems[0], /setup leaves files git can see; gitignore them: node_modules\/x/);
});
