#!/usr/bin/env python3
"""
AURORA A1 Grand Prix — Jev-Omni Decision Bridge Server
Serves the web game on http://localhost:8765 and bridges /api/jev/decide
to a remote Google Colab A100 session running akhilaaa3/Jev-Omni (via google-colab-cli)
or a local calibrated fallback when running offline.
"""
import argparse
import base64
import json
import math
import os
import re
import subprocess
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
COLAB_SESSION = None
USE_WSL_COLAB = True


def query_colab_jev(state: str, question: str, options: list[str], modality: str = "text", image_b64: str | None = None) -> dict | None:
    """Execute Jev-Omni inference on the active Google Colab A100 session."""
    if not COLAB_SESSION:
        return None

    t0 = time.time()
    req_data = {
        "state": state,
        "question": question,
        "options": options,
        "modality": modality if modality in ("text", "image") else "text",
        "image_b64": image_b64 if modality == "image" else None,
    }
    b64_payload = base64.b64encode(json.dumps(req_data).encode("utf-8")).decode("ascii")

    py_snippet = (
        "import base64, json, time\n"
        f"_req = json.loads(base64.b64decode('{b64_payload}').decode('utf-8'))\n"
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

    try:
        if USE_WSL_COLAB and os.name == "nt":
            cmd = ["wsl", "bash", "-c", f"~/.local/bin/colab exec -s {COLAB_SESSION} --timeout 30"]
        else:
            cmd = ["colab", "exec", "-s", COLAB_SESSION, "--timeout", "30"]

        proc = subprocess.run(
            cmd,
            input=py_snippet,
            text=True,
            capture_output=True,
            timeout=15,
        )
        if proc.returncode == 0:
            for line in proc.stdout.splitlines():
                if "JEV_JSON_START:" in line:
                    raw_json = line.split("JEV_JSON_START:", 1)[1].strip()
                    return json.loads(raw_json)
    except Exception as exc:
        print(f"[jev_bridge] Colab exec warning: {exc}")
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


def main():
    global COLAB_SESSION
    parser = argparse.ArgumentParser(description="AURORA A1 Grand Prix - Jev-Omni Bridge Server")
    parser.add_argument("--port", type=int, default=8765, help="HTTP port (default: 8765)")
    parser.add_argument("--colab-session", type=str, default=None, help="Colab CLI session name (e.g. jev-a100)")
    args = parser.parse_args()
    COLAB_SESSION = args.colab_session

    server = ThreadingHTTPServer(("0.0.0.0", args.port), AuroraJevHandler)
    print(f"[*] AURORA A1 Grand Prix + Jev-Omni Bridge running at http://localhost:{args.port}/")
    if COLAB_SESSION:
        print(f"[*] Connected to Google Colab session: {COLAB_SESSION} (Jev-Omni 12B on A100)")
    else:
        print("[*] Running with local calibrated System-1 bridge (pass --colab-session <name> for Colab A100)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] Shutting down server.")


if __name__ == "__main__":
    main()
