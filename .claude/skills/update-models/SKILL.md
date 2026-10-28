---
name: update-models
description: Refresh the per-provider model lists in Arkitekt.ai's catalog (Anthropic, OpenAI, Ollama) with current, exact model IDs. Use when a provider ships or retires models, or someone asks to update the model selector.
---

# Update the model lists

The models live in `catalog.models` in `src/lib/catalog.ts`, one list per provider. The first model in each list is the default for that provider. It is also the model CI uses in `verify`.

## Where IDs come from

Use the exact ID from the provider's own documentation or models API, never one you recall or one with a date suffix added:

- Anthropic: the models overview in the Claude docs, or `GET /v1/models`.
- OpenAI: the models page in the OpenAI docs, or `GET /v1/models`.
- Ollama: the tag on ollama.com/library (e.g. `qwen3.8`, `gpt-oss:20b`). The tag must be something `ollama pull` accepts.

Give each entry a `name` as the provider writes it (`Claude Sonnet 5.5`, `GPT-6.1 Sol`). For Ollama, add the size when the tag doesn't say it (`Qwen 3.8 (27B)`).

## Removing models

Shared links carry the model in the URL (`?model=...`), and `parseOptions` rejects an unknown model, so a link with a removed ID stops loading its setup. Remove only models the provider has retired. Put a newer model first instead of deleting the old one.

## Check

```bash
npx tsc --noEmit
npm run verify -- python sdk <provider> min
npm run verify -- typescript sdk <provider> min
```

Then add a line to `CHANGELOG.md` saying which models were added or removed. Changing a list is a minor release when it adds models, and a patch release when it only fixes IDs. See the `release` skill.
