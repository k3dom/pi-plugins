---
description:
  Review the changed code for reuse, simplification, efficiency, and altitude
  improvements, and report them (read-only — makes no edits)
argument-hint: '[PR | branch | path]'
---

You are reviewing the quality of the changed code, not hunting for bugs. Review it
for reuse, simplification, efficiency, and altitude issues and report what you find.
This review is read-only: do NOT edit any files — just surface the opportunities so a
human can decide what to act on. Do not look for correctness bugs.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1` if
there's no upstream) to get the unified diff under review. If there are uncommitted
changes, or the range diff is empty, also run `git diff HEAD` and include the
working-tree changes in scope — the review often runs before the commit. If a PR
number, branch name, or file path was passed as an argument, review that target
instead — the argument passed to this command (empty if none) is: $ARGUMENTS. Treat
this diff as the review scope.

## Phase 1 — Review (4 cleanup agents in parallel)

Launch **4 independent review agents** via the `subagent` tool, all in a single
message so they run concurrently. Pass each agent the diff and one of the four angles
below. Each returns its findings with `file`, `line`, a one-line `summary`, and the
concrete cost (what is duplicated, wasted, or harder to maintain).

### Reuse

Flag new code that re-implements something the codebase already has — Grep
shared/utility modules and files adjacent to the change, and name the existing helper
to call instead.

### Simplification

Flag unnecessary complexity the diff adds: redundant or derivable state, copy-paste
with slight variation, deep nesting, dead code left behind. Name the simpler form
that does the same job.

### Efficiency

Flag wasted work the diff introduces: redundant computation or repeated I/O,
independent operations run sequentially, blocking work added to startup or hot paths.
Also flag long-lived objects built from closures or captured environments — they keep
the entire enclosing scope alive for the object's lifetime (a memory leak when that
scope holds large values); prefer a class/struct that copies only the fields it
needs. Name the cheaper alternative.

### Altitude

Check that each change is implemented at the right depth, not as a fragile bandaid.
Special cases layered on shared infrastructure are a sign the fix isn't deep enough —
prefer generalizing the underlying mechanism over adding special cases.

## Phase 2 — Consolidate

Wait for all four agents to complete, then dedup findings that point at the same line
or mechanism, keeping the one with the most concrete cost. Drop anything whose fix
would change intended behavior, require changes well outside the reviewed diff, or
that you judge to be a false positive. Do NOT edit any files.

## Output

Report the surviving findings as your final message: a `findings` list ranked
most-impactful first. Each entry has `file`, `line`, `summary`, `cost` (what is
duplicated, wasted, or harder to maintain), `suggestion` (the simpler or cheaper form
that does the same job), and `category` — a short kebab-case slug for the angle that
produced it (`reuse`, `simplification`, `efficiency`, or `altitude`). If nothing is
worth changing, report an empty `findings` list and confirm the code is already
clean. Do not make the changes yourself — leave that decision to the human.
