export type Option = { id: string; name: string; description?: string };
export type FrameworkOption = Option & { languages: Language[] };

export type Language = "python" | "typescript";
export type Provider = "anthropic" | "openai" | "ollama";
export type Framework = "sdk" | "langgraph" | "vercel-ai";
export type Capability = "tools" | "memory" | "rag" | "mcp" | "http" | "docker" | "tests";

export const catalog = {
  languages: [
    { id: "python", name: "Python", description: "pyproject, FastAPI, pytest" },
    { id: "typescript", name: "TypeScript", description: "Node 22, tsx, vitest" },
  ] satisfies Option[],
  providers: [
    { id: "anthropic", name: "Anthropic", description: "Claude models" },
    { id: "openai", name: "OpenAI", description: "GPT models" },
    { id: "ollama", name: "Ollama", description: "Local models, no API key needed" },
  ] satisfies Option[],
  models: {
    anthropic: [
      { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
    ],
    openai: [
      { id: "gpt-4o-mini", name: "GPT-4o mini" },
      { id: "gpt-4o", name: "GPT-4o" },
    ],
    ollama: [
      { id: "llama3.1", name: "Llama 3.1" },
      { id: "qwen2.5", name: "Qwen 2.5" },
      { id: "mistral", name: "Mistral" },
    ],
  } satisfies Record<Provider, Option[]>,
  frameworks: [
    { id: "sdk", name: "Provider SDK", description: "Direct SDK calls, a tool loop you can read in one file", languages: ["python", "typescript"] },
    { id: "langgraph", name: "LangGraph", description: "Graph-based agent runtime from LangChain", languages: ["python"] },
    { id: "vercel-ai", name: "Vercel AI SDK", description: "generateText with multi-step tool calls", languages: ["typescript"] },
  ] satisfies FrameworkOption[],
  capabilities: [
    { id: "tools", name: "Tools", description: "Function calling with two example tools: current time and fetch URL" },
    { id: "memory", name: "Conversation memory", description: "Remembers earlier messages in each session" },
    { id: "rag", name: "RAG", description: "Answers from your own documents in knowledge/" },
    { id: "mcp", name: "MCP client", description: "Connects to the servers in mcp_servers.json" },
    { id: "http", name: "HTTP API", description: "Serves the agent on POST /chat" },
    { id: "docker", name: "Docker", description: "Ready-to-build Dockerfile" },
    { id: "tests", name: "Tests", description: "Example tests for the generated code" },
  ] satisfies Option[],
};

export type Options = {
  name: string;
  description: string;
  language: Language;
  provider: Provider;
  model: string;
  framework: Framework;
  capabilities: Capability[];
};

export const defaultModel = (provider: Provider) => catalog.models[provider][0].id;

export const frameworksFor = (language: Language) => catalog.frameworks.filter((f) => f.languages.includes(language));

const ids = (list: Option[]) => list.map((x) => x.id);

export function parseOptions(input: unknown): Options | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!/^[a-z][a-z0-9-]{0,49}$/.test(name)) return null;
  if (!ids(catalog.languages).includes(o.language as string)) return null;
  if (!ids(catalog.providers).includes(o.provider as string)) return null;
  const language = o.language as Language;
  const provider = o.provider as Provider;

  const framework = (o.framework ?? "sdk") as Framework;
  if (!frameworksFor(language).some((f) => f.id === framework)) return null;

  const model = o.model ?? defaultModel(provider);
  if (!ids(catalog.models[provider]).includes(model as string)) return null;

  const caps = Array.isArray(o.capabilities) ? o.capabilities : [];
  if (!caps.every((c) => ids(catalog.capabilities).includes(c as string))) return null;

  return {
    name,
    description: typeof o.description === "string" ? o.description.slice(0, 200) : "",
    language,
    provider,
    model: model as string,
    framework,
    capabilities: caps as Capability[],
  };
}
