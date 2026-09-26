#!/usr/bin/env python3
"""Collect cockpit frames + ground-truth labels (from course geometry) for offline Jev-Omni prompt evaluation."""
import asyncio
import json
import random
import shutil
import subprocess
import tempfile
import sys
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))
import jev_bridge  # noqa: E402
from run_jev_race import CDP, CHROME_PATH, CDP_PORT, kill_tree, wait_for_cdp  # noqa: E402


async def main(out: Path, port=8767):
    jev_bridge.start_background_server(port=port)   # no backend -> the game's fallback rule drives
    profile = tempfile.mkdtemp(prefix="aurora_chrome_")
    chrome = subprocess.Popen([CHROME_PATH, "--headless=new", "--window-size=1280,720", f"--remote-debugging-port={CDP_PORT}",
                               "--use-angle=d3d11", "--enable-webgl", "--ignore-gpu-blocklist", "--mute-audio",
                               f"--user-data-dir={profile}", f"http://127.0.0.1:{port}/"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    samples = []
    try:
        async with websockets.connect(wait_for_cdp(), max_size=64 * 1024 * 1024) as ws:
            cdp = CDP(ws)
            while await cdp.eval("window.__aurora ? window.__aurora.info().state : 'boot'") != "title":
                await asyncio.sleep(0.3)
            await cdp.eval("window.__aurora.start({laps: 1, diff: 1, jev: 'text', cam: 2})")
            while True:
                st = (await cdp.eval("window.__aurora.info()"))["state"]
                if st == "finished" or len(samples) > 400:
                    break
                if st == "race":
                    samples.append(await cdp.eval("window.__aurora.probe()"))
                await asyncio.sleep(0.35)
    finally:
        kill_tree(chrome)
        shutil.rmtree(profile, ignore_errors=True)
    for s in samples:
        e = s["errDeg"]
        s["steer_gt"] = "left" if e > 1.5 else "right" if e < -1.5 else "straight"
        s["brake_gt"] = s["kmh"] > s["vtKmh"] + 8
    random.seed(0)
    by = {}
    for s in samples:
        by.setdefault(s["steer_gt"], []).append(s)
    keep = [x for k in by for x in random.sample(by[k], min(len(by[k]), 25))]
    print({k: len(v) for k, v in by.items()}, "->", len(keep), "kept")
    out.write_text(json.dumps(keep), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
