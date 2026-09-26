# AURORA A1 Grand Prix

A browser racing game driven by the **AURORA A1** F1 concept car built in FreeCAD
([Sunwood-ai-labs/aurora-a1-freecad](https://github.com/Sunwood-ai-labs/aurora-a1-freecad)). The car mesh, part colours and livery decals
come straight from the CAD build script.

**▶ Play online: https://sunwood-ai-labs.github.io/aurora-a1-grand-prix/**

## Play locally

Double-click `start_game.bat` (it needs Python 3), or run:

```
python -m http.server 8765
```

Then open <http://localhost:8765/>. The game has to be served over HTTP; opening
`index.html` directly as a file will not load the GLB model.

| Key | Action |
| --- | --- |
| ↑ / W | Throttle |
| ↓ / S | Brake (hold at a standstill to reverse) |
| ← → / A D | Steer |
| C | Camera: Chase / Far / Cockpit / TV |
| R | Reset onto the track |
| M | Sound on / off |
| Esc / P | Pause |

On touch devices, on-screen buttons appear instead. Choose 1, 3 or 5 laps and one of
three rival difficulty levels. Your best lap is saved in the browser.

## Structure

```
index.html / style.css   HUD, menus
js/main.js               game loop, car physics, AI, camera, HUD
js/track.js              procedural circuit (2.9 km): road, kerbs, barriers, gantry, scenery
js/audio.js              synthesised engine / tyre / impact sounds (WebAudio)
assets/aurora_a1.glb     car model exported from FreeCAD (~240k triangles)
tools/export_glb.py      FreeCAD → GLB exporter
```

## Re-exporting the car after a CAD change

```
freecadcmd tools/export_glb.py
```

The exporter imports `build_aurora_a1.py`, tessellates each part (2 mm linear, 0.35 rad
angular deflection), merges the parts by colour, and writes a GLB. Each wheel is its own
node (`Hub_XX` → `Wheel_XX` + `Caliper_XX`), so the game can steer and spin it.
Axes are converted from FreeCAD (X rearward, Z up, mm) to three.js (+Z forward, Y up, m).

## Debug

The browser console exposes `__aurora`. For example, `__aurora.auto(true)` enables an
autopilot, and `__aurora.run(10)` steps the simulation 10 s.
