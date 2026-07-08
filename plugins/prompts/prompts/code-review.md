---
description: Correctness review of a diff, ranked by severity
argument-hint: '[PR | branch | path]'
---

You are doing a correctness review of a diff: your job is to catch every real bug
before it ships. Cast a wide net when finding candidates; apply a strict bar when
verifying them. A reportable finding must be:

- **introduced by the diff** — pre-existing issues are out of scope unless the diff
  makes them worse
- **discrete and provable** — a specific defect with nameable triggering inputs/state
  and identifiable affected code, not speculation that something "might break"
- **something the author would fix** — not an intentional change, a style preference,
  or a demand for rigor the rest of the codebase doesn't have

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1` if
there's no upstream) to get the unified diff under review. If there are uncommitted
changes, or the range diff is empty, also run `git diff HEAD` and include the
working-tree changes in scope. If a PR number, branch name, or file path was passed
as an argument, review that target instead — the argument passed to this command
(empty if none) is: $ARGUMENTS.

## Phase 1 — Find candidates

Run **multiple independent finder sub-agents, one per angle below**, via the
`subagent` tool. Do NOT let one angle's conclusions suppress another's — if two
angles flag the same line for different reasons, record both.

### Angle A — logic errors in the new code

Read every hunk line by line, then read the enclosing function — bugs in unchanged
lines of a touched function are in scope. For every line ask: what input, state,
timing, or platform makes this line wrong? Inverted/wrong conditions, off-by-one,
null/undefined deref, wrong-variable copy-paste, bad boundary or empty-input handling
— plus the classic pitfalls of the diff's language (e.g. JS falsy-zero and missing
`await`, Python mutable default args, Go range-var capture, SQL injection, float
equality, timezone drift).

### Angle B — lost behavior

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that behavior is re-established. If you
can't find it, that's a candidate: a removed guard, a dropped error path, a narrowed
validation, a deleted test that was covering a real case.

### Angle C — broken contracts

For each function, type, or interface the diff changes, find its usage sites and
check whether the change breaks any of them: a new precondition, a changed return
shape or type, a new exception, changed semantics under the same signature. Check
both directions — callers of changed code, and callees whose contract the changed
code now violates.

### Angle D — state, lifecycle, and error paths

Trace what happens off the happy path: errors swallowed or mis-propagated, resources
acquired but not released on failure, partial writes with no rollback, operations now
outside the lock/transaction that guarded them, setup/teardown asymmetry, ordering or
reentrancy assumptions the diff breaks, stale caches or duplicated state that can now
diverge.

## Phase 2 — Verify (1-vote, 3-state)

Dedup candidates that point at the same line/mechanism, keeping the one with the most
concrete failure scenario. For each remaining candidate, run **one verifier** via the
`subagent` tool: give it the diff, the relevant file(s), the candidate, and the
reportable-finding bar from the top of this prompt, and have it return exactly one
of:

- **Confirmed** — meets the bar and can name the inputs/state that trigger it and the
  wrong output or crash. Quote the line.
- **Plausible** — mechanism is real, trigger is uncertain (timing, env, config).
  State what would confirm it.
- **Refuted** — factually wrong (code doesn't say that), guarded elsewhere,
  pre-existing, or clearly intentional. Quote the evidence.

Keep every candidate whose vote is Confirmed or Plausible — do NOT drop on
uncertainty.

## Phase 3 — Sweep for gaps

Run **one more finder** as a fresh reviewer who has the verified list. Re-read the
diff and enclosing functions looking ONLY for defects not already listed — the job is
gaps, not re-confirmation. Pay attention to what per-angle passes miss: defects
spanning multiple hunks or files, moved/extracted code that dropped something in
transit, and changed config/defaults whose effect lands far from the diff. If nothing
new, return an empty sweep — do not pad.

## Output

Report this review's results as your final message: a `level` (the review effort,
here extra-high) and a `findings` list ranked most-severe first — include every
finding that survived verification, nothing more. Each entry has:

- `file`, `line`
- `priority` — `p0` (drop everything) / `p1` (fix before merge) / `p2` (fix
  eventually) / `p3` (nice to have)
- `summary` — one matter-of-fact sentence; state severity honestly, don't inflate
- `failure_scenario` — the concrete inputs, state, or environment that trigger it and
  what goes wrong
- `category` — short kebab-case slug for the bug class (`logic`, `lost-behavior`,
  `broken-contract`, `error-path`, or a more specific slug when one fits better)
- `verdict` — when a verify pass produced one

If nothing survives verification, report an empty `findings` list — do not
manufacture findings to have something to say.
