# AdoptOps Git and Parallel Development Rules

## Main

`main` is the integration source of truth.

Feature implementation must not be performed directly on main.

ALL changes — including docs, rules and config — reach main via pull
request. GitHub branch protection is unavailable on this plan (private
repo, personal account), so the `.githooks/pre-push` hook enforces this
locally by rejecting direct pushes to main. `ALLOW_MAIN_PUSH=1` overrides
it for genuine emergencies only; never use the override routinely.

## Starting a Feature Branch

Always cut a new branch from an up-to-date `main` — never from another
feature branch or a stale local `main`:

    git checkout main
    git pull --ff-only origin main
    git checkout -b <type>/<short-topic>

`--ff-only` is deliberate: a plain `git pull` here builds a merge commit when
it cannot fast-forward and drops into the editor; on this machine that editor
is vi and it fails, stranding a half-finished merge on `main`. If `--ff-only`
errors, local `main` has diverged — reconcile with
`git reset --hard origin/main` (local `main` should never carry unique work),
not by merging.

Recommended once per machine so this never recurs:

    git config --global pull.ff only
    git config --global core.editor "code --wait"

## Workstreams

Three parallel workstreams are used:

1. Overview
2. Scheduling
3. Admin & Operations

Each active Claude Code session should use an isolated Git worktree.

## Before Editing

Claude must:
1. identify its current branch
2. identify its worktree
3. identify the active workstream
4. inspect relevant existing code
5. identify cross-workstream dependencies

## Scope Discipline

Do not modify unrelated pages merely because they are nearby.

Avoid unrelated:
- formatting
- renaming
- dependency upgrades
- refactoring

inside a feature change.

## Shared Changes

When a task requires a shared contract used by another workstream:

Preferred:

foundation/shared change
  -> main
  -> affected workstreams update from main

Avoid unnecessary direct dependency between long-running feature branches.

## Stacked Branches and Squash Merges

PRs are squash-merged: a merged PR lands on main as a NEW commit, so a
branch stacked on the original commits shows phantom conflicts on any
shared line (observed twice on the client package.json test-script line).

After each parent PR merges:

git fetch origin
git checkout <stacked-branch>
git rebase origin/main        # patch-id detection drops merged commits
git push --force-with-lease origin <stacked-branch>

--force-with-lease on feature branches only; never force-push main.
State the required merge order in each stacked PR body.

## Before Commit / PR

Run relevant tests/builds before declaring work complete.

Report:
- files changed
- behaviour changed
- tests/builds run
- known limitations
- shared contracts changed
- affected workstreams
- required merge order

Run /dependency-check for significant or cross-cutting changes.

## Updating from Main

When another required change has landed in main:

git fetch origin
git merge --no-edit origin/main

Resolve conflicts deliberately and rerun affected tests. `--no-edit` avoids
dropping into vi for the merge-commit message (see Starting a Feature Branch).

Worktrees keep `.claude/launch.json` local via `git update-index
--skip-worktree` (per-worktree ports). If a merge aborts with "local
changes would be overwritten" on such a file: back up the local copy,
unset the flag, `git checkout -- <file>`, merge, restore the local
copy, then re-set the flag.

## Safety

Never:
- force-push main
- rewrite main history
- commit credentials
- commit tokens
- commit environment secrets
- perform destructive deployment merely to test a feature
