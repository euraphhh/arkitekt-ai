# Arkitekt.ai

A project generator for AI agents, in the spirit of Spring Initializr. Pick a language, an agent framework, a model provider and a few capabilities, then download a project that installs and runs.

## What you can generate

| Option | Choices |
| --- | --- |
| Language | Python, TypeScript |
| Framework | Provider SDK (both), LangGraph (Python), Vercel AI SDK (TypeScript) |
| Provider | Anthropic, OpenAI, Ollama |
| Capabilities | Tools, conversation memory, RAG, MCP client, HTTP API, Docker, tests |

The page also shows every generated file before you download, and the setup lives in the URL so you can share it.

## API

```bash
# Options and their allowed values live in src/lib/catalog.ts
curl -X POST http://localhost:3000/api/starter.zip \
  -H 'content-type: application/json' \
  -d '{"name":"my-agent","language":"python","framework":"langgraph","provider":"anthropic","model":"claude-sonnet-5-5","capabilities":["tools","memory"]}' \
  -o my-agent.zip
```

`PUT /api/starter.zip` takes the same body and returns the files as JSON. `GET /api/metadata` lists the options.

## Versioning

The version lives in `package.json` and shows in the page footer, in `GET /api/metadata` and in every generated README. See `CHANGELOG.md`.

## Develop

```bash
npm install
npm run dev
```

Templates are code, in `src/lib/generators/`. There is no database: every request builds the zip from scratch, so the app deploys to Vercel as is.

## Check the generated projects

```bash
npm run verify -- python langgraph anthropic all
npm run verify -- typescript vercel-ai openai min
```

This generates the project, installs it, type-checks or compiles it, imports the agent and runs its tests. CI runs 16 combinations on every push.
