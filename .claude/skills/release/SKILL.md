---
name: release
description: Cut an Arkitekt.ai release - pick the semver bump, update package.json, package-lock.json and CHANGELOG.md, and run the checks. Use when someone asks to bump the version, release, or write the changelog.
---

# Release

## Pick the bump

| Change | Bump |
| --- | --- |
| New option: capability, framework, provider, language, models | minor (`0.2.x` → `0.3.0`) |
| Fix to generated templates, security fix, dependency upgrade | patch (`0.2.1` → `0.2.2`) |
| Breaking change to the API (`/api/starter.zip`, `/api/metadata`) or to option ids | minor while we are on `0.x`; call it out at the top of the entry |

## Bump

1. `package.json`: `version`. `src/lib/version.ts` reads it from there, and the page footer, `GET /api/metadata` and every generated README show it.
2. `package-lock.json`: edit the two `version` fields at the top (the root and `packages[""]`) by hand. Don't regenerate the lockfile just for the version, since a different npm can rewrite unrelated entries.

## Changelog

Add a `## <version>` section at the top of `CHANGELOG.md`, above the previous release. Write for someone who generates projects: what changes in what they download, and what they get from it. One bullet per change, with config names in backticks (`MAX_STEPS`, `.env.example`).

## Checks

```bash
npx tsc --noEmit
npm run build
```

Then run `verify` for the combinations the release touches. For template changes, run the whole CI matrix (`verify-matrix` skill).
