class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.buffer = new Int16Array(192000);
    this.position = 0;
    this.hot = 0;
    this.quiet = 0;
    this.total = 0;
    this.count = 0;
    this.phase = 0;
    this.speaking = false;
    this.floor = 0.005;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    let energy = 0;
    for (const sample of channel) energy += sample * sample;
    const volume = Math.sqrt(energy / channel.length);
    const loud = volume > Math.max(0.014, this.floor * 3.2);
    if (!loud && !this.speaking) this.floor = 0.995 * this.floor + 0.005 * volume;
    this.hot = loud ? this.hot + channel.length : 0;
    this.quiet = loud ? 0 : this.quiet + channel.length;
    if (!this.speaking && this.hot >= sampleRate * 0.045) {
      this.speaking = true;
      this.port.postMessage({ type: 'onset' });
    }
    for (const sample of channel) {
      this.total += sample;
      this.count++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.buffer[this.position++] = Math.max(-1, Math.min(1, this.total / this.count)) * 32767;
      this.total = 0;
      this.count = 0;
      if (this.position === this.buffer.length) break;
    }
    if (!this.speaking && this.position > 3200) {
      this.buffer.copyWithin(0, this.position - 2400, this.position);
      this.position = 2400;
    }
    if (this.speaking && (this.quiet >= sampleRate * 0.36 || this.position === this.buffer.length)) {
      const samples = this.buffer.slice(0, this.position);
      this.port.postMessage({ type: 'utterance', samples, endedAt: currentTime - this.quiet / sampleRate }, [samples.buffer]);
      this.reset();
    }
    return true;
  }
}
registerProcessor('lcp-voice-capture', VoiceCapture);
