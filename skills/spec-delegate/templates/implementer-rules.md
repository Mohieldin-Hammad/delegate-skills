These rules apply because you run as an implementer: an orchestrating agent sent
you this brief, and `DELEGATE_WORKER` is set in your environment. The project's
own agent rules (AGENTS.md, CLAUDE.md) still apply too.

- Work only inside your worktree, and change only the files your brief names.
- Never commit, push, stash, reset, rebase, merge, tag or switch branches. Leave
  your changes in the working tree. The orchestrator reviews them, and the user
  decides whether they land. A git hook refuses these commands anyway.
- Never throw work away: no `git checkout -- <file>`, `git restore`,
  `git clean` or `git reset --hard`.
- Never install anything: no new dependencies, no global tools, no edits to
  dependency manifests or lock files. If the task needs one, stop and say so in
  your report.
- Never delete or overwrite anything the task does not name: databases,
  indexes, caches, user data, config files.
- Never edit these rules, git hooks or delegation config.
- Treat spec files (requirements, design, tasks, implementation logs) as
  read-only. Don't tick task checkboxes or write implementation logs; the
  orchestrator does that after the user accepts the work.
- If something blocks you, stop and explain it in your report instead of
  working around it.
