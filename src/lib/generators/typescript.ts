import type { Options } from "../catalog";
import { VERSION } from "../version";
import { FETCH_TOOL, MAX_STEPS, MAX_TOKENS, MCP_CONFIG, SEARCH_TOOL, TIME_TOOL, envFile, flags, knowledgeDoc, notes } from "./shared";

const lines = (...parts: (string | false)[]) => parts.filter((p): p is string => p !== false).join("\n");

export function typescriptProject(o: Options): Record<string, string> {
  const f = flags(o);
  const sessionParam = f.memory ? ', sessionId = "default"' : "";
  const historyType = f.vercel ? "ModelMessage" : f.anthropic ? "Anthropic.MessageParam" : "OpenAI.ChatCompletionMessageParam";

  const dependencies: Record<string, string> = f.vercel
    ? { ai: "^7.0.0", [f.anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai"]: "^4.0.0", dotenv: "^16.4.5" }
    : { [f.anthropic ? "@anthropic-ai/sdk" : "openai"]: f.anthropic ? "^1.3.0" : "^7.45.0", dotenv: "^16.4.5" };
  if (f.mcp) dependencies["@modelcontextprotocol/sdk"] = "^1.12.0";
  const devDependencies: Record<string, string> = {
    "@types/node": "^22.0.0",
    tsx: "^4.19.0",
    typescript: "^5.6.0",
  };
  if (f.tests) devDependencies["vitest"] = "^2.1.0";

  const scripts: Record<string, string> = { dev: "tsx src/index.ts", build: "tsc" };
  if (f.http) scripts["serve"] = "tsx src/server.ts";
  if (f.tests) scripts["test"] = "vitest run";

  const limits = lines(
    `const maxTokens = Number(process.env.MAX_TOKENS ?? ${MAX_TOKENS});`,
    `const maxSteps = Number(process.env.MAX_STEPS ?? ${MAX_STEPS}); // tool-calling rounds per message`,
  );
  const stopped = "`Stopped after ${maxSteps} tool-calling steps without a final answer.`";

  const history = lines(
    `const histories = new Map<string, ${historyType}[]>();`,
    "",
    "function historyFor(id: string) {",
    "  let h = histories.get(id);",
    "  if (!h) histories.set(id, (h = []));",
    "  return h;",
    "}",
  );

  const agentAnthropic = lines(
    'import Anthropic from "@anthropic-ai/sdk";',
    f.needsTools && 'import { getTools, runTool } from "./tools.js";',
    "",
    "const client = new Anthropic();",
    `const model = process.env.MODEL ?? "${o.model}";`,
    limits,
    `const system = "You are ${o.name}, a helpful AI agent.";`,
    f.memory && "",
    f.memory && history,
    "",
    `export async function run(prompt: string${sessionParam}): Promise<string> {`,
    `  const messages: Anthropic.MessageParam[] = ${f.memory ? "historyFor(sessionId)" : "[]"};`,
    '  messages.push({ role: "user", content: prompt });',
    f.needsTools && "  const tools = await getTools();",
    "  for (let step = 0; step < maxSteps; step++) {",
    "    const resp = await client.messages.create({",
    "      model,",
    "      max_tokens: maxTokens,",
    "      system,",
    "      messages,",
    '      cache_control: { type: "ephemeral" }, // caches the prompt so far, re-read on the next step',
    f.needsTools && "      ...(tools.length ? { tools } : {}),",
    "    });",
    '    messages.push({ role: "assistant", content: resp.content });',
    '    if (resp.stop_reason !== "tool_use") {',
    '      return resp.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");',
    "    }",
    "    const results = await Promise.all(",
    '      resp.content.flatMap((b) => (b.type === "tool_use" ? [b] : [])).map(async (b) => ({',
    '        type: "tool_result" as const,',
    "        tool_use_id: b.id,",
    `        content: ${f.needsTools ? "await runTool(b.name, b.input)" : '""'},`,
    "      })),",
    "    );",
    '    messages.push({ role: "user", content: results });',
    "  }",
    `  return ${stopped};`,
    "}",
    "",
  );

  const agentOpenAI = lines(
    'import OpenAI from "openai";',
    f.needsTools && 'import { getTools, runTool } from "./tools.js";',
    "",
    "const client = new OpenAI(); // reads OPENAI_API_KEY and OPENAI_BASE_URL",
    `const model = process.env.MODEL ?? "${o.model}";`,
    limits,
    `const system = "You are ${o.name}, a helpful AI agent.";`,
    f.memory && "",
    f.memory && history,
    "",
    `export async function run(prompt: string${sessionParam}): Promise<string> {`,
    `  const messages: OpenAI.ChatCompletionMessageParam[] = ${f.memory ? "historyFor(sessionId)" : "[]"};`,
    '  if (!messages.length) messages.push({ role: "system", content: system });',
    '  messages.push({ role: "user", content: prompt });',
    f.needsTools && "  const tools = await getTools();",
    "  for (let step = 0; step < maxSteps; step++) {",
    "    const resp = await client.chat.completions.create({",
    "      model,",
    "      messages,",
    `      ${o.provider === "ollama" ? "max_tokens" : "max_completion_tokens"}: maxTokens,`,
    f.needsTools && "      ...(tools.length ? { tools } : {}),",
    "    });",
    "    const msg = resp.choices[0].message;",
    "    messages.push(msg);",
    '    if (!msg.tool_calls?.length) return msg.content ?? "";',
    "    for (const call of msg.tool_calls) {",
    '      if (call.type !== "function") continue;',
    "      messages.push({",
    '        role: "tool",',
    "        tool_call_id: call.id,",
    `        content: ${f.needsTools ? 'await runTool(call.function.name, JSON.parse(call.function.arguments || "{}"))' : '""'},`,
    "      });",
    "    }",
    "  }",
    `  return ${stopped};`,
    "}",
    "",
  );

  const agentVercel = lines(
    'import { generateText, jsonSchema, stepCountIs, tool, type ModelMessage } from "ai";',
    f.anthropic ? 'import { createAnthropic } from "@ai-sdk/anthropic";' : 'import { createOpenAI } from "@ai-sdk/openai";',
    f.needsTools && 'import { getSpecs, runTool } from "./tools.js";',
    "",
    `const modelId = process.env.MODEL ?? "${o.model}";`,
    f.anthropic
      ? "const model = createAnthropic()(modelId);"
      : "const model = createOpenAI({ baseURL: process.env.OPENAI_BASE_URL }).chat(modelId); // reads OPENAI_API_KEY",
    limits,
    `const system = "You are ${o.name}, a helpful AI agent.";`,
    f.memory && "",
    f.memory && history,
    f.needsTools && "",
    f.needsTools && "async function buildTools() {",
    f.needsTools && "  const specs = await getSpecs();",
    f.needsTools && "  return Object.fromEntries(",
    f.needsTools && "    specs.map((s) => [",
    f.needsTools && "      s.name,",
    f.needsTools && "      tool({",
    f.needsTools && "        description: s.description,",
    f.needsTools && "        inputSchema: jsonSchema<Record<string, unknown>>(s.schema as Parameters<typeof jsonSchema>[0]),",
    f.needsTools && "        execute: (args) => runTool(s.name, args),",
    f.needsTools && "      }),",
    f.needsTools && "    ]),",
    f.needsTools && "  );",
    f.needsTools && "}",
    "",
    `export async function run(prompt: string${sessionParam}): Promise<string> {`,
    `  const messages: ModelMessage[] = ${f.memory ? "historyFor(sessionId)" : "[]"};`,
    '  messages.push({ role: "user", content: prompt });',
    f.needsTools && "  const tools = await buildTools();",
    "  const result = await generateText({",
    "    model,",
    f.anthropic
      ? lines(
          "    // A cache breakpoint on the system prompt caches the tools and the system prompt.",
          '    system: { role: "system", content: system, providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },',
        )
      : "    system,",
    "    messages,",
    "    maxOutputTokens: maxTokens,",
    f.needsTools && "    ...(Object.keys(tools).length ? { tools, stopWhen: stepCountIs(maxSteps) } : {}),",
    "  });",
    "  messages.push(...result.response.messages);",
    `  if (result.finishReason === "tool-calls") return ${stopped};`,
    "  return result.text;",
    "}",
    "",
  );

  const files: Record<string, string> = {
    "package.json":
      JSON.stringify(
        {
          name: o.name,
          version: "0.1.0",
          description: o.description || "AI agent generated by Arkitekt.ai",
          type: "module",
          scripts,
          dependencies,
          devDependencies,
        },
        null,
        2,
      ) + "\n",
    "tsconfig.json":
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            outDir: "dist",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
          },
          include: ["src"],
        },
        null,
        2,
      ) + "\n",
    ".env.example": envFile(o),
    ".gitignore": ".env\nnode_modules\ndist\n",
    "src/agent.ts": f.vercel ? agentVercel : f.anthropic ? agentAnthropic : agentOpenAI,
    "src/index.ts": lines(
      'import "dotenv/config";',
      'import * as readline from "node:readline/promises";',
      'import { run } from "./agent.js";',
      f.mcp && 'import { closeMcp } from "./mcp.js";',
      "",
      "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
      "while (true) {",
      '  const line = await rl.question("you> ").catch(() => null);',
      "  if (line === null) break;",
      "  console.log(await run(line));",
      "}",
      "rl.close();",
      f.mcp && "await closeMcp();",
      "",
    ),
    "README.md": readme(o, f.http),
  };

  if (f.needsTools) {
    const base = [f.tools && TIME_TOOL, f.tools && FETCH_TOOL, f.rag && SEARCH_TOOL].filter(Boolean);
    const typeImport = f.sdk
      ? f.anthropic
        ? 'import type Anthropic from "@anthropic-ai/sdk";'
        : 'import type OpenAI from "openai";'
      : false;
    const ret = f.anthropic ? "Anthropic.Tool[]" : "OpenAI.ChatCompletionTool[]";
    const fmt = f.anthropic
      ? 'specs.map((s) => ({ name: s.name, description: s.description, input_schema: s.schema as Anthropic.Tool["input_schema"] }))'
      : 'specs.map((s) => ({ type: "function" as const, function: { name: s.name, description: s.description, parameters: s.schema } }))';
    files["src/tools.ts"] = lines(
      f.tools && 'import { lookup } from "node:dns/promises";',
      f.tools && 'import { BlockList } from "node:net";',
      typeImport,
      f.rag && 'import { search } from "./rag.js";',
      f.mcp && 'import { callMcpTool, connect, isMcpTool, mcpSpecs } from "./mcp.js";',
      "",
      "export type Spec = { name: string; description: string; schema: Record<string, unknown> };",
      "",
      `const baseTools: Spec[] = ${JSON.stringify(base, null, 2)};`,
      f.tools && "",
      f.tools && "// Addresses fetch_url refuses: this machine, private networks, link-local (cloud metadata) and multicast.",
      f.tools && "// BlockList also checks IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) against the IPv4 rules.",
      f.tools && "const blocked = new BlockList();",
      f.tools && 'for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16], ["224.0.0.0", 3]] as const) {',
      f.tools && '  blocked.addSubnet(net, prefix, "ipv4");',
      f.tools && "}",
      f.tools && 'for (const [net, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) {',
      f.tools && '  blocked.addSubnet(net, prefix, "ipv6");',
      f.tools && "}",
      f.tools && "",
      f.tools && "async function checkUrl(url: URL): Promise<void> {",
      f.tools && '  const host = url.hostname.replace(/^\\[|\\]$/g, "");',
      f.tools && "  for (const { address, family } of await lookup(host, { all: true })) {",
      f.tools && '    if (blocked.check(address, family === 6 ? "ipv6" : "ipv4")) throw new Error(`${host} is a private or local address`);',
      f.tools && "  }",
      f.tools && "}",
      f.tools && "",
      f.tools && "async function fetchUrl(url: string): Promise<string> {",
      f.tools && '  if (!/^https?:\\/\\//.test(url)) return "Only http(s) URLs are supported.";',
      f.tools && "  try {",
      f.tools && "    const signal = AbortSignal.timeout(10_000);",
      f.tools && "    let target = new URL(url);",
      f.tools && "    // Follows redirects by hand so every hop goes through checkUrl.",
      f.tools && "    for (let hop = 0; hop < 5; hop++) {",
      f.tools && '      if (!/^https?:$/.test(target.protocol)) return "Only http(s) URLs are supported.";',
      f.tools && "      await checkUrl(target);",
      f.tools && '      const res = await fetch(target, { signal, redirect: "manual" });',
      f.tools && '      const location = res.headers.get("location");',
      f.tools && "      if (res.status < 300 || res.status >= 400 || !location) return (await res.text()).slice(0, 4000);",
      f.tools && "      target = new URL(location, target);",
      f.tools && "    }",
      f.tools && '    return "Fetch failed: too many redirects";',
      f.tools && "  } catch (err) {",
      f.tools && "    return `Fetch failed: ${err}`;",
      f.tools && "  }",
      f.tools && "}",
      "",
      "export async function getSpecs(): Promise<Spec[]> {",
      f.mcp && "  await connect();",
      `  return [...baseTools${f.mcp ? ", ...mcpSpecs()" : ""}];`,
      "}",
      f.sdk && "",
      f.sdk && `export async function getTools(): Promise<${ret}> {`,
      f.sdk && "  const specs = await getSpecs();",
      f.sdk && `  return ${fmt};`,
      f.sdk && "}",
      "",
      "export async function runTool(name: string, args: any): Promise<string> {",
      f.tools && '  if (name === "get_current_time") return new Date().toISOString();',
      f.tools && '  if (name === "fetch_url") return fetchUrl(String(args?.url ?? ""));',
      f.rag && '  if (name === "search_knowledge") return search(String(args?.query ?? ""));',
      f.mcp && "  if (isMcpTool(name)) return callMcpTool(name, args);",
      "  return `Unknown tool: ${name}`;",
      "}",
      "",
    );
  }

  if (f.rag) {
    files["knowledge/about.md"] = knowledgeDoc(o.name);
    files["src/rag.ts"] = `import { readFileSync, readdirSync } from "node:fs";

const dir = new URL("../knowledge/", import.meta.url);

const words = (text: string) => new Set(text.toLowerCase().match(/\\w+/g) ?? []);

function chunks() {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .flatMap((file) =>
      readFileSync(new URL(file, dir), "utf8")
        .split(/\\n\\s*\\n/)
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({ file, text })),
    );
}

/** Ranks paragraphs by how many query words they share. */
export function search(query: string, k = 3): string {
  const q = words(query);
  const hits = chunks()
    .map((c) => ({ ...c, score: [...words(c.text)].filter((w) => q.has(w)).length }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return hits.map((h) => \`[\${h.file}] \${h.text}\`).join("\\n\\n") || "No matching documents.";
}
`;
  }

  if (f.mcp) {
    files["mcp_servers.json"] = MCP_CONFIG;
    files["src/mcp.ts"] = `import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Spec } from "./tools.js";

type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };

const clients = new Map<string, Client>();
const specs: Spec[] = [];
let ready: Promise<void> | undefined;

/** Starts every server in mcp_servers.json. Safe to call more than once. */
export function connect(): Promise<void> {
  ready ??= (async () => {
    let servers: Record<string, ServerConfig> = {};
    try {
      const raw = await readFile(new URL("../mcp_servers.json", import.meta.url), "utf8");
      servers = JSON.parse(raw).servers ?? {};
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    for (const [server, cfg] of Object.entries(servers)) {
      const client = new Client({ name: "${o.name}", version: "0.1.0" });
      await client.connect(
        new StdioClientTransport({
          command: cfg.command,
          args: cfg.args,
          env: cfg.env && { ...(process.env as Record<string, string>), ...cfg.env },
        }),
      );
      clients.set(server, client);
      const { tools } = await client.listTools();
      for (const t of tools) {
        specs.push({ name: \`\${server}__\${t.name}\`, description: t.description ?? "", schema: t.inputSchema });
      }
    }
  })();
  return ready;
}

export const mcpSpecs = () => specs;

export const isMcpTool = (name: string) => clients.has(name.split("__")[0]);

export async function callMcpTool(name: string, args: unknown): Promise<string> {
  const [server, ...rest] = name.split("__");
  const res = await clients.get(server)!.callTool({
    name: rest.join("__"),
    arguments: args as Record<string, unknown>,
  });
  return (res.content as { type: string; text?: string }[])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\\n");
}

export async function closeMcp(): Promise<void> {
  await Promise.all([...clients.values()].map((c) => c.close()));
}
`;
  }

  if (f.http) {
    files["src/server.ts"] = lines(
      'import "dotenv/config";',
      'import { createServer } from "node:http";',
      'import { run } from "./agent.js";',
      f.mcp && 'import { closeMcp } from "./mcp.js";',
      "",
      "createServer(async (req, res) => {",
      '  if (req.method !== "POST" || req.url !== "/chat") {',
      "    res.writeHead(404).end();",
      "    return;",
      "  }",
      '  let body = "";',
      "  for await (const chunk of req) body += chunk;",
      "  try {",
      `    const { message${f.memory ? ", sessionId" : ""} } = JSON.parse(body);`,
      `    const reply = await run(String(message)${f.memory ? ", sessionId" : ""});`,
      '    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply }));',
      "  } catch (err) {",
      '    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: String(err) }));',
      "  }",
      '}).listen(3000, () => console.log("listening on :3000"));',
      f.mcp && "",
      f.mcp && 'process.on("SIGINT", async () => {',
      f.mcp && "  await closeMcp();",
      f.mcp && "  process.exit(0);",
      f.mcp && "});",
      "",
    );
  }

  if (f.docker) {
    files["Dockerfile"] = `FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
${f.http ? 'EXPOSE 3000\nCMD ["npm", "run", "serve"]' : 'CMD ["npm", "run", "dev"]'}
`;
    files[".dockerignore"] = ".env\nnode_modules\ndist\n";
  }

  if (f.tests) {
    const tests = [
      f.tools &&
        `test("get_current_time returns an ISO date", async () => {
  expect(await runTool("get_current_time", {})).toMatch(/T/);
});`,
      f.tools &&
        `test("fetch_url rejects non-http URLs", async () => {
  expect(await runTool("fetch_url", { url: "ftp://example.com" })).toContain("http");
});`,
      f.tools &&
        `test("fetch_url rejects local addresses", async () => {
  for (const url of ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data/"]) {
    expect(await runTool("fetch_url", { url })).toContain("private or local");
  }
});`,
      f.rag &&
        `test("search_knowledge finds the sample document", async () => {
  expect(await runTool("search_knowledge", { query: "generated agent" })).toContain("agent");
});`,
    ].filter(Boolean);
    files["src/agent.test.ts"] = tests.length
      ? `import { expect, test } from "vitest";
import { runTool } from "./tools.js";

${tests.join("\n\n")}
`
      : `import { expect, test } from "vitest";

test("smoke", () => {
  expect(1).toBe(1);
});
`;
  }

  return files;
}

function readme(o: Options, http: boolean): string {
  const n = notes(o);
  return `# ${o.name}

${o.description || "AI agent."}

Provider: **${o.provider}**. Generated by Arkitekt.ai v${VERSION}.

## Getting started

\`\`\`bash
npm install
cp .env.example .env  # fill in your settings
npm run dev
${http ? "npm run serve  # POST /chat on :3000\n" : ""}\`\`\`
${n.length ? "\n## Notes\n\n" + n.map((x) => `- ${x}`).join("\n") + "\n" : ""}`;
}
