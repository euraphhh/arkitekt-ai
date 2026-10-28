---
name: add-option
description: Add a new capability, agent framework, model provider or language to Arkitekt.ai, from the catalog to both generators, tests, CI and docs. Use when someone asks to support a new option in the generated projects.
---

# Add an option

Each option starts in `src/lib/catalog.ts` and ends in the generated files. The UI, the API and `GET /api/metadata` all read the catalog, so the page needs no changes.

## 1. Catalog

In `src/lib/catalog.ts`:

- Add the id to its union type (`Capability`, `Framework`, `Provider` or `Language`).
- Add an entry to the matching list in `catalog`, with a `description` that says what the user gets in one line.
- Framework: set `languages` to the languages it supports. `parseOptions` rejects any other pairing.
- Provider: add a `models` list. The first entry is the default. See the `update-models` skill for where IDs come from.

## 2. Flags

In `src/lib/generators/shared.ts`, add a flag to `flags()`. If the capability reaches the model as a tool (like `rag` and `mcp`), include it in `needsTools`.

Put shared pieces here instead of copying them into both generators: tool specs (`TIME_TOOL`, `FETCH_TOOL`, …), config files, and the README notes in `notes()`. Add a note when the user has to know something to use the option.

## 3. Generators

Edit `src/lib/generators/python.ts` **and** `src/lib/generators/typescript.ts`. For each one:

- Dependencies, with the major version pinned (`"pkg>=2,<3"`, `"^2.0.0"`).
- New files go in `files[...]`, behind the flag.
- Lines in existing files use `f.flag && "line"` inside `lines(...)`.
- Variables go into `envFile()` (`shared.ts`) with a default that works.
- Tests go into the generated test file, so `npm test` / `pytest` exercises the option without an API key.

A new framework or provider also needs its own branch of the agent loop. Keep the `MAX_STEPS` stop, the `MAX_TOKENS` limit and (for Anthropic) prompt caching. AGENTS.md lists them.

## 4. Verify

```bash
npx tsc --noEmit
npm run verify -- <language> <framework> <provider> all
npm run verify -- <language> <framework> <provider> min
```

Run every combination the option touches. `all` turns on every capability, so a new capability is covered automatically. For a new framework or provider, add it to the matrix in `.github/workflows/ci.yml`. The `verify-matrix` skill has a stub API for checking the request body.

## 5. Docs and version

- `README.md`: update the "What you can generate" table.
- `CHANGELOG.md`: a new option is a **minor** release. Follow the `release` skill.
