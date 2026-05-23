# pi-plugins

This repository is a pnpm/Turbo monorepo containing plugins/extensions for the pi-agent harness.
Pi-agent plugins live under `plugins/`; shared tooling and support packages live under `tooling/`.

## Validation

Use the `ci` command to validate code changes (format, lint, type-check, build).

## Vendored Repositories

This project vendors external repositories of key libraries as git submodules
under `.agents/repos/`. Use vendored repositories as read-only reference
material when working with related libraries to explore API's, find usage
examples, and understand implementation details.

- Effect-TS v4 (`.agents/repos/effect-smol/packages/`)
- pi-agent (`.agents/repos/pi/`)
