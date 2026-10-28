# AGENTS.md

Guidelines for anyone, human or agent, changing Arkitekt.ai. `CLAUDE.md` imports this file, so keep the rules here.

## What this is

Arkitekt.ai is a project generator for AI agents, in the spirit of Spring Initializr. A Next.js app takes a set of options (language, framework, provider, model, capabilities) and returns a zip with a project that installs and runs. There is no database: each request builds the files from code.

## Layout

| Path | What lives there |
| --- | --- |
| `src/lib/catalog.ts` | Every option, its allowed values, and `parseOptions`, which validates requests. The UI and the API both read from here. |
| `src/lib/generators/shared.ts` | What both languages share: `flags()`, `.env.example`, tool specs, README notes, limit defaults. |
| `src/lib/generators/python.ts` | The Python project templates. |
| `src/lib/generators/typescript.ts` | The TypeScript project templates. |
| `src/lib/generate.ts` | Picks the generator and builds the zip. |
| `src/app/` | The page, `POST/PUT /api/starter.zip` and `GET /api/metadata`. |
| `scripts/verify-generated.ts` | Generates one project, installs it, type-checks it and runs its tests. |
| `scripts/stub-api.py` | A stub Anthropic/OpenAI API that always asks for a tool and logs each request body. |
| `.github/workflows/ci.yml` | Type-checks and builds the app, then verifies 16 generated combinations. |
| `.claude/skills/` | Step-by-step guides for recurring changes, listed below. |

## Commands

```bash
npm ci                 # install
npm run dev            # local server on :3000
npx tsc --noEmit       # type-check the app
npm run build          # production build
npm run verify -- python langgraph anthropic all    # one generated combination
```

`verify` takes `<language> <framework> <provider> <all|min>`: `all` turns on every capability, `min` only tests. It needs Python 3.10+ and Node 22, and network access to PyPI and npm.

## Rules for templates

The generated code is the product. Someone reads it on their first day with an agent framework, so it has to be correct, small and easy to read.

- **Templates are code, not files on disk.** Python and TypeScript build files with the `lines(...)` helper, where `f.flag && "line"` drops a line when the flag is off. Follow that pattern instead of string concatenation or a template engine.
- **Keep the two languages at parity.** A capability, a limit or a fix in one generator goes into the other, unless the framework makes it impossible. In that case, say so in the PR.
- **Cover every framework and provider.** A change to the agent loop touches the SDK loop for Anthropic and for OpenAI/Ollama, LangGraph (Python) and the Vercel AI SDK (TypeScript). Ollama goes through the OpenAI client, so watch for parameters it doesn't accept: it takes `max_tokens`, while OpenAI's current models take `max_completion_tokens`.
- **Generated code needs no edits to run.** It must install, type-check and pass its own tests with just `.env` filled in. Anything configurable goes into `.env.example` with a working default.
- **Keep the safety defaults.** The tool loop stops at `MAX_STEPS`, responses are capped by `MAX_TOKENS`, and `fetch_url` refuses private, loopback and link-local addresses, including after redirects. Don't remove these to make an example shorter.
- **Pin SDK majors** in the generated `pyproject.toml` and `package.json`, so a new major can't break projects that are already generated.
- **Model IDs come from the providers.** Use the exact IDs from the provider's own docs, never guessed or with a date suffix added. The first model in each list in `catalog.ts` is the default.
- **Comments explain why, not what.** Match the comment density of the surrounding template, which is low.

## Verifying a change

1. `npx tsc --noEmit` and `npm run build` for the app.
2. `npm run verify` for each combination your change touches, `all` and `min`. For a change to the agent loop or shared code, run all 16 that CI runs (see the matrix in `ci.yml`).
3. CI doesn't run Ollama or call any real model. When you change a request parameter, generate a project, run it against `scripts/stub-api.py` or a real key, and check the request body. Type-checking passes even when Python receives an unknown argument.
4. Read the generated files, not just the generator. The page's file preview, or `PUT /api/starter.zip`, shows exactly what a user will download.

## Versioning

The version lives in `package.json`, and `src/lib/version.ts` reads it from there. It shows in the page footer, in `GET /api/metadata` and in every generated README. We follow semver: a new option is a minor release, a fix to generated templates is a patch release. Each release gets an entry at the top of `CHANGELOG.md`, written for someone who generates projects. Bump the `version` fields in `package-lock.json` by hand instead of regenerating the lockfile.

## Commits and PRs

- Commit messages are imperative and short: `Add conversation memory capability`, `Upgrade Next.js and React to patched versions`.
- One topic per PR. A PR that changes templates says which combinations it verified.
- Don't commit generated projects, `.env` files or API keys.

## Skills

The guides in `.claude/skills/` cover recurring changes. Claude Code loads them on its own; any other agent can read them as plain Markdown.

| Skill | When to use it |
| --- | --- |
| `add-option` | Adding a capability, framework, provider or language to the catalog and the generators. |
| `update-models` | Refreshing the model lists in `catalog.ts`. |
| `release` | Cutting a version: bump, changelog, checks. |
| `verify-matrix` | Running the CI matrix locally, and checking request bodies against a stub API. |
