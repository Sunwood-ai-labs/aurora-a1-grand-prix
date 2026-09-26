// Procedural circuit: centre-line spline, road / kerb / barrier meshes, scenery and track queries.
import * as THREE from 'three';

// control points (x, z) in metres — start/finish straight runs along -Z at x = 0
const CTRL = [
  [0, 150], [0, -100], [0, -300], [30, -420], [150, -475], [300, -440], [385, -340], [360, -210],
  [260, -150], [215, -45], [290, 60], [420, 90], [525, 185], [525, 330], [430, 425], [300, 430],
  [200, 380], [120, 470], [30, 480], [0, 400], [0, 300],
];

function canvasTex(w, h, draw, renderer, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return t;
}
function noise(g, w, h, base, amp, n = 9000, size = 2) {
  g.fillStyle = base; g.fillRect(0, 0, w, h);
  for (let i = 0; i < n; i++) {
    const v = (Math.random() - 0.5) * amp;
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`;
    g.fillRect(Math.random() * w, Math.random() * h, size, size);
  }
}

export class Track {
  constructor(scene, renderer) {
    this.halfW = 7.5; this.kerbW = 1.4; this.wallD = 25;
    const curve = new THREE.CatmullRomCurve3(CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'centripetal');
    this.length = curve.getLength();
    const n = this.n = Math.round(this.length / 2);
    this.ds = this.length / n;
    this.P = curve.getSpacedPoints(n).slice(0, n);
    this.T = []; this.R = [];
    for (let i = 0; i < n; i++) {
      const t = this.P[(i + 1) % n].clone().sub(this.P[(i - 1 + n) % n]).normalize();
      this.T.push(t); this.R.push(new THREE.Vector3(-t.z, 0, t.x));
    }
    const curv = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const dT = this.T[(i + 1) % n].clone().sub(this.T[(i - 1 + n) % n]);
      curv[i] = dT.dot(this.R[i]) / (2 * this.ds);
    }
    const smooth = (a, w) => {
      const o = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let k = -w; k <= w; k++) s += a[(i + k + n) % n]; o[i] = s / (2 * w + 1); }
      return o;
    };
    this.curvS = smooth(curv, 4);
    const cl = smooth(curv, 14);
    this.line = new Float32Array(n);
    for (let i = 0; i < n; i++) this.line[i] = Math.max(-1, Math.min(1, cl[i] * 110)) * (this.halfW - 1.8);
    this.minRadius = 1 / Math.max(...this.curvS.map(Math.abs));

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of this.P) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
    this.bounds = { minX, maxX, minZ, maxZ, w: maxX - minX, h: maxZ - minZ };
    this.center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);

    this.scene = scene; this.renderer = renderer;
    this.buildSurfaces();
    this.buildStart();
    this.buildScenery();
    console.info(`track: ${this.length.toFixed(0)} m, ${n} samples, min radius ${this.minRadius.toFixed(0)} m`);
  }

  // ------------------------------------------------------------ queries
  frameAt(s) {
    s = ((s % this.length) + this.length) % this.length;
    const f = s / this.ds, i = Math.floor(f) % this.n, j = (i + 1) % this.n, t = f - Math.floor(f);
    const pos = this.P[i].clone().lerp(this.P[j], t);
    const tan = this.T[i].clone().lerp(this.T[j], t).normalize();
    return { pos, tan, right: new THREE.Vector3(-tan.z, 0, tan.x), i };
  }

  locate(pos, hint = -1) {
    const n = this.n;
    let best = -1, bd = Infinity;
    const scan = (i) => {
      const p = this.P[i], d = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
      if (d < bd) { bd = d; best = i; }
    };
    if (hint < 0) for (let i = 0; i < n; i++) scan(i);
    else for (let k = -40; k <= 40; k++) scan((hint + k + n) % n);
    const p = this.P[best], t = this.T[best];
    const rel = pos.clone().sub(p);
    const along = rel.dot(t);
    const s = ((best * this.ds + along) % this.length + this.length) % this.length;
    return { i: best, s, d: rel.dot(this.R[best]), right: this.R[best] };
  }

  // ------------------------------------------------------------ geometry
  ribbon(offA, offB, yA, yB, vScale, idxFilter) {
    const n = this.n, pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const p = this.P[i % n], r = this.R[i % n];
      pos.push(p.x + r.x * offA, yA, p.z + r.z * offA, p.x + r.x * offB, yB, p.z + r.z * offB);
      const v = i * this.ds / vScale;
      uv.push(0, v, 1, v);
    }
    for (let i = 0; i < n; i++) {
      if (idxFilter && !idxFilter(i)) continue;
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  buildSurfaces() {
    const { scene, renderer } = this, hw = this.halfW;
    // asphalt with white edge lines
    const roadTex = canvasTex(512, 512, (g, w, h) => {
      noise(g, w, h, '#3b3b40', 0.22, 26000, 2);
      g.fillStyle = '#f2f2f2'; g.fillRect(6, 0, 12, h); g.fillRect(w - 18, 0, 12, h);
    }, renderer);
    const road = new THREE.Mesh(this.ribbon(-hw, hw, 0.02, 0.02, 14),
      new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.92, metalness: 0.0 }));
    road.receiveShadow = true;
    scene.add(road);

    // red / white kerbs on corners
    const kerbTex = canvasTex(32, 64, (g, w, h) => {
      g.fillStyle = '#e3122a'; g.fillRect(0, 0, w, h / 2);
      g.fillStyle = '#f5f5f5'; g.fillRect(0, h / 2, w, h / 2);
    }, renderer);
    const kerbMat = new THREE.MeshStandardMaterial({ map: kerbTex, roughness: 0.6, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -1 });
    const corner = (i) => Math.abs(this.curvS[i]) > 1 / 320;
    for (const sgn of [-1, 1]) {
      const m = new THREE.Mesh(this.ribbon(sgn * hw, sgn * (hw + this.kerbW), 0.05, 0.03, 3, corner), kerbMat);
      m.receiveShadow = true; scene.add(m);
    }
    // run-off tarmac strip beyond the kerb (darker)
    const runTex = canvasTex(128, 128, (g, w, h) => noise(g, w, h, '#5b5a55', 0.18, 3000, 2), renderer);
    const runMat = new THREE.MeshStandardMaterial({ map: runTex, roughness: 1, side: THREE.DoubleSide });
    for (const sgn of [-1, 1]) {
      const m = new THREE.Mesh(this.ribbon(sgn * (hw + this.kerbW), sgn * (hw + 5), 0.012, 0.012, 10,
        (i) => Math.abs(this.curvS[i]) > 1 / 200), runMat);
      m.receiveShadow = true; scene.add(m);
    }

    // grass
    const grassTex = canvasTex(256, 256, (g, w, h) => noise(g, w, h, '#4f7f32', 0.2, 12000, 3), renderer);
    grassTex.repeat.set(300, 300);
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.copy(this.center);
    ground.receiveShadow = true;
    scene.add(ground);

    // barriers with sponsor boards
    const wallTex = canvasTex(1024, 64, (g, w, h) => {
      const grad = g.createLinearGradient(0, 0, w, 0);
      grad.addColorStop(0, '#2b1a6e'); grad.addColorStop(0.5, '#5a22b8'); grad.addColorStop(1, '#2b1a6e');
      g.fillStyle = grad; g.fillRect(0, 0, w, h);
      g.fillStyle = '#ff2aa6'; g.fillRect(0, h - 8, w, 8);
      g.font = 'italic 900 40px Segoe UI, Arial'; g.textBaseline = 'middle';
      g.fillStyle = '#fff'; g.fillText('AURORA A1', 30, h / 2 - 2);
      g.fillStyle = '#1ab3d6'; g.fillText('FreeCAD', 330, h / 2 - 2);
      g.fillStyle = '#fff'; g.fillText('GRAND PRIX', 600, h / 2 - 2);
    }, renderer);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.7, side: THREE.DoubleSide });
    for (const sgn of [-1, 1]) {
      const n = this.n, pos = [], uv = [], idx = [];
      for (let i = 0; i <= n; i++) {
        const p = this.P[i % n], r = this.R[i % n], o = sgn * this.wallD;
        const x = p.x + r.x * o, z = p.z + r.z * o, v = i * this.ds / 26;
        pos.push(x, 0, z, x, 1.1, z);
        uv.push(v, 0, v, 1);
      }
      for (let i = 0; i < n; i++) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals();
      wallTex.wrapT = THREE.ClampToEdgeWrapping;
      const m = new THREE.Mesh(g, wallMat);
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m);
    }
  }

  buildStart() {
    const { scene, renderer } = this, hw = this.halfW;
    const f = this.frameAt(0), yaw = Math.atan2(f.tan.x, f.tan.z);
    // chequered line
    const chk = canvasTex(256, 32, (g, w, h) => {
      const s = 16;
      for (let x = 0; x < w; x += s) for (let y = 0; y < h; y += s) {
        g.fillStyle = ((x + y) / s) % 2 ? '#111' : '#f4f4f4'; g.fillRect(x, y, s, s);
      }
    }, renderer, false);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 1.8),
      new THREE.MeshStandardMaterial({ map: chk, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.rotation.order = 'YXZ'; line.rotation.set(-Math.PI / 2, yaw, 0);
    line.position.copy(f.pos).setY(0.03);
    scene.add(line);

    // grid boxes
    const boxMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (let k = 0; k < 4; k++) {
      const g = this.frameAt(this.length - 12 - k * 9 + 3.1);
      const d = k % 2 ? 2.8 : -2.8;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.18), boxMat);
      m.rotation.order = 'YXZ'; m.rotation.set(-Math.PI / 2, Math.atan2(g.tan.x, g.tan.z), 0);
      m.position.copy(g.pos).addScaledVector(g.right, d).setY(0.03);
      scene.add(m);
    }

    // start gantry with the five red lights
    const gantry = new THREE.Group();
    const dark = new THREE.MeshStandardMaterial({ color: 0x1a1426, roughness: 0.5, metalness: 0.6 });
    const postGeo = new THREE.BoxGeometry(0.5, 7.5, 0.5);
    for (const sx of [-1, 1]) {
      const p = new THREE.Mesh(postGeo, dark); p.position.set(sx * (hw + 2), 3.75, 0); p.castShadow = true; gantry.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2 * hw + 4.5, 1.2, 0.6), dark);
    beam.position.set(0, 7.0, 0); beam.castShadow = true; gantry.add(beam);
    const signTex = canvasTex(1024, 96, (g, w, h) => {
      g.fillStyle = '#6a2cff'; g.fillRect(0, 0, w, h);
      g.font = 'italic 900 64px Segoe UI, Arial'; g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('AURORA A1  GRAND PRIX', w / 2, h / 2);
    }, renderer, false);
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2 * hw + 4.5, 1.1), new THREE.MeshBasicMaterial({ map: signTex }));
    sign.position.set(0, 8.2, -0.31); sign.rotation.y = Math.PI; gantry.add(sign);
    const sign2 = sign.clone(); sign2.position.z = 0.31; sign2.rotation.y = 0; gantry.add(sign2);
    this.lightMats = [];
    for (let i = 0; i < 5; i++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x220404, emissive: 0x000000, roughness: 0.3 });
      this.lightMats.push(m);
      for (const side of [-1, 1]) {
        const l = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), m);
        l.position.set((i - 2) * 1.0, 7.0, side * 0.35); gantry.add(l);
      }
    }
    gantry.position.copy(f.pos); gantry.rotation.y = yaw;
    scene.add(gantry);
  }

  setLights(n) {
    this.lightMats.forEach((m, i) => { m.emissive.setHex(i < n ? 0xff1010 : 0x000000); m.emissiveIntensity = i < n ? 4 : 0; });
  }

  buildScenery() {
    const { scene, renderer } = this;
    const nearTrack = (x, z, r) => {
      for (let i = 0; i < this.n; i += 3) { const p = this.P[i]; if ((p.x - x) ** 2 + (p.z - z) ** 2 < r * r) return true; }
      return false;
    };
    // grandstand on the left of the main straight, pit building on the right
    const crowd = canvasTex(512, 128, (g, w, h) => {
      g.fillStyle = '#34304a'; g.fillRect(0, 0, w, h);
      const cols = ['#ff2aa6', '#a24bff', '#1ab3d6', '#ffffff', '#ffd23f', '#ff5a36', '#3d7bff'];
      for (let i = 0; i < 2600; i++) {
        g.fillStyle = cols[(Math.random() * cols.length) | 0];
        g.fillRect(Math.random() * w, Math.random() * h, 3, 4);
      }
    }, renderer);
    crowd.repeat.set(40, 1);
    const standMat = new THREE.MeshStandardMaterial({ map: crowd, roughness: 0.9 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xb8b4c4, roughness: 0.9 });
    const stand = new THREE.Group();
    for (let r = 0; r < 8; r++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.4, 360), [standMat, concrete, concrete, concrete, concrete, concrete]);
      m.position.set(-r * 2.2, 0.7 + r * 1.4, 0);
      m.castShadow = m.receiveShadow = true; stand.add(m);
    }
    const roof = new THREE.Mesh(new THREE.BoxGeometry(22, 0.5, 364), new THREE.MeshStandardMaterial({ color: 0x5a22b8, roughness: 0.4, metalness: 0.4 }));
    roof.position.set(-8, 15.5, 0); roof.castShadow = true; stand.add(roof);
    for (let z = -170; z <= 170; z += 34) {
      const col = new THREE.Mesh(new THREE.BoxGeometry(0.5, 15.5, 0.5), concrete); col.position.set(-17, 7.75, z); stand.add(col);
    }
    stand.position.set(-(this.wallD + 4), 0, -70);
    scene.add(stand);

    const pit = new THREE.Group();
    const pitBody = new THREE.Mesh(new THREE.BoxGeometry(14, 9, 300), new THREE.MeshStandardMaterial({ color: 0xe8e6f0, roughness: 0.6 }));
    pitBody.position.y = 4.5; pitBody.castShadow = pitBody.receiveShadow = true; pit.add(pitBody);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(14.2, 2.2, 296), new THREE.MeshStandardMaterial({ color: 0x223a5a, roughness: 0.1, metalness: 0.9 }));
    glass.position.y = 6.5; pit.add(glass);
    const logo = canvasTex(1024, 128, (g, w, h) => {
      g.fillStyle = '#12091f'; g.fillRect(0, 0, w, h);
      g.font = 'italic 900 90px Segoe UI, Arial'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#7b5cff'); gr.addColorStop(1, '#ff2aa6');
      g.fillStyle = gr; g.fillText('AURORA RACING', w / 2, h / 2);
    }, renderer, false);
    const logoM = new THREE.Mesh(new THREE.PlaneGeometry(90, 11), new THREE.MeshBasicMaterial({ map: logo }));
    logoM.position.set(-7.15, 14, 0); logoM.rotation.y = -Math.PI / 2; pit.add(logoM);
    pit.position.set(this.wallD + 12, 0, -60);
    scene.add(pit);

    // trees (instanced)
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 3, 6); trunkGeo.translate(0, 1.5, 0);
    const leafGeo = new THREE.ConeGeometry(2.6, 7, 8); leafGeo.translate(0, 6, 0);
    const N = 700;
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5a3d22, roughness: 1 }), N);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }), N);
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3();
    const col = new THREE.Color();
    const b = this.bounds;
    let k = 0;
    for (let tries = 0; tries < 6000 && k < N; tries++) {
      const x = b.minX - 350 + Math.random() * (b.w + 700), z = b.minZ - 350 + Math.random() * (b.h + 700);
      if (nearTrack(x, z, this.wallD + 10)) continue;
      if (x > -80 && x < 50 && z > -260 && z < 120) continue;   // grandstand / pits
      const s = 0.7 + Math.random() * 0.9;
      m4.compose(p.set(x, 0, z), q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * 6), sc.set(s, s * (0.8 + Math.random() * 0.5), s));
      trunks.setMatrixAt(k, m4); leaves.setMatrixAt(k, m4);
      leaves.setColorAt(k, col.setHSL(0.25 + Math.random() * 0.08, 0.45, 0.2 + Math.random() * 0.12));
      k++;
    }
    trunks.count = leaves.count = k;
    leaves.castShadow = trunks.castShadow = true;
    scene.add(trunks, leaves);

    // distant hills
    const hillMat = new THREE.MeshStandardMaterial({ color: 0x6f9468, roughness: 1 });
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2 + Math.random() * 0.2, R = 1150 + Math.random() * 250;
      const h = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), hillMat);
      h.scale.set(200 + Math.random() * 180, 50 + Math.random() * 90, 200 + Math.random() * 180);
      h.position.set(this.center.x + Math.cos(a) * R, 0, this.center.z + Math.sin(a) * R);
      scene.add(h);
    }
  }
}
