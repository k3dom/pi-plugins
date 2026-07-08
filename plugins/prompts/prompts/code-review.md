---
description: Correctness review of a diff, ranked by severity
argument-hint: '[PR | branch | path]'
---

You are doing a correctness review of a diff: your job is to catch every real bug
before it ships. A caught bug matters more than a false positive, so when in doubt,
surface it.

## Phase 0 — Gather the diff

Run `git diff @{upstream}...HEAD` (or `git diff main...HEAD` / `git diff HEAD~1` if
there's no upstream) to get the unified diff under review. If there are uncommitted
changes, or the range diff is empty, also run `git diff HEAD` and include the
working-tree changes in scope. If a PR number, branch name, or file path was passed
as an argument, review that target instead — the argument passed to this command
(empty if none) is: $ARGUMENTS.

## Phase 1 — Find candidates

Run **multiple independent finder sub-agents with different angles** via the
`subagent` tool. Do NOT let one angle's conclusions suppress another's — if two
angles flag the same line for different reasons, record both.

### Angle A — line-by-line diff scan

Read every hunk in the diff line by line, then Read the enclosing function — bugs in
unchanged lines of a touched function are in scope. For every line ask: what input,
state, timing, or platform makes this line wrong? Look for inverted/wrong conditions,
off-by-one, null/undefined deref, missing `await`, falsy-zero checks, wrong-variable
copy-paste, error swallowed in catch, unescaped regex metachars.

### Angle B — removed-behavior auditor

For every line the diff DELETES or replaces, name the invariant or behavior it
enforced, then search the new code for where that invariant is re-established. If you
can't find it, that's a candidate: a removed guard, a dropped error path, a narrowed
validation, a deleted test that was covering a real case.

### Angle C — cross-file tracer

For each function the diff changes, find its callers (Grep for the symbol) and check
whether the change breaks any call site: a new precondition, a changed return shape,
a new exception, a timing/ordering dependency. Also check callees: does a parallel
change in the same PR make a call unsafe?

### Angle D — language-pitfall specialist

Scan for the classic pitfalls of the diff's language/framework — for example: JS
falsy-zero, `==` coercion, closure-captured loop var; Python mutable default args,
late-binding closures; Go nil-map write, range-var capture; SQL injection;
timezone/DST drift; float equality. Flag any instance the diff introduces.

### Angle E — wrapper/proxy correctness

When the PR adds or modifies a type that wraps another (cache, proxy, decorator,
adapter): check that every method routes to the wrapped instance and not back through
a registry/session/global that re-enters the wrapper or recurses. Also check that the
wrapper forwards all the methods its callers use.

## Phase 2 — Verify (1-vote, 3-state)

Dedup candidates that point at the same line/mechanism, keeping the one with the most
concrete failure scenario. For each remaining candidate, run **one verifier** via the
`subagent` tool: give it the diff, the relevant file(s), and the candidate, and have
it return exactly one of:

- **Confirmed** — can name the inputs/state that trigger it and the wrong output or
  crash. Quote the line.
- **Plausible** — mechanism is real, trigger is uncertain (timing, env, config).
  State what would confirm it.
- **Refuted** — factually wrong (code doesn't say that) or guarded elsewhere. Quote
  the line that proves it.

Keep every candidate whose vote is Confirmed or Plausible — do NOT drop on
uncertainty.

## Phase 3 — Sweep for gaps

Run **one more finder** as a fresh reviewer who has the verified list. Re-read the
diff and enclosing functions looking ONLY for defects not already listed — the job is
gaps, not re-confirmation. Focus on what the first pass tends to miss:
moved/extracted code that dropped a guard or anchor; second-tier footguns (dataclass
default evaluated once, `hash()` non-determinism, lock-scope shrink, predicate
methods with side effects); setup/teardown asymmetry in tests; config defaults
flipped. If nothing new, return an empty sweep — do not pad.

## Output

Report this review's results as your final message: a `level` (the review effort,
here extra-high) and a `findings` list of at most 15 entries ranked most-severe
first. Each entry has `file`, `line`, `summary`, `failure_scenario`, and `category` —
a short kebab-case slug for the angle that produced it (`correctness`, `conventions`,
or a more specific slug like `test-coverage` when one fits better) — plus `verdict`
when a verify pass produced one. If nothing survives verification, report an empty
`findings` list.
