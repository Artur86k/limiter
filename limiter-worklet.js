// AudioWorkletProcessor — sample-accurate lookahead limiter
// Runs on the audio thread: ring buffer delay, envelope follower, gain reduction, metering.

class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    // Parameters
    this.saturationLevel = -6;
    this.kneeWidth = 0;
    this.outputGain = 6;
    this.lookaheadMs = 0.5;
    this.minRecovery = 20;

    // Ring buffer for lookahead delay (max 20ms at 48kHz = 960 samples)
    this.maxDelaySamples = Math.ceil(sampleRate * 0.020);
    this.ringL = new Float32Array(this.maxDelaySamples);
    this.ringR = new Float32Array(this.maxDelaySamples);
    this.writeIndex = 0;

    // Envelope state
    this.envelope = 0;
    this.holdTimer = 0;       // in samples
    this.peakRate = 0;

    // Spectral data from main thread (updated via MessagePort)
    this.centroid = 0;
    this.lowEnergy = 0;
    this.rms = 0;

    // Metering: peaks per reporting interval
    this.inPeakL = 0;
    this.inPeakR = 0;
    this.outPeakL = 0;
    this.outPeakR = 0;
    this.meterBlockCount = 0;

    this.alive = true;

    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'params') {
        if (msg.saturationLevel !== undefined) this.saturationLevel = msg.saturationLevel;
        if (msg.kneeWidth !== undefined) this.kneeWidth = msg.kneeWidth;
        if (msg.outputGain !== undefined) this.outputGain = msg.outputGain;
        if (msg.lookaheadMs !== undefined) this.lookaheadMs = msg.lookaheadMs;
        if (msg.minRecovery !== undefined) this.minRecovery = msg.minRecovery;
      } else if (msg.type === 'spectral') {
        this.centroid = msg.centroid;
        this.lowEnergy = msg.lowEnergy;
        this.rms = msg.rms;
      } else if (msg.type === 'destroy') {
        this.alive = false;
      }
    };
  }

  process(inputs, outputs) {
    if (!this.alive) return false;

    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    const blockSize = inL.length; // 128

    const delaySamples = Math.min(
      Math.max(Math.round(this.lookaheadMs * 0.001 * sampleRate), 0),
      this.maxDelaySamples - 1
    );

    const satLin = Math.pow(10, this.saturationLevel / 20);
    const outGainLin = Math.pow(10, this.outputGain / 20);
    const sat = this.saturationLevel;
    const knee = this.kneeWidth;

    // Decay coefficient — computed from adaptive recovery
    const freqFactor = Math.max(0.2, 1 - (this.centroid / 10000));
    const energyFactor = 1 + (this.lowEnergy * this.rms * 5);
    let recoveryMs = this.minRecovery * energyFactor * freqFactor;
    recoveryMs = Math.min(Math.max(recoveryMs, this.minRecovery), this.minRecovery * 5);
    const releaseSec = recoveryMs / 1000;
    const decay = Math.exp(-1 / (releaseSec * sampleRate));

    // Per-channel input peak tracking for metering
    let blockInPeakL = 0, blockInPeakR = 0;
    let blockOutPeakL = 0, blockOutPeakR = 0;

    for (let i = 0; i < blockSize; i++) {
      const sL = inL[i];
      const sR = inR[i];

      // Track input peaks
      const absL = Math.abs(sL);
      const absR = Math.abs(sR);
      if (absL > blockInPeakL) blockInPeakL = absL;
      if (absR > blockInPeakR) blockInPeakR = absR;

      const peak = Math.max(absL, absR);

      // --- Envelope follower ---
      const peakHit = (peak >= this.envelope * 0.9) ? 1 : 0;
      this.peakRate = this.peakRate * 0.9995 + peakHit * 0.0005;

      if (peak > this.envelope) {
        // Instant attack
        this.envelope = peak;
        // Adaptive hold
        const densityFactor = 1 + this.peakRate * 4;
        const lowFreqFactor = 1 + this.lowEnergy * 3;
        const highFreqFactor = Math.max(0.3, 1 - this.centroid / 8000);
        const holdMs = 5 * densityFactor * lowFreqFactor * highFreqFactor;
        const minHoldMs = Math.max(holdMs, this.lookaheadMs);
        this.holdTimer = Math.min(Math.max(minHoldMs, 5), 200) * 0.001 * sampleRate;
      } else if (this.holdTimer > 0) {
        this.holdTimer--;
      } else {
        this.envelope = this.envelope * decay + peak * (1 - decay);
      }

      // --- Gain reduction ---
      const envelopeDb = 20 * Math.log10(Math.max(this.envelope, 0.00001));
      let gainReductionDb = 0;

      if (knee <= 0 || envelopeDb < sat - knee / 2) {
        if (envelopeDb > sat) {
          gainReductionDb = sat - envelopeDb;
        }
      } else if (envelopeDb > sat + knee / 2) {
        gainReductionDb = sat - envelopeDb;
      } else {
        const x = envelopeDb - (sat - knee / 2);
        gainReductionDb = -(x * x) / (2 * knee);
      }

      const gain = Math.pow(10, gainReductionDb / 20) * outGainLin;

      // --- Ring buffer: write current, read delayed ---
      this.ringL[this.writeIndex] = sL;
      this.ringR[this.writeIndex] = sR;

      let readIndex = this.writeIndex - delaySamples;
      if (readIndex < 0) readIndex += this.maxDelaySamples;

      const delayedL = this.ringL[readIndex];
      const delayedR = this.ringR[readIndex];

      this.writeIndex = (this.writeIndex + 1) % this.maxDelaySamples;

      // --- Apply gain to delayed signal ---
      outL[i] = delayedL * gain;
      outR[i] = delayedR * gain;

      // Track output peaks
      const outAbsL = Math.abs(outL[i]);
      const outAbsR = Math.abs(outR[i]);
      if (outAbsL > blockOutPeakL) blockOutPeakL = outAbsL;
      if (outAbsR > blockOutPeakR) blockOutPeakR = outAbsR;
    }

    // Update metering peaks (keep max across blocks)
    if (blockInPeakL > this.inPeakL) this.inPeakL = blockInPeakL;
    if (blockInPeakR > this.inPeakR) this.inPeakR = blockInPeakR;
    if (blockOutPeakL > this.outPeakL) this.outPeakL = blockOutPeakL;
    if (blockOutPeakR > this.outPeakR) this.outPeakR = blockOutPeakR;

    // Post metering data every ~6 blocks (~16ms at 48kHz)
    this.meterBlockCount++;
    if (this.meterBlockCount >= 6) {
      const toDb = (v) => {
        const db = 20 * Math.log10(Math.max(v, 0.00001));
        return isFinite(db) ? db : -100;
      };
      this.port.postMessage({
        type: 'levels',
        inL: toDb(this.inPeakL),
        inR: toDb(this.inPeakR),
        outL: toDb(this.outPeakL),
        outR: toDb(this.outPeakR)
      });
      this.inPeakL = 0;
      this.inPeakR = 0;
      this.outPeakL = 0;
      this.outPeakR = 0;
      this.meterBlockCount = 0;
    }

    return true;
  }
}

registerProcessor('limiter-processor', LimiterProcessor);
