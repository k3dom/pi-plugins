# @pi-plugins/skills

## 0.3.0

### Minor Changes

- 077bdb9: Rename the `prompts` package to `skills` and ship its two templates as Agent Skills
  instead of prompt templates. Both set `disable-model-invocation: true`, so they stay
  out of the system prompt and only run when invoked as `/skill:simplify` or
  `/skill:code-review`.

  Migration: `pi install npm:@pi-plugins/skills` and drop `npm:@pi-plugins/prompts`.
  The commands change from `/simplify` and `/code-review` to `/skill:simplify` and
  `/skill:code-review`.

> Released as `@pi-plugins/prompts` up to 0.2.1.

## 0.2.1

### Patch Changes

- 3f61feb: Have `/code-review` and `/simplify` report their findings as a markdown table with
  explicit columns instead of a loose field list.

## 0.2.0

### Minor Changes

- ad25194: Add the `prompts` package bundling two prompt templates: `/simplify` (code
  cleanup — reuse, simplification, efficiency, altitude) and `/code-review`
  (high-recall correctness review of a diff, ranked by severity).
