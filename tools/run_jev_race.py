#!/usr/bin/env python3
"""
Jev-Omni race runner & video recorder for AURORA A1 Grand Prix.

Starts the bridge server (tools/jev_bridge.py) and headless Chrome, lets Jev-Omni drive
from the rendered game screen, records the page with the CDP screencast and writes
MP4 + GIF + a decision log.

  --timing realtime  (default) the game clock never stops; decisions arrive while the car keeps moving
  --timing step      the game clock waits for every decision (JEV_STEP_DT of game time per decision)

Usage:
  python tools/run_jev_race.py --colab-session jev-racer
  python tools/run_jev_race.py --colab-session jev-racer --timing step
"""
import argparse
import asyncio
import base64
import json
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import websockets

ROOT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT_DIR / "tools"))
import jev_bridge  # noqa: E402

IMG_DIR = ROOT_DIR / "docs" / "images"
VID_DIR = ROOT_DIR / "docs" / "videos"
CHROME_PATH = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
CDP_PORT = 9229


class CDP:
    """Minimal CDP client with a background reader so screencast events are never dropped."""

    def __init__(self, ws):
        self.ws = ws
        self.msg_id = 0
        self.pending: dict[int, asyncio.Future] = {}
        self.handlers = {}
        self.reader = asyncio.create_task(self._read())

    async def _read(self):
        async for raw in self.ws:
            msg = json.loads(raw)
            if "id" in msg and msg["id"] in self.pending:
                self.pending.pop(msg["id"]).set_result(msg)
            elif msg.get("method") in self.handlers:
                await self.handlers[msg["method"]](msg["params"])

    async def send(self, method, params=None):
        self.msg_id += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.msg_id] = fut
        await self.ws.send(json.dumps({"id": self.msg_id, "method": method, "params": params or {}}))
        msg = await fut
        if "error" in msg:
            raise RuntimeError(f"CDP {method}: {msg['error']}")
        return msg.get("result", {})

    async def eval(self, expr):
        res = await self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": True})
        return res.get("result", {}).get("value")

    async def screenshot(self, path: Path):
        res = await self.send("Page.captureScreenshot", {"format": "png"})
        path.write_bytes(base64.b64decode(res["data"]))


def wait_for_cdp():
    for _ in range(50):
        time.sleep(0.3)
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json") as r:
                for tab in json.loads(r.read().decode()):
                    if tab.get("type") == "page":
                        return tab["webSocketDebuggerUrl"]
        except OSError:
            pass
    raise RuntimeError("headless Chrome did not expose CDP")


def kill_tree(proc):
    """Stop the headless Chrome we started (and only its children)."""
    if sys.platform == "win32":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    else:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def encode_video(frames_dir: Path, stamps: list[float], mp4: Path, gif: Path, gif_speed: float):
    """Variable-rate screencast frames -> constant 30 fps MP4 (wall-clock timing) -> GIF."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg or len(stamps) < 2:
        print("[!] ffmpeg not found or no frames; skipping video encode")
        return
    concat = frames_dir / "frames.txt"
    lines = []
    for i, t in enumerate(stamps):
        dur = (stamps[i + 1] - t) if i + 1 < len(stamps) else 1 / 30
        lines.append(f"file 'f{i:05d}.jpg'\nduration {max(dur, 0.001):.4f}")
    lines.append(f"file 'f{len(stamps) - 1:05d}.jpg'")
    concat.write_text("\n".join(lines), encoding="utf-8")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat),
                    "-vf", "fps=30,scale=1280:-2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "22",
                    "-movflags", "+faststart", str(mp4)], check=True)
    vf = (f"setpts=PTS/{gif_speed},fps=10,scale=480:-1:flags=lanczos,split[a][b];"
          "[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4")
    subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-i", str(mp4), "-vf", vf, "-loop", "0", str(gif)], check=True)
    print(f"[✓] {mp4.relative_to(ROOT_DIR)} ({mp4.stat().st_size / 1e6:.1f} MB), {gif.relative_to(ROOT_DIR)} ({gif.stat().st_size / 1e6:.1f} MB)")


async def run(args):
    IMG_DIR.mkdir(parents=True, exist_ok=True)
    VID_DIR.mkdir(parents=True, exist_ok=True)
    frames_dir = VID_DIR / "_frames"
    shutil.rmtree(frames_dir, ignore_errors=True)
    frames_dir.mkdir()

    jev_bridge.start_background_server(port=args.port, colab_session=args.colab_session)
    if args.colab_session and jev_bridge._get_persistent_worker() is None:
        raise RuntimeError(f"could not attach to Colab session '{args.colab_session}'")
    print(f"[*] bridge on http://127.0.0.1:{args.port}/ (backend: {args.colab_session or 'none -> local fallback'})")

    profile = tempfile.mkdtemp(prefix="aurora_chrome_")
    chrome = subprocess.Popen([
        CHROME_PATH, "--headless=new", "--window-size=1280,720", f"--remote-debugging-port={CDP_PORT}",
        "--use-angle=d3d11", "--enable-webgl", "--ignore-gpu-blocklist", "--mute-audio",
        "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
        "--user-data-dir=" + profile, f"http://127.0.0.1:{args.port}/",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tag = f"tactics_{args.policy.replace(':', '_').lower()}" if args.mode == "tactics" else f"{args.mode}_{args.timing}"
    if not args.colab_session and not (args.mode == "tactics" and args.policy != "jev"):
        tag += "_nomodel"   # never overwrite a real model run with a fallback test
    stamps: list[float] = []
    try:
        async with websockets.connect(wait_for_cdp(), max_size=64 * 1024 * 1024) as ws:
            cdp = CDP(ws)
            await cdp.send("Page.enable")
            for _ in range(100):
                if await cdp.eval("window.__aurora ? window.__aurora.info().state : 'boot'") == "title":
                    break
                await asyncio.sleep(0.3)

            recording = {"on": False}

            async def on_frame(p):
                # ack without awaiting: the reply is read by the same reader task that calls us
                asyncio.create_task(cdp.send("Page.screencastFrameAck", {"sessionId": p["sessionId"]}))
                if recording["on"]:
                    (frames_dir / f"f{len(stamps):05d}.jpg").write_bytes(base64.b64decode(p["data"]))
                    stamps.append(p["metadata"]["timestamp"])

            cdp.handlers["Page.screencastFrame"] = on_frame
            await cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 80, "maxWidth": 1280, "maxHeight": 720})
            recording["on"] = True

            cam = {"chase": 0, "far": 1, "cockpit": 2, "tv": 3}[args.cam]
            await cdp.eval(f"window.__aurora.start({{laps: {args.laps}, diff: {args.diff}, jev: '{args.mode}', timing: '{args.timing}', policy: '{args.policy}', cam: {cam}}})")
            while (await cdp.eval("window.__aurora.info().state")) != "race":
                await asyncio.sleep(0.1)
            print(f"[*] GO — Jev-Omni {args.mode.upper()} / {args.timing.upper()} / cam {args.cam}")

            wall0, snaps, last_print = time.time(), 0, 0.0
            stuck_since, last_dist, info = None, 0.0, {}
            while True:
                info = await cdp.eval("window.__aurora.info()")
                wall = time.time() - wall0
                if info["state"] == "finished" or wall > args.max_seconds:
                    break
                if wall - last_print >= 5:
                    last_print = wall
                    r = info["jevLastResult"]
                    print(f"    wall {wall:5.1f}s | game {info['raceTime']:5.1f}s | {info['v']:6.1f} km/h | P{info['pos']} | "
                          f"dist {info['dist']:7.1f} m | {r['prediction']} {r['confidence'] * 100:4.1f}% {r['latency_ms']} ms [{r['backend']}]")
                if snaps < 3 and wall > 6 + snaps * 9:
                    await cdp.screenshot(IMG_DIR / f"jev_{tag}_{snaps + 1}.png")
                    snaps += 1
                # a car that stopped making progress for 20 s is out of the race
                if info["dist"] > last_dist + 5:
                    last_dist, stuck_since = info["dist"], None
                elif stuck_since is None:
                    stuck_since = wall
                elif wall - stuck_since > 20:
                    print("[!] no progress for 20 s — stopping the run")
                    break
                await asyncio.sleep(0.2)

            finished = info["state"] == "finished"
            if finished:
                await asyncio.sleep(3.6)   # result overlay appears 3.2 s after the flag
            await cdp.screenshot(IMG_DIR / f"jev_{tag}_end.png")
            recording["on"] = False
            await cdp.send("Page.stopScreencast")
            final = await cdp.eval("window.__aurora.info()")
            log = await cdp.eval("window.__aurora.jevLog()")
            wall_total = time.time() - wall0
    finally:
        kill_tree(chrome)
        shutil.rmtree(profile, ignore_errors=True)

    lat = sorted(d["ms"] for d in log) or [0]
    model_calls = [d for d in log if "Jev-Omni" in d["backend"]]
    off = sum(1 for d in log if d["surface"] == 2)
    summary = {
        "mode": args.mode, "policy": args.policy if args.mode == "tactics" else None, "timing": args.timing, "camera": args.cam, "laps": args.laps,
        "finished": finished, "position": final["pos"], "lap_times": final["laps"],
        "race_time_s": final["raceTime"], "wall_time_s": round(wall_total, 1),
        "distance_m": final["dist"],
        "decisions": len(log), "model_decisions": len(model_calls),
        "decision_rate_hz": round(len(log) / max(wall_total, 1e-3), 2),
        "latency_ms_median": lat[len(lat) // 2], "latency_ms_p90": lat[int(len(lat) * 0.9)],
        "decisions_on_grass_pct": round(100 * off / max(len(log), 1), 1),
        "tactic_counts": {t: sum(1 for d in log if d["pred"] == t) for t in sorted({d["pred"] for d in log})},
    }
    out = ROOT_DIR / "docs" / f"jev_race_{tag}.json"
    out.write_text(json.dumps({"summary": summary, "decisions": log}, ensure_ascii=False, indent=1), encoding="utf-8")
    print("[✓] summary:", json.dumps(summary, ensure_ascii=False))

    encode_video(frames_dir, stamps, VID_DIR / f"jev_{tag}.mp4", IMG_DIR / f"jev_{tag}.gif", args.gif_speed)
    shutil.rmtree(frames_dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Record an AURORA A1 race driven by Jev-Omni")
    ap.add_argument("--colab-session", default=None, help="google-colab-cli session with Jev-Omni loaded (e.g. jev-racer)")
    ap.add_argument("--mode", choices=["tactics", "vision", "sensor", "fusion", "text"], default="vision")
    ap.add_argument("--policy", choices=["jev", "rule", "pass_only", "random", "fixed", "fixed:PASS_LEFT", "fixed:PASS_RIGHT", "fixed:BOOST"], default="jev", help="tactics mode: who picks the tactic")
    ap.add_argument("--timing", choices=["realtime", "step"], default="realtime")
    ap.add_argument("--cam", choices=["chase", "far", "cockpit", "tv"], default="cockpit")
    ap.add_argument("--laps", type=int, default=1)
    ap.add_argument("--diff", type=int, default=1)
    ap.add_argument("--max-seconds", type=float, default=150, help="wall-clock limit for the run")
    ap.add_argument("--gif-speed", type=float, default=2.0, help="GIF playback speed-up factor")
    ap.add_argument("--port", type=int, default=8766)
    asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    main()
