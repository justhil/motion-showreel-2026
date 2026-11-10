// Procedural Deep-Space Telemetry & Harmonic Soundscape (WebAudio API)
export function createSpaceAudioEngine() {
  let ctx = null;
  let masterGain = null;
  let subOsc = null;
  let padOsc1 = null;
  let padOsc2 = null;
  let padOsc3 = null;
  let padFilter = null;
  let noiseNode = null;
  let noiseFilter = null;
  let noiseGain = null;
  let pingTimer = 0;
  let enabled = false;

  function init() {
    if (ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    ctx = new AudioCtx();

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.0;
    masterGain.connect(ctx.destination);

    // Warm analog-style low-pass filter for harmonic pad
    padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 340;
    padFilter.Q.value = 1.2;

    const padGain = ctx.createGain();
    padGain.gain.value = 0.16;
    padFilter.connect(padGain);
    padGain.connect(masterGain);

    // Root sub-bass + fifth + ninth oscillators
    subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.value = 55.0; // A1
    const subGain = ctx.createGain();
    subGain.gain.value = 0.24;
    subOsc.connect(subGain);
    subGain.connect(masterGain);

    padOsc1 = ctx.createOscillator();
    padOsc1.type = 'sawtooth';
    padOsc1.frequency.value = 110.0;
    padOsc1.detune.value = -5;
    padOsc1.connect(padFilter);

    padOsc2 = ctx.createOscillator();
    padOsc2.type = 'triangle';
    padOsc2.frequency.value = 164.81; // E3
    padOsc2.detune.value = 6;
    padOsc2.connect(padFilter);

    padOsc3 = ctx.createOscillator();
    padOsc3.type = 'sine';
    padOsc3.frequency.value = 246.94; // B3
    padOsc3.connect(padFilter);

    // Filtered pink/white noise for subtle orbital thrust / solar wind / Earth flyby Doppler whoosh
    const bufSize = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < bufSize; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.997 * b0 + w * 0.029;
      b1 = 0.985 * b1 + w * 0.032;
      b2 = 0.950 * b2 + w * 0.048;
      data[i] = (b0 + b1 + b2) * 0.35;
    }
    noiseNode = ctx.createBufferSource();
    noiseNode.buffer = buf;
    noiseNode.loop = true;

    noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 280;
    noiseFilter.Q.value = 1.6;

    noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.03;

    noiseNode.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(masterGain);

    subOsc.start();
    padOsc1.start();
    padOsc2.start();
    padOsc3.start();
    noiseNode.start();
  }

  function triggerPing(freq, dur = 0.22, vol = 0.035) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  function setEnabled(flag) {
    if (flag) {
      init();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    }
    enabled = Boolean(flag && ctx);
    if (ctx && masterGain) {
      masterGain.gain.setTargetAtTime(enabled ? 0.55 : 0.0, ctx.currentTime, 0.18);
    }
    return enabled;
  }

  function update(frameState, dt, isPlaying) {
    if (!ctx || !enabled) return;
    const now = ctx.currentTime;
    const t = frameState.t;
    const speed = frameState.camera.speedUnitsPerSec;

    // Harmonic progression across the 5 stops:
    // Stop 1 (2026): D2 (73.42 Hz) nocturnal tension
    // Stop 2 (2032): G2 (98.00 Hz) architectural grandeur
    // Stop 3 (2040): E2 (82.41 Hz) crystalline lunar suspension
    // Stop 4 (2048): C2 (65.41 Hz) vast Martian canyon expanse
    // Stop 5 (2056): A2 -> D3 radiant solar cathedral chord!
    let root = 73.42;
    let third = 220.0;
    let cutoff = 320;
    if (t < 11.2) {
      root = 73.42; third = 220.0; cutoff = 310;
    } else if (t < 23.5) {
      root = 65.41; third = 196.0; cutoff = 480;
    } else if (t < 37.2) {
      root = 55.00; third = 246.94; cutoff = 290;
    } else if (t < 51.4) {
      root = 61.74; third = 185.0; cutoff = 430;
    } else {
      root = 73.42; third = 293.66; cutoff = 780;
    }

    subOsc.frequency.setTargetAtTime(root, now, 0.35);
    padOsc1.frequency.setTargetAtTime(root * 2.0, now, 0.35);
    padOsc2.frequency.setTargetAtTime(root * 3.0, now, 0.35);
    padOsc3.frequency.setTargetAtTime(third, now, 0.35);
    padFilter.frequency.setTargetAtTime(cutoff + Math.min(600, speed * 3.5), now, 0.15);

    // Doppler solar-wind / flyby rush scales smoothly with interplanetary velocity & Sun proximity
    const sunRush = t > 56.0 ? 0.085 : 0.0;
    const flybyBoost = frameState.isEarthReturnFlyby ? 0.11 : 0.0;
    const nGain = Math.min(0.16, 0.018 + speed * 0.00055 + sunRush + flybyBoost) * (isPlaying ? 1.0 : 0.35);
    noiseGain.gain.setTargetAtTime(nGain, now, 0.1);
    noiseFilter.frequency.setTargetAtTime(190 + Math.min(1100, speed * 6.0 + (t > 56 ? 320 : 0)), now, 0.1);

    // Subtle optical telemetry micro-ping in 2026 LEO & stop transitions
    if (isPlaying) {
      pingTimer += dt;
      const interval = t < 10.5 ? 0.42 : 1.35;
      if (pingTimer >= interval) {
        pingTimer = 0;
        const freqs = [880, 1174.66, 1318.5, 1760];
        const f = freqs[Math.floor((t * 7.3) % freqs.length)];
        triggerPing(f, t < 10.5 ? 0.14 : 0.28, t < 10.5 ? 0.022 : 0.014);
      }
    }
  }

  return {
    setEnabled,
    isEnabled: () => enabled,
    update,
  };
}
