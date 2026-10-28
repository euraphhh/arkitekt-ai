---
name: verify-matrix
description: Run Arkitekt.ai's generated-project checks locally - the 16-combination CI matrix, plus running a generated agent against a stub API to check request bodies and loop limits. Use after changing templates, before pushing.
---

# Verify the generated projects

## The CI matrix

CI runs `scripts/verify-generated.ts` for 4 stacks × 2 providers × 2 capability sets. To run the same 16 locally, in parallel:

```bash
for st in "python sdk" "python langgraph" "typescript sdk" "typescript vercel-ai"; do
  for p in anthropic openai; do
    for c in all min; do
      (npx tsx scripts/verify-generated.ts $st $p $c > "/tmp/verify-${st// /_}-$p-$c.log" 2>&1; echo "$st $p $c: $?") &
    done
  done
done; wait
```

A non-zero exit code points to the log that failed. Each run generates the project in a temporary directory, installs it, type-checks it (Python: `compileall` + import), and runs its tests.

## What the matrix misses

- **Ollama**: not in CI. Run `npm run verify -- python sdk ollama min` and `npm run verify -- typescript sdk ollama min` when you touch the OpenAI-compatible path.
- **Request parameters in Python**: `compileall` and import pass even when the SDK rejects an argument at call time. TypeScript catches unknown fields at `tsc`, Python doesn't.
- **Loop behavior**: no test calls a model.

For the last two, run the agent against `scripts/stub-api.py`, a stub that always asks for a tool, and look at what it sends. It answers `POST /v1/messages` with a `tool_use` block (Anthropic) and `POST /v1/chat/completions` with `tool_calls` (OpenAI), and logs each request body as a JSON line. Generate a project with the `tools` capability (the page, or `PUT /api/starter.zip`), install it, then:

```bash
python3 scripts/stub-api.py 8701 /tmp/requests.jsonl &
MAX_STEPS=3 ANTHROPIC_API_KEY=test ANTHROPIC_BASE_URL=http://127.0.0.1:8701 \
  .venv/bin/python -c "import asyncio; from demo_agent.agent import run; print(asyncio.run(run('hi')))"
```

The agent should return `Stopped after 3 tool-calling steps…` after exactly 3 requests, and the logged bodies should carry the expected parameters (`max_tokens` / `max_completion_tokens`, `cache_control`). For TypeScript, set `OPENAI_BASE_URL=http://127.0.0.1:8701/v1` for OpenAI, and for Anthropic with the Vercel AI SDK, `ANTHROPIC_BASE_URL=http://127.0.0.1:8701/v1`. LangGraph's OpenAI model calls `POST /v1/responses`, which the stub logs but doesn't answer, so for that combination check only the logged body.
