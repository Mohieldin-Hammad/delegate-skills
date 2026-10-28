import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

/** A committed repo at <tmp>/repo holding `files`; `untracked` stay uncommitted. */
function makeRepo(files = {}, { hooksPath, untracked = {} } = {}) {
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

test("a bare repo is reported as not set up, and verify and write refuse", () => {
  const repo = makeRepo();
  const { json } = init(repo);
  assert.equal(json.configFile, "missing");
  assert.equal(json.config, null);
  assert.ok(json.notes.some((n) => n.startsWith("No .delegate/spec-delegate.json yet")));
  for (const flag of ["--verify", "--write"]) {
    const r = init(repo, flag);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no \.delegate\/spec-delegate\.json: write it first/);
  }
});

test("spec-workflow state: ignored, tracked, visible and missing", () => {
  const spec = { ".spec-workflow/specs/a/tasks.md": "- [ ] 1\n" };
  const ignored = init(makeRepo({ ".gitignore": ".spec-workflow/\n" }, { untracked: spec })).json;
  assert.equal(ignored.specWorkflow, "ignored");
  assert.equal(init(makeRepo(spec)).json.specWorkflow, "tracked");
  const visible = init(makeRepo({}, { untracked: spec })).json;
  assert.equal(visible.specWorkflow, "untracked");
  assert.ok(visible.notes.some((n) => n.includes("neither committed nor gitignored")));
  assert.ok(init(makeRepo()).json.notes.some((n) => n.startsWith("No .spec-workflow/")));
});

test("a hooks directory in the working tree must be in protected", () => {
  const bare = init(makeRepo({ ".delegate/spec-delegate.json": CONFIG }, { hooksPath: ".githooks" })).json;
  assert.equal(bare.hooksDir, ".githooks/");
  assert.ok(bare.notes.includes('Add ".githooks/" to "protected": the hook lives in the working tree.'));
  const ok = '{ "version": "spec-delegate.v1", "protected": [".githooks/"] }';
  const done = init(makeRepo({ ".delegate/spec-delegate.json": ok }, { hooksPath: ".githooks" })).json;
  assert.ok(!done.notes.some((n) => n.startsWith("Add ")));
  assert.equal(init(makeRepo()).json.hooksDir, null, "the default hooks dir is in .git, not the tree");
});

test("--write installs the hook and creates AGENTS.md, and a second run changes nothing", () => {
  const repo = makeRepo({ ".delegate/spec-delegate.json": CONFIG });
  const first = init(repo, "--write");
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(first.json.write.written, [".git/hooks/reference-transaction", "AGENTS.md"]);
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /## Rules for delegated implementers/);
  const second = init(repo, "--write");
  assert.deepEqual(second.json.write.written, []);
  assert.equal(second.json.agentsMd, "has-rules");
});

test("--write never changes the config and appends rules to an existing AGENTS.md", () => {
  const repo = makeRepo({ ".delegate/spec-delegate.json": CONFIG, "AGENTS.md": "# Mine\n\n- my rule" });
  init(repo, "--write");
  assert.equal(readFileSync(join(repo, ".delegate/spec-delegate.json"), "utf8"), CONFIG);
  const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
  assert.ok(agents.startsWith("# Mine\n\n- my rule\n\n## Rules for delegated implementers"));
});

test("--write notes that a tracked hook must be committed", () => {
  const r = init(makeRepo({ ".delegate/spec-delegate.json": CONFIG }, { hooksPath: ".githooks" }), "--write");
  assert.ok(r.json.write.notes.some((n) => n.startsWith("Commit .githooks/reference-transaction")));
});

test("--verify runs setup and every gate in a throwaway worktree", () => {
  const config = {
    version: "spec-delegate.v1",
    setup: ["mkdir -p .venv && touch .venv/ok"],
    gates: ["test -f .venv/ok", "false", "true"],
  };
  const repo = makeRepo({ ".gitignore": ".venv/\n", ".delegate/spec-delegate.json": JSON.stringify(config) });
  const r = init(repo, "--verify", "--write");
  assert.equal(r.status, 1);
  assert.deepEqual(r.json.verify.gates.map((g) => g.status), [0, 1, 0]);
  assert.deepEqual(r.json.verify.problems, ["gates fail on the base commit: false"]);
  assert.equal(r.json.write, undefined, "nothing is written when verification fails");
  assert.equal(existsSync(join(repo, ".git/hooks/reference-transaction")), false);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1, "the probe worktree is gone");
});

test("--verify fails when setup leaves files git can see", () => {
  const config = { version: "spec-delegate.v1", setup: ["mkdir -p node_modules && touch node_modules/x"] };
  const r = init(makeRepo({ ".delegate/spec-delegate.json": JSON.stringify(config) }), "--verify");
  assert.equal(r.status, 1);
  assert.match(r.json.verify.problems[0], /setup leaves files git can see; gitignore them: node_modules\/x/);
});
