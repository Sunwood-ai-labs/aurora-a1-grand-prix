#!/usr/bin/env python3
"""
AURORA A1 Grand Prix — Real-Time Jev-Omni Decision Bridge Server
Serves the web game on http://localhost:8765 and bridges /api/jev/decide to:
  1. An in-process JevOmniClassifier instance (when running directly inside a Colab A100 notebook), or
  2. A persistent Google Colab A100 WebSocket kernel connection (via google-colab-cli ColabRuntime), or
  Without a backend it answers 503 and the game uses its labelled local fallback.
"""
import argparse
import base64
import json
import os
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
COLAB_SESSION = None
IN_PROCESS_CLASSIFIER = None
_WORKER_LOCK = threading.Lock()
_WORKER_PROC = None


def _get_persistent_worker():
    global _WORKER_PROC
    if _WORKER_PROC is not None and _WORKER_PROC.poll() is None:
        return _WORKER_PROC
    if not COLAB_SESSION:
        return None
    worker_py = ROOT_DIR / "tools" / "colab_worker.py"
    if os.name == "nt":
        # Convert C:\Prj\... to /mnt/c/Prj/...
        drive = worker_py.drive.rstrip(":").lower()
        wsl_path = f"/mnt/{drive}/" + worker_py.as_posix().split(":/", 1)[1]
        cmd = [
            "wsl", "bash", "-c",
            f"~/.local/share/uv/tools/google-colab-cli/bin/python -u '{wsl_path}' '{COLAB_SESSION}'"
        ]
    else:
        colab_py = os.path.expanduser("~/.local/share/uv/tools/google-colab-cli/bin/python")
        py_bin = colab_py if os.path.exists(colab_py) else "python3"
        cmd = [py_bin, "-u", str(worker_py), COLAB_SESSION]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    ready_line = proc.stdout.readline().strip()
    if "WORKER_READY" in ready_line:
        _WORKER_PROC = proc
        return _WORKER_PROC
    err_out = proc.stderr.read() if proc.stderr else ""
    print(f"[jev_bridge] Worker failed to start: {ready_line} | {err_out[:200]}")
    proc.terminate()
    return None


def query_in_process_jev(state: str, question: str, options: list[str], modality: str = "text", image_b64: str | None = None) -> dict | None:
    """Execute Jev-Omni inference directly in-process (when running inside Google Colab)."""
    if IN_PROCESS_CLASSIFIER is None:
        return None
    t0 = time.time()
    kw = {"state": state, "question": question, "options": options}
    if modality == "image" and image_b64:
        raw = image_b64.split(",")[-1]
        frame_path = "/tmp/aurora_frame.jpg"
        Path(frame_path).write_bytes(base64.b64decode(raw))
        kw["media"] = frame_path
        kw["modality"] = "image"
    with _WORKER_LOCK:
        res = IN_PROCESS_CLASSIFIER.predict(**kw)
    res["latency_ms"] = round((time.time() - t0) * 1000, 1)
    res["backend"] = "Colab A100 (Jev-Omni 12B)"
    return res


def query_colab_jev(state: str, question: str, options: list[str], modality: str = "text", image_b64: str | None = None) -> dict | None:
    """Execute Jev-Omni inference over a persistent WebSocket to the active Google Colab A100 session."""
    if IN_PROCESS_CLASSIFIER is not None:
        return query_in_process_jev(state, question, options, modality, image_b64)
    if not COLAB_SESSION:
        return None

    req_data = {
        "state": state,
        "question": question,
        "options": options,
        "modality": modality if modality in ("text", "image") else "text",
        "image_b64": image_b64 if modality == "image" else None,
    }
    b64_payload = base64.b64encode(json.dumps(req_data).encode("utf-8")).decode("ascii")

    with _WORKER_LOCK:
        try:
            proc = _get_persistent_worker()
            if proc is not None:
                proc.stdin.write(b64_payload + "\n")
                proc.stdin.flush()
                resp_line = proc.stdout.readline().strip()
                if resp_line:
                    parsed = json.loads(resp_line)
                    if "prediction" in parsed:
                        return parsed
        except Exception as exc:
            print(f"[jev_bridge] Persistent Colab worker warning: {exc}")
    return None


class AuroraJevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if not self.path.startswith("/api/jev/decide"):
            super().log_message(fmt, *args)

    def do_POST(self):
        if self.path.startswith("/api/jev/decide"):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            state = body.get("state", "")
            question = body.get("question", "Select optimal driving action:")
            options = body.get("options", [])
            modality = body.get("modality", "text")
            image_b64 = body.get("image_base64")

            res = query_colab_jev(state, question, options, modality, image_b64)
            if res is None:
                # no model connected: the game falls back to its own (clearly labelled) rule
                self.send_error(503, "Jev-Omni backend not connected")
                return

            payload = json.dumps(res).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_error(404)


def start_background_server(port: int = 8765, classifier=None, colab_session: str | None = None):
    """Helper to start the bridge server in a background daemon thread (ideal for Colab notebooks)."""
    global IN_PROCESS_CLASSIFIER, COLAB_SESSION
    if classifier is not None:
        IN_PROCESS_CLASSIFIER = classifier
    if colab_session is not None:
        COLAB_SESSION = colab_session
    server = ThreadingHTTPServer(("0.0.0.0", port), AuroraJevHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


def main():
    global COLAB_SESSION
    parser = argparse.ArgumentParser(description="AURORA A1 Grand Prix - Jev-Omni Bridge Server")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default: 8765)")
    parser.add_argument("--colab-session", type=str, default=None, help="Colab CLI session name (e.g. jev-racer)")
    args = parser.parse_args()
    COLAB_SESSION = args.colab_session

    server = ThreadingHTTPServer(("0.0.0.0", args.port), AuroraJevHandler)
    print(f"[*] AURORA A1 Grand Prix + Jev-Omni Bridge running at http://localhost:{args.port}/")
    if COLAB_SESSION:
        print(f"[*] Connecting persistent WebSocket worker to Google Colab session: {COLAB_SESSION}")
        _get_persistent_worker()
    else:
        print("[*] No model backend: the game uses its local fallback (pass --colab-session <name> for Colab A100)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down server.")


if __name__ == "__main__":
    main()
