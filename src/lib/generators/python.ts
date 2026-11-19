import type { Options } from "../catalog";
import { VERSION } from "../version";
import { FETCH_TOOL, MAX_STEPS, MAX_TOKENS, MCP_CONFIG, SEARCH_TOOL, TIME_TOOL, confirmTools, envFile, evalCases, flags, knowledgeDoc, notes } from "./shared";

const lines = (...parts: (string | false)[]) => parts.filter((p): p is string => p !== false).join("\n");

export function pythonProject(o: Options): Record<string, string> {
  const pkg = o.name.replace(/-/g, "_");
  const f = flags(o);

  const deps = f.langgraph
    ? ["langchain>=1.0", "langgraph>=1.0", f.anthropic ? "langchain-anthropic>=1.0" : "langchain-openai>=1.0", "python-dotenv"]
    : [f.anthropic ? "anthropic>=2,<3" : "openai>=3,<4", "python-dotenv"];
  if (f.mcp) deps.push("mcp>=1.2");
  if (f.structured) deps.push("pydantic>=2,<3");
  if (f.http) deps.push("fastapi", "uvicorn");
  if (f.tests) deps.push("pytest");

  const sessionParam = f.memory ? ', session_id: str = "default"' : "";
  const streamParam = f.streaming ? ", on_text: Callable[[str], None] | None = None" : "";
  const signature = `async def run(prompt: str${sessionParam}${streamParam}) -> str:`;
  const limits = [
    `MAX_TOKENS = int(os.getenv("MAX_TOKENS", "${MAX_TOKENS}"))`,
    `MAX_STEPS = int(os.getenv("MAX_STEPS", "${MAX_STEPS}"))  # tool-calling rounds per message`,
  ].join("\n");
  const stopMsg = 'f"Stopped after {MAX_STEPS} tool-calling steps without a final answer."';
  // When streaming, the stop message goes to on_text too, so the caller sees why the reply ended.
  const stopped = (indent: string) =>
    f.streaming
      ? lines(`${indent}note = ${stopMsg}`, `${indent}if on_text:`, `${indent}    on_text(note)`, `${indent}return note`)
      : `${indent}return ${stopMsg}`;
  const header = (sdkImport: string) =>
    lines(
      f.needsTools && f.sdk && !f.anthropic && "import json",
      "import os",
      f.observability && "import time",
      f.memory && "from collections import defaultdict",
      f.streaming && "from collections.abc import Callable",
      "",
      sdkImport,
      (f.needsTools || f.observability) && "",
      f.observability && "from . import telemetry",
      f.needsTools && (f.sdk ? "from .tools import get_tools, run_tool" : "from .tools import get_specs, run_tool"),
    );
  const memory = lines(
    "# One message history per session id, kept in memory.",
    "HISTORY: dict[str, list] = defaultdict(list)",
  );

  const agentAnthropic = lines(
    header("from anthropic import AsyncAnthropic"),
    "",
    "client = AsyncAnthropic()",
    `MODEL = os.getenv("MODEL", "${o.model}")`,
    limits,
    `SYSTEM = "You are ${o.name}, a helpful AI agent."`,
    f.memory && "",
    f.memory && memory,
    "",
    "",
    signature,
    `    messages = ${f.memory ? "HISTORY[session_id]" : "[]"}`,
    '    messages.append({"role": "user", "content": prompt})',
    f.needsTools && "    tools = await get_tools()",
    f.needsTools && '    extra = {"tools": tools} if tools else {}',
    `    for ${f.observability ? "step" : "_"} in range(MAX_STEPS):`,
    f.observability && "        start = time.perf_counter()",
    f.streaming ? "        async with client.messages.stream(" : "        resp = await client.messages.create(",
    "            model=MODEL,",
    "            max_tokens=MAX_TOKENS,",
    "            system=SYSTEM,",
    "            messages=messages,",
    "            cache_control={\"type\": \"ephemeral\"},  # caches the prompt so far, re-read on the next step",
    f.needsTools && "            **extra,",
    f.streaming
      ? lines(
          "        ) as stream:",
          "            async for text in stream.text_stream:",
          "                if on_text:",
          "                    on_text(text)",
          "            resp = await stream.get_final_message()",
        )
      : "        )",
    f.observability &&
      lines(
        "        telemetry.event(",
        '            "model_call",',
        "            step=step,",
        "            model=MODEL,",
        "            ms=telemetry.ms_since(start),",
        "            input_tokens=resp.usage.input_tokens,",
        "            output_tokens=resp.usage.output_tokens,",
        "            cache_read_tokens=resp.usage.cache_read_input_tokens,",
        "            stop_reason=resp.stop_reason,",
        "        )",
      ),
    '        messages.append({"role": "assistant", "content": resp.content})',
    '        if resp.stop_reason != "tool_use":',
    '            return "".join(b.text for b in resp.content if b.type == "text")',
    "        results = [",
    `            {"type": "tool_result", "tool_use_id": b.id, "content": ${f.needsTools ? "await run_tool(b.name, b.input)" : '""'}}`,
    "            for b in resp.content",
    '            if b.type == "tool_use"',
    "        ]",
    '        messages.append({"role": "user", "content": results})',
    stopped("    "),
    "",
  );

  const tokensParam = o.provider === "ollama" ? "max_tokens" : "max_completion_tokens";
  const toolResult = (name: string, args: string) =>
    f.needsTools ? `await run_tool(${name}, json.loads(${args} or "{}"))` : '""';
  const usageEvent = lines(
    "        telemetry.event(",
    '            "model_call",',
    "            step=step,",
    "            model=MODEL,",
    "            ms=telemetry.ms_since(start),",
    "            input_tokens=usage.prompt_tokens if usage else None,",
    "            output_tokens=usage.completion_tokens if usage else None,",
    "        )",
  );
  const openaiCall = lines(
    "            model=MODEL,",
    "            messages=messages,",
    `            ${tokensParam}=MAX_TOKENS,`,
    f.streaming && "            stream=True,",
    f.streaming && f.observability && '            stream_options={"include_usage": True},',
    f.needsTools && "            **extra,",
    "        )",
  );
  const openaiStep = f.streaming
    ? lines(
        "        stream = await client.chat.completions.create(",
        openaiCall,
        "        # Tool calls arrive in pieces, keyed by index, so they're put back together as the chunks come in.",
        `        content, calls${f.observability ? ", usage" : ""} = "", {}${f.observability ? ", None" : ""}`,
        "        async for chunk in stream:",
        f.observability && "            usage = chunk.usage or usage",
        "            if not chunk.choices:",
        "                continue",
        "            delta = chunk.choices[0].delta",
        "            if delta.content:",
        "                content += delta.content",
        "                if on_text:",
        "                    on_text(delta.content)",
        "            for tc in delta.tool_calls or []:",
        '                call = calls.setdefault(tc.index, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}})',
        '                call["id"] = tc.id or call["id"]',
        "                if tc.function:",
        '                    call["function"]["name"] += tc.function.name or ""',
        '                    call["function"]["arguments"] += tc.function.arguments or ""',
        f.observability && usageEvent,
        "        tool_calls = list(calls.values())",
        '        messages.append({"role": "assistant", "content": content, **({"tool_calls": tool_calls} if tool_calls else {})})',
        "        if not tool_calls:",
        "            return content",
        "        for call in tool_calls:",
        "            messages.append({",
        '                "role": "tool",',
        '                "tool_call_id": call["id"],',
        `                "content": ${toolResult('call["function"]["name"]', 'call["function"]["arguments"]')},`,
        "            })",
      )
    : lines(
        "        resp = await client.chat.completions.create(",
        openaiCall,
        "        msg = resp.choices[0].message",
        f.observability && "        usage = resp.usage",
        f.observability && usageEvent,
        "        messages.append(msg)",
        "        if not msg.tool_calls:",
        '            return msg.content or ""',
        "        for call in msg.tool_calls:",
        "            messages.append({",
        '                "role": "tool",',
        '                "tool_call_id": call.id,',
        `                "content": ${toolResult("call.function.name", "call.function.arguments")},`,
        "            })",
      );

  const agentOpenAI = lines(
    header("from openai import AsyncOpenAI"),
    "",
    "client = AsyncOpenAI()  # reads OPENAI_API_KEY and OPENAI_BASE_URL",
    `MODEL = os.getenv("MODEL", "${o.model}")`,
    limits,
    `SYSTEM = "You are ${o.name}, a helpful AI agent."`,
    f.memory && "",
    f.memory && memory,
    "",
    "",
    signature,
    `    messages = ${f.memory ? "HISTORY[session_id]" : "[]"}`,
    "    if not messages:",
    '        messages.append({"role": "system", "content": SYSTEM})',
    '    messages.append({"role": "user", "content": prompt})',
    f.needsTools && "    tools = await get_tools()",
    f.needsTools && '    extra = {"tools": tools} if tools else {}',
    `    for ${f.observability ? "step" : "_"} in range(MAX_STEPS):`,
    f.observability && "        start = time.perf_counter()",
    openaiStep,
    stopped("    "),
    "",
  );

  const chatModel = f.anthropic
    ? "ChatAnthropic(model=MODEL, max_tokens=MAX_TOKENS)"
    : 'ChatOpenAI(model=MODEL, base_url=os.getenv("OPENAI_BASE_URL"), max_tokens=MAX_TOKENS)';
  const agentLangGraph = lines(
    "import os",
    f.observability && "import time",
    f.streaming && "from collections.abc import Callable",
    "",
    f.anthropic ? "from langchain_anthropic import ChatAnthropic" : "from langchain_openai import ChatOpenAI",
    "from langchain.agents import create_agent",
    f.anthropic && "from langchain_anthropic.middleware import AnthropicPromptCachingMiddleware",
    f.needsTools && "from langchain_core.tools import StructuredTool",
    f.memory && "from langgraph.checkpoint.memory import InMemorySaver",
    "from langgraph.errors import GraphRecursionError",
    (f.needsTools || f.observability) && "",
    f.observability && "from . import telemetry",
    f.needsTools && "from .tools import get_specs, run_tool",
    "",
    `MODEL = os.getenv("MODEL", "${o.model}")`,
    limits,
    `SYSTEM = "You are ${o.name}, a helpful AI agent."`,
    "",
    "_agent = None",
    "",
    "",
    f.needsTools && "def _runner(name: str):",
    f.needsTools && "    async def call(**kwargs) -> str:",
    f.needsTools && "        return await run_tool(name, kwargs)",
    f.needsTools && "",
    f.needsTools && "    return call",
    f.needsTools && "",
    f.needsTools && "",
    "async def _get_agent():",
    "    global _agent",
    "    if _agent is None:",
    `        model = ${chatModel}`,
    f.needsTools
      ? `        tools = [
            StructuredTool(name=s["name"], description=s["description"], args_schema=s["schema"], coroutine=_runner(s["name"]))
            for s in await get_specs()
        ]`
      : "        tools = []",
    `        _agent = create_agent(model, tools, system_prompt=SYSTEM${f.anthropic ? ", middleware=[AnthropicPromptCachingMiddleware()]" : ""}${f.memory ? ", checkpointer=InMemorySaver()" : ""})`,
    "    return _agent",
    "",
    "",
    f.observability &&
      lines(
        "def _log_steps(messages: list, start: float) -> None:",
        '    """Logs the model calls since the last user message, from the usage on each AI message."""',
        '    turn = max(i for i, m in enumerate(messages) if m.type == "human")',
        '    steps = [m for m in messages[turn + 1 :] if m.type == "ai"]',
        "    for step, m in enumerate(steps):",
        "        usage = m.usage_metadata or {}",
        '        telemetry.event("model_call", step=step, model=MODEL, input_tokens=usage.get("input_tokens"), output_tokens=usage.get("output_tokens"))',
        '    telemetry.event("run", steps=len(steps), ms=telemetry.ms_since(start))',
        "",
        "",
      ),
    signature,
    "    agent = await _get_agent()",
    "    # Each step is a model node plus a tools node. An even limit stops right after the tools run,",
    "    # so a remembered thread never ends on a tool call without its result.",
    `    config = {${f.memory ? '"configurable": {"thread_id": session_id}, ' : ""}"recursion_limit": 2 * MAX_STEPS}`,
    '    inputs = {"messages": [{"role": "user", "content": prompt}]}',
    f.observability && "    start = time.perf_counter()",
    "    try:",
    f.streaming
      ? lines(
          "        result: dict = {}",
          '        async for mode, data in agent.astream(inputs, config, stream_mode=["messages", "values"]):',
          '            if mode == "values":',
          "                result = data",
          "                continue",
          "            chunk, meta = data",
          '            if on_text and meta.get("langgraph_node") == "model" and chunk.text:',
          "                on_text(chunk.text)",
        )
      : "        result = await agent.ainvoke(inputs, config)",
    "    except GraphRecursionError:",
    stopped("        "),
    f.observability && '    _log_steps(result["messages"], start)',
    '    return str(result["messages"][-1].text)',
    "",
  );

  const files: Record<string, string> = {
    "pyproject.toml": `[project]
name = "${o.name}"
version = "0.1.0"
description = "${o.description || "AI agent generated by Arkitekt.ai"}"
requires-python = ">=3.10"
dependencies = [
${deps.map((d) => `    "${d}",`).join("\n")}
]

[build-system]
requires = ["setuptools"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]
`,
    ".env.example": envFile(o),
    ".gitignore": ".env\n__pycache__/\n.venv/\n*.egg-info/\n",
    [`src/${pkg}/__init__.py`]: "",
    [`src/${pkg}/agent.py`]: f.langgraph ? agentLangGraph : f.anthropic ? agentAnthropic : agentOpenAI,
    [`src/${pkg}/__main__.py`]: mainPy(f),
    "README.md": readme(o, [
      "python -m venv .venv && source .venv/bin/activate  # Windows: .venv\\Scripts\\activate",
      "pip install -e .",
      "cp .env.example .env  # fill in your settings",
      `python -m ${pkg}`,
      ...(f.http ? [`uvicorn ${pkg}.server:app --reload  # POST /chat${f.streaming ? ", POST /chat/stream" : ""}`] : []),
      ...(f.structured ? [`python -m ${pkg}.extract "Ana Silva, ana@example.com, works at Acme"`] : []),
      ...(f.evals ? [`python -m ${pkg}.evals`] : []),
    ]),
  };

  if (f.needsTools) {
    const base = [f.tools && TIME_TOOL, f.tools && FETCH_TOOL, f.rag && SEARCH_TOOL].filter(Boolean);
    const fmt = f.anthropic
      ? '{"name": s["name"], "description": s["description"], "input_schema": s["schema"]}'
      : '{"type": "function", "function": {"name": s["name"], "description": s["description"], "parameters": s["schema"]}}';
    const wrap = f.approval || f.observability;
    files[`src/${pkg}/tools.py`] = lines(
      f.tools && "import asyncio",
      f.approval && "import fnmatch",
      f.tools && "import ipaddress",
      f.approval && "import os",
      f.tools && "import socket",
      f.observability && "import time",
      f.tools && "import urllib.parse",
      f.tools && "import urllib.request",
      f.approval && "from collections.abc import Awaitable, Callable",
      f.tools && "from datetime import datetime, timezone",
      (f.rag || f.mcp || f.observability) && "",
      f.rag && "from . import rag",
      f.mcp && "from . import mcp_client",
      f.observability && "from . import telemetry",
      "",
      `BASE_TOOLS: list[dict] = ${JSON.stringify(base, null, 4)}`,
      f.approval &&
        lines(
          "",
          "# Tools that reach outside this process. Each call needs a yes from the approver.",
          `CONFIRM_TOOLS = [p.strip() for p in os.getenv("CONFIRM_TOOLS", "${confirmTools(o)}").split(",") if p.strip()]`,
          "",
          "Approver = Callable[[str, dict], Awaitable[bool]]",
          "",
          "",
          "async def _decline(name: str, args: dict) -> bool:",
          "    return False",
          "",
          "",
          "_approver: Approver = _decline",
          "",
          "",
          "def set_approver(approver: Approver) -> None:",
          '    """Decides whether a tool in CONFIRM_TOOLS may run. The CLI asks in the terminal; without one, calls are declined."""',
          "    global _approver",
          "    _approver = approver",
        ),
      f.tools && "",
      f.tools && "",
      f.tools && "def _check_url(url: str) -> None:",
      f.tools && '    """Rejects URLs that point at this machine or a private network."""',
      f.tools && "    host = urllib.parse.urlsplit(url).hostname",
      f.tools && "    if not host:",
      f.tools && '        raise ValueError("the URL has no host")',
      f.tools && "    for *_, addr in socket.getaddrinfo(host, None):",
      f.tools && "        if not ipaddress.ip_address(addr[0]).is_global:",
      f.tools && '            raise ValueError(f"{host} is a private or local address")',
      f.tools && "",
      f.tools && "",
      f.tools && "class _CheckedRedirects(urllib.request.HTTPRedirectHandler):",
      f.tools && "    def redirect_request(self, req, fp, code, msg, headers, newurl):",
      f.tools && "        _check_url(newurl)",
      f.tools && "        return super().redirect_request(req, fp, code, msg, headers, newurl)",
      f.tools && "",
      f.tools && "",
      f.tools && "_opener = urllib.request.build_opener(_CheckedRedirects)",
      f.tools && "",
      f.tools && "",
      f.tools && "def _fetch(url: str) -> str:",
      f.tools && '    if not url.startswith(("http://", "https://")):',
      f.tools && '        return "Only http(s) URLs are supported."',
      f.tools && "    try:",
      f.tools && "        _check_url(url)",
      f.tools && "        with _opener.open(url, timeout=10) as res:",
      f.tools && '            return res.read(4000).decode("utf-8", errors="replace")',
      f.tools && "    except Exception as err:",
      f.tools && '        return f"Fetch failed: {err}"',
      "",
      "",
      "async def get_specs() -> list[dict]:",
      "    specs = list(BASE_TOOLS)",
      f.mcp && "    await mcp_client.connect()",
      f.mcp && "    specs += mcp_client.specs()",
      "    return specs",
      f.sdk && "",
      f.sdk && "",
      f.sdk && "async def get_tools() -> list[dict]:",
      f.sdk && `    return [${fmt} for s in await get_specs()]`,
      "",
      "",
      wrap &&
        lines(
          "async def run_tool(name: str, args: dict) -> str:",
          f.approval && "    if any(fnmatch.fnmatchcase(name, p) for p in CONFIRM_TOOLS) and not await _approver(name, args):",
          f.approval && '        return "The user declined this tool call."',
          f.observability && "    start = time.perf_counter()",
          f.observability && "    result = await _call(name, args)",
          f.observability && '    telemetry.event("tool_call", name=name, ms=telemetry.ms_since(start), chars=len(result))',
          f.observability ? "    return result" : "    return await _call(name, args)",
          "",
          "",
        ),
      `async def ${wrap ? "_call" : "run_tool"}(name: str, args: dict) -> str:`,
      f.tools && '    if name == "get_current_time":',
      f.tools && "        return datetime.now(timezone.utc).isoformat()",
      f.tools && '    if name == "fetch_url":',
      f.tools && '        return await asyncio.to_thread(_fetch, str(args.get("url", "")))',
      f.rag && '    if name == "search_knowledge":',
      f.rag && '        return rag.search(str(args.get("query", "")))',
      f.mcp && "    if mcp_client.owns(name):",
      f.mcp && "        return await mcp_client.call(name, args)",
      '    return f"Unknown tool: {name}"',
      "",
    );
  }

  if (f.rag) {
    files["knowledge/about.md"] = knowledgeDoc(o.name);
    files[`src/${pkg}/rag.py`] = `import re
from pathlib import Path

DOCS = Path(__file__).resolve().parents[2] / "knowledge"


def _words(text: str) -> set[str]:
    return set(re.findall(r"\\w+", text.lower()))


def _chunks():
    for path in sorted(DOCS.glob("*.md")):
        for part in re.split(r"\\n\\s*\\n", path.read_text(encoding="utf-8")):
            if part.strip():
                yield path.name, part.strip()


def search(query: str, k: int = 3) -> str:
    """Ranks paragraphs by how many query words they share."""
    q = _words(query)
    scored = sorted(((len(q & _words(c)), n, c) for n, c in _chunks()), reverse=True)
    hits = [f"[{n}] {c}" for score, n, c in scored[:k] if score > 0]
    return "\\n\\n".join(hits) or "No matching documents."
`;
  }

  if (f.mcp) {
    files["mcp_servers.json"] = MCP_CONFIG;
    files[`src/${pkg}/mcp_client.py`] = `import json
from contextlib import AsyncExitStack
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

CONFIG = Path(__file__).resolve().parents[2] / "mcp_servers.json"

_stack = AsyncExitStack()
_sessions: dict[str, ClientSession] = {}
_specs: list[dict] = []
_connected = False


async def connect() -> None:
    """Starts every server in mcp_servers.json. Safe to call more than once."""
    global _connected
    if _connected:
        return
    _connected = True
    if not CONFIG.exists():
        return
    servers = json.loads(CONFIG.read_text(encoding="utf-8")).get("servers", {})
    for server, cfg in servers.items():
        params = StdioServerParameters(command=cfg["command"], args=cfg.get("args", []), env=cfg.get("env"))
        read, write = await _stack.enter_async_context(stdio_client(params))
        session = await _stack.enter_async_context(ClientSession(read, write))
        await session.initialize()
        _sessions[server] = session
        for tool in (await session.list_tools()).tools:
            _specs.append({
                "name": f"{server}__{tool.name}",
                "description": tool.description or "",
                "schema": getattr(tool, "inputSchema", None) or tool.input_schema,  # mcp 1.x / 2.x
            })


def specs() -> list[dict]:
    return _specs


def owns(name: str) -> bool:
    return name.split("__", 1)[0] in _sessions


async def call(name: str, args: dict) -> str:
    server, tool = name.split("__", 1)
    result = await _sessions[server].call_tool(tool, args)
    return "\\n".join(c.text for c in result.content if c.type == "text")


async def close() -> None:
    await _stack.aclose()
`;
  }

  if (f.http) {
    files[`src/${pkg}/server.py`] = lines(
      f.streaming && "import asyncio",
      f.streaming && "import json",
      f.mcp && "from contextlib import asynccontextmanager",
      (f.mcp || f.streaming) && "",
      "from dotenv import load_dotenv",
      "",
      "load_dotenv()",
      "",
      "from fastapi import FastAPI  # noqa: E402",
      f.streaming && "from fastapi.responses import StreamingResponse  # noqa: E402",
      "from pydantic import BaseModel  # noqa: E402",
      "",
      f.mcp && "from . import mcp_client  # noqa: E402",
      "from .agent import run  # noqa: E402",
      "",
      f.mcp && "",
      f.mcp && "@asynccontextmanager",
      f.mcp && "async def lifespan(_: FastAPI):",
      f.mcp && "    await mcp_client.connect()",
      f.mcp && "    yield",
      f.mcp && "    await mcp_client.close()",
      f.mcp && "",
      f.mcp && "",
      `app = FastAPI(title="${o.name}"${f.mcp ? ", lifespan=lifespan" : ""})`,
      "",
      "",
      "class ChatRequest(BaseModel):",
      "    message: str",
      f.memory && '    session_id: str = "default"',
      "",
      "",
      '@app.post("/chat")',
      "async def chat(req: ChatRequest):",
      `    return {"reply": await run(req.message${f.memory ? ", req.session_id" : ""})}`,
      f.streaming &&
        lines(
          "",
          "",
          '@app.post("/chat/stream")',
          "async def chat_stream(req: ChatRequest):",
          '    """Sends the reply as server-sent events, one JSON-encoded text chunk per event."""',
          "    queue: asyncio.Queue[str | None] = asyncio.Queue()",
          "",
          "    async def produce() -> None:",
          "        try:",
          `            await run(req.message${f.memory ? ", req.session_id" : ""}, on_text=queue.put_nowait)`,
          "        finally:",
          "            queue.put_nowait(None)",
          "",
          "    async def events():",
          "        task = asyncio.create_task(produce())",
          "        while (text := await queue.get()) is not None:",
          '            yield f"data: {json.dumps(text)}\\n\\n"',
          "        await task",
          '        yield "event: done\\ndata: {}\\n\\n"',
          "",
          '    return StreamingResponse(events(), media_type="text/event-stream")',
        ),
      "",
    );
  }

  if (f.observability) {
    files[`src/${pkg}/telemetry.py`] = `import json
import sys
import time


def event(kind: str, /, **fields) -> None:
    """Writes one JSON line to stderr. Send it to any log collector, or swap this module for OpenTelemetry."""
    print(json.dumps({"ts": round(time.time(), 3), "event": kind, **fields}), file=sys.stderr, flush=True)


def ms_since(start: float) -> int:
    return round((time.perf_counter() - start) * 1000)
`;
  }

  if (f.structured) {
    files[`src/${pkg}/schemas.py`] = `from pydantic import BaseModel, ConfigDict, Field


class Contact(BaseModel):
    """What extract() pulls out of free text. Change the fields to fit your data."""

    model_config = ConfigDict(extra="forbid")  # strict JSON schemas need additionalProperties: false

    name: str
    email: str = Field(description="Empty if the text has none")
    company: str = Field(description="Empty if the text has none")
`;
    files[`src/${pkg}/extract.py`] = extractPy(o, f);
  }

  if (f.evals) {
    files["evals/cases.json"] = evalCases(o);
    files[`src/${pkg}/evals.py`] = lines(
      "import asyncio",
      "import json",
      "import sys",
      "from pathlib import Path",
      "",
      "from dotenv import load_dotenv",
      "",
      'CASES = Path(__file__).resolve().parents[2] / "evals" / "cases.json"',
      "",
      "",
      "def check(output: str, case: dict) -> list[str]:",
      '    """Returns the phrases from case["contains"] that are missing from the output, ignoring case."""',
      '    return [p for p in case.get("contains", []) if p.lower() not in output.lower()]',
      "",
      "",
      "async def main() -> int:",
      "    load_dotenv()",
      "    # Imported here so the tests can use check() without an API key.",
      "    from .agent import run",
      f.mcp && "    from . import mcp_client",
      "",
      '    cases = json.loads(CASES.read_text(encoding="utf-8"))',
      "    failed = 0",
      "    for i, case in enumerate(cases):",
      `        missing = check(await run(case["input"]${f.memory ? ', f"eval-{i}"' : ""}), case)`,
      "        failed += bool(missing)",
      `        print(("FAIL" if missing else "PASS") + f"  {case['input']}" + (f"  missing: {missing}" if missing else ""))`,
      f.mcp && "    await mcp_client.close()",
      '    print(f"\\n{len(cases) - failed}/{len(cases)} passed")',
      "    return 1 if failed else 0",
      "",
      "",
      'if __name__ == "__main__":',
      "    sys.exit(asyncio.run(main()))",
      "",
    );
  }

  if (f.docker) {
    files["Dockerfile"] = `FROM python:3.12-slim
WORKDIR /app
COPY . .
RUN pip install --no-cache-dir -e .
${f.http ? `EXPOSE 8000\nCMD ["uvicorn", "${pkg}.server:app", "--host", "0.0.0.0", "--port", "8000"]` : `CMD ["python", "-m", "${pkg}"]`}
`;
    files[".dockerignore"] = ".env\n.venv\n__pycache__\n";
  }

  if (f.tests) {
    const toolTests = [
      f.tools &&
        `def test_get_current_time():
    assert "T" in asyncio.run(run_tool("get_current_time", {}))
`,
      f.tools &&
        `def test_fetch_url_rejects_non_http():
    assert "http" in asyncio.run(run_tool("fetch_url", {"url": "ftp://example.com"}))
`,
      f.tools &&
        `def test_fetch_url_rejects_local_addresses():
    for url in ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/"]:
        assert "private or local" in asyncio.run(run_tool("fetch_url", {"url": url}))
`,
      f.rag &&
        `def test_search_knowledge():
    result = asyncio.run(run_tool("search_knowledge", {"query": "generated agent"}))
    assert "agent" in result.lower()
`,
      f.approval &&
        f.tools &&
        `def test_tools_need_approval():
    async def deny(name, args):
        return False

    set_approver(deny)
    assert "declined" in asyncio.run(run_tool("fetch_url", {"url": "https://example.com"}))
`,
    ].filter(Boolean) as string[];
    const otherTests = [
      f.structured &&
        `def test_contact_schema():
    assert Contact.model_validate({"name": "Ana", "email": "", "company": ""}).name == "Ana"
    with pytest.raises(ValidationError):
        Contact.model_validate({"name": "Ana"})
`,
      f.evals &&
        `def test_eval_check():
    assert check("Hello World", {"contains": ["hello", "bye"]}) == ["bye"]
`,
      f.observability &&
        `def test_telemetry_writes_json(capsys):
    telemetry.event("tool_call", name="x")
    assert json.loads(capsys.readouterr().err)["event"] == "tool_call"
`,
    ].filter(Boolean) as string[];
    const tests = [...toolTests, ...otherTests];
    const imports = lines(
      toolTests.length > 0 && "import asyncio",
      f.observability && "import json",
      (f.structured || (f.approval && f.tools)) && "",
      (f.structured || (f.approval && f.tools)) && "import pytest",
      f.structured && "from pydantic import ValidationError",
      "",
      f.observability && `from ${pkg} import telemetry`,
      f.evals && `from ${pkg}.evals import check`,
      f.structured && `from ${pkg}.schemas import Contact`,
      toolTests.length > 0 && `from ${pkg}.tools import run_tool${f.approval ? ", set_approver" : ""}`,
      f.approval &&
        f.tools &&
        `

@pytest.fixture(autouse=True)
def allow_tools():
    async def allow(name, args):
        return True

    set_approver(allow)`,
    );
    files["tests/test_smoke.py"] = tests.length
      ? `${imports.replace(/^\n+/, "")}


${tests.join("\n\n")}`
      : `import os

os.environ.setdefault("ANTHROPIC_API_KEY", "test")
os.environ.setdefault("OPENAI_API_KEY", "test")


def test_agent_imports():
    import ${pkg}.agent  # noqa: F401
`;
  }

  return files;
}

function mainPy(f: ReturnType<typeof flags>): string {
  const reply = f.streaming
    ? '    await run(line, on_text=lambda text: print(text, end="", flush=True))\n    print()'
    : "    print(await run(line))";
  const loop = `while True:
    try:
        line = await asyncio.to_thread(input, "you> ")
    except EOFError:
        break
${reply}`;
  const indent = (s: string, n: number) => s.split("\n").map((l) => " ".repeat(n) + l).join("\n");
  const body = lines(
    f.approval && "    set_approver(ask)",
    f.mcp
      ? `    await mcp_client.connect()\n    try:\n${indent(loop, 8)}\n    finally:\n        await mcp_client.close()`
      : indent(loop, 4),
  );
  return lines(
    "import asyncio",
    f.approval && "import json",
    "",
    "from dotenv import load_dotenv",
    "",
    "load_dotenv()",
    "",
    f.mcp && "from . import mcp_client  # noqa: E402",
    "from .agent import run  # noqa: E402",
    f.approval && "from .tools import set_approver  # noqa: E402",
    f.approval &&
      `

async def ask(name: str, args: dict) -> bool:
    answer = await asyncio.to_thread(input, f"\\nallow {name}({json.dumps(args)})? [y/N] ")
    return answer.strip().lower() == "y"`,
    "",
    "",
    "async def main() -> None:",
    body,
    "",
    "",
    'if __name__ == "__main__":',
    "    try:",
    "        asyncio.run(main())",
    "    except KeyboardInterrupt:",
    "        pass",
    "",
  );
}

function extractPy(o: Options, f: ReturnType<typeof flags>): string {
  const system = '"Extract the contact details from the user\'s text. Use an empty string for anything missing."';
  const call = f.langgraph
    ? lines(
        `    model = ${f.anthropic ? "ChatAnthropic(model=MODEL, max_tokens=MAX_TOKENS)" : 'ChatOpenAI(model=MODEL, base_url=os.getenv("OPENAI_BASE_URL"), max_tokens=MAX_TOKENS)'}`,
        "    result = await model.with_structured_output(Contact).ainvoke([(\"system\", SYSTEM), (\"human\", text)])",
        "    return Contact.model_validate(result)",
      )
    : f.anthropic
      ? lines(
          "    resp = await client.messages.create(",
          "        model=MODEL,",
          "        max_tokens=MAX_TOKENS,",
          "        system=SYSTEM,",
          '        messages=[{"role": "user", "content": text}],',
          '        tools=[{"name": "record_contact", "description": "Records the contact details found in the text.", "input_schema": Contact.model_json_schema()}],',
          "        # Forcing the tool makes the model answer with arguments that follow the schema.",
          '        tool_choice={"type": "tool", "name": "record_contact"},',
          "    )",
          '    block = next(b for b in resp.content if b.type == "tool_use")',
          "    return Contact.model_validate(block.input)",
        )
      : lines(
          "    resp = await client.chat.completions.create(",
          "        model=MODEL,",
          '        messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],',
          `        ${o.provider === "ollama" ? "max_tokens" : "max_completion_tokens"}=MAX_TOKENS,`,
          '        response_format={"type": "json_schema", "json_schema": {"name": "contact", "schema": Contact.model_json_schema(), "strict": True}},',
          "    )",
          '    return Contact.model_validate_json(resp.choices[0].message.content or "{}")',
        );
  return lines(
    "import asyncio",
    "import os",
    "import sys",
    "",
    "from dotenv import load_dotenv",
    "",
    "load_dotenv()",
    "",
    f.langgraph
      ? f.anthropic
        ? "from langchain_anthropic import ChatAnthropic  # noqa: E402"
        : "from langchain_openai import ChatOpenAI  # noqa: E402"
      : f.anthropic
        ? "from anthropic import AsyncAnthropic  # noqa: E402"
        : "from openai import AsyncOpenAI  # noqa: E402",
    "",
    "from .schemas import Contact  # noqa: E402",
    "",
    !f.langgraph && (f.anthropic ? "client = AsyncAnthropic()" : "client = AsyncOpenAI()"),
    `MODEL = os.getenv("MODEL", "${o.model}")`,
    `MAX_TOKENS = int(os.getenv("MAX_TOKENS", "${MAX_TOKENS}"))`,
    `SYSTEM = ${system}`,
    "",
    "",
    "async def extract(text: str) -> Contact:",
    '    """Pulls a Contact out of free text, validated against the schema."""',
    call,
    "",
    "",
    'if __name__ == "__main__":',
    '    contact = asyncio.run(extract(" ".join(sys.argv[1:]) or sys.stdin.read()))',
    "    print(contact.model_dump_json(indent=2))",
    "",
  );
}

function readme(o: Options, steps: string[]): string {
  const n = notes(o);
  return `# ${o.name}

${o.description || "AI agent."}

Provider: **${o.provider}**. Generated by Arkitekt.ai v${VERSION}.

## Getting started

\`\`\`bash
${steps.join("\n")}
\`\`\`
${n.length ? "\n## Notes\n\n" + n.map((x) => `- ${x}`).join("\n") + "\n" : ""}`;
}
