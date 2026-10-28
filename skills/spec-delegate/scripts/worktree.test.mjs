import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./worktree.mjs", import.meta.url));
const dirs = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function sh(cwd, cmd, args, env = {}) {
  return spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env } });
}

function git(cwd, ...args) {
  const r = sh(cwd, "git", args);
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A repo at <tmp>/repo with one commit; worktrees land in <tmp>/repo-wt. */
function makeRepo({ hooksPath, config, files = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "spec-delegate-"));
  dirs.push(base);
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "test");
  if (hooksPath) git(repo, "config", "core.hooksPath", hooksPath);
  const all = { "src/app.txt": "one\n", ...files };
  if (config) all[".delegate/spec-delegate.json"] = JSON.stringify({ version: "spec-delegate.v1", ...config });
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  return { base, repo, wt: (task) => join(base, "repo-wt", task) };
}

function run(repo, args, env = {}) {
  const r = sh(repo, process.execPath, [SCRIPT, ...args], env);
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
}

function ready(opts) {
  const ctx = makeRepo(opts);
  assert.equal(run(ctx.repo, ["install-hook"]).status, 0);
  return ctx;
}

test("create refuses, and cleans up, when the hook is missing", () => {
  const { repo, wt } = makeRepo();
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /hook is missing/);
  assert.equal(existsSync(wt("t1")), false);
  assert.equal(sh(repo, "git", ["rev-parse", "--verify", "--quiet", "delegate/t1"]).status, 1);
});

test("a hook in the shared git dir reaches worktrees at once", () => {
  const { repo } = makeRepo();
  const r = run(repo, ["install-hook"]);
  assert.equal(r.status, 0);
  assert.equal(r.json.reachesWorktrees, "now");
  assert.equal(run(repo, ["install-hook"]).json.changed, false);
});

test("a hook in a tracked hooks directory reaches worktrees after a commit", () => {
  const { repo } = makeRepo({ hooksPath: ".githooks" });
  assert.equal(run(repo, ["install-hook"]).json.reachesWorktrees, "after-commit");
  assert.equal(run(repo, ["create", "--task", "t1"]).status, 2);
  git(repo, "add", ".githooks");
  git(repo, "commit", "-qm", "hook");
  assert.equal(run(repo, ["install-hook"]).json.reachesWorktrees, "now");
  assert.equal(run(repo, ["create", "--task", "t1"]).status, 0);
});

test("install-hook leaves a hook it did not write alone", () => {
  const { repo } = makeRepo();
  writeFileSync(join(repo, ".git/hooks/reference-transaction"), "#!/bin/sh\nexit 0\n");
  const r = run(repo, ["install-hook"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not written by spec-delegate/);
});

test("create copies ignored snapshot paths, skips tracked ones and runs setup", () => {
  const { repo, wt } = ready({
    config: { snapshot: [".specs", "docs"], setup: ["touch .setup-ran"] },
    files: { ".gitignore": ".specs/\n.setup-ran\n", "docs/guide.md": "tracked\n" },
  });
  mkdirSync(join(repo, ".specs"));
  writeFileSync(join(repo, ".specs/tasks.md"), "- [ ] 1.1\n");
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.snapshot, { copied: [".specs"], skipped: [{ path: "docs", reason: "tracked" }] });
  assert.equal(readFileSync(join(wt("t1"), ".specs/tasks.md"), "utf8"), "- [ ] 1.1\n");
  assert.ok(existsSync(join(wt("t1"), ".setup-ran")));
  assert.equal(r.json.branch, "delegate/t1");
  assert.equal(run(repo, ["check", "--task", "t1"]).json.empty, true);
});

test("create refuses a snapshot path git would see", () => {
  const { repo, wt } = ready({ config: { snapshot: ["notes"] } });
  mkdirSync(join(repo, "notes"));
  writeFileSync(join(repo, "notes/a.md"), "x\n");
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not gitignored/);
  assert.equal(existsSync(wt("t1")), false);
});

test("a failed setup command fails create but keeps the worktree for remove", () => {
  const { repo, wt } = ready({ config: { setup: ["exit 3", "touch never"] } });
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.setup, [{ command: "exit 3", status: 3 }]);
  assert.ok(existsSync(wt("t1")));
  assert.equal(run(repo, ["remove", "--task", "t1"]).status, 0);
});

test("the hook refuses an implementer's commit, even with --no-verify", () => {
  const { repo, wt } = ready();
  run(repo, ["create", "--task", "t1"]);
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");
  const worker = { DELEGATE_WORKER: "1" };
  for (const args of [["commit", "-qam", "x"], ["commit", "-qam", "x", "--no-verify"], ["stash"], ["checkout", "-qb", "other"]]) {
    assert.notEqual(sh(wt("t1"), "git", args, worker).status, 0, `git ${args.join(" ")} should be refused`);
  }
  const c = run(repo, ["check", "--task", "t1"]);
  assert.equal(c.status, 0);
  assert.deepEqual(c.json.changed, ["src/app.txt"]);
});

test("check catches a commit made around the hook", () => {
  const { repo, wt } = ready();
  run(repo, ["create", "--task", "t1"]);
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");
  git(wt("t1"), "commit", "-qam", "sneaky");
  const c = run(repo, ["check", "--task", "t1"]);
  assert.equal(c.status, 1);
  assert.ok(c.json.problems.some((p) => p.startsWith("HEAD moved")));
  assert.ok(c.json.problems.some((p) => p.includes("delegate/t1 moved")));
});

test("check flags files outside --allow and protected files", () => {
  const { repo, wt } = ready({ config: { protected: ["AGENTS.md", ".delegate/"] } });
  run(repo, ["create", "--task", "t1"]);
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");
  writeFileSync(join(wt("t1"), "src/new.txt"), "new\n");
  writeFileSync(join(wt("t1"), "AGENTS.md"), "looser rules\n");
  assert.equal(run(repo, ["check", "--task", "t1", "--allow", "src/"]).status, 1);
  const c = run(repo, ["check", "--task", "t1", "--allow", "src/app.txt"]);
  assert.deepEqual(c.json.changed, ["AGENTS.md", "src/app.txt", "src/new.txt"]);
  assert.ok(c.json.problems.includes("changed files outside --allow: AGENTS.md, src/new.txt"));
  assert.ok(c.json.problems.includes("changed protected files: AGENTS.md"));
});

test("remove keeps unlanded commits unless --force, and cleans up", () => {
  const { repo, wt } = ready();
  run(repo, ["create", "--task", "t1"]);
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");
  git(wt("t1"), "commit", "-qam", "accepted work");
  assert.equal(run(repo, ["remove", "--task", "t1"]).status, 2);
  git(repo, "merge", "-q", "--ff-only", "delegate/t1");
  const r = run(repo, ["remove", "--task", "t1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(wt("t1")), false);
  assert.deepEqual(run(repo, ["list"]).json.worktrees, []);
});

test("implementers may not create or remove worktrees", () => {
  const { repo } = ready();
  const worker = { DELEGATE_WORKER: "1" };
  assert.match(run(repo, ["create", "--task", "t1"], worker).stderr, /implementers may not run `create`/);
  run(repo, ["create", "--task", "t1"]);
  assert.match(run(repo, ["remove", "--task", "t1"], worker).stderr, /implementers may not run `remove`/);
  assert.equal(run(repo, ["check", "--task", "t1"], worker).status, 0);
});

test("bad task ids and config are refused", () => {
  const { repo } = ready({ config: { snapshots: [] } });
  assert.match(run(repo, ["create", "--task", "t1"]).stderr, /unknown keys snapshots/);
  const plain = ready();
  assert.match(run(plain.repo, ["create", "--task", "../x"]).stderr, /--task must match/);
  const flags = ready({ config: { relayFlags: { agy: ["sandbox"] } } });
  assert.match(run(flags.repo, ["create", "--task", "t1"]).stderr, /"relayFlags" must map/);
});
