import type { Options } from "../catalog";
import { VERSION } from "../version";
import { FETCH_TOOL, MAX_STEPS, MAX_TOKENS, MCP_CONFIG, SEARCH_TOOL, TIME_TOOL, confirmTools, envFile, evalCases, flags, knowledgeDoc, notes } from "./shared";

const lines = (...parts: (string | false)[]) => parts.filter((p): p is string => p !== false).join("\n");

export function typescriptProject(o: Options): Record<string, string> {
  const f = flags(o);
  const sessionParam = f.memory ? ', sessionId = "default"' : "";
  const historyType = f.vercel ? "ModelMessage" : f.anthropic ? "Anthropic.MessageParam" : "OpenAI.ChatCompletionMessageParam";

  const dependencies: Record<string, string> = f.vercel
    ? { ai: "^7.0.0", [f.anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai"]: "^4.0.0", dotenv: "^16.4.5" }
    : { [f.anthropic ? "@anthropic-ai/sdk" : "openai"]: f.anthropic ? "^1.3.0" : "^7.45.0", dotenv: "^16.4.5" };
  if (f.mcp) dependencies["@modelcontextprotocol/sdk"] = "^1.12.0";
  if (f.structured) dependencies["zod"] = "^4.0.0";
  const devDependencies: Record<string, string> = {
    "@types/node": "^22.0.0",
    tsx: "^4.19.0",
    typescript: "^5.6.0",
  };
  if (f.tests) devDependencies["vitest"] = "^2.1.0";

  const scripts: Record<string, string> = { dev: "tsx src/index.ts", build: "tsc" };
  if (f.http) scripts["serve"] = "tsx src/server.ts";
  if (f.structured) scripts["extract"] = "tsx src/extract.ts";
  if (f.evals) scripts["eval"] = "tsx src/evals.ts";
  if (f.tests) scripts["test"] = "vitest run";

  const limits = lines(
    `const maxTokens = Number(process.env.MAX_TOKENS ?? ${MAX_TOKENS});`,
    `const maxSteps = Number(process.env.MAX_STEPS ?? ${MAX_STEPS}); // tool-calling rounds per message`,
  );
  const stopMsg = "`Stopped after ${maxSteps} tool-calling steps without a final answer.`";
  // When streaming, the stop message goes to onText too, so the caller sees why the reply ended.
  const stopped = (indent: string) =>
    f.streaming
      ? lines(`${indent}const note = ${stopMsg};`, `${indent}onText?.(note);`, `${indent}return note;`)
      : `${indent}return ${stopMsg};`;
  const signature = `export async function run(prompt: string${sessionParam}${f.streaming ? ", onText?: (text: string) => void" : ""}): Promise<string> {`;
  const telemetryImport = f.observability && 'import { logEvent, msSince } from "./telemetry.js";';

  const history = lines(
    `const histories = new Map<string, ${historyType}[]>();`,
    "",
    "function historyFor(id: string) {",
    "  let h = histories.get(id);",
    "  if (!h) histories.set(id, (h = []));",
    "  return h;",
    "}",
  );

  const anthropicParams = lines(
    "      model,",
    "      max_tokens: maxTokens,",
    "      system,",
    "      messages,",
    '      cache_control: { type: "ephemeral" }, // caches the prompt so far, re-read on the next step',
    f.needsTools && "      ...(tools.length ? { tools } : {}),",
  );
  const agentAnthropic = lines(
    'import Anthropic from "@anthropic-ai/sdk";',
    telemetryImport,
    f.needsTools && 'import { getTools, runTool } from "./tools.js";',
    "",
    "const client = new Anthropic();",
    `const model = process.env.MODEL ?? "${o.model}";`,
    limits,
    `const system = "You are ${o.name}, a helpful AI agent.";`,
    f.memory && "",
    f.memory && history,
    "",
    signature,
    `  const messages: Anthropic.MessageParam[] = ${f.memory ? "historyFor(sessionId)" : "[]"};`,
    '  messages.push({ role: "user", content: prompt });',
    f.needsTools && "  const tools = await getTools();",
    "  for (let step = 0; step < maxSteps; step++) {",
    f.observability && "    const start = performance.now();",
    f.streaming
      ? lines(
          "    const stream = client.messages.stream({",
          anthropicParams,
          "    });",
          '    if (onText) stream.on("text", onText);',
          "    const resp = await stream.finalMessage();",
        )
      : lines("    const resp = await client.messages.create({", anthropicParams, "    });"),
    f.observability &&
      lines(
        '    logEvent("model_call", {',
        "      step,",
        "      model,",
        "      ms: msSince(start),",
        "      input_tokens: resp.usage.input_tokens,",
        "      output_tokens: resp.usage.output_tokens,",
        "      cache_read_tokens: resp.usage.cache_read_input_tokens,",
        "      stop_reason: resp.stop_reason,",
        "    });",
      ),
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
    stopped("  "),
    "}",
    "",
  );

  const tokensParam = o.provider === "ollama" ? "max_tokens" : "max_completion_tokens";
  const toolContent = (name: string, args: string) =>
    f.needsTools ? `await runTool(${name}, JSON.parse(${args} || "{}"))` : '""';
  const usageEvent = lines(
    '    logEvent("model_call", {',
    "      step,",
    "      model,",
    "      ms: msSince(start),",
    "      input_tokens: usage?.prompt_tokens,",
    "      output_tokens: usage?.completion_tokens,",
    "    });",
  );
  const openaiParams = lines(
    "      model,",
    "      messages,",
    `      ${tokensParam}: maxTokens,`,
    f.streaming && "      stream: true,",
    f.streaming && f.observability && "      stream_options: { include_usage: true },",
    f.needsTools && "      ...(tools.length ? { tools } : {}),",
  );
  const openaiStep = f.streaming
    ? lines(
        "    const stream = await client.chat.completions.create({",
        openaiParams,
        "    });",
        "    // Tool calls arrive in pieces, keyed by index, so they're put back together as the chunks come in.",
        '    let content = "";',
        "    const calls: OpenAI.ChatCompletionMessageFunctionToolCall[] = [];",
        f.observability && "    let usage: OpenAI.CompletionUsage | undefined;",
        "    for await (const chunk of stream) {",
        f.observability && "      usage = chunk.usage ?? usage;",
        "      const delta = chunk.choices[0]?.delta;",
        "      if (delta?.content) {",
        "        content += delta.content;",
        "        onText?.(delta.content);",
        "      }",
        "      for (const tc of delta?.tool_calls ?? []) {",
        '        const call = (calls[tc.index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });',
        "        call.id = tc.id ?? call.id;",
        '        call.function.name += tc.function?.name ?? "";',
        '        call.function.arguments += tc.function?.arguments ?? "";',
        "      }",
        "    }",
        f.observability && usageEvent,
        '    messages.push({ role: "assistant", content, ...(calls.length ? { tool_calls: calls } : {}) });',
        "    if (!calls.length) return content;",
        "    for (const call of calls) {",
        "      messages.push({",
        '        role: "tool",',
        "        tool_call_id: call.id,",
        `        content: ${toolContent("call.function.name", "call.function.arguments")},`,
        "      });",
        "    }",
      )
    : lines(
        "    const resp = await client.chat.completions.create({",
        openaiParams,
        "    });",
        "    const msg = resp.choices[0].message;",
        f.observability && "    const usage = resp.usage;",
        f.observability && usageEvent,
        "    messages.push(msg);",
        '    if (!msg.tool_calls?.length) return msg.content ?? "";',
        "    for (const call of msg.tool_calls) {",
        '      if (call.type !== "function") continue;',
        "      messages.push({",
        '        role: "tool",',
        "        tool_call_id: call.id,",
        `        content: ${toolContent("call.function.name", "call.function.arguments")},`,
        "      });",
        "    }",
      );

  const agentOpenAI = lines(
    'import OpenAI from "openai";',
    telemetryImport,
    f.needsTools && 'import { getTools, runTool } from "./tools.js";',
    "",
    "const client = new OpenAI(); // reads OPENAI_API_KEY and OPENAI_BASE_URL",
    `const model = process.env.MODEL ?? "${o.model}";`,
    limits,
    `const system = "You are ${o.name}, a helpful AI agent.";`,
    f.memory && "",
    f.memory && history,
    "",
    signature,
    `  const messages: OpenAI.ChatCompletionMessageParam[] = ${f.memory ? "historyFor(sessionId)" : "[]"};`,
    '  if (!messages.length) messages.push({ role: "system", content: system });',
    '  messages.push({ role: "user", content: prompt });',
    f.needsTools && "  const tools = await getTools();",
    "  for (let step = 0; step < maxSteps; step++) {",
    f.observability && "    const start = performance.now();",
    openaiStep,
    "  }",
    stopped("  "),
    "}",
    "",
  );

  const agentVercel = lines(
    `import { ${f.streaming ? "streamText" : "generateText"}, jsonSchema, stepCountIs, tool, type ModelMessage } from "ai";`,
    f.anthropic ? 'import { createAnthropic } from "@ai-sdk/anthropic";' : 'import { createOpenAI } from "@ai-sdk/openai";',
    telemetryImport,
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
    signature,
    `  const messages: ModelMessage[] = ${f.memory ? "historyFor(sessionId)" : "[]"};`,
    '  messages.push({ role: "user", content: prompt });',
    f.needsTools && "  const tools = await buildTools();",
    f.observability && "  const start = performance.now();",
    `  const result = ${f.streaming ? "streamText" : "await generateText"}({`,
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
    f.streaming
      ? lines(
          "  for await (const text of result.textStream) onText?.(text);",
          f.observability
            ? "  const [response, steps, finishReason, text] = await Promise.all([result.response, result.steps, result.finishReason, result.text]);"
            : "  const [response, finishReason, text] = await Promise.all([result.response, result.finishReason, result.text]);",
          "  messages.push(...response.messages);",
        )
      : lines(
          `  const { ${f.observability ? "steps, " : ""}finishReason, text } = result;`,
          "  messages.push(...result.response.messages);",
        ),
    f.observability &&
      lines(
        "  steps.forEach((s, step) =>",
        '    logEvent("model_call", { step, model: modelId, input_tokens: s.usage.inputTokens, output_tokens: s.usage.outputTokens, finish_reason: s.finishReason }),',
        "  );",
        '  logEvent("run", { steps: steps.length, ms: msSince(start) });',
      ),
    '  if (finishReason === "tool-calls") {',
    stopped("    "),
    "  }",
    "  return text;",
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
      f.approval && 'import { setApprover } from "./tools.js";',
      "",
      "const rl = readline.createInterface({ input: process.stdin, output: process.stdout });",
      f.approval &&
        "setApprover(async (name, args) => (await rl.question(`\\nallow ${name}(${JSON.stringify(args)})? [y/N] `)).trim().toLowerCase() === \"y\");",
      "while (true) {",
      '  const line = await rl.question("you> ").catch(() => null);',
      "  if (line === null) break;",
      f.streaming
        ? lines(`  await run(line${f.memory ? ', "default"' : ""}, (text) => process.stdout.write(text));`, '  process.stdout.write("\\n");')
        : "  console.log(await run(line));",
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
      f.observability && 'import { logEvent, msSince } from "./telemetry.js";',
      "",
      "export type Spec = { name: string; description: string; schema: Record<string, unknown> };",
      "",
      `const baseTools: Spec[] = ${JSON.stringify(base, null, 2)};`,
      f.approval &&
        lines(
          "",
          "// Tools that reach outside this process. Each call needs a yes from the approver.",
          `const confirmTools = (process.env.CONFIRM_TOOLS ?? "${confirmTools(o)}")`,
          '  .split(",")',
          "  .map((p) => p.trim())",
          "  .filter(Boolean)",
          '  .map((p) => new RegExp(`^${p.split("*").map((s) => s.replace(/[.+?^${}()|[\\]\\\\]/g, "\\\\$&")).join(".*")}$`));',
          "",
          "export type Approver = (name: string, args: unknown) => Promise<boolean>;",
          "",
          "let approver: Approver = async () => false;",
          "",
          "/** Decides whether a tool in CONFIRM_TOOLS may run. The CLI asks in the terminal; without one, calls are declined. */",
          "export function setApprover(fn: Approver): void {",
          "  approver = fn;",
          "}",
        ),
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
      (f.approval || f.observability) &&
        lines(
          "export async function runTool(name: string, args: any): Promise<string> {",
          f.approval && "  if (confirmTools.some((re) => re.test(name)) && !(await approver(name, args))) {",
          f.approval && '    return "The user declined this tool call.";',
          f.approval && "  }",
          f.observability && "  const start = performance.now();",
          f.observability && "  const result = await callTool(name, args);",
          f.observability && '  logEvent("tool_call", { name, ms: msSince(start), chars: result.length });',
          f.observability ? "  return result;" : "  return callTool(name, args);",
          "}",
          "",
        ),
      `${f.approval || f.observability ? "async function callTool" : "export async function runTool"}(name: string, args: any): Promise<string> {`,
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
    const sess = f.memory ? ", sessionId" : "";
    files["src/server.ts"] = lines(
      'import "dotenv/config";',
      'import { createServer } from "node:http";',
      'import { run } from "./agent.js";',
      f.mcp && 'import { closeMcp } from "./mcp.js";',
      "",
      `const routes = ${f.streaming ? '["/chat", "/chat/stream"]' : '["/chat"]'};`,
      "",
      "createServer(async (req, res) => {",
      '  if (req.method !== "POST" || !routes.includes(req.url ?? "")) {',
      "    res.writeHead(404).end();",
      "    return;",
      "  }",
      '  let body = "";',
      "  for await (const chunk of req) body += chunk;",
      "  try {",
      `    const { message${sess} } = JSON.parse(body);`,
      f.streaming &&
        lines(
          '    if (req.url === "/chat/stream") {',
          "      // Server-sent events, one JSON-encoded text chunk per event.",
          '      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });',
          `      await run(String(message)${sess}, (text) => res.write(\`data: \${JSON.stringify(text)}\\n\\n\`));`,
          '      res.end("event: done\\ndata: {}\\n\\n");',
          "      return;",
          "    }",
        ),
      `    const reply = await run(String(message)${sess});`,
      '    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ reply }));',
      "  } catch (err) {",
      f.streaming &&
        lines(
          "    if (res.headersSent) {",
          "      res.end(`event: error\\ndata: ${JSON.stringify(String(err))}\\n\\n`);",
          "      return;",
          "    }",
        ),
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

  if (f.observability) {
    files["src/telemetry.ts"] = `/** Writes one JSON line to stderr. Send it to any log collector, or swap this module for OpenTelemetry. */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stderr.write(JSON.stringify({ ts: Date.now() / 1000, event, ...fields }) + "\\n");
}

export const msSince = (start: number) => Math.round(performance.now() - start);
`;
  }

  if (f.structured) {
    files["src/schemas.ts"] = `import { z } from "zod";

/** What extract() pulls out of free text. Change the fields to fit your data. */
export const Contact = z.strictObject({
  name: z.string(),
  email: z.string().describe("Empty if the text has none"),
  company: z.string().describe("Empty if the text has none"),
});
export type Contact = z.infer<typeof Contact>;

// The $schema key is dropped because provider APIs don't expect it.
const { $schema: _, ...contactJsonSchema } = z.toJSONSchema(Contact);
export { contactJsonSchema };
`;
    files["src/extract.ts"] = extractTs(o, f);
  }

  if (f.evals) {
    files["evals/cases.json"] = evalCases(o);
    files["src/evals.ts"] = lines(
      'import "dotenv/config";',
      'import { readFile } from "node:fs/promises";',
      'import { fileURLToPath } from "node:url";',
      "",
      "export type EvalCase = { input: string; contains?: string[] };",
      "",
      "/** Returns the phrases from contains that are missing from the output, ignoring case. */",
      "export function check(output: string, c: EvalCase): string[] {",
      "  return (c.contains ?? []).filter((p) => !output.toLowerCase().includes(p.toLowerCase()));",
      "}",
      "",
      "async function main() {",
      "  // Imported here so the tests can use check() without an API key.",
      '  const { run } = await import("./agent.js");',
      '  const cases: EvalCase[] = JSON.parse(await readFile(new URL("../evals/cases.json", import.meta.url), "utf8"));',
      "  let failed = 0;",
      "  for (const [i, c] of cases.entries()) {",
      `    const missing = check(await run(c.input${f.memory ? ", `eval-${i}`" : ""}), c);`,
      "    if (missing.length) failed++;",
      '    console.log(`${missing.length ? "FAIL" : "PASS"}  ${c.input}${missing.length ? `  missing: ${missing.join(", ")}` : ""}`);',
      "  }",
      "  console.log(`\\n${cases.length - failed}/${cases.length} passed`);",
      f.mcp && '  await (await import("./mcp.js")).closeMcp();',
      "  process.exitCode = failed ? 1 : 0;",
      "}",
      "",
      "if (process.argv[1] === fileURLToPath(import.meta.url)) await main();",
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
    const toolTests = [
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
      f.approval &&
        f.tools &&
        `test("tools that need approval are declined without it", async () => {
  setApprover(async () => false);
  expect(await runTool("fetch_url", { url: "https://example.com" })).toContain("declined");
});`,
    ].filter(Boolean) as string[];
    const otherTests = [
      f.structured &&
        `test("Contact validates extracted data", () => {
  expect(Contact.parse({ name: "Ana", email: "", company: "" }).name).toBe("Ana");
  expect(() => Contact.parse({ name: "Ana" })).toThrow();
});`,
      f.evals &&
        `test("check reports missing phrases", () => {
  expect(check("Hello World", { input: "", contains: ["hello", "bye"] })).toEqual(["bye"]);
});`,
      f.observability &&
        `test("logEvent writes one JSON line", () => {
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  logEvent("tool_call", { name: "x" });
  expect(JSON.parse(String(write.mock.calls[0][0])).event).toBe("tool_call");
  write.mockRestore();
});`,
    ].filter(Boolean) as string[];
    const tests = [...toolTests, ...otherTests];
    const approvalHook = f.approval && f.tools;
    const vitest = ["beforeEach", "expect", "test", "vi"].filter(
      (n) => (n !== "beforeEach" || approvalHook) && (n !== "vi" || f.observability),
    );
    files["src/agent.test.ts"] = tests.length
      ? lines(
          `import { ${vitest.join(", ")} } from "vitest";`,
          f.evals && 'import { check } from "./evals.js";',
          f.structured && 'import { Contact } from "./schemas.js";',
          f.observability && 'import { logEvent } from "./telemetry.js";',
          toolTests.length > 0 && `import { runTool${f.approval ? ", setApprover" : ""} } from "./tools.js";`,
          approvalHook && "\nbeforeEach(() => setApprover(async () => true));",
          "",
          tests.join("\n\n"),
          "",
        )
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
  const f = flags(o);
  return `# ${o.name}

${o.description || "AI agent."}

Provider: **${o.provider}**. Generated by Arkitekt.ai v${VERSION}.

## Getting started

\`\`\`bash
npm install
cp .env.example .env  # fill in your settings
npm run dev
${http ? `npm run serve  # POST /chat${f.streaming ? " and /chat/stream" : ""} on :3000\n` : ""}${f.structured ? 'npm run extract -- "Ana Silva, ana@example.com, works at Acme"\n' : ""}${f.evals ? "npm run eval\n" : ""}\`\`\`
${n.length ? "\n## Notes\n\n" + n.map((x) => `- ${x}`).join("\n") + "\n" : ""}`;
}

function extractTs(o: Options, f: ReturnType<typeof flags>): string {
  const system = 'const system = "Extract the contact details from the user\'s text. Use an empty string for anything missing.";';
  const main = lines(
    "",
    "if (process.argv[1] === fileURLToPath(import.meta.url)) {",
    '  console.log(JSON.stringify(await extract(process.argv.slice(2).join(" ")), null, 2));',
    "}",
    "",
  );
  const head = (imports: string[]) =>
    lines('import "dotenv/config";', 'import { fileURLToPath } from "node:url";', ...imports, "");
  const limits = lines(`const model = process.env.MODEL ?? "${o.model}";`, `const maxTokens = Number(process.env.MAX_TOKENS ?? ${MAX_TOKENS});`, system);
  if (f.vercel) {
    return lines(
      head([
        'import { generateText, Output } from "ai";',
        f.anthropic ? 'import { createAnthropic } from "@ai-sdk/anthropic";' : 'import { createOpenAI } from "@ai-sdk/openai";',
        'import { Contact } from "./schemas.js";',
      ]),
      limits.replace("const model =", "const modelId ="),
      f.anthropic ? "const model = createAnthropic()(modelId);" : "const model = createOpenAI({ baseURL: process.env.OPENAI_BASE_URL }).chat(modelId);",
      "",
      "/** Pulls a Contact out of free text, validated against the schema. */",
      "export async function extract(text: string): Promise<Contact> {",
      "  const { output } = await generateText({ model, system, prompt: text, maxOutputTokens: maxTokens, output: Output.object({ schema: Contact }) });",
      "  return output;",
      "}",
      main,
    );
  }
  if (f.anthropic) {
    return lines(
      head(['import Anthropic from "@anthropic-ai/sdk";', 'import { Contact, contactJsonSchema } from "./schemas.js";']),
      "const client = new Anthropic();",
      limits,
      "",
      "/** Pulls a Contact out of free text, validated against the schema. */",
      "export async function extract(text: string): Promise<Contact> {",
      "  const resp = await client.messages.create({",
      "    model,",
      "    max_tokens: maxTokens,",
      "    system,",
      '    messages: [{ role: "user", content: text }],',
      '    tools: [{ name: "record_contact", description: "Records the contact details found in the text.", input_schema: contactJsonSchema as Anthropic.Tool["input_schema"] }],',
      "    // Forcing the tool makes the model answer with arguments that follow the schema.",
      '    tool_choice: { type: "tool", name: "record_contact" },',
      "  });",
      '  return Contact.parse(resp.content.find((b) => b.type === "tool_use")?.input);',
      "}",
      main,
    );
  }
  return lines(
    head(['import OpenAI from "openai";', 'import { Contact, contactJsonSchema } from "./schemas.js";']),
    "const client = new OpenAI();",
    limits,
    "",
    "/** Pulls a Contact out of free text, validated against the schema. */",
    "export async function extract(text: string): Promise<Contact> {",
    "  const resp = await client.chat.completions.create({",
    "    model,",
    "    messages: [",
    '      { role: "system", content: system },',
    '      { role: "user", content: text },',
    "    ],",
    `    ${o.provider === "ollama" ? "max_tokens" : "max_completion_tokens"}: maxTokens,`,
    '    response_format: { type: "json_schema", json_schema: { name: "contact", schema: contactJsonSchema, strict: true } },',
    "  });",
    '  return Contact.parse(JSON.parse(resp.choices[0].message.content ?? "{}"));',
    "}",
    main,
  );
}
