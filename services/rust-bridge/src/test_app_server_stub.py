#!/usr/bin/env python3
"""
Test stub for OpenCode/AppServer JSON-RPC and HTTP interfaces.

When invoked as: stub.py serve --hostname H --port P
  Starts an HTTP server responding to GET /global/health with {"healthy":true}.

When invoked as: stub.py app-server --listen stdio://  (or any other mode)
  Processes stdio JSON-RPC requests, responding to each with an empty result.
"""
import sys
import json
import time
import threading
import argparse

def run_http_server(host, port):
    """Minimal HTTP server for OpenCode health/session endpoints."""
    import http.server
    import socketserver

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass  # silence logs

        def do_GET(self):
            if self.path == "/global/health":
                body = b'{"healthy":true}'
            elif self.path in ("/experimental/session", "/session", "/session/status",
                               "/global/event"):
                body = b"[]"
            else:
                self.send_response(404)
                self.end_headers()
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            length = int(self.headers.get("Content-Length", 0))
            self.rfile.read(length)
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    # Allow quick reuse of the port.
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer((host, int(port)), Handler) as httpd:
        httpd.serve_forever()


def main():
    args = sys.argv[1:]
    if args and args[0] == "serve":
        parser = argparse.ArgumentParser()
        parser.add_argument("--hostname", default="127.0.0.1")
        parser.add_argument("--port", default="4040")
        parsed, _ = parser.parse_known_args(args[1:])
        t = threading.Thread(
            target=run_http_server,
            args=(parsed.hostname, parsed.port),
            daemon=False,
        )
        t.start()
        # Block until the server thread exits (it serves_forever, so this blocks
        # until the process is killed externally).
        t.join()
        return

    # App-server stdio JSON-RPC mode.
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        req_id = msg.get("id")
        method = msg.get("method")
        if req_id is None:
            continue  # notification — no response
        if method:
            # Server-to-client request: respond with empty result.
            sys.stdout.write(json.dumps({"id": req_id, "result": {}}) + "\n")
            sys.stdout.flush()
        # Ignore responses (no-method messages).


if __name__ == "__main__":
    main()
