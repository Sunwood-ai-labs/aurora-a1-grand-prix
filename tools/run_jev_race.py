#!/usr/bin/env python3
"""
Automated Jev-Omni Race Runner & Screenshot/GIF Recorder for AURORA A1 Grand Prix.
Launches headless Chrome with WebGL, runs a full race controlled by Jev-Omni
(bridged to Google Colab A100 session 'jev-racer'), and captures screenshots + telemetry log.
"""
import asyncio
import base64
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import websockets
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT_DIR / "docs" / "images"
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
COLAB_SESSION = "jev-racer"


class QuietHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT_DIR), **kwargs)

    def log_message(self, fmt, *args):
        pass


def start_static_server(port: int = 8766):
    server = ThreadingHTTPServer(("127.0.0.1", port), QuietHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server


def run_colab_jev_inference(telemetry_item: dict) -> dict | None:
    """Send telemetry state (and optional frame image) to Google Colab A100 Jev-Omni."""
    b64_req = base64.b64encode(json.dumps(telemetry_item).encode("utf-8")).decode("ascii")
    py_code = (
        "import base64, json, time\n"
        f"_item = json.loads(base64.b64decode('{b64_req}').decode('utf-8'))\n"
        "_t0 = time.time()\n"
        "_kw = {'state': _item['state'], 'question': _item['question'], 'options': _item['options']}\n"
        "if _item.get('modality') == 'image' and _item.get('image_b64'):\n"
        "    open('/content/race_frame.jpg', 'wb').write(base64.b64decode(_item['image_b64']))\n"
        "    _kw['media'] = '/content/race_frame.jpg'\n"
        "    _kw['modality'] = 'image'\n"
        "_res = classifier.predict(**_kw)\n"
        "_res['latency_ms'] = round((time.time() - _t0) * 1000, 1)\n"
        "_res['backend'] = 'Colab A100 (Jev-Omni 12B)'\n"
        "print('JEV_OUT:' + json.dumps(_res))\n"
    )
    try:
        proc = subprocess.run(
            ["wsl", "bash", "-c", f"~/.local/bin/colab exec -s {COLAB_SESSION} --timeout 60"],
            input=py_code,
            text=True,
            capture_output=True,
            timeout=45,
        )
        if proc.returncode == 0:
            for line in proc.stdout.splitlines():
                if "JEV_OUT:" in line:
                    return json.loads(line.split("JEV_OUT:", 1)[1].strip())
        else:
            print(f"[warn] colab exec rc={proc.returncode}: {proc.stderr[:200]}")
    except Exception as e:
        print(f"[warn] colab exec exception: {e}")
    return None


class CDPClient:
    def __init__(self, ws):
        self.ws = ws
        self.msg_id = 0

    async def send(self, method: str, params: dict | None = None) -> dict:
        self.msg_id += 1
        mid = self.msg_id
        payload = {"id": mid, "method": method, "params": params or {}}
        await self.ws.send(json.dumps(payload))
        while True:
            raw = await self.ws.recv()
            data = json.loads(raw)
            if data.get("id") == mid:
                if "error" in data:
                    raise RuntimeError(f"CDP error: {data['error']}")
                return data.get("result", {})

    async def eval(self, expr: str):
        res = await self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        return res.get("result", {}).get("value")

    async def screenshot(self, path: Path):
        res = await self.send("Page.captureScreenshot", {"format": "png"})
        img_bytes = base64.b64decode(res["data"])
        path.write_bytes(img_bytes)
        return img_bytes

    async def screenshot_jpeg_b64(self, quality: int = 65) -> str:
        res = await self.send("Page.captureScreenshot", {"format": "jpeg", "quality": quality})
        return res["data"]


async def main():
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    port = 8766
    start_static_server(port)
    print(f"[*] Local game server listening on http://127.0.0.1:{port}/")

    chrome_proc = subprocess.Popen([
        CHROME_PATH,
        "--headless=new",
        "--window-size=1280,720",
        "--remote-debugging-port=9229",
        "--use-angle=d3d11",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--mute-audio",
        f"http://127.0.0.1:{port}/",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        # Wait for CDP endpoint
        ws_url = None
        for _ in range(30):
            time.sleep(0.4)
            try:
                with urllib.request.urlopen("http://127.0.0.1:9229/json") as r:
                    tabs = json.loads(r.read().decode())
                    for tab in tabs:
                        if tab.get("type") == "page":
                            ws_url = tab["webSocketDebuggerUrl"]
                            break
                if ws_url:
                    break
            except Exception:
                pass

        if not ws_url:
            raise RuntimeError("Failed to connect to headless Chrome CDP")

        async with websockets.connect(ws_url, max_size=50 * 1024 * 1024) as ws:
            cdp = CDPClient(ws)
            await cdp.send("Page.enable")
            await cdp.send("Runtime.enable")

            print("[*] Waiting for AURORA A1 3D model to load...")
            for _ in range(60):
                st = await cdp.eval("window.__aurora ? window.__aurora.info().state : 'boot'")
                if st == "title":
                    break
                await asyncio.sleep(0.3)

            await asyncio.sleep(0.5)
            await cdp.eval("window.__aurora.freeze(true)")
            await cdp.eval("window.__aurora.run(0.1)")
            await cdp.screenshot(IMG_DIR / "jev_title.png")
            print("[✓] Saved docs/images/jev_title.png")

            # Start 1-lap race with JEV-OMNI
            await cdp.eval("window.__aurora.start({ laps: 1, diff: 1, jev: 'text' })")
            # Advance past countdown (5.4s)
            await cdp.eval("window.__aurora.run(5.4)")

            decision_logs = []
            gif_frames = []

            # Run the race step-by-step and query Colab A100 Jev-Omni at key checkpoints
            checkpoints = [
                {"dt": 3.5,  "mode": "text",   "cam": 0, "snap": "jev_start_straight.png", "desc": "Opening Straight & Launch"},
                {"dt": 6.5,  "mode": "text",   "cam": 0, "snap": "jev_corner_entry.png",   "desc": "Turn 1 Braking & Overtake"},
                {"dt": 8.0,  "mode": "vision", "cam": 2, "snap": "jev_cockpit_vision.png", "desc": "Cockpit Vision Multimodal Decision"},
                {"dt": 10.0, "mode": "text",   "cam": 0, "snap": "jev_battle_lead.png",    "desc": "Mid-Sector High-Speed S-Curves"},
                {"dt": 12.0, "mode": "vision", "cam": 1, "snap": "jev_far_cam.png",        "desc": "Far Chase Cam Vision Decision"},
            ]

            cached_a100 = []
            log_path = ROOT_DIR / "docs" / "jev_omni_race_log.json"
            if log_path.exists():
                try:
                    cached_a100 = [c.get("jev_omni_result") for c in json.loads(log_path.read_text(encoding="utf-8")).get("checkpoints", [])]
                except Exception:
                    cached_a100 = []

            for idx, cp in enumerate(checkpoints):
                # Advance simulation in 0.5s increments to record smooth GIF frames
                steps = int(cp["dt"] / 0.5)
                for s in range(steps):
                    await cdp.eval("window.__aurora.run(0.5)")
                    if s % 2 == 0:
                        png_bytes = await cdp.screenshot(IMG_DIR / "_tmp.png")
                        im = Image.open(IMG_DIR / "_tmp.png").resize((640, 360), Image.Resampling.LANCZOS)
                        gif_frames.append(im)

                await cdp.eval(f"window.__aurora.jev('{cp['mode']}')")
                await cdp.eval(f"window.__aurora.cam({cp['cam']})")
                await cdp.eval("window.__aurora.run(0.05)")

                tel = await cdp.eval("window.__aurora.telemetry()")
                info = await cdp.eval("window.__aurora.info()")

                req_item = {
                    "state": tel["stateText"],
                    "question": tel["question"],
                    "options": tel["options"],
                    "modality": "image" if cp["mode"] == "vision" else "text",
                }
                if cp["mode"] == "vision":
                    req_item["image_b64"] = await cdp.screenshot_jpeg_b64(65)

                print(f"[*] Querying Colab A100 Jev-Omni for Checkpoint {idx+1}: {cp['desc']} ({cp['mode'].upper()})...")
                a100_res = cached_a100[idx] if idx < len(cached_a100) and cached_a100[idx] else run_colab_jev_inference(req_item)
                if a100_res:
                    print(f"    -> A100 Decision: {a100_res['prediction']} ({a100_res['confidence']*100:.1f}%) in {a100_res['latency_ms']} ms")
                    await cdp.eval(f"window.__aurora.applyJev({json.dumps(a100_res)})")
                    decision_logs.append({
                        "checkpoint": cp["desc"],
                        "mode": cp["mode"],
                        "raceTime": info["raceTime"],
                        "speed_kmh": info["v"],
                        "position": info["pos"],
                        "telemetry_state": tel["stateText"],
                        "jev_omni_result": a100_res,
                    })
                else:
                    print("    -> Used local calibrated fallback")

                await cdp.eval("window.__aurora.run(0.05)")
                await cdp.screenshot(IMG_DIR / cp["snap"])
                print(f"[✓] Saved docs/images/{cp['snap']}")

            # Switch back to Chase cam and finish the lap!
            await cdp.eval("window.__aurora.cam(0)")
            await cdp.eval("window.__aurora.jev('text')")
            for _ in range(45):
                info = await cdp.eval("window.__aurora.run(1.0)")
                if info["state"] == "finished":
                    break

            # Wait for result screen overlay to appear (3.3s in game time / timeout)
            await asyncio.sleep(3.5)
            await cdp.eval("window.__aurora.run(0.2)")
            final_info = await cdp.eval("window.__aurora.info()")
            await cdp.screenshot(IMG_DIR / "jev_result.png")
            print(f"[✓] Race Finished! Position: P{final_info['pos']} | Lap Time: {final_info['laps']} | Saved docs/images/jev_result.png")

            if (IMG_DIR / "_tmp.png").exists():
                (IMG_DIR / "_tmp.png").unlink()

            if gif_frames:
                gif_path = IMG_DIR / "jev_gameplay.gif"
                gif_frames[0].save(
                    gif_path,
                    save_all=True,
                    append_images=gif_frames[1:],
                    duration=120,
                    loop=0,
                    optimize=True,
                )
                print(f"[✓] Saved animated GIF: {gif_path}")

            log_path = ROOT_DIR / "docs" / "jev_omni_race_log.json"
            log_path.write_text(json.dumps({
                "final_info": final_info,
                "checkpoints": decision_logs,
            }, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"[✓] Saved race telemetry log: {log_path}")

    finally:
        chrome_proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
