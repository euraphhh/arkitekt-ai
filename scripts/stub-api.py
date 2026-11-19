# Stub Anthropic/OpenAI API that always asks for a tool, streamed when the request sets stream, for checking generated agents
# without a key. Logs each request body as one JSON line.
# Usage: python3 scripts/stub-api.py <port> <log.jsonl>
import itertools
import json
import socketserver
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, log = int(sys.argv[1]), sys.argv[2]
ids = itertools.count()


def anthropic_reply(body: dict, i: int) -> dict:
    return {
        "id": f"msg_{i}", "type": "message", "role": "assistant", "model": body["model"],
        "stop_reason": "tool_use", "stop_sequence": None,
        "content": [{"type": "tool_use", "id": f"toolu_{i}", "name": "get_current_time", "input": {}}],
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


def openai_reply(body: dict, i: int) -> dict:
    call = {"id": f"call_{i}", "type": "function", "function": {"name": "get_current_time", "arguments": "{}"}}
    return {
        "id": f"chatcmpl_{i}", "object": "chat.completion", "created": 0, "model": body["model"],
        "choices": [{"index": 0, "finish_reason": "tool_calls", "message": {"role": "assistant", "content": None, "tool_calls": [call]}}],
        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
    }


def anthropic_events(body: dict, i: int) -> list[tuple[str, dict]]:
    msg = {**anthropic_reply(body, i), "content": [], "stop_reason": None}
    block = {"type": "tool_use", "id": f"toolu_{i}", "name": "get_current_time", "input": {}}
    return [
        ("message_start", {"type": "message_start", "message": msg}),
        ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": block}),
        ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "{}"}}),
        ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 1}}),
        ("message_stop", {"type": "message_stop"}),
    ]


def openai_chunks(body: dict, i: int) -> list[dict]:
    base = {"id": f"chatcmpl_{i}", "object": "chat.completion.chunk", "created": 0, "model": body["model"]}
    call = {"index": 0, "id": f"call_{i}", "type": "function", "function": {"name": "get_current_time", "arguments": "{}"}}
    chunks = [
        {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "tool_calls": [call]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
    ]
    if body.get("stream_options", {}).get("include_usage"):
        chunks.append({**base, "choices": [], "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}})
    return chunks


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        with open(log, "a") as f:
            f.write(json.dumps({"path": self.path, "body": body}) + "\n")
        if body.get("stream") and self.path.endswith(("/messages", "/chat/completions")):
            self.send_response(200)
            self.send_header("content-type", "text/event-stream")
            self.end_headers()
            i = next(ids)
            if self.path.endswith("/messages"):
                for event, data in anthropic_events(body, i):
                    self.wfile.write(f"event: {event}\ndata: {json.dumps(data)}\n\n".encode())
            else:
                for chunk in openai_chunks(body, i):
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
            return
        if self.path.endswith("/messages"):
            reply = anthropic_reply(body, next(ids))
        elif self.path.endswith("/chat/completions"):
            reply = openai_reply(body, next(ids))
        else:  # e.g. the Responses API: logged, not answered
            self.send_response(501)
            self.end_headers()
            return
        data = json.dumps(reply).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class Server(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer.server_bind looks up the host's FQDN, which can hang on a slow resolver.
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "127.0.0.1", port


Server(("127.0.0.1", port), Handler).serve_forever()
