#!/usr/bin/env node
/**
 * init.mjs — set up spec-delegate in a repository.
 *
 * Usage:
 *   node init.mjs [--cd <dir>]                     report what is set up, change nothing
 *   node init.mjs --verify [--cd <dir>]            try the config in a throwaway worktree
 *   node init.mjs --write [--verify] [--cd <dir>]  install the hook and implementer rules
 *   node init.mjs --help
 *
 * The orchestrator writes `.delegate/spec-delegate.json` itself, following
 * references/setup.md: working out a project's setup and gates takes judgment
 * no fixed table has. This script does the parts that must be exact.
 * --verify proves the setup works, leaves nothing git can see, and that the
 * gates pass on the base commit, before any implementer is measured against
 * them. --write installs the reference-transaction hook and adds the
 * implementer rules to AGENTS.md (created if missing). With --verify it writes
 * only when verification passes.
 *
 * Prints JSON on stdout. Exit codes: 0 ok, 1 verification or hook install
 * failed, 2 usage or git error. Node built-ins only.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CONFIG_PATH,
  changedFiles,
  commonDir,
  copySnapshot,
  dropWorktree,
  git,
  gitOptional,
  gitRaw,
  hookFile,
  hookInstalled,
  installHook,
  loadConfig,
  normalizeConfig,
  repoRoot,
  runCommands,
} from "./worktree.mjs";

const RULES_TEMPLATE = fileURLToPath(new URL("../templates/implementer-rules.md", import.meta.url));
const RULES_HEADING = "## Rules for delegated implementers";
const SPEC_DIR = ".spec-workflow";

const HELP = `init.mjs — set up spec-delegate in a repository

Usage:
  node init.mjs [--cd <dir>]                     report what is set up, change nothing
  node init.mjs --verify [--cd <dir>]            try the config in a throwaway worktree
  node init.mjs --write [--verify] [--cd <dir>]  install the hook and implementer rules

Write ${CONFIG_PATH} first (references/setup.md).
--verify runs the setup commands and gates in a detached worktree of HEAD and
fails when setup fails, setup leaves files git can see, or a gate fails.
--write installs the reference-transaction hook and adds the implementer rules
to AGENTS.md. It never changes the config.
`;

function fail(message) {
  process.stderr.write(`init.mjs: ${message}\n`);
  process.exit(2);
}

const has = (root, path) => existsSync(join(root, path));
const read = (root, path) => readFileSync(join(root, path), "utf8");

function specWorkflowState(root) {
  if (!has(root, SPEC_DIR)) return "missing";
  if (gitOptional(root, ["ls-files", "--", SPEC_DIR]) !== "") return "tracked";
  return gitRaw(root, ["check-ignore", "-q", "--", `${SPEC_DIR}/`]).status === 0 ? "ignored" : "untracked";
}

function agentsState(root) {
  if (!has(root, "AGENTS.md")) return "missing";
  return read(root, "AGENTS.md").includes(RULES_HEADING) ? "has-rules" : "needs-rules";
}

/** Reports how far the repository is set up; changes nothing. */
export function inspect(root) {
  const notes = [];
  const configFile = has(root, CONFIG_PATH) ? "exists" : "missing";
  const config = configFile === "exists" ? loadConfig(root) : null;
  if (!config) notes.push(`No ${CONFIG_PATH} yet: write it by following references/setup.md.`);

  // A hooks directory inside the working tree is tracked content to protect.
  const hook = hookFile(root);
  const hookRel = relative(root, dirname(hook));
  const hooksDir =
    !hookRel.startsWith("..") && !isAbsolute(hookRel) && !hook.startsWith(commonDir(root) + sep)
      ? `${hookRel.split(sep).join("/")}/`
      : null;
  if (hooksDir && config && !config.protected.includes(hooksDir)) {
    notes.push(`Add "${hooksDir}" to "protected": the hook lives in the working tree.`);
  }

  const specWorkflow = specWorkflowState(root);
  if (specWorkflow === "missing") {
    notes.push(`No ${SPEC_DIR}/ yet: create a spec with the spec-workflow MCP before dispatching tasks.`);
  } else if (specWorkflow === "untracked") {
    notes.push(`${SPEC_DIR}/ is neither committed nor gitignored: do one, so worktrees can see the specs.`);
  }
  if (gitRaw(root, ["check-ignore", "-q", "--", CONFIG_PATH]).status === 0) {
    notes.push(`${CONFIG_PATH} is gitignored: other clones will not get the config.`);
  }
  if (!has(root, "CLAUDE.md") && has(root, "AGENTS.md")) {
    notes.push("No CLAUDE.md: if your orchestrator reads only CLAUDE.md, add one containing @AGENTS.md.");
  }

  return {
    configFile,
    config,
    hooksDir,
    hook: hookInstalled(root),
    agentsMd: agentsState(root),
    specWorkflow,
    notes,
  };
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

/** Installs the hook and adds the implementer rules; never touches the config. */
export function write(root, state) {
  const written = [];
  const hook = installHook(root);
  if (hook.changed) written.push(relative(root, hook.file));
  const rules = readFileSync(RULES_TEMPLATE, "utf8");
  if (state.agentsMd === "missing") {
    writeFileSync(join(root, "AGENTS.md"), `# Agent rules\n\n${rules}`);
    written.push("AGENTS.md");
  } else if (state.agentsMd === "needs-rules") {
    const current = read(root, "AGENTS.md");
    appendFileSync(join(root, "AGENTS.md"), `${current.endsWith("\n") ? "" : "\n"}\n${rules}`);
    written.push("AGENTS.md");
  }
  const notes = [];
  if (hook.reachesWorktrees === "after-commit") {
    notes.push(`Commit ${relative(root, hook.file)}: worktrees get the hook only from a commit.`);
  } else if (hook.reachesWorktrees === "never") {
    notes.push(`${relative(root, hook.file)} is gitignored, so worktrees never get it: point core.hooksPath elsewhere.`);
  }
  return { ok: hook.ok, written, hook, notes };
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
    if ((values.verify || values.write) && !state.config) {
      throw new Error(`no ${CONFIG_PATH}: write it first (references/setup.md)`);
    }
    result = { ok: true, root, ...state };
    if (values.verify) {
      result.verify = verify(root, JSON.parse(read(root, CONFIG_PATH)));
      result.ok = result.verify.ok;
    }
    if (values.write && result.ok) {
      if (process.env.DELEGATE_WORKER) throw new Error("implementers may not run `init --write`");
      result.write = write(root, state);
      result.ok = result.write.ok;
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
