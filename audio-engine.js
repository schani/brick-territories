const SCALE = [0, 2, 5, 7, 10];
const MODE_GAIN = {
  drones: 0.5,
  bells: 0.42,
  swarm: 0.55,
  wind: 0.46,
  pulse: 0.4
};

const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
const note = (owner, base = 55) => base * 2 ** ((SCALE[owner % SCALE.length] + Math.floor(owner / SCALE.length) % 2 * 12) / 12);

function smooth(parameter, value, duration = 0.08) {
  const amount = clamp(0.08 / duration, 0.04, 1);
  parameter.value += (value - parameter.value) * amount;
}

export class TerritoryAudio {
  constructor() {
    this.mode = "off";
    this.modeRequest = 0;
    this.context = null;
    this.modeSources = [];
    this.captureCount = 0;
    this.captureLevel = 0;
    this.lastMetricsAt = -Infinity;
    this.lastControlAt = -Infinity;
    this.nextBellAt = 0;
    this.nextPulseAt = 0;
    this.step = 0;
    this.paused = false;
  }

  get supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  async setMode(mode, world) {
    if (mode === "off") {
      this.stop();
      return;
    }

    const request = ++this.modeRequest;
    this.ensureContext();
    await this.context.resume();
    if (request !== this.modeRequest) return;
    this.mode = mode;
    this.startMode(world);
    this.setOutput(this.paused ? 0 : MODE_GAIN[mode]);
    this.updateMetrics(world);
    this.update(world, []);
  }

  setPaused(paused) {
    this.paused = paused;
    if (this.context) this.setOutput(paused || this.mode === "off" ? 0 : MODE_GAIN[this.mode]);
  }

  reset(world) {
    this.captureCount = 0;
    this.captureLevel = 0;
    this.lastMetricsAt = -Infinity;
    this.lastControlAt = -Infinity;
    if (this.context && this.mode !== "off") this.startMode(world);
  }

  update(world, captures) {
    if (!this.context || this.mode === "off" || this.paused) return;
    const now = this.context.currentTime;
    this.captureCount += captures.length;
    if (now - this.lastMetricsAt >= 0.12) this.updateMetrics(world);

    if (this.mode === "bells") this.updateBells(captures, now);
    else if (this.mode === "pulse") this.updatePulse(world, now);
    else if (now - this.lastControlAt >= 0.08) {
      this.lastControlAt = now;
      if (this.mode === "drones") this.updateDrones(world);
      else if (this.mode === "swarm") this.updateSwarm(world, now);
      else if (this.mode === "wind") this.updateWind(now);
    }
  }

  ensureContext() {
    if (this.context) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("Web Audio is unavailable");
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = 0;
    const compressor = this.context.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.01;
    compressor.release.value = 0.3;
    this.master.connect(compressor).connect(this.context.destination);
  }

  setOutput(value) {
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(value, now, 0.05);
  }

  stop() {
    this.modeRequest += 1;
    this.mode = "off";
    this.stopMode();
    if (this.context) this.setOutput(0);
  }

  startMode(world) {
    this.stopMode();
    this.modeBus = this.context.createGain();
    this.modeBus.connect(this.master);
    if (this.mode === "drones") this.makeDrones(world);
    else if (this.mode === "bells") this.makeBells();
    else if (this.mode === "swarm") this.makeSwarm(world);
    else if (this.mode === "wind") this.makeWind();
    this.nextBellAt = 0;
    this.nextPulseAt = 0;
    this.step = 0;
  }

  stopMode() {
    for (const source of this.modeSources) {
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.modeSources = [];
    if (this.modeBus) this.modeBus.disconnect();
    this.modeBus = null;
    this.droneVoices = [];
    this.swarmVoices = [];
  }

  updateMetrics(world) {
    const counts = world.counts();
    let boundaries = 0;
    for (let row = 0; row < world.rows; row += 1) {
      for (let col = 0; col < world.cols; col += 1) {
        const index = row * world.cols + col;
        if (col + 1 < world.cols && world.cells[index] !== world.cells[index + 1]) boundaries += 1;
        if (row + 1 < world.rows && world.cells[index] !== world.cells[index + world.cols]) boundaries += 1;
      }
    }
    const sample = clamp(this.captureCount / 8);
    this.captureLevel = this.captureLevel * 0.72 + sample * 0.28;
    this.captureCount = 0;
    this.metrics = {
      counts,
      boundary: clamp(boundaries / (world.cells.length * 0.35))
    };
    this.lastMetricsAt = this.context.currentTime;
  }

  makeDrones(world) {
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 0.7;
    filter.connect(this.modeBus);
    this.droneFilter = filter;
    this.droneVoices = Array.from({ length: Math.min(5, world.balls.length) }, (_, index) => {
      const oscillator = this.context.createOscillator();
      oscillator.type = index % 2 ? "triangle" : "sine";
      oscillator.detune.value = index * 3 - 6;
      const gain = this.context.createGain();
      gain.gain.value = 0.0001;
      const pan = this.context.createStereoPanner();
      oscillator.connect(gain).connect(pan).connect(filter);
      oscillator.start();
      this.modeSources.push(oscillator);
      return { oscillator, gain, pan };
    });
  }

  updateDrones(world) {
    const ranked = [...this.metrics.counts.keys()].sort((a, b) => this.metrics.counts[b] - this.metrics.counts[a]);
    const total = world.cells.length;
    this.droneVoices.forEach((voice, index) => {
      const owner = ranked[index];
      const share = this.metrics.counts[owner] / total;
      const ball = world.balls[owner];
      smooth(voice.oscillator.frequency, note(owner, 46) * (1 + share * 0.16), 0.8);
      smooth(voice.gain.gain, 0.03 + share * 0.23, 0.6);
      smooth(voice.pan.pan, ball.x / world.width * 1.6 - 0.8, 0.5);
    });
    smooth(this.droneFilter.frequency, 380 + this.captureLevel * 1100, 0.4);
  }

  makeBells() {
    this.bellInput = this.context.createGain();
    const delay = this.context.createDelay(1);
    const feedback = this.context.createGain();
    delay.delayTime.value = 0.34;
    feedback.gain.value = 0.28;
    this.bellInput.connect(this.modeBus);
    this.bellInput.connect(delay).connect(feedback).connect(delay);
    delay.connect(this.modeBus);
  }

  updateBells(captures, now) {
    if (!captures.length || now < this.nextBellAt) return;
    const event = captures[captures.length - 1];
    const frequency = note(event.owner, 185) * (1 + event.y * 0.28);
    const oscillator = this.context.createOscillator();
    const overtone = this.context.createOscillator();
    const overtoneGain = this.context.createGain();
    const envelope = this.context.createGain();
    const pan = this.context.createStereoPanner();
    oscillator.type = "sine";
    overtone.type = "sine";
    oscillator.frequency.value = frequency;
    overtone.frequency.value = frequency * 2.01;
    overtoneGain.gain.value = 0.22;
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.16, now + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.6);
    pan.pan.value = event.x * 1.8 - 0.9;
    oscillator.connect(envelope);
    overtone.connect(overtoneGain).connect(envelope);
    envelope.connect(pan).connect(this.bellInput);
    oscillator.start(now);
    overtone.start(now);
    oscillator.stop(now + 1.65);
    overtone.stop(now + 1.65);
    this.nextBellAt = now + Math.max(0.055, 0.16 - captures.length * 0.018);
  }

  makeSwarm(world) {
    const filter = this.context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.Q.value = 1.2;
    filter.connect(this.modeBus);
    this.swarmFilter = filter;
    this.swarmVoices = world.balls.map((ball, index) => {
      const oscillator = this.context.createOscillator();
      oscillator.type = ["sine", "triangle", "sawtooth"][index % 3];
      const gain = this.context.createGain();
      gain.gain.value = 0.012;
      const pan = this.context.createStereoPanner();
      oscillator.connect(gain).connect(pan).connect(filter);
      oscillator.start();
      this.modeSources.push(oscillator);
      return { owner: ball.owner, oscillator, gain, pan, level: index % 3 === 2 ? 0.58 : 1 };
    });
  }

  updateSwarm(world, now) {
    for (const voice of this.swarmVoices) {
      const ball = world.balls[voice.owner];
      const speed = Math.hypot(ball.vx, ball.vy) / (world.settings.brick * 20.375);
      const x = ball.x / world.width;
      const y = ball.y / world.height;
      const horizontalInterval = SCALE[Math.min(4, Math.floor(x * 5))];
      const verticalInterval = y < 0.3 ? 12 : y < 0.64 ? 7 : 0;
      const vibrato = 1 + Math.sin(now * (0.7 + ball.owner * 0.035) + ball.owner * 1.7) * (0.006 + clamp(speed / 4) * 0.012);
      const frequency = note(ball.owner, 52) * 2 ** ((horizontalInterval + verticalInterval) / 12) * (0.9 + clamp(speed, 0, 3) * 0.08) * vibrato;
      smooth(voice.oscillator.frequency, frequency, 0.1);
      smooth(voice.pan.pan, ball.x / world.width * 1.8 - 0.9, 0.08);
      smooth(voice.gain.gain, (0.014 + clamp(speed / 5) * 0.028) * voice.level, 0.12);
    }
    const shimmer = 0.5 + 0.5 * Math.sin(now * 0.43);
    smooth(this.swarmFilter.frequency, 650 + this.metrics.boundary * 900 + this.captureLevel * 2200 + shimmer * 420, 0.15);
  }

  makeWind() {
    const buffer = this.context.createBuffer(1, this.context.sampleRate * 3, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    const noise = this.context.createBufferSource();
    noise.buffer = buffer;
    noise.loop = true;
    this.windBranches = [260, 1250].map((frequency, index) => {
      const filter = this.context.createBiquadFilter();
      const gain = this.context.createGain();
      const pan = this.context.createStereoPanner();
      filter.type = "bandpass";
      filter.frequency.value = frequency;
      filter.Q.value = index ? 1.4 : 0.65;
      gain.gain.value = index ? 0.025 : 0.05;
      pan.pan.value = index ? 0.45 : -0.45;
      noise.connect(filter).connect(gain).connect(pan).connect(this.modeBus);
      return { filter, gain, pan };
    });
    noise.start();
    this.modeSources.push(noise);
  }

  updateWind(now) {
    const lowDrift = 0.5 + 0.5 * Math.sin(now * 0.31 + Math.sin(now * 0.07) * 2);
    const highDrift = 0.5 + 0.5 * Math.sin(now * 0.47 + 2.1);
    const gust = 0.72 + 0.28 * Math.sin(now * (0.18 + this.captureLevel * 0.7));
    const [low, high] = this.windBranches;
    smooth(low.filter.frequency, 130 + this.metrics.boundary * 850 + this.captureLevel * 650 + lowDrift * 320, 0.3);
    smooth(high.filter.frequency, 720 + this.metrics.boundary * 2600 + this.captureLevel * 1700 + highDrift * 950, 0.22);
    smooth(low.filter.Q, 0.5 + lowDrift * 1.2 + this.captureLevel * 1.8, 0.25);
    smooth(high.filter.Q, 1 + highDrift * 3 + this.captureLevel * 3.5, 0.2);
    smooth(low.gain.gain, (0.045 + this.metrics.boundary * 0.11) * gust, 0.25);
    smooth(high.gain.gain, 0.015 + this.captureLevel * 0.1 + highDrift * 0.035, 0.2);
    smooth(low.pan.pan, -0.65 + lowDrift * 0.55, 0.4);
    smooth(high.pan.pan, 0.65 - highDrift * 0.55, 0.4);
  }

  updatePulse(world, now) {
    if (now < this.nextPulseAt) return;
    const ranked = [...this.metrics.counts.keys()].sort((a, b) => this.metrics.counts[b] - this.metrics.counts[a]);
    const owner = ranked[this.step % Math.min(6, ranked.length)];
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    const pan = this.context.createStereoPanner();
    oscillator.type = "triangle";
    oscillator.frequency.value = note(owner, 92) * (this.step % 4 === 3 ? 2 : 1);
    filter.type = "lowpass";
    filter.frequency.value = 780 + this.captureLevel * 1800;
    envelope.gain.setValueAtTime(0.0001, now);
    envelope.gain.exponentialRampToValueAtTime(0.18, now + 0.02);
    envelope.gain.exponentialRampToValueAtTime(0.0001, now + 0.48);
    pan.pan.value = world.balls[owner].x / world.width * 1.6 - 0.8;
    oscillator.connect(filter).connect(envelope).connect(pan).connect(this.modeBus);
    oscillator.start(now);
    oscillator.stop(now + 0.5);
    this.step += 1;
    this.nextPulseAt = now + 0.82 - this.captureLevel * 0.48 - this.metrics.boundary * 0.16;
  }
}
