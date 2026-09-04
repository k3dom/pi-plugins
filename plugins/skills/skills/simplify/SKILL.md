---
name: simplify
description:
  Review the changed code for reuse, simplification, efficiency, and altitude
  improvements, and report them (read-only — makes no edits). Takes an optional
  target — a PR number, branch name, or path.
disable-model-invocation: true
---

You are reviewing the quality of the changed code, not hunting for bugs — review it
for reuse, simplification, efficiency, and altitude issues and report what you find.
This review is read-only: do NOT edit any files, just surface the opportunities for a
human to act on.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1` if
there's no upstream) to get the unified diff under review. If there are uncommitted
changes, or the range diff is empty, also run `git diff HEAD` and include the
working-tree changes in scope. If an argument — a PR number, branch name, or file
path — was passed to this skill, it appears immediately after these instructions.
Review that target instead.

## Phase 1 — Review (4 cleanup agents in parallel)

Launch **4 independent review sub-agents** via the `subagent` tool, all in a single
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
Also flag long-lived objects built from closures or captured environments — they pin
the whole enclosing scope for their lifetime. Prefer a class/struct that copies only
the fields it needs. Name the cheaper alternative.

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

Report the surviving findings as your final message: a markdown table ranked
most-impactful first, with these columns:

| #   | Location               | Category | Summary                                                               | Cost                                                                       | Suggestion                                                             |
| --- | ---------------------- | -------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | `src/api/client.ts:88` | reuse    | Re-implements retry-with-backoff that `withRetry()` already provides. | Second copy of the backoff policy to keep in sync with `src/lib/retry.ts`. | Call `withRetry(fn, { attempts: 3 })` instead of the hand-rolled loop. |

- `#` — 1-based rank, matching the impact order
- `Location` — `` `file:line` `` in backticks, using the file's path as it appears in
  the diff
- `Category` — short kebab-case slug for the angle that produced it (`reuse`,
  `simplification`, `efficiency`, or `altitude`)
- `Summary` — one matter-of-fact sentence. Don't inflate the issue
- `Cost` — what is concretely duplicated, wasted, or harder to maintain
- `Suggestion` — the simpler or cheaper form that does the same job

One row per finding, and keep each cell to a single line so the table stays readable.
If a suggestion needs a code snippet, put it in a short fenced block below the table,
referencing the row `#`.

If nothing is worth changing, skip the table and confirm the code is already clean —
do not manufacture findings to have something to say.
