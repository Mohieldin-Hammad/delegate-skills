#!/usr/bin/env node
/**
 * init.mjs — set up spec-delegate in a repository.
 *
 * Usage:
 *   node init.mjs [--cd <dir>]                     report what is set up, change nothing
 *   node init.mjs --verify [--cd <dir>]            try the config in a throwaway worktree
 *   node init.mjs --write [--verify] [--cd <dir>]  gitignore .spec-workflow/ if it is not yet
 *   node init.mjs --help
 *
 * The orchestrator writes `.spec-workflow/delegate.json` itself, following
 * references/setup.md: working out a project's setup and gates takes judgment
 * no fixed table has. This script does the parts that must be exact.
 * --verify proves the setup works, leaves nothing git can see, and that the
 * gates pass on the base commit, before any implementer is measured against
 * them. --write adds `.spec-workflow/` to `.gitignore` when it is neither
 * tracked nor ignored. Nothing else in the project changes: the guard hook
 * lives in the git dir and `worktree.mjs create` wires it up per worktree.
 *
 * Prints JSON on stdout. Exit codes: 0 ok, 1 verification failed, 2 usage or
 * git error. Node built-ins only.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CONFIG_PATH,
  SPEC_DIR,
  changedFiles,
  commonDir,
  copySnapshot,
  dropWorktree,
  git,
  gitOptional,
  gitRaw,
  loadConfig,
  normalizeConfig,
  repoRoot,
  requireSpecWorkflow,
  runCommands,
} from "./worktree.mjs";

const HELP = `init.mjs — set up spec-delegate in a repository

Usage:
  node init.mjs [--cd <dir>]                     report what is set up, change nothing
  node init.mjs --verify [--cd <dir>]            try the config in a throwaway worktree
  node init.mjs --write [--verify] [--cd <dir>]  gitignore ${SPEC_DIR}/ if it is not yet

Needs ${SPEC_DIR}/: create a spec with the spec-workflow MCP first.
Write ${CONFIG_PATH} before --verify (references/setup.md).
--verify runs the setup commands and gates in a detached worktree of HEAD and
fails when setup fails, setup leaves files git can see, or a gate fails.
--write adds ${SPEC_DIR}/ to .gitignore when it is neither tracked nor ignored.
`;

function fail(message) {
  process.stderr.write(`init.mjs: ${message}\n`);
  process.exit(2);
}

function specWorkflowState(root) {
  if (gitOptional(root, ["ls-files", "--", SPEC_DIR]) !== "") return "tracked";
  return gitRaw(root, ["check-ignore", "-q", "--", `${SPEC_DIR}/`]).status === 0 ? "ignored" : "untracked";
}

function hasTasks(root) {
  const specs = join(root, SPEC_DIR, "specs");
  if (!existsSync(specs)) return false;
  return readdirSync(specs, { withFileTypes: true }).some(
    (entry) => entry.isDirectory() && existsSync(join(specs, entry.name, "tasks.md")),
  );
}

/** The project's own hooks directory, when it lives in the working tree. */
function projectHooksDir(root) {
  const path = gitOptional(root, ["config", "core.hooksPath"]);
  if (!path || path.startsWith("~")) return null;
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || abs.startsWith(commonDir(root) + sep)) return null;
  return `${rel.split(sep).join("/")}/`;
}

/** Reports how far the repository is set up; changes nothing. */
export function inspect(root) {
  requireSpecWorkflow(root);
  const notes = [];
  const configFile = existsSync(join(root, CONFIG_PATH)) ? "exists" : "missing";
  const config = configFile === "exists" ? loadConfig(root) : null;
  if (!config) notes.push(`No ${CONFIG_PATH} yet: write it by following references/setup.md.`);

  const specWorkflow = specWorkflowState(root);
  if (specWorkflow === "untracked") {
    notes.push(`${SPEC_DIR}/ is neither tracked nor ignored: run with --write to add it to .gitignore.`);
  }
  if (!hasTasks(root)) notes.push(`No spec with a tasks.md under ${SPEC_DIR}/specs/ yet: nothing to delegate.`);

  // The project's own hooks are tracked content an implementer must not touch.
  const hooksDir = projectHooksDir(root);
  if (hooksDir && config && !config.protected.includes(hooksDir)) {
    notes.push(`Add "${hooksDir}" to "protected": the project keeps its hooks there.`);
  }
  return { configFile, config, specWorkflow, hooksDir, notes };
}

/** Runs setup and gates in a detached worktree of HEAD, then deletes it. */
export function verify(root, raw) {
  const config = normalizeConfig(root, raw);
  const probe = join(config.worktreeRoot, `.init-probe-${process.pid}`);
  mkdirSync(config.worktreeRoot, { recursive: true });
  git(root, ["worktree", "add", "--quiet", "--detach", probe, "HEAD"]);
  try {
    const snapshot = copySnapshot(root, probe, config.snapshot);
    const setup = runCommands(probe, config.setup);
    const problems = [];
    let gates = [];
    if (setup.some((r) => r.status !== 0)) {
      problems.push(`setup failed: ${setup.at(-1).command}`);
    } else {
      // Anything setup creates must be gitignored, or every check would list it.
      const leftovers = changedFiles(probe);
      if (leftovers.length) {
        const shown = leftovers.slice(0, 5).join(", ") + (leftovers.length > 5 ? ", …" : "");
        problems.push(`setup leaves files git can see; gitignore them: ${shown}`);
      }
      gates = runCommands(probe, config.gates, { keepGoing: true });
      const failed = gates.filter((g) => g.status !== 0).map((g) => g.command);
      if (failed.length) problems.push(`gates fail on the base commit: ${failed.join(", ")}`);
    }
    return { ok: problems.length === 0, snapshot, setup, gates, problems };
  } finally {
    dropWorktree(root, probe);
  }
}

/** Adds .spec-workflow/ to .gitignore when git would otherwise see it. */
export function write(root, state) {
  if (state.specWorkflow !== "untracked") return { ok: true, written: [] };
  const file = join(root, ".gitignore");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  appendFileSync(file, `${current === "" || current.endsWith("\n") ? "" : "\n"}${SPEC_DIR}/\n`);
  return { ok: true, written: [".gitignore"] };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        cd: { type: "string" },
        verify: { type: "boolean" },
        write: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (err) {
    fail(err.message);
  }
  const { values } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }

  let result;
  try {
    const root = repoRoot(resolve(values.cd ?? "."));
    const state = inspect(root);
    if (values.verify && !state.config) throw new Error(`no ${CONFIG_PATH}: write it first (references/setup.md)`);
    result = { ok: true, root, ...state };
    if (values.verify) {
      result.verify = verify(root, JSON.parse(readFileSync(join(root, CONFIG_PATH), "utf8")));
      result.ok = result.verify.ok;
    }
    if (values.write && result.ok) {
      if (process.env.DELEGATE_WORKER) throw new Error("implementers may not run `init --write`");
      result.write = write(root, state);
      Object.assign(result, inspect(root));
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
