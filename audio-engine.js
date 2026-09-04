export class TerritoryAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.output = null;
    this.renderer = null;
    this.paused = false;
  }

  get supported() {
    return Boolean(window.AudioContext || window.webkitAudioContext);
  }

  async connect(renderer, world) {
    this.stop();
    if (!renderer) return;

    this.ensureContext();
    await this.context.resume();
    this.output = this.context.createGain();
    this.output.connect(this.master);
    this.renderer = renderer;
    this.renderer.start?.({ context: this.context, output: this.output, world });
    this.setOutput(this.paused ? 0 : 1);
  }

  setPaused(paused) {
    this.paused = paused;
    if (this.context) this.setOutput(paused || !this.renderer ? 0 : 1);
  }

  reset(world) {
    this.renderer?.reset?.({ context: this.context, output: this.output, world });
  }

  update(world, captures) {
    if (!this.context || !this.renderer || this.paused) return;
    this.renderer.update?.({ context: this.context, output: this.output, world, captures });
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
    this.renderer?.stop?.();
    this.output?.disconnect();
    this.output = null;
    this.renderer = null;
    if (this.context) this.setOutput(0);
  }
}
