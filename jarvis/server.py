import hmac
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import BoundedSemaphore

from .agents import ROLES, compile_agents
from .tools import AgentError

LIMIT = 32768


def handler(graph, secret):
    slots = BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        def setup(self):
            super().setup()
            self.connection.settimeout(5)

        def send_json(self, status, result):
            payload = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def do_POST(self):
            if self.path != "/run":
                return self.send_json(404, {"error": "Route not found."})
            supplied = self.headers.get("Authorization", "").encode()
            if not hmac.compare_digest(supplied, ("Bearer " + secret).encode()):
                return self.send_json(401, {"error": "Worker credentials rejected."})
            if self.headers.get_content_type() != "application/json" or self.headers.get("Transfer-Encoding"):
                return self.send_json(415, {"error": "Expected a JSON body."})
            try:
                length = int(self.headers.get("Content-Length", 0))
                if not 0 < length <= LIMIT:
                    return self.send_json(413, {"error": "Request exceeds worker limit."})
                command = json.loads(self.rfile.read(length))
                if not isinstance(command, dict):
                    raise ValueError("Expected an object")
                role, prompt, context = (command.get(key) for key in ("role", "prompt", "context"))
                if role not in ROLES or not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 1000 or not isinstance(context, dict):
                    raise ValueError("Invalid request")
            except (ValueError, OSError):
                return self.send_json(400, {"error": "Invalid worker request."})
            if not slots.acquire(blocking=False):
                return self.send_json(429, {"error": "JARVIS is already running a task. Retry after it completes."})
            try:
                result = graph.invoke({"role": role, "prompt": prompt, "context": context}, {"recursion_limit": 6})
                status, body = 200, result["result"]
            except AgentError as error:
                status, body = error.status, {"error": str(error)}
            except Exception:
                status, body = 502, {"error": "The agent could not complete this request."}
            finally:
                slots.release()
            self.send_json(status, body)

    return Handler


def main():
    secret = os.environ.get("LCP_JARVIS_TOKEN", "")
    if len(secret) < 32:
        raise SystemExit("Set LCP_JARVIS_TOKEN to a secret of at least 32 characters.")
    # The graph carries internal operating data. Keep it on loopback or behind a TLS proxy.
    service = ThreadingHTTPServer(("127.0.0.1", int(os.getenv("LCP_JARVIS_PORT", "4180"))), handler(compile_agents(), secret))
    with service:
        print(f"JARVIS listening on {service.server_address[0]}:{service.server_address[1]}", flush=True)
        service.serve_forever()


if __name__ == "__main__":
    main()
