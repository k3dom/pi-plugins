# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repo root — it points at one `CONTEXT.md` per workspace
  package. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. Also check
  `plugins/<name>/docs/adr/` and `tooling/<name>/docs/adr/` for package-scoped
  decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence or
suggest creating them upfront. The `/domain-modeling` skill (reached via
`/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when
terms or decisions actually get resolved.

## File structure

This is a multi-context repo: a root `CONTEXT-MAP.md` points at one `CONTEXT.md` per
workspace package.

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← repo-wide decisions
├── plugins/
│   ├── checkpoint/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                  ← package-scoped decisions
│   └── usage/
│       ├── CONTEXT.md
│       └── docs/adr/
└── tooling/
    └── shared/
        ├── CONTEXT.md
        └── docs/adr/
```

Not every package has these files, and that's expected — `/domain-modeling` creates
them lazily as terms and decisions actually get resolved. Read the ones that exist
and proceed silently past the ones that don't.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a
hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to
synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're
inventing language the project doesn't use (reconsider) or there's a real gap (note
it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
