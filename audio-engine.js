const SCALE = [0, 2, 5, 7, 10];
const BELL_SCALE = [0, 3, 5, 7, 10];
const MODE_GAIN = {
  drones: 0.5,
  bells: 0.42,
  swarm: 0.55,
  wind: 0.46,
  pulse: 0.4,
  "grain-impact": 0.82,
  "grain-clouds": 0.7,
  "grain-scrub": 0.76
};

const clamp = (value, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));
const note = (owner, base = 55) => base * 2 ** ((SCALE[owner % SCALE.length] + Math.floor(owner / SCALE.length) % 2 * 12) / 12);
const bellNote = (owner, y) => {
  const territoryOctave = Math.floor(owner / BELL_SCALE.length) % 2 * 12;
  const positionOctave = y < 1 / 3 ? 12 : y > 2 / 3 ? -12 : 0;
  return 185 * 2 ** ((BELL_SCALE[owner % BELL_SCALE.length] + territoryOctave + positionOctave) / 12);
};

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
    this.nextGrainAt = 0;
    this.grainSequence = 0;
    this.grainGeneration = 0;
    this.activeGrains = 0;
    this.scrubPosition = 0;
    this.grainSources = new Map();
    this.grainLoadRequest = 0;
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

  async loadGrainSource(arrayBuffer, world) {
    const request = ++this.grainLoadRequest;
    this.ensureContext();
    const buffer = await this.context.decodeAudioData(arrayBuffer.slice(0));
    if (request !== this.grainLoadRequest) return null;
    this.setGrainBuffer(buffer, "upload");
    if (this.mode.startsWith("grain-")) this.startMode(world);
    return buffer.duration;
  }

  async loadGrainPreset(key, url, world) {
    const request = ++this.grainLoadRequest;
    this.ensureContext();
    let source = this.grainSources.get(key);
    if (!source && key === "builtin") {
      this.grainBuffer = null;
      this.grainAnalysis = null;
      this.ensureGrainBuffer();
      source = this.grainSources.get(key);
    } else if (!source) {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load " + url);
      const buffer = await this.context.decodeAudioData(await response.arrayBuffer());
      if (request !== this.grainLoadRequest) return false;
      this.setGrainBuffer(buffer, key);
      source = this.grainSources.get(key);
    }
    if (request !== this.grainLoadRequest) return false;
    this.grainBuffer = source.buffer;
    this.grainAnalysis = source.analysis;
    if (this.mode.startsWith("grain-")) this.startMode(world);
    return true;
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
    else if (this.mode === "grain-impact") this.updateGrainImpacts(world, captures, now);
    else if (this.mode === "grain-clouds") this.updateGrainClouds(world, captures, now);
    else if (this.mode === "grain-scrub") this.updateGrainScrubber(world, captures, now);
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
    else if (this.mode.startsWith("grain-")) this.makeGranular();
    this.nextBellAt = 0;
    this.nextPulseAt = 0;
    this.nextGrainAt = 0;
    this.grainSequence = 0;
    this.step = 0;
  }

  stopMode() {
    for (const source of this.modeSources) {
      try { source.stop(); } catch {}
      source.disconnect();
    }
    this.modeSources = [];
    for (const node of this.grainNodes || []) node.disconnect();
    this.grainNodes = [];
    this.grainGeneration += 1;
    this.activeGrains = 0;
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
    const frequency = bellNote(event.owner, event.y);
    const oscillator = this.context.createOscillator();
    const overtone = this.context.createOscillator();
    const overtoneGain = this.context.createGain();
    const envelope = this.context.createGain();
    const pan = this.context.createStereoPanner();
    oscillator.type = "sine";
    overtone.type = "sine";
    oscillator.frequency.value = frequency;
    overtone.frequency.value = frequency * 2;
    overtoneGain.gain.value = 0.16;
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

  setGrainBuffer(buffer, key) {
    this.grainBuffer = buffer;
    this.grainAnalysis = this.analyzeGrainBuffer(buffer);
    this.grainSources.set(key, { buffer, analysis: this.grainAnalysis });
  }

  ensureGrainBuffer() {
    if (this.grainBuffer) return;
    const sampleRate = this.context.sampleRate;
    const buffer = this.context.createBuffer(1, sampleRate * 12, sampleRate);
    const data = buffer.getChannelData(0);
    const frequencies = [55, 82.5, 110, 146.83, 220];
    let noise = 0;
    for (let index = 0; index < data.length; index += 1) {
      const time = index / sampleRate;
      noise = noise * 0.985 + (Math.random() * 2 - 1) * 0.015;
      const tone = frequencies.reduce((sum, frequency, voice) => (
        sum + Math.sin(time * frequency * Math.PI * 2 + voice * 1.7) * (0.08 / (voice + 1))
      ), 0);
      const pulse = Math.sin(time * Math.PI * 0.43) ** 8;
      data[index] = clamp(tone + noise * (0.18 + pulse * 0.32), -0.8, 0.8);
    }
    this.setGrainBuffer(buffer, "builtin");
  }

  analyzeGrainBuffer(buffer) {
    const data = buffer.getChannelData(0);
    const windowSize = Math.min(2048, data.length);
    const frameCount = Math.min(1536, Math.max(1, Math.floor(data.length / windowSize)));
    const frames = [];
    let previousRms = 0;
    let maxima = { rms: 0, brightness: 0, noisiness: 0, transient: 0 };

    for (let frame = 0; frame < frameCount; frame += 1) {
      const start = Math.floor(frame / frameCount * Math.max(1, data.length - windowSize));
      let energy = 0;
      let difference = 0;
      let crossings = 0;
      let previous = data[start];
      for (let index = 0; index < windowSize; index += 1) {
        const sample = data[start + index];
        energy += sample * sample;
        difference += Math.abs(sample - previous);
        if ((sample >= 0) !== (previous >= 0)) crossings += 1;
        previous = sample;
      }
      const rms = Math.sqrt(energy / windowSize);
      const brightness = difference / windowSize;
      const noisiness = crossings / windowSize;
      const transient = Math.max(0, rms - previousRms);
      previousRms = rms;
      maxima = {
        rms: Math.max(maxima.rms, rms),
        brightness: Math.max(maxima.brightness, brightness),
        noisiness: Math.max(maxima.noisiness, noisiness),
        transient: Math.max(maxima.transient, transient)
      };
      frames.push({ offset: start / buffer.sampleRate, rms, brightness, noisiness, transient });
    }

    for (const frame of frames) {
      for (const feature of ["rms", "brightness", "noisiness", "transient"]) {
        frame[feature] /= maxima[feature] || 1;
      }
    }
    const audible = frames.filter((frame) => frame.rms > 0.02);
    const sourceFrames = audible.length ? audible : frames;
    const ranked = (feature, portion, descending = true) => [...sourceFrames]
      .sort((a, b) => (a[feature] - b[feature]) * (descending ? -1 : 1))
      .slice(0, Math.max(1, Math.ceil(sourceFrames.length * portion)));
    return {
      timeline: sourceFrames,
      all: sourceFrames,
      bright: ranked("brightness", 0.3),
      soft: ranked("rms", 0.4, false),
      transient: ranked("transient", 0.25)
    };
  }

  makeGranular() {
    this.ensureGrainBuffer();
    this.grainInput = this.context.createGain();
    this.grainFilter = this.context.createBiquadFilter();
    this.grainNodes = [this.grainInput, this.grainFilter];

    if (this.mode === "grain-impact") {
      const distortion = this.context.createWaveShaper();
      distortion.curve = Float32Array.from({ length: 256 }, (_, index) => Math.tanh((index / 127.5 - 1) * 2.4));
      distortion.oversample = "2x";
      this.grainFilter.type = "highpass";
      this.grainFilter.frequency.value = 110;
      this.grainInput.connect(this.grainFilter).connect(distortion).connect(this.modeBus);
      this.grainNodes.push(distortion);
      return;
    }

    if (this.mode === "grain-clouds") {
      if (!this.cloudImpulse) {
        const length = Math.floor(this.context.sampleRate * 2.8);
        this.cloudImpulse = this.context.createBuffer(2, length, this.context.sampleRate);
        for (let channel = 0; channel < 2; channel += 1) {
          const data = this.cloudImpulse.getChannelData(channel);
          for (let index = 0; index < length; index += 1) {
            data[index] = (Math.random() * 2 - 1) * (1 - index / length) ** 2.8;
          }
        }
      }
      const dry = this.context.createGain();
      const wet = this.context.createGain();
      const reverb = this.context.createConvolver();
      dry.gain.value = 0.52;
      wet.gain.value = 0.62;
      reverb.buffer = this.cloudImpulse;
      this.grainFilter.type = "lowpass";
      this.grainFilter.frequency.value = 1700;
      this.grainFilter.Q.value = 0.45;
      this.grainInput.connect(this.grainFilter);
      this.grainFilter.connect(dry).connect(this.modeBus);
      this.grainFilter.connect(reverb).connect(wet).connect(this.modeBus);
      this.grainNodes.push(dry, wet, reverb);
      return;
    }

    const delay = this.context.createDelay(0.5);
    const feedback = this.context.createGain();
    const echo = this.context.createGain();
    delay.delayTime.value = 0.13;
    feedback.gain.value = 0.24;
    echo.gain.value = 0.28;
    this.grainFilter.type = "lowpass";
    this.grainFilter.frequency.value = 5600;
    this.grainFilter.Q.value = 0.55;
    this.grainInput.connect(this.grainFilter).connect(this.modeBus);
    this.grainFilter.connect(delay).connect(feedback).connect(delay);
    delay.connect(echo).connect(this.modeBus);
    this.grainNodes.push(delay, feedback, echo);
  }

  grainDescriptor(kind, seed) {
    const pool = this.grainAnalysis[kind] || this.grainAnalysis.all;
    return pool[Math.floor(Math.abs(seed * 9973)) % pool.length];
  }

  grainRate(y, speed) {
    const rates = [1, 2, 4];
    const heightBand = Math.floor((1 - clamp(y)) * 2);
    const speedBand = speed > 2.4 ? 1 : speed < 0.8 ? -1 : 0;
    return rates[clamp(heightBand + speedBand, 0, rates.length - 1)];
  }

  playGrain(descriptor, {
    when, duration, rate, gain, pan, brightness,
    shape = "cloud", filterType = "lowpass", resonance = 0.7
  }) {
    if (!descriptor || this.activeGrains >= 40) return;
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const envelope = this.context.createGain();
    const panner = this.context.createStereoPanner();
    const generation = this.grainGeneration;
    const offset = Math.min(descriptor.offset, Math.max(0, this.grainBuffer.duration - duration * rate - 0.01));
    source.buffer = this.grainBuffer;
    source.playbackRate.value = rate;
    filter.type = filterType;
    filter.frequency.value = filterType === "bandpass"
      ? 280 + clamp(brightness) * 5200
      : 700 + clamp(brightness) * 7200;
    filter.Q.value = resonance + descriptor.noisiness * 1.5;
    envelope.gain.setValueAtTime(0.0001, when);
    if (shape === "impact") {
      envelope.gain.exponentialRampToValueAtTime(gain, when + Math.min(0.006, duration * 0.08));
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    } else if (shape === "gate") {
      envelope.gain.linearRampToValueAtTime(gain, when + duration * 0.08);
      envelope.gain.setValueAtTime(gain * 0.88, when + duration * 0.72);
      envelope.gain.linearRampToValueAtTime(0.0001, when + duration);
    } else {
      envelope.gain.linearRampToValueAtTime(gain, when + duration * 0.44);
      envelope.gain.linearRampToValueAtTime(0.0001, when + duration);
    }
    panner.pan.value = clamp(pan, -1, 1);
    source.connect(filter).connect(envelope).connect(panner).connect(this.grainInput);
    source.start(when, offset);
    source.stop(when + duration + 0.01);
    this.activeGrains += 1;
    source.onended = () => {
      if (generation === this.grainGeneration) this.activeGrains = Math.max(0, this.activeGrains - 1);
      source.disconnect();
      filter.disconnect();
      envelope.disconnect();
      panner.disconnect();
    };
  }

  updateGrainImpacts(world, captures, now) {
    if (!captures.length || now < this.nextGrainAt) return;
    const activity = clamp(captures.length / 10 * 0.7 + this.captureLevel * 0.3);
    const limit = Math.min(1 + Math.floor(activity * 3), captures.length);
    for (let index = 0; index < limit; index += 1) {
      const event = captures[captures.length - 1 - index];
      const ball = world.balls[event.owner];
      const speed = Math.hypot(ball.vx, ball.vy) / (world.settings.brick * 20.375);
      const rate = this.grainRate(event.y, speed);
      const descriptor = this.grainDescriptor("transient", this.grainSequence++ + event.owner);
      this.playGrain(descriptor, {
        when: now + index * 0.026,
        duration: 0.025 + descriptor.transient * 0.04 + activity * 0.018,
        rate,
        gain: 0.22 + descriptor.rms * 0.14 + activity * 0.12,
        pan: event.x * 1.8 - 0.9,
        brightness: 0.25 + descriptor.brightness * 0.75,
        shape: "impact",
        filterType: "bandpass",
        resonance: 2.2 + event.owner % 4
      });
      const snap = this.grainDescriptor("bright", this.grainSequence++ + event.owner * 3);
      this.playGrain(snap, {
        when: now + 0.014 + index * 0.026,
        duration: 0.018 + snap.noisiness * 0.025,
        rate: Math.min(4, rate * 2),
        gain: 0.09 + snap.brightness * 0.07 + activity * 0.055,
        pan: event.x * 1.9 - 0.95,
        brightness: 0.72 + snap.brightness * 0.28,
        shape: "impact",
        filterType: "bandpass",
        resonance: 4.5
      });
      if (activity > 0.45) {
        const thump = this.grainDescriptor("all", this.grainSequence++ + event.owner * 11);
        this.playGrain(thump, {
          when: now + index * 0.026,
          duration: 0.055 + activity * 0.05,
          rate: 0.5,
          gain: 0.08 + activity * 0.12,
          pan: event.x * 1.4 - 0.7,
          brightness: 0.08,
          shape: "impact",
          filterType: "lowpass"
        });
      }
    }
    smooth(this.grainFilter.frequency, 70 + activity * 520, 0.06);
    this.nextGrainAt = now + 0.075 - activity * 0.052;
  }

  updateGrainClouds(world, captures, now) {
    if (now < this.nextGrainAt) return;
    const activity = clamp(captures.length / 10 * 0.65 + this.captureLevel * 0.35);
    const total = world.cells.length;
    let cursor = (this.grainSequence * 0.61803398875 % 1) * total;
    let owner = 0;
    for (; owner < this.metrics.counts.length - 1; owner += 1) {
      cursor -= this.metrics.counts[owner];
      if (cursor < 0) break;
    }
    const share = this.metrics.counts[owner] / total;
    const ball = world.balls[owner];
    const speed = Math.hypot(ball.vx, ball.vy) / (world.settings.brick * 20.375);
    const descriptor = this.grainDescriptor(this.grainSequence % 5 ? "soft" : "all", this.grainSequence++ + owner);
    let rate = ball.y / world.height > 0.66 ? 0.25 : ball.y / world.height > 0.33 ? 0.5 : 1;
    if (speed > 2.5) rate *= 2;
    const duration = 1.25 + share * 4.5 + descriptor.rms * 0.65 - activity * 0.5;
    const latestCapture = captures[captures.length - 1];
    const pan = latestCapture && activity > 0.35
      ? latestCapture.x * 1.9 - 0.95
      : ball.x / world.width * 1.8 - 0.9;
    this.playGrain(descriptor, {
      when: now,
      duration,
      rate,
      gain: 0.085 + share * 0.2 + activity * 0.045,
      pan,
      brightness: 0.06 + this.metrics.boundary * 0.28 + descriptor.brightness * 0.14 + activity * 0.48,
      shape: "cloud"
    });
    const partner = this.grainDescriptor("soft", this.grainSequence++ + owner * 7);
    this.playGrain(partner, {
      when: now + 0.08,
      duration: duration * 1.18,
      rate: Math.max(0.25, rate * 0.5),
      gain: 0.06 + share * 0.13 + activity * 0.035,
      pan: -pan * 0.72,
      brightness: 0.1 + this.metrics.boundary * 0.22 + activity * 0.42,
      shape: "cloud"
    });
    if (activity > 0.5) {
      const flare = this.grainDescriptor("bright", this.grainSequence++ + owner * 13);
      this.playGrain(flare, {
        when: now + 0.04,
        duration: 0.5 + (1 - activity) * 0.7,
        rate: activity > 0.78 ? 2 : 1,
        gain: 0.055 + activity * 0.08,
        pan: -pan,
        brightness: 0.7 + activity * 0.3,
        shape: "cloud"
      });
    }
    smooth(this.grainFilter.frequency, 520 + this.metrics.boundary * 1800 + activity * 3900, 0.22);
    this.nextGrainAt = now + Math.max(0.075, 0.39 - this.metrics.boundary * 0.1 - activity * 0.25);
  }

  updateGrainScrubber(world, captures, now) {
    if (now < this.nextGrainAt) return;
    const activity = clamp(captures.length / 8 * 0.7 + this.captureLevel * 0.3);
    const counts = this.metrics.counts;
    let owner = 0;
    for (let index = 1; index < counts.length; index += 1) {
      if (counts[index] > counts[owner]) owner = index;
    }
    const share = counts[owner] / world.cells.length;
    const latestCapture = captures[captures.length - 1];
    const target = latestCapture
      ? (latestCapture.owner / counts.length * 0.5 + latestCapture.x * 0.35 + latestCapture.y * 0.15) % 1
      : (owner / counts.length * 0.72 + share * 0.2 + this.metrics.boundary * 0.08) % 1;
    const distance = (target - this.scrubPosition + 1.5) % 1 - 0.5;
    const rate = activity > 0.72 ? 2 : activity < 0.12 ? 0.5 : 1;
    const duration = 0.5 - activity * 0.37;
    const interval = Math.max(0.045, 0.3 - activity * 0.245);
    const advance = interval * rate / this.grainBuffer.duration * (0.88 + activity * 0.5);
    const steering = clamp(distance, -advance * 0.35, advance * (1.2 + activity * 2.8));
    this.scrubPosition = (this.scrubPosition + advance + steering + 1) % 1;
    const timeline = this.grainAnalysis.timeline;
    const analyzed = timeline[Math.min(timeline.length - 1, Math.floor(this.scrubPosition * timeline.length))];
    const descriptor = { ...analyzed, offset: this.scrubPosition * this.grainBuffer.duration };
    const ball = world.balls[owner];
    const pan = latestCapture
      ? latestCapture.x * 1.8 - 0.9
      : ball.x / world.width * 1.4 - 0.7;
    this.playGrain(descriptor, {
      when: now,
      duration: duration + this.metrics.boundary * 0.08,
      rate,
      gain: 0.2 + share * 0.13 + activity * 0.08,
      pan: this.grainSequence % 2 ? pan : -pan,
      brightness: 0.28 + this.metrics.boundary * 0.28 + activity * 0.44,
      shape: "gate"
    });
    smooth(this.grainFilter.frequency, 1700 + this.metrics.boundary * 2400 + activity * 3900, 0.07);
    this.grainSequence += 1;
    this.nextGrainAt = now + interval;
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
