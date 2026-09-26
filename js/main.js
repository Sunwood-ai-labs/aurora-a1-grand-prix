// AURORA A1 Grand Prix — web racing game using the FreeCAD-built AURORA A1 model.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Track } from './track.js';
import { Audio } from './audio.js';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const fmt = (t) => {
  if (!isFinite(t)) return '--:--.---';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};

// ---------------------------------------------------------------- renderer / scene
const canvas = $('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fc4ea);
scene.fog = new THREE.Fog(0xb9d3ee, 250, 1400);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 3000);
scene.add(new THREE.HemisphereLight(0xdfeaff, 0x4a6a2a, 0.9));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -35, right: 35, top: 35, bottom: -35, near: 1, far: 300 });
sun.shadow.bias = -0.0004;
scene.add(sun, sun.target);
const SUN_DIR = new THREE.Vector3(-0.45, 0.8, 0.35).normalize();

function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------- track
const track = new Track(scene, renderer);
const L = track.length;

// ---------------------------------------------------------------- physics constants
const G = 9.81, WHEELBASE = 3.6, VMAX = 97;
const engineAccel = (v) => Math.max(0, 12.5 - 0.105 * v);
const dragAccel = (v) => 0.00028 * v * Math.abs(v);
const brakeAccel = (v) => 22 + 0.0026 * v * v;
const latGrip = (v, mu) => mu * (12 + 0.0035 * v * v);   // downforce grows with v²
const GEARS = [0, 22, 33, 44, 55, 66, 76, 86, 99];
function gearOf(v) {
  if (v < 0.5) return v < -0.3 ? -1 : 0;
  for (let g = 1; g < GEARS.length; g++) if (v < GEARS[g]) return g;
  return 8;
}
function rpmOf(v) {
  const g = gearOf(Math.abs(v));
  if (g <= 0) return 4000 + Math.abs(v) * 400;
  const lo = g === 1 ? 0 : GEARS[g - 1] * 0.92, hi = GEARS[g];
  return 6500 + 5500 * clamp((v - lo) / (hi - lo), 0, 1);
}

// AI speed profile from track curvature (same grip model as the player)
function speedProfile(mu) {
  const n = track.n, ds = track.ds, v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const R = 1 / Math.max(Math.abs(track.curvS[i]), 1e-5);
    const den = 1 - mu * 0.0035 * R;
    v[i] = den <= 0 ? VMAX : Math.min(VMAX, Math.sqrt(12 * mu * R / den));
  }
  for (let pass = 0; pass < 2; pass++)
    for (let k = n - 1; k >= 0; k--) {
      const j = (k + 1) % n;
      v[k] = Math.min(v[k], Math.sqrt(v[j] * v[j] + 2 * brakeAccel(v[j]) * 0.8 * ds));
    }
  return v;
}

// ---------------------------------------------------------------- cars
const RIVALS = [
  { name: 'NOVA', hue: 0.72, tag: '#2ee6a6' },
  { name: 'SOLAR', hue: 0.36, tag: '#ff9a1a' },
  { name: 'CRIMSON', hue: 0.27, tag: '#ff3348' },
];
const PLAYER_TAG = '#a24bff';
const SKILL = [[0.80, 0.84, 0.87], [0.88, 0.92, 0.95], [0.94, 0.97, 1.0]];

function tintModel(root, hueShift) {
  const cache = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.material = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
      if (!cache.has(m)) {
        const c = m.clone();
        const hsl = {}; c.color.getHSL(hsl);
        if (hsl.s > 0.35 && hsl.l > 0.08) c.color.setHSL((hsl.h + hueShift) % 1, hsl.s, hsl.l);
        cache.set(m, c);
      }
      return cache.get(m);
    });
    if (o.material.length === 1) o.material = o.material[0];
  });
}

class Car {
  constructor(model, opts) {
    this.obj = model;
    this.name = opts.name; this.tag = opts.tag; this.isPlayer = !!opts.player;
    this.body = model.getObjectByName('Body');
    this.hubs = {}; this.wheels = {};
    for (const k of ['FR', 'FL', 'RR', 'RL']) {
      this.hubs[k] = model.getObjectByName('Hub_' + k);
      this.wheels[k] = model.getObjectByName('Wheel_' + k);
    }
    this.pos = new THREE.Vector3(); this.yaw = 0;
    this.vel = new THREE.Vector3();
    this.v = 0; this.steer = 0; this.skill = 1;
    this.idx = 0; this.s = 0; this.d = 0; this.dist = 0;
    this.lapStart = 0; this.laps = []; this.finished = false; this.finishTime = Infinity;
    this.pitch = 0; this.roll = 0; this.lane = 0; this.spin = 0;
    scene.add(model);
  }
  place(s, d) {
    const p = track.frameAt(s);
    this.pos.copy(p.pos).addScaledVector(p.right, d);
    this.yaw = Math.atan2(p.tan.x, p.tan.z);
    this.vel.set(0, 0, 0); this.v = 0; this.steer = 0;
    this.idx = p.i; this.s = s; this.d = d;
    this.dist = s - L;    // on the grid, behind the line
    this.laps = []; this.finished = false; this.finishTime = Infinity;
    this.lane = d;
  }
  syncVisual(dt) {
    this.obj.position.set(this.pos.x, 0.02, this.pos.z);
    this.obj.rotation.y = this.yaw;
    this.spin += (this.v / 0.335) * dt;
    for (const k in this.wheels) this.wheels[k].rotation.x = this.spin;
    this.hubs.FR.rotation.y = this.hubs.FL.rotation.y = -this.steer * 0.9;
    this.body.rotation.set(this.pitch, 0, this.roll);
  }
}

// ---------------------------------------------------------------- input
const keys = {};
const KEYMAP = { ArrowUp: 'gas', KeyW: 'gas', ArrowDown: 'brake', KeyS: 'brake', ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right' };
addEventListener('keydown', (e) => {
  if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; e.preventDefault(); }
  if (e.repeat) return;
  if (e.code === 'KeyC') cycleCam();
  if (e.code === 'KeyJ') cycleJevMode();
  if (e.code === 'KeyT') cycleJevTiming();
  if (e.code === 'KeyM') audio.toggle();
  if (e.code === 'KeyR' && state === 'race') resetToTrack(player);
  if (e.code === 'Escape' || e.code === 'KeyP') togglePause();
});
addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
for (const b of document.querySelectorAll('#touch button')) {
  const k = b.dataset.k;
  const on = (e) => { e.preventDefault(); keys[k] = true; b.classList.add('act'); };
  const off = (e) => { e.preventDefault(); keys[k] = false; b.classList.remove('act'); };
  b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off);
  b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
}

// ---------------------------------------------------------------- camera
const CAMS = ['CHASE', 'FAR', 'COCKPIT', 'TV'];
let camMode = 0;
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let camYaw = 0;
function cycleCam() { camMode = (camMode + 1) % CAMS.length; $('cam').textContent = `CAM: ${CAMS[camMode]} (C)`; }

function updateCamera(car, dt, shake) {
  const fwd = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
  const k = 1 - Math.exp(-dt * 8);
  let wantPos, wantLook, fov = 60 + clamp(car.v, 0, 95) * 0.14;
  if (CAMS[camMode] === 'COCKPIT') {
    wantPos = car.pos.clone().addScaledVector(fwd, 0.42).setY(0.98);
    wantLook = car.pos.clone().addScaledVector(fwd, 30).setY(0.8);
    camPos.copy(wantPos); camLook.copy(wantLook); fov += 6;
  } else if (CAMS[camMode] === 'TV') {
    const p = track.frameAt(Math.floor((car.s + 60) / 180) * 180 + 60);
    wantPos = p.pos.clone().addScaledVector(p.right, track.halfW + 26).setY(9);
    camPos.copy(wantPos);
    camLook.lerp(car.pos.clone().setY(0.8), 1 - Math.exp(-dt * 12));
    fov = clamp(1800 / Math.max(10, camPos.distanceTo(car.pos)), 12, 55);
  } else {
    // follow the smoothed heading so the camera never trails further behind at speed
    const far = CAMS[camMode] === 'FAR';
    camYaw += wrapAngle(car.yaw - camYaw) * k;
    const cf = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
    wantPos = car.pos.clone().addScaledVector(cf, far ? -13 : -8.2).setY(far ? 4.2 : 2.5);
    camPos.copy(wantPos);
    camLook.copy(car.pos).addScaledVector(cf, 5).setY(0.9);
  }
  camera.position.copy(camPos);
  if (shake > 0) camera.position.add(new THREE.Vector3((Math.random() - .5) * shake, (Math.random() - .5) * shake, 0));
  camera.lookAt(camLook);
  camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * 4));
  camera.updateProjectionMatrix();
}

// ---------------------------------------------------------------- game state
const audio = new Audio();
let cars = [], player = null, template = null;
let state = 'loading', raceTime = 0, countdown = 0, laps = 3, diff = 1, bestLap = Infinity;
let lastLight = -1, msgTimer = 0;
let jevMode = 'vision'; // 'off' | 'vision' (screen frames) | 'sensor' (range sensors) | 'fusion' (frames + sensors) | 'text' | 'tactics' (two-layer) (course telemetry)
const jevProfile = speedProfile(1.0);
try { bestLap = parseFloat(localStorage.getItem('aurora_best') || 'Infinity'); } catch { /* storage unavailable */ }
$('best').textContent = fmt(bestLap);

function showMsg(t, dur = 1.6) { $('msg').textContent = t; $('msg').classList.add('show'); msgTimer = dur; }

function buildCars() {
  for (const c of cars) scene.remove(c.obj);
  cars = [];
  RIVALS.forEach((r, i) => {
    const m = template.clone(true);
    tintModel(m, r.hue);
    const car = new Car(m, { name: r.name, tag: r.tag });
    car.skill = SKILL[diff][2 - i];
    cars.push(car);
  });
  const pName = jevMode === 'off' ? 'YOU' : 'JEV-OMNI';
  player = new Car(template.clone(true), { name: pName, tag: PLAYER_TAG, player: true });
  cars.push(player);
  // grid: fastest rival on pole, player starts last
  cars.forEach((c, k) => c.place(L - 12 - k * 9, k % 2 ? 2.8 : -2.8));
  for (const c of cars) if (!c.isPlayer) c.profile = speedProfile(c.skill);
}

function startRace() {
  buildCars();
  raceTime = 0; countdown = 0; lastLight = -1; state = 'countdown';
  camMode = !['off', 'text', 'tactics'].includes(jevMode) ? CAMS.indexOf('COCKPIT') : 0; $('cam').textContent = `CAM: ${CAMS[camMode]} (C)`;
  jevLog = []; jevBusy = false; jevTimer = 0; resetTactics();
  camYaw = player.yaw;
  $('title').classList.add('hidden'); $('result').classList.add('hidden'); $('hud').classList.remove('hidden');
  $('lights').classList.add('show');
  for (const i of document.querySelectorAll('#lights i')) i.classList.remove('on');
  track.setLights(0);
  initJevHUD();
  audio.start();
}

function resetToTrack(car) {
  const p = track.frameAt(car.s);
  car.pos.copy(p.pos); car.yaw = Math.atan2(p.tan.x, p.tan.z);
  car.vel.set(0, 0, 0); car.v = 0;
}

function togglePause() {
  if (state === 'race' || state === 'countdown') {
    pausedFrom = state; state = 'paused'; $('pause').classList.remove('hidden'); audio.mute(true);
  } else if (state === 'paused') {
    state = pausedFrom; $('pause').classList.add('hidden'); audio.mute(false);
  }
}
let pausedFrom = 'race';

// ---------------------------------------------------------------- simulation
function wrapDelta(ds) { return ds - L * Math.round(ds / L); }

function stepPlayer(car, dt, controls) {
  const fwd = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  let vF = car.vel.dot(fwd), vL = car.vel.dot(right);
  const surf = car.surface;              // 0 track, 1 kerb, 2 grass
  const mu = surf === 2 ? 0.55 : 1.0;

  // longitudinal
  let a = 0;
  if (controls.gas) a += vF >= -0.5 ? engineAccel(vF) * (surf === 2 ? 0.6 : 1) * (controls.ers ?? 1) : brakeAccel(0);
  if (controls.brake) a -= vF > 0.5 ? brakeAccel(vF) * (surf === 2 ? 0.5 : 1) : (vF > -12 ? 6 : 0);
  a -= dragAccel(vF) + Math.sign(vF) * (surf === 2 ? 0.02 * vF * vF + 3 : 0.35);
  if (!controls.gas && !controls.brake && Math.abs(vF) < 0.4) vF = 0;
  vF += a * dt;
  vF = clamp(vF, -12, VMAX + 3);

  // steering (speed-sensitive)
  // analog axis (-1..1) from the Jev-Omni pilot, otherwise digital keys
  const target = controls.steerAxis ?? ((controls.right ? 1 : 0) - (controls.left ? 1 : 0));
  const maxSteer = 0.32 / (1 + Math.abs(vF) / 30);
  car.steer = lerp(car.steer, target * maxSteer, 1 - Math.exp(-dt * 7));
  let yawRate = vF * Math.tan(car.steer) / WHEELBASE;
  const aMax = latGrip(Math.abs(vF), mu);
  const yrMax = aMax / Math.max(Math.abs(vF), 1);
  car.slip = 0;
  if (Math.abs(yawRate) > yrMax) {                       // understeer: scrub speed
    car.slip = clamp((Math.abs(yawRate) - yrMax) / yrMax, 0, 1.5);
    yawRate = Math.sign(yawRate) * yrMax;
    vF -= Math.sign(vF) * car.slip * 6 * dt;
  }
  car.yaw -= yawRate * dt;                               // +steer = right = clockwise from above
  vL *= Math.exp(-dt * (surf === 2 ? 3 : 8));
  car.slip = Math.max(car.slip, Math.abs(vL) / 6);

  const f2 = new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw));
  const r2 = new THREE.Vector3(-f2.z, 0, f2.x);
  car.vel.copy(f2).multiplyScalar(vF).addScaledVector(r2, vL);
  car.v = vF;
  car.pos.addScaledVector(car.vel, dt);

  // body motion
  car.pitch = lerp(car.pitch, clamp(-a * 0.0012, -0.02, 0.02), 1 - Math.exp(-dt * 6));
  car.roll = lerp(car.roll, clamp(-yawRate * vF * 0.0007, -0.025, 0.025), 1 - Math.exp(-dt * 6));
}

function trackState(car, full = false) {
  const t = track.locate(car.pos, full ? -1 : car.idx);
  const ds = wrapDelta(t.s - car.s);
  car.idx = t.i; car.s = t.s; car.d = t.d;
  car.dist += ds;
  const ad = Math.abs(t.d);
  car.surface = ad < track.halfW ? 0 : ad < track.halfW + track.kerbW ? 1 : 2;
  // barriers
  const wall = track.wallD - 1.2;
  if (ad > wall) {
    const n = t.right.clone().multiplyScalar(Math.sign(t.d));
    car.pos.addScaledVector(n, wall - ad);
    const vn = car.vel.dot(n);
    if (vn > 0) {
      car.vel.addScaledVector(n, -1.4 * vn);
      car.vel.multiplyScalar(0.8);
      car.v = car.vel.dot(new THREE.Vector3(Math.sin(car.yaw), 0, Math.cos(car.yaw)));
      if (car.isPlayer && vn > 4) { audio.hit(Math.min(1, vn / 30)); shakeT = 0.3; }
    }
  }
}

function stepAI(car, dt, racing) {
  const i = Math.floor(car.s / track.ds) % track.n;
  let vt = racing ? car.profile[(i + 3) % track.n] * (0.97 + 0.03 * Math.sin(raceTime * 0.3 + car.skill * 20)) : 0;
  // traffic: follow / pass the car ahead
  let laneWant = track.line[i] * 0.9;
  for (const o of cars) {
    if (o === car) continue;
    const gap = wrapDelta(o.s - car.s);
    if (gap > 0 && gap < 22 && Math.abs(o.d - car.d) < 2.4) {
      if (o.v < car.v + 2) {
        laneWant = o.d > 0 ? o.d - 3.6 : o.d + 3.6;
        if (gap < 9) vt = Math.min(vt, o.v - 1);
      }
    }
  }
  car.lane = lerp(car.lane, clamp(laneWant, -track.halfW + 1.4, track.halfW - 1.4), 1 - Math.exp(-dt * 0.9));
  const acc = car.v < vt ? Math.min(engineAccel(car.v) - dragAccel(car.v), (vt - car.v) * 4) : -Math.min(brakeAccel(car.v), (car.v - vt) * 6);
  car.v = Math.max(0, car.v + acc * dt);
  const prevS = car.s;
  car.s = (car.s + car.v * dt) % L;
  car.dist += wrapDelta(car.s - prevS);
  car.d = clamp(lerp(car.d, car.lane, 1 - Math.exp(-dt * 3)), -track.wallD + 2, track.wallD - 2);
  const p = track.frameAt(car.s), q = track.frameAt(car.s + 7 + car.v * 0.12);
  car.pos.copy(p.pos).addScaledVector(p.right, car.d);
  const ahead = q.pos.clone().addScaledVector(q.right, lerp(car.d, car.lane, 0.5));
  const oldYaw = car.yaw, tanYaw = Math.atan2(p.tan.x, p.tan.z);
  // heading follows the path ahead, never more than ~17° off the track direction
  car.yaw = tanYaw + clamp(wrapAngle(Math.atan2(ahead.x - car.pos.x, ahead.z - car.pos.z) - tanYaw), -0.3, 0.3);
  const yawRate = wrapAngle(car.yaw - oldYaw) / Math.max(dt, 1e-4);
  car.steer = clamp(-yawRate * WHEELBASE / Math.max(car.v, 3), -0.3, 0.3);
  car.vel.set(Math.sin(car.yaw), 0, Math.cos(car.yaw)).multiplyScalar(car.v);
  car.pitch = lerp(car.pitch, clamp(-acc * 0.0012, -0.02, 0.02), 1 - Math.exp(-dt * 6));
  car.roll = lerp(car.roll, clamp(yawRate * car.v * 0.0007, -0.025, 0.025), 1 - Math.exp(-dt * 6));
  car.idx = p.i;
}
const wrapAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function collide() {
  // player vs rivals in track coordinates (car ≈ 5.6 m × 2.0 m)
  for (const o of cars) {
    if (o === player) continue;
    const ds = wrapDelta(o.s - player.s), dd = o.d - player.d;
    if (Math.abs(ds) < 5.2 && Math.abs(dd) < 1.95) {
      const p = track.frameAt(player.s);
      const pushLat = Math.abs(dd) / 1.95 > Math.abs(ds) / 5.2;
      if (pushLat) {
        const push = (1.95 - Math.abs(dd)) * Math.sign(dd || 1);
        player.pos.addScaledVector(p.right, -push * 0.7);
        o.d += push * 0.3; o.lane = clamp(o.lane + push * 0.3, -track.halfW + 1.4, track.halfW - 1.4);
        player.vel.addScaledVector(p.right, -Math.sign(dd || 1) * 2);
      } else {
        const behind = ds > 0;           // player behind rival
        const push = (5.2 - Math.abs(ds)) * (behind ? 1 : -1);
        player.pos.addScaledVector(p.tan, -push * 0.6);
        const vp = player.v, vo = o.v;
        if (behind && vp > vo) { player.vel.multiplyScalar(Math.max(0.2, vo / Math.max(vp, 1)) * 0.95); o.v = vo + (vp - vo) * 0.5; }
        if (!behind && vo > vp) { o.v = vp * 0.95; player.vel.multiplyScalar(1 + (vo - vp) * 0.3 / Math.max(vp, 5)); }
      }
      const imp = Math.abs(player.v - o.v);
      if (imp > 3) { audio.hit(Math.min(1, imp / 25)); shakeT = 0.25; }
    }
  }
}

function lapCheck(car) {
  const lap = Math.floor(car.dist / L);         // completed laps (grid is behind the line)
  if (!car.finished && lap > car.laps.length) {
    {
      const lt = raceTime - car.lapStart;
      car.laps.push(lt); car.lapStart = raceTime;
      if (car.isPlayer) {
        $('last').textContent = fmt(lt);
        if (lt < bestLap) {
          bestLap = lt; $('best').textContent = fmt(bestLap);
          try { localStorage.setItem('aurora_best', String(bestLap)); } catch { /* ignore */ }
          if (car.laps.length < laps) showMsg('BEST LAP ' + fmt(lt), 1.8);
        }
        if (car.laps.length === laps - 1) setTimeout(() => showMsg('FINAL LAP'), 1900);
      }
      if (car.laps.length >= laps) {
        car.finished = true; car.finishTime = raceTime;
        if (car.isPlayer) finishRace();
      }
    }
  }
}

function finishRace() {
  state = 'finished';
  showMsg('FINISH!', 3);
  setTimeout(showResults, 3200);
}

function standings() {
  return [...cars].sort((a, b) => {
    if (a.finished || b.finished) return (a.finishTime - b.finishTime) || (b.dist - a.dist);
    return b.dist - a.dist;
  });
}

function showResults() {
  const st = standings();
  const pos = st.indexOf(player) + 1;
  $('res-title').textContent = pos === 1 ? 'VICTORY!' : `P${pos} FINISH`;
  $('res-table').innerHTML = st.map((c, i) => {
    const t = c.finished ? fmt(c.finishTime) : `+${Math.max(0, (laps * L - c.dist) / Math.max(c.v, 30)).toFixed(1)}s`;
    const best = c.laps.length ? fmt(Math.min(...c.laps)) : '--';
    return `<tr class="${c.isPlayer ? 'me' : ''}"><td>P${i + 1}</td><td><span style="color:${c.tag}">■</span> ${c.name}</td><td>BEST ${best}</td><td>${t}</td></tr>`;
  }).join('');
  $('res-best').textContent = `あなたのベストラップ（記録）: ${fmt(bestLap)}`;
  $('result').classList.remove('hidden');
}

// ---------------------------------------------------------------- HUD
const mm = $('minimap').getContext('2d');
function drawMinimap() {
  const W = 220; mm.clearRect(0, 0, W, W);
  const b = track.bounds, sc = (W - 30) / Math.max(b.w, b.h);
  const tx = (x) => 15 + (x - b.minX) * sc + (W - 30 - b.w * sc) / 2;
  const tz = (z) => 15 + (z - b.minZ) * sc + (W - 30 - b.h * sc) / 2;
  if (!drawMinimap.path) {
    const p = new Path2D();
    for (let i = 0; i <= track.n; i += 4) { const q = track.P[i % track.n]; i ? p.lineTo(tx(q.x), tz(q.z)) : p.moveTo(tx(q.x), tz(q.z)); }
    p.closePath(); drawMinimap.path = p;
  }
  mm.lineJoin = 'round';
  mm.strokeStyle = 'rgba(255,255,255,.18)'; mm.lineWidth = 9; mm.stroke(drawMinimap.path);
  mm.strokeStyle = '#d8d2ee'; mm.lineWidth = 3; mm.stroke(drawMinimap.path);
  const s0 = track.P[0];
  mm.fillStyle = '#fff'; mm.fillRect(tx(s0.x) - 5, tz(s0.z) - 1.5, 10, 3);
  for (const c of cars) {
    mm.beginPath(); mm.arc(tx(c.pos.x), tz(c.pos.z), c.isPlayer ? 6 : 4.5, 0, 7);
    mm.fillStyle = c.tag; mm.fill();
    if (c.isPlayer) { mm.strokeStyle = '#fff'; mm.lineWidth = 2; mm.stroke(); }
  }
}

function updateHUD() {
  const st = standings(), pos = st.indexOf(player) + 1;
  $('pos').innerHTML = `P${pos}<small>/${cars.length}</small>`;
  $('lap').textContent = `${clamp(player.laps.length + 1, 1, laps)}/${laps}`;
  $('time').textContent = fmt(state === 'countdown' ? 0 : (player.finished ? player.finishTime : raceTime));
  const kmh = Math.round(Math.abs(player.v) * 3.6);
  $('speed').textContent = kmh;
  const g = gearOf(player.v);
  $('gear').textContent = g < 0 ? 'R' : g === 0 ? 'N' : g;
  $('rpmfill').style.width = `${clamp((rpmOf(Math.abs(player.v)) - 3000) / 9500, 0, 1) * 100}%`;
  const lead = st[0];
  $('board').innerHTML = st.map((c, i) => {
    const gap = i === 0 ? 'LEADER' : `+${((lead.dist - c.dist) / Math.max(c.v, 20)).toFixed(1)}`;
    return `<div class="${c.isPlayer ? 'me' : ''}"><span>${i + 1}</span><i style="background:${c.tag}"></i>${c.name}<span class="gap">${gap}</span></div>`;
  }).join('');
  drawMinimap();
  updateJevHUD();
}

// ---------------------------------------------------------------- Jev-Omni System-1 AI
// Each option is sent to Jev-Omni as plain language; the answer is mapped back by index.
// steer: -1 left .. +1 right, lon: +1 throttle .. -1 brake
const JEV_OPTIONS = [
  { id: 'FULL_GAS_STRAIGHT', label: 'GAS + STRAIGHT', text: 'Drive straight ahead at full throttle', steer: 0, lon: 1 },
  { id: 'GAS_STEER_LEFT',    label: 'GAS + LEFT',     text: 'Steer left to follow the left curve', steer: -1, lon: 1 },
  { id: 'GAS_STEER_RIGHT',   label: 'GAS + RIGHT',    text: 'Steer right to follow the right curve', steer: 1, lon: 1 },
  { id: 'BRAKE_ENTRY_LEFT',  label: 'BRAKE + LEFT',   text: 'Brake and turn left into the sharp left corner', steer: -1, lon: -1 },
  { id: 'BRAKE_ENTRY_RIGHT', label: 'BRAKE + RIGHT',  text: 'Brake and turn right into the sharp right corner', steer: 1, lon: -1 },
  { id: 'HARD_BRAKE',        label: 'HARD BRAKE',     text: 'Brake hard because the car is about to leave the track', steer: 0, lon: -1 },
];
const JEV_STEP_DT = 0.2;     // STEP mode: game seconds simulated per decision

let jevTiming = 'realtime';  // 'realtime' (the clock never stops) | 'step' (the clock waits for each decision)
let jevLastResult = {
  prediction: 'FULL_GAS_STRAIGHT',
  confidence: 0,
  probabilities: {},
  latency_ms: 0,
  backend: 'READY',
  summary: '',
};
let jevSensors = null;
let jevBusy = false, jevTimer = 0, jevLog = [], jevHz = 0, jevLastAt = 0;
const jevFrame = document.createElement('canvas');
jevFrame.width = 512; jevFrame.height = 288;

function initJevHUD() {
  const bars = $('jev-bars');
  if (!bars) return;
  bars.innerHTML = jevOptions().map((o) => `
    <div class="jev-row" id="jrow-${o.id}">
      <span>${o.label}</span>
      <div class="jev-bar-bg"><div class="jev-bar-fg" id="jbar-${o.id}"></div></div>
      <span class="jev-pct" id="jpct-${o.id}">0%</span>
    </div>`).join('');
  updateJevHUD();
}

function cycleJevMode() {
  const order = ['off', 'tactics', 'vision', 'sensor', 'fusion', 'text'];
  jevMode = order[(order.indexOf(jevMode) + 1) % order.length];
  if (player) player.name = jevMode === 'off' ? 'YOU' : 'JEV-OMNI';
  showMsg(`JEV-OMNI: ${jevMode.toUpperCase()}`, 1.2);
  updateJevHUD();
}

function cycleJevTiming() {
  jevTiming = jevTiming === 'realtime' ? 'step' : 'realtime';
  showMsg(`JEV TIMING: ${jevTiming.toUpperCase()}`, 1.2);
  updateJevHUD();
}

// course telemetry computed by the game (TEXT mode input and the offline fallback only)
function courseTelemetry(car) {
  const i = Math.floor(car.s / track.ds) % track.n;
  const vt = jevProfile[(i + 8) % track.n];
  const p = track.frameAt(car.s + 12 + car.v * 0.3);
  const target = p.pos.clone().addScaledVector(p.right, track.line[p.i] * 0.55).sub(car.pos);
  const errRad = wrapAngle(Math.atan2(target.x, target.z) - car.yaw);
  const c = track.curvS[(i + 12) % track.n];
  const curve = Math.abs(c) < 0.0025 ? 'straight' : c > 0.007 ? 'sharp right' : c > 0 ? 'right' : c < -0.007 ? 'sharp left' : 'left';
  return { vt, errRad, curve };
}

// LiDAR-like range sensor: free asphalt distance along rays from the car (+angle = right)
const SENSOR_ANGLES = [-60, -30, -10, 0, 10, 30, 60], SENSOR_MAX = 120;
function readSensors(car) {
  const edge = track.halfW + track.kerbW;
  const rays = SENSOR_ANGLES.map((deg) => {
    const a = car.yaw - deg * Math.PI / 180, dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    let hint = car.idx, r = 0;
    while (r < SENSOR_MAX) {
      const t = track.locate(car.pos.clone().addScaledVector(dir, r + 1.5), hint);
      if (Math.abs(t.d) > edge) break;
      hint = t.i; r += 1.5;
    }
    return Math.round(r);
  });
  return { rays, left: +(track.halfW + car.d).toFixed(1), right: +(track.halfW - car.d).toFixed(1) };
}
function sensorText(sn) {
  const name = (deg) => deg === 0 ? 'straight ahead' : `${Math.abs(deg)} deg ${deg < 0 ? 'left' : 'right'}`;
  const rays = SENSOR_ANGLES.map((deg, k) => `${name(deg)} ${sn.rays[k] >= SENSOR_MAX ? `${SENSOR_MAX}+` : sn.rays[k]} m`).join(', ');
  return `Range sensors (distance of open track along each direction): ${rays}. Distance to the track edge: left ${sn.left} m, right ${sn.right} m.`;
}

// What the model is given. VISION: the rendered 3D frame (the HUD is DOM, so it is not in the canvas)
// plus the speed/gear a driver reads off the dashboard. SENSOR: range-sensor readings only (no image).
// FUSION: the frame plus the range-sensor readings.
// TEXT: course telemetry computed by the game.
function buildJevInput(car) {
  const kmh = Math.round(car.v * 3.6), g = gearOf(car.v);
  const question = 'What should the driver do right now to stay on the track and drive fast?';
  if (jevMode === 'tactics') {
    const ts = tacticState(car);
    return { state: ts.text, question: 'Which race tactic should the driver use for the next second?',
      options: TACTICS.map((o) => o.text), modality: 'text', debias: true };
  }
  const options = JEV_OPTIONS.map((o) => o.text);
  if (jevMode === 'sensor') {   // range sensors only, no image
    const sn = readSensors(car);
    return { state: `You are driving an F1 race car on an asphalt circuit. Speed: ${kmh} km/h, gear ${g}. ${sensorText(sn)}`,
      question, options, modality: 'text', sensors: sn };
  }
  if (jevMode === 'vision' || jevMode === 'fusion') {
    jevFrame.getContext('2d').drawImage(canvas, 0, 0, jevFrame.width, jevFrame.height);
    const sn = jevMode === 'fusion' ? readSensors(car) : null;
    return {
      state: `${CAMS[camMode].toLowerCase()} camera view of your F1 race car on an asphalt circuit. Speed: ${kmh} km/h, gear ${g}.` + (sn ? ' ' + sensorText(sn) : ''),
      question, options, modality: 'image', image_base64: jevFrame.toDataURL('image/jpeg', 0.8), sensors: sn,
    };
  }
  const t = courseTelemetry(car), errDeg = t.errRad * (180 / Math.PI);
  return {
    state: `Speed: ${kmh} km/h (safe speed ahead: ${Math.round(t.vt * 3.6)} km/h). Racing line is ${Math.abs(errDeg).toFixed(1)} deg to the ${errDeg > 0 ? 'left' : 'right'}. Upcoming: ${t.curve}. Surface: ${['asphalt', 'kerb', 'grass'][car.surface || 0]}.`,
    question, options, modality: 'text',
  };
}

// offline fallback (e.g. GitHub Pages without the bridge): a hand-tuned rule on course telemetry, not the model
function localFallbackJev(car) {
  const { vt, errRad: e } = courseTelemetry(car);
  const over = car.v - vt > 2;
  const logits = JEV_OPTIONS.map((o) => (o.lon > 0 ? (over ? -2 : 2.4) : (over ? 2.4 : -2.4)) +
    (o.steer === 0 ? -Math.abs(e) * 18 : (Math.abs(e) > 0.018 && Math.sign(e) === -o.steer ? Math.abs(e) * 22 : -2.5)));
  const m = Math.max(...logits), ex = logits.map((l) => Math.exp(l - m)), sum = ex.reduce((a, b) => a + b, 0);
  return ex.map((x) => x / sum);
}

function applyJevProbs(probs, latency, backend) {
  const probabilities = {};
  let best = 0;
  const opts = jevOptions();
  opts.forEach((o, k) => { probabilities[o.id] = probs[k] || 0; if (probs[k] > probs[best]) best = k; });
  jevLastResult = {
    prediction: opts[best].id, confidence: probs[best], probabilities,
    latency_ms: Math.round(latency), backend, summary: opts[best].text,
  };
  const now = performance.now();
  if (jevLastAt) jevHz = lerp(jevHz, 1000 / Math.max(1, now - jevLastAt), 0.3);
  jevLastAt = now;
  jevLog.push({ t: +raceTime.toFixed(2), kmh: Math.round(player.v * 3.6), surface: player.surface, mode: jevMode, timing: jevTiming,
    battery: Math.round(player.battery ?? 0), pos: standings().indexOf(player) + 1,
    pred: jevLastResult.prediction, conf: +probs[best].toFixed(3), ms: jevLastResult.latency_ms, backend });
  updateJevHUD();
}

async function pollJev(car) {
  jevBusy = true;
  const t0 = performance.now();
  const inp = buildJevInput(car);
  jevSensors = inp.sensors || null;
  try {
    const resp = await fetch('/api/jev/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inp),
      signal: AbortSignal.timeout(5000),
    });
    const data = resp.ok ? await resp.json() : null;
    if (data && data.probabilities) {
      applyJevProbs(inp.options.map((t) => data.probabilities[t] ?? 0), data.latency_ms ?? performance.now() - t0, data.backend || 'JEV-OMNI');
      jevBusy = false;
      return;
    }
  } catch { /* no bridge: standalone page */ }
  if (jevMode === 'tactics') {
    const r = ruleTactic(tacticState(car), car);
    applyJevProbs(TACTICS.map((o) => (o.id === r ? 1 : 0)), performance.now() - t0, 'LOCAL FALLBACK (rule, no model)');
  } else applyJevProbs(localFallbackJev(car), performance.now() - t0, 'LOCAL FALLBACK (no model)');
  jevBusy = false;
}

// The car is driven only by Jev-Omni's probability distribution: no racing-line or speed-profile assist.
function stepJevAutopilot(car, ctl, dt) {
  if (jevMode === 'tactics') { stepTactics(car, ctl, dt); return; }
  jevTimer -= dt;
  if (!jevBusy && jevTimer <= 0) {
    jevTimer = jevTiming === 'step' ? JEV_STEP_DT : 0;
    pollJev(car);
  }
  const p = jevLastResult.probabilities;
  let steer = 0, lon = 0;
  for (const o of JEV_OPTIONS) { steer += (p[o.id] || 0) * o.steer; lon += (p[o.id] || 0) * o.lon; }
  ctl.steerAxis = clamp(steer * 1.5, -1, 1);
  ctl.gas = lon > 0.1;
  ctl.brake = lon < -0.1 && car.v > 1;   // braking at a standstill would engage reverse
}

// STEP mode: hold the simulation clock while a decision is in flight
function jevHoldsClock() {
  return jevMode !== 'off' && jevTiming === 'step' && state === 'race' && jevBusy;
}

function updateJevHUD() {
  const badge = $('jev-badge'), meta = $('jev-meta'), st = $('jev-state');
  if (!badge) return;
  if (jevMode === 'off') {
    badge.textContent = 'MANUAL (J)';
    badge.className = 'badge';
    meta.innerHTML = 'Press <kbd>J</kbd> to activate Jev-Omni AI';
  } else {
    badge.textContent = jevMode === 'tactics' ? `TACTICS · ${tacticPolicy.toUpperCase()}` : `${jevMode === 'fusion' ? 'V+S' : jevMode.toUpperCase()} · ${jevTiming === 'step' ? 'STEP' : 'REALTIME'}`;
    badge.className = 'badge ' + jevMode;
    meta.innerHTML = `<span>${jevLastResult.backend}</span><span>${jevLastResult.latency_ms} ms · ${jevHz.toFixed(1)} Hz</span>`;
  }
  const probs = jevLastResult.probabilities || {};
  for (const o of jevOptions()) {
    const pct = Math.round(clamp(probs[o.id] || 0, 0, 1) * 100);
    const row = $(`jrow-${o.id}`), bar = $(`jbar-${o.id}`), txt = $(`jpct-${o.id}`);
    if (row) row.classList.toggle('top', jevLastResult.prediction === o.id && jevMode !== 'off');
    if (bar) bar.style.width = `${pct}%`;
    if (txt) txt.textContent = `${pct}%`;
  }
  if (st) {
    st.textContent = jevMode === 'off' ? '' : (jevLastResult.summary || 'Waiting for race start...');
    if (jevMode === 'tactics' && player) st.textContent += `
BATTERY ${Math.round(player.battery)}%`;
    else if (jevSensors) st.textContent += `
SENSOR ${SENSOR_ANGLES.map((d, k) => `${d > 0 ? 'R' : d < 0 ? 'L' : ''}${Math.abs(d)}:${jevSensors.rays[k]}`).join(' ')} m`;
  }
}

// ---------------------------------------------------------------- two-layer pilot: Jev-Omni tactics
// Upper layer (Jev-Omni or a baseline policy) picks a tactic about once a second.
// Lower layer (a plain controller) follows the racing line at a fixed pace, stays behind
// slower cars unless told to pass, and applies the chosen battery mode.
const TACTICS = [
  { id: 'NORMAL',     label: 'NORMAL',      text: 'Drive normally on the racing line' },
  { id: 'BOOST',      label: 'BOOST',       text: 'Use the battery boost to accelerate harder' },
  { id: 'HARVEST',    label: 'HARVEST',     text: 'Save energy: lift slightly and recharge the battery' },
  { id: 'PASS_LEFT',  label: 'PASS LEFT',   text: 'Overtake the car ahead on its left side' },
  { id: 'PASS_RIGHT', label: 'PASS RIGHT',  text: 'Overtake the car ahead on its right side' },
];
const TACTIC_PACE = 1.0;          // controller pace (speed-profile grip factor), same for every policy
const TACTIC_DT = 0.6;            // decision interval for the non-model policies (game seconds)
const ERS = { BOOST: { accel: 1.35, rate: -14 }, HARVEST: { accel: 0.8, rate: 7 }, other: { accel: 1, rate: 1.5 } };
let tacticPolicy = 'jev';         // 'jev' | 'rule' | 'pass_only' | 'random' | 'fixed' | 'fixed:<TACTIC>'
let tactic = 'NORMAL', tacticLane = 0, tacticProfile = null;
let tacticRng = 1;

function jevOptions() { return jevMode === 'tactics' ? TACTICS : JEV_OPTIONS; }

function resetTactics() {
  tactic = 'NORMAL'; tacticLane = 0; tacticRng = 12345;
  tacticProfile = tacticProfile || speedProfile(TACTIC_PACE);
  if (player) player.battery = 50;
}

// the next corner ahead of the car (course knowledge belongs to the controller layer; the tactic prompt gets a summary)
function nextCorner(car) {
  for (let k = 0; k < 250; k++) {
    const c = track.curvS[(car.idx + k) % track.n];
    if (Math.abs(c) > 0.004) return { dist: Math.round(k * track.ds), dir: c > 0 ? 'right' : 'left', sharp: Math.abs(c) > 0.009 };
  }
  return { dist: 500, dir: 'none', sharp: false };
}

function carAhead(car, range = 45) {
  let best = null;
  for (const o of cars) {
    if (o === car) continue;
    const gap = wrapDelta(o.s - car.s);
    if (gap > -4 && gap < range && (!best || gap < best.gap)) best = { car: o, gap };
  }
  if (!best) return null;
  const o = best.car, room = (d) => +(d - 1.0).toFixed(1);
  return { car: o, name: o.name, gap: best.gap, dv: (o.v - car.v) * 3.6, d: o.d,
    roomLeft: room(track.halfW + o.d), roomRight: room(track.halfW - o.d), overlap: Math.abs(o.d - car.d) < 2.3 };
}

function tacticState(car) {
  const st = standings(), pos = st.indexOf(car) + 1, corner = nextCorner(car), ah = carAhead(car);
  const lap = clamp(car.laps.length + 1, 1, laps);
  let text = `F1 race, lap ${lap} of ${laps}, position ${pos} of ${cars.length}. Speed ${Math.round(car.v * 3.6)} km/h. Battery ${Math.round(car.battery)}%. `;
  text += corner.dist < 15 ? `The car is in a ${corner.sharp ? 'sharp ' : ''}${corner.dir} corner now. `
    : `Straight road for the next ${corner.dist} m, then a ${corner.sharp ? 'sharp ' : ''}${corner.dir} corner. `;
  if (ah && ah.gap < 40) {
    text += `Car ahead: ${ah.name}, ${Math.max(0, Math.round(ah.gap))} m ahead, ${Math.abs(Math.round(ah.dv))} km/h ${ah.dv < 0 ? 'slower' : 'faster'} than you. ` +
      `Free space beside it: ${Math.max(0, ah.roomLeft)} m on its left, ${Math.max(0, ah.roomRight)} m on its right (a car needs about 3 m).`;
  } else text += 'No car within 40 m ahead.';
  return { text, corner, ahead: ah, pos };
}

// baseline policies
function ruleTactic(ts, car) {
  const ah = ts.ahead;
  if (ah && ah.gap < 30 && ah.dv < 3) {
    if (Math.max(ah.roomLeft, ah.roomRight) >= 3) return ah.roomLeft > ah.roomRight ? 'PASS_LEFT' : 'PASS_RIGHT';
  }
  if (ts.corner.dist > 120 && car.battery > 20) return 'BOOST';
  if (ts.corner.dist < 40 && car.battery < 90) return 'HARVEST';
  return 'NORMAL';
}
function randomTactic() {
  tacticRng = (tacticRng * 1103515245 + 12345) & 0x7fffffff;
  return TACTICS[tacticRng % TACTICS.length].id;
}

function decideTacticLocally(car) {
  const ts = tacticState(car);
  // 'fixed' = always NORMAL, 'fixed:<ID>' = always that tactic, 'pass_only' = rule without battery use
  if (tacticPolicy === 'rule') tactic = ruleTactic(ts, car);
  else if (tacticPolicy === 'pass_only') { const r = ruleTactic(ts, car); tactic = r.startsWith('PASS') ? r : 'NORMAL'; }
  else if (tacticPolicy === 'random') tactic = randomTactic();
  else tactic = tacticPolicy.startsWith('fixed:') ? tacticPolicy.slice(6) : 'NORMAL';
  const probs = TACTICS.map((o) => (o.id === tactic ? 1 : 0));
  applyJevProbs(probs, 0, `${tacticPolicy.toUpperCase()} POLICY`);
}

function stepTactics(car, ctl, dt) {
  // upper layer
  jevTimer -= dt;
  if (tacticPolicy === 'jev') {
    if (!jevBusy && jevTimer <= 0) { jevTimer = jevTiming === 'step' ? JEV_STEP_DT : 0; pollJev(car); }
    if (TACTICS.some((o) => o.id === jevLastResult.prediction)) tactic = jevLastResult.prediction;
  } else if (jevTimer <= 0) {
    jevTimer = TACTIC_DT;
    decideTacticLocally(car);
  }
  // lower layer: pace + traffic + lane
  const i = car.idx;
  let vt = tacticProfile[(i + 8) % track.n];
  let lane = track.line[i] * 0.6;
  const ah = carAhead(car, 30);
  if (ah && ah.gap > -4) {
    const passing = (tactic === 'PASS_LEFT' && ah.roomLeft >= 3) || (tactic === 'PASS_RIGHT' && ah.roomRight >= 3);
    if (passing) lane = ah.d + (tactic === 'PASS_LEFT' ? -3.4 : 3.4);
    else if (ah.overlap && ah.gap > 0 && ah.gap < 14) vt = Math.min(vt, ah.car.v - 1);   // stay behind
  }
  tacticLane = lerp(tacticLane, clamp(lane, -track.halfW + 1.2, track.halfW - 1.2), 1 - Math.exp(-dt * 1.5));
  ctl.gas = car.v < vt * 0.98;
  ctl.brake = car.v > vt * 1.03;
  const p = track.frameAt(car.s + 12 + car.v * 0.3);
  const toT = p.pos.clone().addScaledVector(p.right, tacticLane).sub(car.pos);
  const err = wrapAngle(Math.atan2(toT.x, toT.z) - car.yaw);
  ctl.steerAxis = clamp(-err * 6, -1, 1);
  // battery (ERS)
  const mode = car.battery > 0 && tactic === 'BOOST' ? ERS.BOOST : tactic === 'HARVEST' ? ERS.HARVEST : ERS.other;
  ctl.ers = mode.accel;
  car.battery = clamp(car.battery + mode.rate * dt, 0, 100);
}

// ---------------------------------------------------------------- main loop
let shakeT = 0, hudT = 0;
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 1 / 20);
  if (!frozen) tick(dt);
}
function tick(dt, draw = true) {
  if (state === 'loading' || state === 'title') {
    // attract mode: slow orbit around the start line
    const t = performance.now() * 0.00008;
    const c = track.P[0];
    camera.position.set(c.x + Math.cos(t) * 40, 14, c.z + Math.sin(t) * 40);
    camera.lookAt(c.x, 1, c.z);
    if (player) { player.syncVisual(0); }
    sun.position.copy(camera.position).addScaledVector(SUN_DIR, 120); sun.target.position.copy(c);
    renderer.render(scene, camera);
    return;
  }
  if (jevHoldsClock()) { renderer.render(scene, camera); return; }   // STEP mode: time waits for Jev-Omni
  if (state !== 'paused') {
    const SUB = 4, h = dt / SUB;
    if (state === 'countdown') {
      countdown += dt;
      const lit = Math.min(5, Math.floor(countdown / 0.9));
      if (lit !== lastLight) {
        lastLight = lit; track.setLights(lit);
        document.querySelectorAll('#lights i').forEach((el, i) => el.classList.toggle('on', i < lit));
        if (lit > 0) audio.beep(lit === 5 ? 660 : 440);
      }
      if (countdown > 0.9 * 5 + 0.6 + (startDelay)) {
        state = 'race'; track.setLights(0);
        document.querySelectorAll('#lights i').forEach((el) => el.classList.remove('on'));
        setTimeout(() => $('lights').classList.remove('show'), 800);
        showMsg('GO!', 1.0); audio.beep(990, 0.4);
        for (const c of cars) c.lapStart = 0;
      }
    }
    const racing = state === 'race' || state === 'finished';
    for (let s = 0; s < SUB; s++) {
      if (racing) raceTime += h;
      const ctl = state === 'race' ? keys : state === 'finished' ? { brake: player.v > 25, gas: player.v < 20 } : {};
      if (state === 'finished') autoSteer(player, ctl);   // autopilot cool-down lap
      if (jevMode !== 'off' && state === 'race') {
        stepJevAutopilot(player, ctl, h);
      } else if (debugAuto && state === 'race') {
        const vt = debugAuto[(player.idx + 8) % track.n];
        ctl.gas = player.v < vt * 0.97; ctl.brake = player.v > vt * 1.03; autoSteer(player, ctl);
      }
      stepPlayer(player, h, ctl);
      trackState(player);
      for (const c of cars) if (!c.isPlayer) stepAI(c, h, racing);
      collide();
      if (racing) for (const c of cars) lapCheck(c);
    }
    audio.update(rpmOf(Math.abs(player.v)), keys.gas && state === 'race', player.slip * (Math.abs(player.v) > 8 ? 1 : 0), player.surface === 2 ? Math.abs(player.v) : 0);
    for (const c of cars) c.syncVisual(dt);
    shakeT = Math.max(0, shakeT - dt);
    const grassShake = player.surface === 2 ? Math.min(0.08, Math.abs(player.v) * 0.002) : player.surface === 1 ? 0.02 : 0;
    updateCamera(player, dt, shakeT * 0.4 + (CAMS[camMode] === 'COCKPIT' ? grassShake * 0.5 : grassShake));
    hudT -= dt;
    if (hudT <= 0) { updateHUD(); hudT = 1 / 20; }
    if (msgTimer > 0 && (msgTimer -= dt) <= 0) $('msg').classList.remove('show');
  }
  sun.position.copy(player.pos).addScaledVector(SUN_DIR, 120);
  sun.target.position.copy(player.pos);
  if (draw) renderer.render(scene, camera);
}
let startDelay = 0, debugAuto = null, frozen = false;

// steer toward the racing line (used after the flag)
function autoSteer(car, ctl) {
  const p = track.frameAt(car.s + 12 + car.v * 0.3);
  const target = p.pos.clone().addScaledVector(p.right, track.line[p.i] * 0.6);
  const toT = target.sub(car.pos);
  const want = Math.atan2(toT.x, toT.z);
  const err = wrapAngle(want - car.yaw);
  ctl.left = err > 0.02; ctl.right = err < -0.02;
}

// ---------------------------------------------------------------- UI wiring
for (const seg of document.querySelectorAll('.seg')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    if (seg.dataset.opt === 'laps') laps = +b.dataset.v;
    else if (seg.dataset.opt === 'diff') diff = +b.dataset.v;
    else if (seg.dataset.opt === 'jev') jevMode = b.dataset.v;
    else if (seg.dataset.opt === 'timing') jevTiming = b.dataset.v;
  });
}
$('start').onclick = () => { startDelay = Math.random() * 1.2; startRace(); };
$('again').onclick = () => { $('result').classList.add('hidden'); $('hud').classList.add('hidden'); $('title').classList.remove('hidden'); state = 'title'; audio.stop(); };
$('resume').onclick = togglePause;
$('quit').onclick = () => { $('pause').classList.add('hidden'); $('hud').classList.add('hidden'); $('title').classList.remove('hidden'); state = 'title'; audio.stop(); };

// ---------------------------------------------------------------- load the FreeCAD model
new GLTFLoader().load('assets/aurora_a1.glb', (gltf) => {
  template = gltf.scene;
  template.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  buildCars();
  state = 'title';
  $('loadfill').style.width = '100%';
  $('loadtxt').textContent = 'AURORA A1 — FreeCAD model ready (' +
    Math.round(countTris(template) / 1000) + 'k tris)';
  $('start').disabled = false;
}, (e) => {
  if (e.total) $('loadfill').style.width = `${(e.loaded / e.total) * 100}%`;
}, (err) => { $('loadtxt').textContent = 'モデルの読込に失敗しました: ' + err.message; console.error(err); });

function countTris(root) {
  let n = 0;
  root.traverse((o) => { if (o.isMesh) n += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  return n;
}

state = 'loading';
frame();

// debug hook for automated testing: __aurora.run(seconds, {gas:true}) steps the simulation manually
window.__aurora = {
  run(sec, k = {}) { Object.assign(keys, k); for (let t = 0; t < sec; t += 1 / 60) tick(1 / 60, t + 1 / 60 >= sec); updateHUD(); return this.info(); },
  info: () => ({ state, raceTime: +raceTime.toFixed(2), v: +(player?.v * 3.6).toFixed(1), s: +player?.s.toFixed(1),
    d: +player?.d.toFixed(2), dist: +player?.dist.toFixed(1), laps: player?.laps, pos: standings().indexOf(player) + 1,
    surface: player?.surface, jevMode, jevLastResult,
    ai: cars.filter((c) => !c.isPlayer).map((c) => ({ n: c.name, v: +(c.v * 3.6).toFixed(0), dist: +c.dist.toFixed(0), laps: c.laps.map((x) => +x.toFixed(2)) })) }),
  freeze: (on) => { frozen = on; },
  cam: (i) => { camMode = (i + CAMS.length - 1) % CAMS.length; cycleCam(); },
  auto: (on, skill = 0.9) => { debugAuto = on ? speedProfile(skill) : null; },
  jev: (mode = 'text') => { jevMode = mode; if (player) player.name = mode === 'off' ? 'YOU' : 'JEV-OMNI'; initJevHUD(); return jevMode; },
  policy: (p) => { if (p) tacticPolicy = p; updateJevHUD(); return tacticPolicy; },
  timing: (t) => { if (t) jevTiming = t; updateJevHUD(); return jevTiming; },
  jevLog: () => jevLog,
  // evaluation only: the frame the model would see plus ground truth from the course (never sent to the model)
  probe: () => {
    const m = jevMode; jevMode = 'vision'; const inp = buildJevInput(player); jevMode = m;
    const sn = readSensors(player);
    const t = courseTelemetry(player);
    return { img: inp.image_base64, kmh: Math.round(player.v * 3.6), vtKmh: Math.round(t.vt * 3.6), errDeg: +(t.errRad * 180 / Math.PI).toFixed(2), curve: t.curve, surface: player.surface, sensors: sn, sensorText: sensorText(sn) };
  },
  start: (opts = {}) => {
    if (opts.laps) laps = opts.laps;
    if (opts.diff !== undefined) diff = opts.diff;
    if (opts.jev) jevMode = opts.jev;
    if (opts.timing) jevTiming = opts.timing;
    if (opts.policy) tacticPolicy = opts.policy;
    startDelay = 0;
    startRace();
    if (opts.cam !== undefined) { camMode = (opts.cam + CAMS.length - 1) % CAMS.length; cycleCam(); }
  },
};
