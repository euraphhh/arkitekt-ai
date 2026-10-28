# Changelog

Versions follow [semver](https://semver.org): new options are minor releases, fixes to generated templates are patch releases.

## 0.2.2

Fixes to the generated projects:

- The tool-calling loop stops after `MAX_STEPS` rounds (default 10) instead of looping forever when the model keeps calling tools. LangGraph uses `recursion_limit`, the Vercel AI SDK uses `stopWhen`.
- `MAX_TOKENS` (default 16000) sets the response limit for every provider and framework, replacing the fixed `max_tokens=1024` that cut long answers short. Both limits live in `.env.example`.
- `fetch_url` refuses private, loopback, link-local and multicast addresses, and checks every redirect, so the agent can't reach the local network or cloud metadata endpoints.
- Anthropic agents use prompt caching: automatic caching in the SDK loop, `AnthropicPromptCachingMiddleware` in LangGraph, and a cache breakpoint on the system prompt in the Vercel AI SDK.

## 0.2.1

- Upgraded Next.js to 15.5.28 and React to 19.1.10 to fix CVE-2025-66478, which made Vercel block the deploy.

## 0.2.0

- Added agent frameworks: LangGraph (Python) and Vercel AI SDK (TypeScript).
- Added a model selector per provider.
- Updated the model lists: GPT-6 family for OpenAI, Claude Fable 5.1 for Anthropic, and qwen3.8, gpt-oss and llama3.1 for Ollama.
- Added capabilities: conversation memory, RAG and MCP client.
- Added the `fetch_url` example tool.
- Page: file preview, copy-as-curl, and a shareable link for each setup.
- Generated projects pin SDK major versions and state the Arkitekt.ai version in their README.
- CI generates, installs and tests 16 project combinations.

## 0.1.0

- First release: Python and TypeScript agents for Anthropic, OpenAI and Ollama, with tools, HTTP API, Docker and tests.
