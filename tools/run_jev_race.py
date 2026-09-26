#!/usr/bin/env python3
"""
Real-Time Jev-Omni Race Runner & Screenshot/GIF Recorder for AURORA A1 Grand Prix.
Launches the Jev-Omni Bridge Server (tools/jev_bridge.py) and headless Chrome with WebGL.
Runs a 100% real-time race (60 FPS requestAnimationFrame, NEVER freezing or stepping time)
where the browser continuously queries /api/jev/decide in real time.
"""
import argparse
import asyncio
import base64
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websockets
from PIL import Image

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "tools"))
import jev_bridge

IMG_DIR = ROOT_DIR / "docs" / "images"
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"


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


async def main():
    parser = argparse.ArgumentParser(description="Run a 100% real-time AURORA A1 race with Jev-Omni")
    parser.add_argument("--colab-session", type=str, default=None, help="Active Google Colab session name (e.g. jev-racer)")
    parser.add_argument("--port", type=int, default=8766, help="Local bridge port")
    args = parser.parse_args()

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    jev_bridge.start_background_server(port=args.port, colab_session=args.colab_session)
    print(f"[*] Real-Time Jev-Omni Bridge Server listening on http://127.0.0.1:{args.port}/")

    chrome_proc = subprocess.Popen([
        CHROME_PATH,
        "--headless=new",
        "--window-size=1280,720",
        "--remote-debugging-port=9229",
        "--use-angle=d3d11",
        "--enable-webgl",
        "--ignore-gpu-blocklist",
        "--mute-audio",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        f"http://127.0.0.1:{args.port}/",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
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

            await asyncio.sleep(0.6)
            await cdp.screenshot(IMG_DIR / "jev_title.png")
            print("[✓] Saved docs/images/jev_title.png")

            # Start 1-lap race in 100% REAL TIME (no freeze, requestAnimationFrame runs continuously at 60 FPS)
            await cdp.eval("window.__aurora.start({ laps: 1, diff: 1, jev: 'text' })")
            print("[*] Race started in real-time (60 FPS, frozen=false)...")

            # Wait for 5-light start sequence in real time
            while True:
                info = await cdp.eval("window.__aurora.info()")
                if info["state"] == "race":
                    break
                await asyncio.sleep(0.1)

            checkpoints = [
                {"t": 4.0,  "mode": "text",   "cam": 0, "snap": "jev_start_straight.png", "desc": "Opening Straight & Launch"},
                {"t": 10.8, "mode": "text",   "cam": 0, "snap": "jev_corner_entry.png",   "desc": "Turn 1 Braking & Overtake"},
                {"t": 19.2, "mode": "vision", "cam": 2, "snap": "jev_cockpit_vision.png", "desc": "Cockpit Vision Multimodal Decision"},
                {"t": 29.6, "mode": "text",   "cam": 0, "snap": "jev_battle_lead.png",    "desc": "Mid-Sector High-Speed S-Curves"},
                {"t": 42.1, "mode": "vision", "cam": 1, "snap": "jev_far_cam.png",        "desc": "Far Chase Cam Vision Decision"},
            ]
            next_cp = 0
            decision_logs = []
            gif_frames = []
            last_gif_t = 0.0

            # Real-time monitoring loop (never freezes or steps simulation clock)
            while True:
                info = await cdp.eval("window.__aurora.info()")
                rt = info["raceTime"]

                if info["state"] == "finished":
                    break

                if rt - last_gif_t >= 1.2 and rt < 45.0:
                    last_gif_t = rt
                    await cdp.screenshot(IMG_DIR / "_tmp.png")
                    im = Image.open(IMG_DIR / "_tmp.png").resize((640, 360), Image.Resampling.LANCZOS)
                    gif_frames.append(im)

                if next_cp < len(checkpoints) and rt >= checkpoints[next_cp]["t"] - 0.6:
                    cp = checkpoints[next_cp]
                    await cdp.eval(f"window.__aurora.jev('{cp['mode']}')")
                    await cdp.eval(f"window.__aurora.cam({cp['cam']})")
                    # Wait 0.6s in real time so the browser's live /api/jev/decide poll completes in the new mode/camera
                    await asyncio.sleep(0.6)
                    info = await cdp.eval("window.__aurora.info()")
                    tel = await cdp.eval("window.__aurora.telemetry()")
                    await cdp.screenshot(IMG_DIR / cp["snap"])
                    res = info.get("jevLastResult", {})
                    print(f"[✓] Real-Time Checkpoint {next_cp+1} ({rt:.1f}s): {res.get('prediction')} ({res.get('confidence', 0)*100:.1f}%) | {res.get('latency_ms')} ms -> {cp['snap']}")
                    decision_logs.append({
                        "checkpoint": cp["desc"],
                        "mode": cp["mode"],
                        "raceTime": info["raceTime"],
                        "speed_kmh": info["v"],
                        "position": info["pos"],
                        "telemetry_state": tel["stateText"] if tel else "",
                        "jev_omni_result": res,
                    })
                    # Return to CHASE + TEXT for next sector
                    await cdp.eval("window.__aurora.cam(0)")
                    await cdp.eval("window.__aurora.jev('text')")
                    next_cp += 1

                await asyncio.sleep(0.1)

            # Wait in real time for the result overlay (3.3s after finish)
            await asyncio.sleep(3.5)
            final_info = await cdp.eval("window.__aurora.info()")
            await cdp.screenshot(IMG_DIR / "jev_result.png")
            print(f"[✓] Real-Time Race Finished! Position: P{final_info['pos']} | Lap Time: {final_info['laps']}")

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

    finally:
        chrome_proc.terminate()


if __name__ == "__main__":
    asyncio.run(main())
