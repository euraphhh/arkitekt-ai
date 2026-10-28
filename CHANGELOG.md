# Changelog

Versions follow [semver](https://semver.org): new options are minor releases, fixes to generated templates are patch releases.

## 0.2.0

- Added agent frameworks: LangGraph (Python) and Vercel AI SDK (TypeScript).
- Added a model selector per provider.
- Added capabilities: conversation memory, RAG and MCP client.
- Added the `fetch_url` example tool.
- Page: file preview, copy-as-curl, and a shareable link for each setup.
- Generated projects pin SDK major versions and state the Arkitekt.ai version in their README.
- CI generates, installs and tests 16 project combinations.

## 0.1.0

- First release: Python and TypeScript agents for Anthropic, OpenAI and Ollama, with tools, HTTP API, Docker and tests.
