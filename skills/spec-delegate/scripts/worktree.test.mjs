import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * A repo at <tmp>/repo with one commit and a gitignored .spec-workflow/ that
 * holds the config; worktrees land in <tmp>/repo-wt.
 */
function makeRepo({ hooksPath, config, files = {}, specs = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "spec-delegate-"));
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
  put({ ".gitignore": ".spec-workflow/\n", "src/app.txt": "one\n", ...files });
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  if (specs) {
    put({
      ".spec-workflow/specs/demo/tasks.md": "- [ ] 1. demo\n",
      ".spec-workflow/delegate.json": JSON.stringify({ version: "spec-delegate.v1", ...config }),
    });
  }
  return { base, repo, wt: (task) => join(base, "repo-wt", task) };
}

function run(repo, args, env = {}) {
  const r = sh(repo, process.execPath, [SCRIPT, ...args], env);
  return { status: r.status, stderr: r.stderr, json: r.stdout ? JSON.parse(r.stdout) : null };
}

/** A repo with worktree t1 already created. */
function withTask(opts) {
  const ctx = makeRepo(opts);
  const r = run(ctx.repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 0, r.stderr);
  return ctx;
}

const guard = (repo) => join(repo, ".git/spec-delegate/hooks");

test("create refuses a project without .spec-workflow/", () => {
  const { repo, wt } = makeRepo({ specs: false });
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no \.spec-workflow\/ in .*create a spec .* or use a plain \*-delegate skill/);
  assert.equal(existsSync(wt("t1")), false);
});

test("create guards only the new worktree and leaves the project untouched", () => {
  const { repo, wt } = withTask({ hooksPath: ".githooks" });
  assert.equal(git(wt("t1"), "config", "core.hooksPath"), guard(repo));
  assert.equal(git(repo, "config", "core.hooksPath"), ".githooks", "the main checkout keeps its hooks");
  assert.equal(git(repo, "status", "--porcelain"), "", "nothing for git to see in the project");
  assert.ok(existsSync(join(guard(repo), "reference-transaction")));
});

test("the guard refuses ref changes, with or without DELEGATE_WORKER, even with --no-verify", () => {
  const { wt } = withTask();
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");
  const attempts = [["commit", "-qam", "x"], ["commit", "-qam", "x", "--no-verify"], ["stash"], ["checkout", "-qb", "other"]];
  for (const env of [{ DELEGATE_WORKER: "1" }, {}]) {
    for (const args of attempts) {
      const r = sh(wt("t1"), "git", args, env);
      assert.notEqual(r.status, 0, `git ${args.join(" ")} should be refused (${JSON.stringify(env)})`);
    }
  }
  assert.equal(readFileSync(join(wt("t1"), "src/app.txt"), "utf8"), "two\n");
});

test("commit lands the work with the project's own hooks, and rebase follows a moved branch", () => {
  const preCommit = '#!/bin/sh\necho ran >> "$(git rev-parse --git-common-dir)/pre-commit-ran"\n';
  const { repo, wt } = makeRepo({ hooksPath: ".githooks", files: { ".githooks/pre-commit": preCommit } });
  chmodSync(join(repo, ".githooks/pre-commit"), 0o755);
  git(repo, "commit", "-qam", "executable hook");
  assert.equal(run(repo, ["create", "--task", "t1"]).status, 0);
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");

  const c = run(repo, ["commit", "--task", "t1", "--message", "accepted work"]);
  assert.equal(c.status, 0, c.stderr);
  assert.equal(git(wt("t1"), "log", "-1", "--format=%s"), "accepted work");
  assert.ok(existsSync(join(repo, ".git/pre-commit-ran")), "the project's pre-commit ran");

  writeFileSync(join(repo, "other.txt"), "main moved\n");
  git(repo, "add", "other.txt");
  git(repo, "commit", "-qm", "main moved");
  const rb = run(repo, ["rebase", "--task", "t1", "--onto", "main"]);
  assert.equal(rb.status, 0, rb.stderr);
  git(repo, "merge", "-q", "--ff-only", "delegate/t1");
  assert.equal(run(repo, ["remove", "--task", "t1"]).status, 0);
  assert.equal(readFileSync(join(repo, "src/app.txt"), "utf8"), "two\n");
});

test("commit needs a message", () => {
  const { repo } = withTask();
  assert.match(run(repo, ["commit", "--task", "t1"]).stderr, /commit needs --message/);
});

test("create copies ignored snapshot paths, skips tracked ones and runs setup", () => {
  const { repo, wt } = makeRepo({
    config: { snapshot: [".spec-workflow/specs", "docs"], setup: ["touch .setup-ran"] },
    files: { ".gitignore": ".spec-workflow/\n.setup-ran\n", "docs/guide.md": "tracked\n" },
  });
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.snapshot, {
    copied: [".spec-workflow/specs"],
    skipped: [{ path: "docs", reason: "tracked" }],
  });
  assert.equal(readFileSync(join(wt("t1"), ".spec-workflow/specs/demo/tasks.md"), "utf8"), "- [ ] 1. demo\n");
  assert.ok(existsSync(join(wt("t1"), ".setup-ran")));
  assert.equal(r.json.branch, "delegate/t1");
  assert.equal(run(repo, ["check", "--task", "t1"]).json.empty, true);
});

test("create refuses a snapshot path git would see", () => {
  const { repo, wt } = makeRepo({ config: { snapshot: ["notes"] } });
  mkdirSync(join(repo, "notes"));
  writeFileSync(join(repo, "notes/a.md"), "x\n");
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not gitignored/);
  assert.equal(existsSync(wt("t1")), false);
});

test("a failed setup command fails create but keeps the worktree for remove", () => {
  const { repo, wt } = makeRepo({ config: { setup: ["exit 3", "touch never"] } });
  const r = run(repo, ["create", "--task", "t1"]);
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.setup, [{ command: "exit 3", status: 3 }]);
  assert.ok(existsSync(wt("t1")));
  assert.equal(run(repo, ["remove", "--task", "t1"]).status, 0);
});

test("check catches a commit made around the guard", () => {
  const { repo, wt } = withTask();
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");
  git(wt("t1"), "-c", "core.hooksPath=/nonexistent", "commit", "-qam", "sneaky");
  const c = run(repo, ["check", "--task", "t1"]);
  assert.equal(c.status, 1);
  assert.ok(c.json.problems.some((p) => p.startsWith("HEAD moved")));
  assert.ok(c.json.problems.some((p) => p.includes("delegate/t1 moved")));
});

test("check catches a worktree that dropped the guard", () => {
  const { repo, wt } = withTask();
  git(wt("t1"), "config", "--worktree", "--unset", "core.hooksPath");
  const c = run(repo, ["check", "--task", "t1"]);
  assert.equal(c.status, 1);
  assert.ok(c.json.problems.includes("the worktree no longer points core.hooksPath at the guard"));
});

test("check flags files outside --allow and protected files", () => {
  const { repo, wt } = withTask({ config: { protected: ["AGENTS.md"] } });
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
  const { repo, wt } = withTask();
  writeFileSync(join(wt("t1"), "src/app.txt"), "two\n");
  assert.equal(run(repo, ["commit", "--task", "t1", "--message", "accepted work"]).status, 0);
  assert.equal(run(repo, ["remove", "--task", "t1"]).status, 2);
  git(repo, "merge", "-q", "--ff-only", "delegate/t1");
  const r = run(repo, ["remove", "--task", "t1"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(wt("t1")), false);
  assert.deepEqual(run(repo, ["list"]).json.worktrees, []);
});

test("implementers may not create, commit, rebase or remove", () => {
  const { repo } = makeRepo();
  const worker = { DELEGATE_WORKER: "1" };
  assert.match(run(repo, ["create", "--task", "t1"], worker).stderr, /implementers may not run `create`/);
  run(repo, ["create", "--task", "t1"]);
  for (const [command, extra] of [["commit", ["--message", "x"]], ["rebase", ["--onto", "main"]], ["remove", []]]) {
    const r = run(repo, [command, "--task", "t1", ...extra], worker);
    assert.match(r.stderr, new RegExp(`implementers may not run \`${command}\``));
  }
  assert.equal(run(repo, ["check", "--task", "t1"], worker).status, 0);
});

test("bad task ids and config are refused", () => {
  const { repo } = makeRepo({ config: { snapshots: [] } });
  assert.match(run(repo, ["create", "--task", "t1"]).stderr, /unknown keys snapshots/);
  const plain = makeRepo();
  assert.match(run(plain.repo, ["create", "--task", "../x"]).stderr, /--task must match/);
  const flags = makeRepo({ config: { relayFlags: { agy: ["sandbox"] } } });
  assert.match(run(flags.repo, ["create", "--task", "t1"]).stderr, /"relayFlags" must map/);
});
