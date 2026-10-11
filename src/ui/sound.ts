/** Tiny WebAudio synth for tactile feedback. No audio files. */
export class Sound {
  enabled = true;
  private ctx: AudioContext | null = null;
  private last = 0;
  private static NOTES = [523.25, 587.33, 659.25, 783.99, 880, 1046.5, 1174.66];

  unlock() {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, glideTo?: number, delay = 0) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(this.ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private throttle(ms = 45) {
    const now = performance.now();
    if (now - this.last < ms) return false;
    this.last = now;
    return true;
  }

  place(seed: number) {
    if (!this.throttle()) return;
    const n = Sound.NOTES[Math.abs(seed) % Sound.NOTES.length];
    this.tone(n, 0.12, 'triangle', 0.07);
    this.tone(n * 2, 0.06, 'sine', 0.02);
  }
  prop() {
    if (this.throttle(60)) this.tone(880, 0.14, 'sine', 0.06, 1320);
  }
  erase() {
    if (this.throttle()) this.tone(300, 0.12, 'sine', 0.07, 120);
  }
  raise() {
    if (this.throttle()) this.tone(330, 0.1, 'square', 0.025, 660);
  }
  lower() {
    if (this.throttle()) this.tone(520, 0.1, 'square', 0.025, 260);
  }
  whoosh(up: boolean) {
    this.tone(up ? 200 : 600, 0.28, 'sine', 0.06, up ? 600 : 180);
  }
  chime() {
    [0, 2, 4, 6].forEach((k, i) => this.tone(Sound.NOTES[k], 0.3, 'triangle', 0.05, undefined, i * 0.07));
  }
  click() {
    this.tone(1200, 0.04, 'sine', 0.03);
  }
}
