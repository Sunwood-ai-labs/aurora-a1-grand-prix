#!/usr/bin/env python3
"""
AURORA A1 Grand Prix — Real-Time Jev-Omni Decision Bridge Server
Serves the web game on http://localhost:8765 and bridges /api/jev/decide to:
  1. An in-process JevOmniClassifier instance (when running directly inside a Colab A100 notebook), or
  2. A persistent Google Colab A100 WebSocket kernel connection (via google-colab-cli ColabRuntime), or
  3. A local calibrated System-1 fallback when running offline.
"""
import argparse
import base64
import json
import math
import os
import re
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


_PERSISTENT_WORKER_CODE = r"""
import sys, json, base64
from colab_cli.common import state
from colab_cli.runtime import ColabRuntime

session_name = sys.argv[1]
name = state.resolve_session(session_name)
s = state.store.get(name)
if not s:
    print(json.dumps({"error": f"Session {name} not found"}), flush=True)
    sys.exit(1)

runtime = ColabRuntime(
    s.url,
    s.token,
    kernel_id=s.kernel_id,
    session_id=s.session_id,
    on_kernel_started=lambda kid: (setattr(s, "kernel_id", kid), state.store.add(s)),
    on_session_started=lambda sid: (setattr(s, "session_id", sid), state.store.add(s)),
)
runtime.execute_code("import os; os.makedirs('/content', exist_ok=True); os.chdir('/content')")
print("WORKER_READY", flush=True)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        py_snippet = (
            "import base64, json, time\n"
            f"_req = json.loads(base64.b64decode('{line}').decode('utf-8'))\n"
            "_t0 = time.time()\n"
            "_kw = {'state': _req['state'], 'question': _req['question'], 'options': _req['options']}\n"
            "if _req.get('modality') == 'image' and _req.get('image_b64'):\n"
            "    _raw = _req['image_b64'].split(',')[-1]\n"
            "    open('/content/aurora_frame.jpg', 'wb').write(base64.b64decode(_raw))\n"
            "    _kw['media'] = '/content/aurora_frame.jpg'\n"
            "    _kw['modality'] = 'image'\n"
            "_res = classifier.predict(**_kw)\n"
            "_res['latency_ms'] = round((time.time() - _t0) * 1000, 1)\n"
            "_res['backend'] = 'Colab A100 (Jev-Omni 12B)'\n"
            "print('JEV_JSON_START:' + json.dumps(_res))\n"
        )
        outputs = runtime.execute_code(py_snippet, timeout=15.0)
        found = None
        for out in outputs:
            txt = out.get("text", "") if isinstance(out, dict) else str(out)
            for ln in txt.splitlines():
                if "JEV_JSON_START:" in ln:
                    found = ln.split("JEV_JSON_START:", 1)[1].strip()
        print(found if found else json.dumps({"error": "no output"}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
"""


def _get_persistent_worker():
    global _WORKER_PROC
    if _WORKER_PROC is not None and _WORKER_PROC.poll() is None:
        return _WORKER_PROC
    if not COLAB_SESSION:
        return None
    if os.name == "nt":
        cmd = [
            "wsl", "bash", "-c",
            f"~/.local/share/uv/tools/google-colab-cli/bin/python -u -c {json.dumps(_PERSISTENT_WORKER_CODE)} {COLAB_SESSION}"
        ]
    else:
        colab_py = os.path.expanduser("~/.local/share/uv/tools/google-colab-cli/bin/python")
        py_bin = colab_py if os.path.exists(colab_py) else "python3"
        cmd = [py_bin, "-u", "-c", _PERSISTENT_WORKER_CODE, COLAB_SESSION]

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


def local_calibrated_fallback(state: str, options: list[str]) -> dict:
    """Calibrated System-1 probability distribution computed from telemetry state."""
    speed_m = re.search(r"Speed:\s*(\d+)\s*km/h\s*\(Optimal ahead:\s*(\d+)\s*km/h\)", state)
    err_m = re.search(r"Heading error:\s*([-\d.]+)\s*deg", state)
    kmh = float(speed_m.group(1)) if speed_m else 180.0
    target_kmh = float(speed_m.group(2)) if speed_m else 200.0
    err_deg = float(err_m.group(1)) if err_m else 0.0
    err_rad = err_deg * (math.pi / 180.0)

    dv = (kmh - target_kmh) / 3.6
    need_brake = dv > 2.2
    need_hard = dv > 9.5

    logits = {
        "FULL_GAS_STRAIGHT": (2.6 if not need_brake else -2.0) - abs(err_rad) * 18.0,
        "GAS_STEER_LEFT":    (2.2 if not need_brake else -1.5) + (err_rad * 22.0 if err_rad > 0.018 else -2.5),
        "GAS_STEER_RIGHT":   (2.2 if not need_brake else -1.5) + (-err_rad * 22.0 if err_rad < -0.018 else -2.5),
        "BRAKE_ENTRY_LEFT":  (2.4 if need_brake else -2.2) + (err_rad * 20.0 if err_rad > 0.015 else -2.0),
        "BRAKE_ENTRY_RIGHT": (2.4 if need_brake else -2.2) + (-err_rad * 20.0 if err_rad < -0.015 else -2.0),
        "HARD_BRAKE":        (3.0 if need_hard else (1.2 if need_brake else -3.0)) - abs(err_rad) * 8.0,
    }
    filtered = {k: logits.get(k, 0.0) for k in options}
    max_l = max(filtered.values()) if filtered else 0.0
    exps = {k: math.exp(v - max_l) for k, v in filtered.items()}
    total = sum(exps.values()) or 1.0
    probs = {k: exps[k] / total for k in options}
    best = max(probs, key=probs.get)
    return {
        "prediction": best,
        "prediction_index": options.index(best),
        "confidence": probs[best],
        "probabilities": probs,
        "latency_ms": 2.1,
        "backend": "Local System-1 Bridge",
    }


class AuroraJevHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def log_message(self, fmt, *args):
        if "/api/jev/decide" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def do_POST(self):
        if self.path.startswith("/api/jev/decide"):
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            state = body.get("state", "")
            question = body.get("question", "Select optimal driving action:")
            options = body.get("options", [
                "FULL_GAS_STRAIGHT", "GAS_STEER_LEFT", "GAS_STEER_RIGHT",
                "BRAKE_ENTRY_LEFT", "BRAKE_ENTRY_RIGHT", "HARD_BRAKE"
            ])
            modality = body.get("modality", "text")
            image_b64 = body.get("image_base64")

            res = query_colab_jev(state, question, options, modality, image_b64)
            if res is None:
                res = local_calibrated_fallback(state, options)

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
        print("[*] Running with local calibrated System-1 bridge (pass --colab-session <name> for Colab A100)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down server.")


if __name__ == "__main__":
    main()
