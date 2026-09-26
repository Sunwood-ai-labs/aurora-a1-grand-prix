// Synthesised sound: V6-hybrid style engine, tyre squeal, impacts and start beeps (WebAudio, no files).
export class Audio {
  constructor() { this.ctx = null; this.enabled = true; this.muted = false; }

  start() {
    if (!this.ctx) this.init();
    this.ctx.resume();
    this.setMaster();
  }
  stop() { if (this.ctx) this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.1); }
  toggle() { this.enabled = !this.enabled; this.setMaster(); }
  mute(m) { this.muted = m; this.setMaster(); }
  setMaster() {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(this.enabled && !this.muted ? 0.5 : 0, this.ctx.currentTime, 0.05);
  }

  init() {
    const ctx = this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.master = ctx.createGain(); this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // engine: two detuned saws + square sub, through a resonant low-pass
    this.eng = ctx.createGain(); this.eng.gain.value = 0.0;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.Q.value = 6;
    this.lp.connect(this.eng).connect(this.master);
    this.oscs = [['sawtooth', 1, 0.35], ['sawtooth', 1.007, 0.3], ['square', 0.5, 0.22], ['triangle', 2, 0.12]].map(([type, mul, g]) => {
      const o = ctx.createOscillator(); o.type = type;
      const gn = ctx.createGain(); gn.gain.value = g;
      o.connect(gn).connect(this.lp); o.start();
      return { o, mul };
    });
    // noise source shared by squeal / rumble / impacts
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const mk = (type, f, q) => {
      const n = ctx.createBufferSource(); n.buffer = buf; n.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = type; bp.frequency.value = f; bp.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      n.connect(bp).connect(g).connect(this.master); n.start();
      return g;
    };
    this.squeal = mk('bandpass', 1900, 9);
    this.rumble = mk('lowpass', 180, 1);
  }

  update(rpm, throttle, slip, grass) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const f = rpm / 60 * 3 / 4;          // firing frequency / 4 for a softer tone
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.03);
    this.lp.frequency.setTargetAtTime(500 + rpm * (throttle ? 0.28 : 0.12), t, 0.05);
    this.eng.gain.setTargetAtTime(throttle ? 0.32 : 0.18, t, 0.08);
    this.squeal.gain.setTargetAtTime(Math.min(0.25, slip * 0.3), t, 0.05);
    this.rumble.gain.setTargetAtTime(Math.min(0.6, grass * 0.012), t, 0.05);
  }

  hit(strength) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = ctx.createBufferSource(); n.buffer = this.noiseBuf;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9 * strength, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    n.connect(lp).connect(g).connect(this.master); n.start(t); n.stop(t + 0.4);
  }

  beep(freq, dur = 0.18) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }
}
