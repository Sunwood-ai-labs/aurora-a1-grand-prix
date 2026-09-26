# Export AURORA A1 (FreeCAD build script) to assets/aurora_a1.glb for the web racer.
# Run:  freecadcmd.exe export_glb.py
# three.js frame: +Z forward, +Y up, metres, origin = mid-wheelbase on the ground.
import sys, os, json, struct
SRC = r"C:\Prj\FreeCAD_Demo_001\aurora_a1"
OUT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "aurora_a1.glb"))
sys.path.insert(0, SRC)
import numpy as np
import build_aurora_a1 as B
import MeshPart

TOL = 2.0        # mm linear deflection (game LOD)
ANG = 0.35       # rad angular deflection
XC = B.WHEELBASE / 2


def to3(p):  # FreeCAD (X rearward, Y lateral, Z up, mm) -> three.js (m); det = +1
    return (-p[1] / 1000.0, p[2] / 1000.0, -(p[0] - XC) / 1000.0)


def mesh_of(shape, pivot=None):
    P, N, I = [], [], []
    base = 0
    for f in shape.Faces:
        try:
            m = MeshPart.meshFromShape(Shape=f, LinearDeflection=TOL, AngularDeflection=ANG, Relative=False)
            v, t = m.Topology
        except Exception:
            continue
        if not t:
            continue
        v = np.array([to3(q) for q in v], dtype=np.float64)
        if pivot is not None:
            v -= pivot
        t = np.array(t, dtype=np.int64)
        a, b, c = v[t[:, 0]], v[t[:, 1]], v[t[:, 2]]
        fn = np.cross(b - a, c - a)
        vn = np.zeros_like(v)
        for k in range(3):
            np.add.at(vn, t[:, k], fn)
        ln = np.linalg.norm(vn, axis=1, keepdims=True)
        ln[ln == 0] = 1
        vn /= ln
        P.append(v); N.append(vn); I.append(t + base)
        base += len(v)
    if not P:
        return None
    return (np.vstack(P).astype(np.float32), np.vstack(N).astype(np.float32),
            np.vstack(I).astype(np.uint32).ravel())


class GLB:
    def __init__(self):
        self.bin = bytearray(); self.views = []; self.acc = []; self.meshes = []; self.nodes = []
        self.mats = {}; self.matlist = []

    def mat(self, col):
        key = tuple(round(c, 3) for c in col)
        if key not in self.mats:
            dark = key in (tuple(B.C_TYRE), tuple(B.C_CARBON))
            metal = key in (tuple(B.C_METAL), tuple(B.C_TITAN), tuple(B.C_BRAKE))
            lin = [c ** 2.2 for c in key]  # sRGB -> linear
            self.mats[key] = len(self.matlist)
            self.matlist.append({
                "name": "c_%d" % len(self.matlist),
                "pbrMetallicRoughness": {
                    "baseColorFactor": lin + [1.0],
                    "metallicFactor": 0.8 if metal else (0.1 if dark else 0.35),
                    "roughnessFactor": 0.85 if key == tuple(B.C_TYRE) else (0.45 if dark else 0.25)},
                "doubleSided": True})
        return self.mats[key]

    def buf(self, arr, target):
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin); self.bin += arr.tobytes()
        self.views.append({"buffer": 0, "byteOffset": off, "byteLength": arr.nbytes, "target": target})
        return len(self.views) - 1

    def mesh(self, name, parts):  # parts: [(P, N, I, col)]
        prims = []
        for P, N, I, col in parts:
            vp = self.buf(P, 34962); vn = self.buf(N, 34962); vi = self.buf(I, 34963)
            self.acc += [
                {"bufferView": vp, "componentType": 5126, "count": len(P), "type": "VEC3",
                 "min": P.min(0).tolist(), "max": P.max(0).tolist()},
                {"bufferView": vn, "componentType": 5126, "count": len(N), "type": "VEC3"},
                {"bufferView": vi, "componentType": 5125, "count": len(I), "type": "SCALAR"}]
            n = len(self.acc)
            prims.append({"attributes": {"POSITION": n - 3, "NORMAL": n - 2}, "indices": n - 1,
                          "material": self.mat(col)})
        self.meshes.append({"name": name, "primitives": prims})
        return len(self.meshes) - 1

    def node(self, name, mesh=None, t=None, children=None):
        nd = {"name": name}
        if mesh is not None: nd["mesh"] = mesh
        if t is not None: nd["translation"] = [float(x) for x in t]
        if children: nd["children"] = children
        self.nodes.append(nd)
        return len(self.nodes) - 1

    def write(self, path, roots):
        while len(self.bin) % 4:
            self.bin.append(0)
        js = {"asset": {"version": "2.0", "generator": "AURORA A1 FreeCAD exporter"},
              "scene": 0, "scenes": [{"nodes": roots}], "nodes": self.nodes, "meshes": self.meshes,
              "materials": self.matlist, "accessors": self.acc, "bufferViews": self.views,
              "buffers": [{"byteLength": len(self.bin)}]}
        j = json.dumps(js, separators=(",", ":")).encode()
        j += b" " * ((4 - len(j) % 4) % 4)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(j) + 8 + len(self.bin)))
            f.write(struct.pack("<II", len(j), 0x4E4F534A)); f.write(j)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942)); f.write(bytes(self.bin))


def merge_by_color(items, pivot=None):
    groups = {}
    for name, (shp, col) in items:
        m = mesh_of(shp, pivot)
        if m is not None:
            groups.setdefault(tuple(col), []).append(m)
    out = []
    for col, ms in groups.items():
        P = np.vstack([m[0] for m in ms]); N = np.vstack([m[1] for m in ms])
        off, I = 0, []
        for m in ms:
            I.append(m[2] + off); off += len(m[0])
        out.append((P, N, np.concatenate(I).astype(np.uint32), col))
    return out


body = []
chassis = B.build_chassis(); body += list(chassis.items())
aero, pod_r, pod_l, cover = B.build_aero(); body += list(aero.items())
body += list(B.build_power_unit().items())
body += list(B.build_drivetrain().items())
body += list(B.build_suspension().items())

# livery decals (same as build())
A = B.App; V = B.V
decals = [("AURORA", 105, pod_r, V(1520, 800, 390), A.Rotation(V(1, 0, 0), -90).multiply(A.Rotation(V(0, 0, 1), 180)), True),
          ("AURORA", 105, pod_l, V(1520, -800, 390), A.Rotation(V(1, 0, 0), 90), True),
          ("77", 150, chassis["NoseCone"][0], V(-430, 0, 500), A.Rotation(V(0, 0, 1), -90), False),
          ("AURORA", 70, cover, V(2350, 0, 900), A.Rotation(V(0, 0, 1), 0), False)]
for i, (txt, size, host, pl, rot, side) in enumerate(decals):
    shift = V(0, 6 if pl.y > 0 else -6, 0) if side else V(0, 0, 6)
    try:
        d = B.decal(txt, size, host, pl, rot, shift=shift)
        if d is not None and d.Volume > 1:
            body.append(("Decal%d" % i, (d, B.C_WHITE)))
    except Exception as e:
        print("decal failed:", e)
for y, rot in ((530, A.Rotation(V(1, 0, 0), -90).multiply(A.Rotation(V(0, 0, 1), 180))),
               (-530, A.Rotation(V(1, 0, 0), 90))):
    ts = B.text_solid("AURORA", 60, 3)
    ts.Placement = A.Placement(V(4310, y, 640), rot).multiply(ts.Placement)
    body.append(("DecalRE", (ts, B.C_WHITE)))

g = GLB()
children = [g.node("Body", g.mesh("Body", merge_by_color(body)))]
for wn, parts in B.build_wheels().items():
    key = wn.split("_")[1]                      # FR, FL, RR, RL
    x = 0.0 if key[0] == "F" else B.WHEELBASE
    T = B.FRONT_TYRE if key[0] == "F" else B.REAR_TYRE
    y = (1 if key[1] == "R" else -1) * T["track"] / 2
    piv = np.array(to3((x, y, T["D"] / 2)))
    spin = [(n, v) for n, v in parts.items() if not n.startswith("BrakeCaliper")]
    cal = [(n, v) for n, v in parts.items() if n.startswith("BrakeCaliper")]
    wnode = g.node("Wheel_" + key, g.mesh("Wheel_" + key, merge_by_color(spin, piv)))
    cnode = g.node("Caliper_" + key, g.mesh("Caliper_" + key, merge_by_color(cal, piv)))
    children.append(g.node("Hub_" + key, None, piv, [wnode, cnode]))
root = g.node("AURORA_A1", None, None, children)
g.write(OUT, [root])
tris = sum(a["count"] for a in g.acc if a["type"] == "SCALAR") // 3
print("WROTE", OUT, os.path.getsize(OUT), "bytes", tris, "tris")
