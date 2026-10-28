import type { Options } from "../catalog";
import { VERSION } from "../version";
import { FETCH_TOOL, MCP_CONFIG, SEARCH_TOOL, TIME_TOOL, envFile, flags, knowledgeDoc, notes } from "./shared";

const lines = (...parts: (string | false)[]) => parts.filter((p): p is string => p !== false).join("\n");

export function pythonProject(o: Options): Record<string, string> {
  const pkg = o.name.replace(/-/g, "_");
  const f = flags(o);

  const deps = f.langgraph
    ? ["langchain>=1.0", "langgraph>=1.0", f.anthropic ? "langchain-anthropic>=1.0" : "langchain-openai>=1.0", "python-dotenv"]
    : [f.anthropic ? "anthropic>=2,<3" : "openai>=3,<4", "python-dotenv"];
  if (f.mcp) deps.push("mcp>=1.2");
  if (f.http) deps.push("fastapi", "uvicorn");
  if (f.tests) deps.push("pytest");

  const sessionParam = f.memory ? ', session_id: str = "default"' : "";

  const agentAnthropic = lines(
    "import os",
    f.memory && "from collections import defaultdict",
    "",
    "from anthropic import AsyncAnthropic",
    f.needsTools && "",
    f.needsTools && "from .tools import get_tools, run_tool",
    "",
    "client = AsyncAnthropic()",
    `MODEL = os.getenv("MODEL", "${o.model}")`,
    `SYSTEM = "You are ${o.name}, a helpful AI agent."`,
    f.memory && "",
    f.memory && "# One message history per session id, kept in memory.",
    f.memory && "HISTORY: dict[str, list] = defaultdict(list)",
    "",
    "",
    `async def run(prompt: str${sessionParam}) -> str:`,
    `    messages = ${f.memory ? "HISTORY[session_id]" : "[]"}`,
    '    messages.append({"role": "user", "content": prompt})',
    f.needsTools && "    tools = await get_tools()",
    f.needsTools && '    extra = {"tools": tools} if tools else {}',
    "    while True:",
    "        resp = await client.messages.create(",
    "            model=MODEL,",
    "            max_tokens=1024,",
    "            system=SYSTEM,",
    "            messages=messages,",
    f.needsTools && "            **extra,",
    "        )",
    '        messages.append({"role": "assistant", "content": resp.content})',
    '        if resp.stop_reason != "tool_use":',
    '            return "".join(b.text for b in resp.content if b.type == "text")',
    "        results = [",
    `            {"type": "tool_result", "tool_use_id": b.id, "content": ${f.needsTools ? "await run_tool(b.name, b.input)" : '""'}}`,
    "            for b in resp.content",
    '            if b.type == "tool_use"',
    "        ]",
    '        messages.append({"role": "user", "content": results})',
    "",
  );

  const agentOpenAI = lines(
    f.needsTools && "import json",
    "import os",
    f.memory && "from collections import defaultdict",
    "",
    "from openai import AsyncOpenAI",
    f.needsTools && "",
    f.needsTools && "from .tools import get_tools, run_tool",
    "",
    "client = AsyncOpenAI()  # reads OPENAI_API_KEY and OPENAI_BASE_URL",
    `MODEL = os.getenv("MODEL", "${o.model}")`,
    `SYSTEM = "You are ${o.name}, a helpful AI agent."`,
    f.memory && "",
    f.memory && "# One message history per session id, kept in memory.",
    f.memory && "HISTORY: dict[str, list] = defaultdict(list)",
    "",
    "",
    `async def run(prompt: str${sessionParam}) -> str:`,
    `    messages = ${f.memory ? "HISTORY[session_id]" : "[]"}`,
    "    if not messages:",
    '        messages.append({"role": "system", "content": SYSTEM})',
    '    messages.append({"role": "user", "content": prompt})',
    f.needsTools && "    tools = await get_tools()",
    f.needsTools && '    extra = {"tools": tools} if tools else {}',
    "    while True:",
    `        resp = await client.chat.completions.create(model=MODEL, messages=messages${f.needsTools ? ", **extra" : ""})`,
    "        msg = resp.choices[0].message",
    "        messages.append(msg)",
    "        if not msg.tool_calls:",
    '            return msg.content or ""',
    "        for call in msg.tool_calls:",
    "            messages.append({",
    '                "role": "tool",',
    '                "tool_call_id": call.id,',
    `                "content": ${f.needsTools ? 'await run_tool(call.function.name, json.loads(call.function.arguments or "{}"))' : '""'},`,
    "            })",
    "",
  );

  const agentLangGraph = lines(
    "import os",
    "",
    f.anthropic ? "from langchain_anthropic import ChatAnthropic" : "from langchain_openai import ChatOpenAI",
    "from langchain.agents import create_agent",
    f.needsTools && "from langchain_core.tools import StructuredTool",
    f.memory && "from langgraph.checkpoint.memory import InMemorySaver",
    f.needsTools && "",
    f.needsTools && "from .tools import get_specs, run_tool",
    "",
    `MODEL = os.getenv("MODEL", "${o.model}")`,
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
    f.anthropic ? "        model = ChatAnthropic(model=MODEL)" : '        model = ChatOpenAI(model=MODEL, base_url=os.getenv("OPENAI_BASE_URL"))',
    f.needsTools
      ? `        tools = [
            StructuredTool(name=s["name"], description=s["description"], args_schema=s["schema"], coroutine=_runner(s["name"]))
            for s in await get_specs()
        ]`
      : "        tools = []",
    `        _agent = create_agent(model, tools, system_prompt=SYSTEM${f.memory ? ", checkpointer=InMemorySaver()" : ""})`,
    "    return _agent",
    "",
    "",
    `async def run(prompt: str${sessionParam}) -> str:`,
    "    agent = await _get_agent()",
    f.memory && '    config = {"configurable": {"thread_id": session_id}}',
    `    result = await agent.ainvoke({"messages": [{"role": "user", "content": prompt}]}${f.memory ? ", config" : ""})`,
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
    [`src/${pkg}/__main__.py`]: mainPy(f.mcp),
    "README.md": readme(o, [
      "python -m venv .venv && source .venv/bin/activate  # Windows: .venv\\Scripts\\activate",
      "pip install -e .",
      "cp .env.example .env  # fill in your settings",
      `python -m ${pkg}`,
      ...(f.http ? [`uvicorn ${pkg}.server:app --reload  # POST /chat`] : []),
    ]),
  };

  if (f.needsTools) {
    const base = [f.tools && TIME_TOOL, f.tools && FETCH_TOOL, f.rag && SEARCH_TOOL].filter(Boolean);
    const fmt = f.anthropic
      ? '{"name": s["name"], "description": s["description"], "input_schema": s["schema"]}'
      : '{"type": "function", "function": {"name": s["name"], "description": s["description"], "parameters": s["schema"]}}';
    files[`src/${pkg}/tools.py`] = lines(
      f.tools && "import asyncio",
      f.tools && "import urllib.request",
      f.tools && "from datetime import datetime, timezone",
      f.rag && "" ,
      f.rag && "from . import rag",
      f.mcp && "from . import mcp_client",
      "",
      `BASE_TOOLS: list[dict] = ${JSON.stringify(base, null, 4)}`,
      f.tools && "",
      f.tools && "",
      f.tools && "def _fetch(url: str) -> str:",
      f.tools && '    if not url.startswith(("http://", "https://")):',
      f.tools && '        return "Only http(s) URLs are supported."',
      f.tools && "    try:",
      f.tools && "        with urllib.request.urlopen(url, timeout=10) as res:",
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
      "async def run_tool(name: str, args: dict) -> str:",
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
      f.mcp && "from contextlib import asynccontextmanager",
      f.mcp && "",
      "from dotenv import load_dotenv",
      "",
      "load_dotenv()",
      "",
      "from fastapi import FastAPI  # noqa: E402",
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
    const tests = [
      f.tools &&
        `def test_get_current_time():
    assert "T" in asyncio.run(run_tool("get_current_time", {}))
`,
      f.tools &&
        `def test_fetch_url_rejects_non_http():
    assert "http" in asyncio.run(run_tool("fetch_url", {"url": "ftp://example.com"}))
`,
      f.rag &&
        `def test_search_knowledge():
    result = asyncio.run(run_tool("search_knowledge", {"query": "generated agent"}))
    assert "agent" in result.lower()
`,
    ].filter(Boolean);
    files["tests/test_smoke.py"] = tests.length
      ? `import asyncio

from ${pkg}.tools import run_tool


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

function mainPy(mcp: boolean): string {
  const loop = `while True:
    try:
        line = await asyncio.to_thread(input, "you> ")
    except EOFError:
        break
    print(await run(line))`;
  const indent = (s: string, n: number) => s.split("\n").map((l) => " ".repeat(n) + l).join("\n");
  const body = mcp
    ? `    await mcp_client.connect()\n    try:\n${indent(loop, 8)}\n    finally:\n        await mcp_client.close()`
    : indent(loop, 4);
  return `import asyncio

from dotenv import load_dotenv

load_dotenv()

${mcp ? "from . import mcp_client  # noqa: E402\n" : ""}from .agent import run  # noqa: E402


async def main() -> None:
${body}


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
`;
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
