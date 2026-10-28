# Stub Anthropic/OpenAI API that always asks for a tool, for checking generated agents
# without a key. Logs each request body as one JSON line.
# Usage: python3 scripts/stub-api.py <port> <log.jsonl>
import itertools
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

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


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        with open(log, "a") as f:
            f.write(json.dumps({"path": self.path, "body": body}) + "\n")
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


HTTPServer(("127.0.0.1", port), Handler).serve_forever()
