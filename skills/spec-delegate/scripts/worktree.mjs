#!/usr/bin/env node
/**
 * worktree.mjs — isolated worktrees and guardrails for spec-delegate.
 *
 * Usage:
 *   node worktree.mjs create --task <id> [--cd <dir>] [--base <ref>] [--no-setup]
 *   node worktree.mjs check  --task <id> [--cd <dir>] [--allow <path>]...
 *   node worktree.mjs commit --task <id> --message <text> [--cd <dir>]
 *   node worktree.mjs rebase --task <id> --onto <ref> [--cd <dir>]
 *   node worktree.mjs remove --task <id> [--cd <dir>] [--force]
 *   node worktree.mjs list   [--cd <dir>]
 *   node worktree.mjs --help
 *
 * Each implementer works in its own worktree on branch `delegate/<id>`, so the
 * user's working tree and its gitignored files (databases, `.env`, local
 * config) are out of reach. Each worktree's own git config points
 * core.hooksPath at a reference-transaction hook in the shared git dir that
 * refuses every ref change, so the implementer cannot commit, stash, reset or
 * switch branches. The orchestrator lands with `commit` and `rebase`, which
 * use the project's own hooks instead. `check` is the backstop: it compares
 * the worktree with the state recorded by `create`. Nothing in the project's
 * tracked files or the main checkout's git config changes.
 *
 * Settings come from `<repo>/.spec-workflow/delegate.json` (all optional).
 * Prints JSON on stdout. Exit codes: 0 ok, 1 a check or setup command failed,
 * 2 usage or git error. Node built-ins only.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const CONFIG_VERSION = "spec-delegate.v1";
const STATE_VERSION = "spec-delegate-worktree.v1";
export const SPEC_DIR = ".spec-workflow";
export const CONFIG_PATH = join(SPEC_DIR, "delegate.json");
const CONFIG_KEYS = new Set([
  "version",
  "worktreeRoot",
  "setup",
  "gates",
  "snapshot",
  "protected",
  "relayFlags",
]);
const HOOK_NAME = "reference-transaction";
const HOOK_TEMPLATE = fileURLToPath(new URL(`../templates/${HOOK_NAME}`, import.meta.url));
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const HELP = `worktree.mjs — isolated worktrees and guardrails for spec-delegate

Usage:
  node worktree.mjs create --task <id> [--cd <dir>] [--base <ref>] [--no-setup]
  node worktree.mjs check  --task <id> [--cd <dir>] [--allow <path>]...
  node worktree.mjs commit --task <id> --message <text> [--cd <dir>]
  node worktree.mjs rebase --task <id> --onto <ref> [--cd <dir>]
  node worktree.mjs remove --task <id> [--cd <dir>] [--force]
  node worktree.mjs list   [--cd <dir>]

Commands:
  create        Make worktree <worktreeRoot>/<id> on branch delegate/<id>, point
                its hooks at the guard that refuses ref changes, copy the
                snapshot paths into it, and run the setup commands.
  check         Confirm HEAD, the branch and the guard did not change, and list
                changed files. --allow limits the files the task may change
                (repeatable; a trailing / matches a directory).
  commit        Stage everything in the worktree and commit it, running the
                project's own hooks instead of the guard.
  rebase        Rebase the worktree's branch onto <ref>, the same way.
  remove        Delete the worktree and its branch. Refuses when the branch has
                commits that are not in HEAD, unless --force.
  list          Show worktrees made by this script.

Options:
  --cd <dir>    Repository to work on (default: current directory).
  --base <ref>  create: commit to start from (default: HEAD).
  --no-setup    create: skip the setup commands.
  --force       remove: drop unlanded commits too.
`;

function fail(message) {
  process.stderr.write(`worktree.mjs: ${message}\n`);
  process.exit(2);
}

export function gitRaw(cwd, args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.error) throw new Error(`git: ${r.error.message}`);
  return r;
}

export function git(cwd, args) {
  const r = gitRaw(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.trim()}`);
  return r.stdout.replace(/\n$/, "");
}

/** Prints `value` or "" when the command fails (missing ref, detached HEAD). */
export function gitOptional(cwd, args) {
  const r = gitRaw(cwd, args);
  return r.status === 0 ? r.stdout.trim() : "";
}

function refuseImplementer(command) {
  // Managing worktrees is the orchestrator's job; an implementer that reaches
  // this script should stop, not route around the hook.
  if (process.env.DELEGATE_WORKER) throw new Error(`implementers may not run \`${command}\``);
}

function checkTask(task) {
  if (typeof task !== "string" || !TASK_ID.test(task)) {
    throw new Error(`--task must match ${TASK_ID} (got ${JSON.stringify(task)})`);
  }
  return task;
}

export function repoRoot(cwd) {
  return git(cwd, ["rev-parse", "--show-toplevel"]);
}

export function commonDir(root) {
  return git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
}

/** spec-delegate works from spec-workflow specs; without them there is nothing to delegate. */
export function requireSpecWorkflow(root) {
  if (!existsSync(join(root, SPEC_DIR))) {
    throw new Error(
      `no ${SPEC_DIR}/ in ${root}. spec-delegate implements spec-workflow tasks: create a spec ` +
        "with the spec-workflow MCP first, or use a plain *-delegate skill for one-off work",
    );
  }
}

function statePath(root, task) {
  return join(commonDir(root), "spec-delegate", `${task}.json`);
}

function readState(root, task) {
  const file = statePath(root, task);
  if (!existsSync(file)) throw new Error(`no worktree recorded for task ${task}`);
  return JSON.parse(readFileSync(file, "utf8"));
}

export function loadConfig(root) {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) return normalizeConfig(root, {});
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_PATH}: ${err.message}`);
  }
  if (raw.version !== CONFIG_VERSION) {
    throw new Error(`${CONFIG_PATH}: "version" must be "${CONFIG_VERSION}"`);
  }
  return normalizeConfig(root, raw);
}

/** Validates a config document and resolves worktreeRoot against `root`. */
export function normalizeConfig(root, raw) {
  const unknown = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length) throw new Error(`${CONFIG_PATH}: unknown keys ${unknown.join(", ")}`);
  const list = (key) => {
    const value = raw[key] ?? [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === "")) {
      throw new Error(`${CONFIG_PATH}: "${key}" must be a list of non-empty strings`);
    }
    return value;
  };
  const snapshot = list("snapshot");
  for (const path of snapshot) {
    const rel = relative(root, resolve(root, path));
    if (isAbsolute(path) || rel === "" || rel.startsWith("..")) {
      throw new Error(`${CONFIG_PATH}: snapshot path ${path} must be inside the repository`);
    }
  }
  // Extra relay flags per implementer key, e.g. a permission bypass the user
  // approved for this project. Kept in the config so the approval is on record.
  const relayFlags = raw.relayFlags ?? {};
  const flagsOk =
    relayFlags !== null &&
    typeof relayFlags === "object" &&
    !Array.isArray(relayFlags) &&
    Object.values(relayFlags).every(
      (flags) => Array.isArray(flags) && flags.every((f) => typeof f === "string" && f.startsWith("--")),
    );
  if (!flagsOk) {
    throw new Error(`${CONFIG_PATH}: "relayFlags" must map implementer keys to lists of --flags`);
  }
  return {
    worktreeRoot: resolve(root, raw.worktreeRoot ?? join("..", `${basename(root)}-wt`)),
    setup: list("setup"),
    gates: list("gates"),
    snapshot,
    protected: list("protected"),
    relayFlags,
  };
}

export function hookFile(cwd) {
  const dir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]);
  return join(dir, HOOK_NAME);
}

export function guardDir(root) {
  return join(commonDir(root), "spec-delegate", "hooks");
}

/**
 * Writes the guard into the shared git dir and turns on per-worktree config,
 * so each delegate worktree can point its own core.hooksPath at the guard
 * while the main checkout keeps its hooks.
 */
export function ensureGuard(root) {
  const dir = guardDir(root);
  const file = join(dir, HOOK_NAME);
  const template = readFileSync(HOOK_TEMPLATE, "utf8");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(file) || readFileSync(file, "utf8") !== template) writeFileSync(file, template);
  chmodSync(file, 0o755);
  if (gitOptional(root, ["config", "--local", "--type=bool", "extensions.worktreeConfig"]) !== "true") {
    // With per-worktree config on, these would apply to every worktree; git
    // asks for them to move into the main worktree's config first.
    if (gitOptional(root, ["config", "--local", "--type=bool", "core.bare"]) === "true" ||
        gitOptional(root, ["config", "--local", "core.worktree"])) {
      throw new Error("core.bare or core.worktree is set in .git/config; move it to config.worktree first");
    }
    git(root, ["config", "--local", "extensions.worktreeConfig", "true"]);
  }
  return dir;
}

/** The hooks directory the project itself uses, for landing commits. */
function projectHooksPath(root) {
  return gitOptional(root, ["config", "core.hooksPath"]) || join(commonDir(root), "hooks");
}

export function copySnapshot(root, worktree, paths) {
  const copied = [];
  const skipped = [];
  for (const path of paths) {
    if (!existsSync(join(root, path))) {
      skipped.push({ path, reason: "missing" });
      continue;
    }
    if (gitOptional(root, ["ls-files", "--", path]) !== "") {
      skipped.push({ path, reason: "tracked" });
      continue;
    }
    // A copy git can see would show up in the diff and could be landed by mistake.
    // The path does not exist in the worktree yet, so a trailing slash tells
    // git it is a directory; directory-only patterns like `.specs/` need that.
    const isDir = statSync(join(root, path)).isDirectory();
    const probe = isDir ? `${path.replace(/\/+$/, "")}/` : path;
    if (gitRaw(worktree, ["check-ignore", "-q", "--", probe]).status !== 0) {
      throw new Error(`snapshot path ${path} is not gitignored; ignore it or drop it from "snapshot"`);
    }
    cpSync(join(root, path), join(worktree, path), { recursive: true });
    copied.push(path);
  }
  return { copied, skipped };
}

/** Runs shell commands in `cwd`; stops at the first failure unless `keepGoing`. */
export function runCommands(cwd, commands, { keepGoing = false } = {}) {
  const results = [];
  for (const command of commands) {
    // Command output goes to stderr so stdout stays one JSON document.
    const r = spawnSync(command, { cwd, shell: true, stdio: ["ignore", 2, 2] });
    results.push({ command, status: r.status ?? 1 });
    if (r.status !== 0 && !keepGoing) break;
  }
  return results;
}

export function dropWorktree(root, path, branch) {
  if (existsSync(path)) git(root, ["worktree", "remove", "--force", path]);
  else git(root, ["worktree", "prune"]);
  if (branch && gitOptional(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
    git(root, ["branch", "-D", branch]);
  }
}

export function create(root, { task, base, setup = true }) {
  refuseImplementer("create");
  checkTask(task);
  requireSpecWorkflow(root);
  const config = loadConfig(root);
  const branch = `delegate/${task}`;
  const path = join(config.worktreeRoot, task);
  const state = statePath(root, task);
  if (existsSync(state)) throw new Error(`task ${task} already has a worktree; remove it first`);
  if (existsSync(path)) throw new Error(`${path} already exists`);
  if (gitOptional(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])) {
    throw new Error(`branch ${branch} already exists`);
  }
  const baseSha = gitOptional(root, ["rev-parse", "--verify", "--quiet", `${base ?? "HEAD"}^{commit}`]);
  if (!baseSha) throw new Error(`cannot resolve --base ${base ?? "HEAD"}`);
  const baseRef = base ?? (gitOptional(root, ["symbolic-ref", "--short", "-q", "HEAD"]) || baseSha);

  const guard = ensureGuard(root);
  mkdirSync(config.worktreeRoot, { recursive: true });
  git(root, ["worktree", "add", "--quiet", "-b", branch, path, baseSha]);
  let snapshot;
  try {
    git(path, ["config", "--worktree", "core.hooksPath", guard]);
    if (hookFile(path) !== join(guard, HOOK_NAME)) {
      throw new Error(`the new worktree does not use the guard in ${guard}`);
    }
    snapshot = copySnapshot(root, path, config.snapshot);
  } catch (err) {
    dropWorktree(root, path, branch);
    throw err;
  }
  mkdirSync(dirname(state), { recursive: true });
  const record = {
    version: STATE_VERSION,
    task,
    branch,
    path,
    base: baseSha,
    baseRef,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(state, `${JSON.stringify(record, null, 2)}\n`);

  // Recorded before setup runs, so a failed setup leaves a worktree that
  // `remove` can clean up.
  const results = setup ? runCommands(path, config.setup) : [];
  const ok = results.every((r) => r.status === 0);
  return { ok, ...record, snapshot, setup: results };
}

export function changedFiles(worktree) {
  const out = git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = out.split("\0");
  const files = new Set();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    files.add(entry.slice(3));
    // Renames and copies carry the original path as the next field.
    if (xy.includes("R") || xy.includes("C")) files.add(parts[++i]);
  }
  return [...files].sort();
}

function matchesAny(file, patterns) {
  return patterns.some((p) =>
    p.endsWith("/") ? file.startsWith(p) : file === p || file.startsWith(`${p}/`),
  );
}

export function check(root, { task, allow = [] }) {
  checkTask(task);
  const state = readState(root, task);
  if (!existsSync(state.path)) throw new Error(`worktree ${state.path} is gone`);
  // Protected paths come from the user's tree, not the worktree, so the
  // implementer cannot loosen them.
  const config = loadConfig(root);
  const head = git(state.path, ["rev-parse", "HEAD"]);
  const onBranch = gitOptional(state.path, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const tip = gitOptional(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${state.branch}`]);
  const changed = changedFiles(state.path);
  const outsideAllow = allow.length ? changed.filter((f) => !matchesAny(f, allow)) : [];
  const protectedHits = changed.filter((f) => matchesAny(f, config.protected));
  const hooks = gitOptional(state.path, ["config", "--worktree", "core.hooksPath"]);

  const problems = [];
  if (head !== state.base) problems.push(`HEAD moved from ${state.base.slice(0, 12)} to ${head.slice(0, 12)}`);
  if (onBranch !== state.branch) problems.push(`worktree is on ${onBranch || "a detached HEAD"}, not ${state.branch}`);
  if (tip !== state.base) problems.push(`branch ${state.branch} ${tip ? "moved" : "was deleted"}`);
  if (hooks !== guardDir(root)) problems.push("the worktree no longer points core.hooksPath at the guard");
  if (outsideAllow.length) problems.push(`changed files outside --allow: ${outsideAllow.join(", ")}`);
  if (protectedHits.length) problems.push(`changed protected files: ${protectedHits.join(", ")}`);
  return {
    ok: problems.length === 0,
    task,
    path: state.path,
    branch: state.branch,
    problems,
    changed,
    empty: changed.length === 0,
  };
}

/** Runs git in a task's worktree with the project's own hooks instead of the guard. */
function landGit(root, task, args) {
  const state = readState(root, task);
  if (!existsSync(state.path)) throw new Error(`worktree ${state.path} is gone`);
  // Hook and git output go to stderr so stdout stays one JSON document.
  const r = spawnSync("git", ["-C", state.path, "-c", `core.hooksPath=${projectHooksPath(root)}`, ...args], {
    stdio: ["ignore", 2, 2],
  });
  return { state, status: r.status ?? 1 };
}

export function commit(root, { task, message }) {
  refuseImplementer("commit");
  checkTask(task);
  if (!message) throw new Error("commit needs --message");
  const add = landGit(root, task, ["add", "-A"]);
  const { state, status } = add.status === 0 ? landGit(root, task, ["commit", "-q", "-m", message]) : add;
  const head = gitOptional(state.path, ["rev-parse", "HEAD"]);
  return { ok: status === 0, task, branch: state.branch, head };
}

export function rebase(root, { task, onto }) {
  refuseImplementer("rebase");
  checkTask(task);
  if (!onto) throw new Error("rebase needs --onto");
  const { state, status } = landGit(root, task, ["rebase", "-q", onto]);
  const head = gitOptional(state.path, ["rev-parse", "HEAD"]);
  return { ok: status === 0, task, branch: state.branch, onto, head };
}

export function remove(root, { task, force = false }) {
  refuseImplementer("remove");
  checkTask(task);
  const state = readState(root, task);
  const tip = gitOptional(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${state.branch}`]);
  if (tip && tip !== state.base && !force) {
    const landed = gitRaw(root, ["merge-base", "--is-ancestor", tip, "HEAD"]).status === 0;
    if (!landed) {
      throw new Error(`${state.branch} has commits that are not in HEAD; land them first or pass --force`);
    }
  }
  dropWorktree(root, state.path, state.branch);
  rmSync(statePath(root, task));
  return { ok: true, task, removed: state.path, branch: state.branch };
}

export function list(root) {
  const dir = join(commonDir(root), "spec-delegate");
  if (!existsSync(dir)) return { ok: true, worktrees: [] };
  const worktrees = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const state = JSON.parse(readFileSync(join(dir, name), "utf8"));
      return { ...state, exists: existsSync(state.path) };
    });
  return { ok: true, worktrees };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        cd: { type: "string" },
        task: { type: "string" },
        base: { type: "string" },
        allow: { type: "string", multiple: true },
        message: { type: "string" },
        onto: { type: "string" },
        "no-setup": { type: "boolean" },
        force: { type: "boolean" },
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
  if (positionals.length > 1) fail(`unexpected arguments: ${positionals.slice(1).join(" ")}`);

  let result;
  try {
    const root = repoRoot(resolve(values.cd ?? "."));
    switch (positionals[0]) {
      case "create":
        result = create(root, { task: values.task, base: values.base, setup: !values["no-setup"] });
        break;
      case "check":
        result = check(root, { task: values.task, allow: values.allow ?? [] });
        break;
      case "commit":
        result = commit(root, { task: values.task, message: values.message });
        break;
      case "rebase":
        result = rebase(root, { task: values.task, onto: values.onto });
        break;
      case "remove":
        result = remove(root, { task: values.task, force: values.force });
        break;
      case "list":
        result = list(root);
        break;
      default:
        fail(`unknown command ${positionals[0]}; see --help`);
    }
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
