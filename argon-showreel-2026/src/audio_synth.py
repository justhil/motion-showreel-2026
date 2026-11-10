import json
import math
import wave
import numpy as np

SR = 48000
DUR = 15.0
N = int(SR * DUR)
BPM = 128.0
BEAT = 60.0 / BPM  # 0.46875s

rng = np.random.default_rng(20260417)

L = np.zeros(N, dtype=np.float64)
R = np.zeros(N, dtype=np.float64)
# Separate stems so we can extract accurate per-frame telemetry!
stem_low = np.zeros(N, dtype=np.float64)
stem_mid = np.zeros(N, dtype=np.float64)
stem_high = np.zeros(N, dtype=np.float64)

def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69.0) / 12.0))

def mix_stereo(buf_l, buf_r, sig, start_t, pan=0.0, stem=None):
    idx = int(round(start_t * SR))
    if idx >= N or len(sig) == 0:
        return
    if idx < 0:
        sig = sig[-idx:]
        idx = 0
    end = min(N, idx + len(sig))
    seg = sig[:end - idx]
    # Constant-power pan (-1..+1)
    angle = (np.clip(pan, -1.0, 1.0) + 1.0) * (math.pi / 4.0)
    gl = math.cos(angle)
    gr = math.sin(angle)
    buf_l[idx:end] += seg * gl
    buf_r[idx:end] += seg * gr
    if stem is not None:
        stem[idx:end] += np.abs(seg)

def add_kick(beat_pos, gain=0.82):
    t0 = beat_pos * BEAT
    dur = 0.34
    t = np.arange(int(dur * SR)) / SR
    # Exponential pitch envelope: 158Hz -> 43.65Hz (F1)
    f_inst = 43.65 + 115.0 * np.exp(-t * 36.0)
    phase = 2.0 * math.pi * np.cumsum(f_inst) / SR
    body = np.sin(phase) * np.exp(-t * 9.5)
    # Punchy transient click
    click = np.sin(2.0 * math.pi * 1950.0 * t * np.exp(-t * 90.0)) * np.exp(-t * 110.0) * 0.32
    sig = np.tanh((body + click) * 1.75) * gain
    # Tiny 2ms attack ramp to prevent DC pop
    ramp = min(96, len(sig))
    sig[:ramp] *= np.linspace(0.0, 1.0, ramp)
    mix_stereo(L, R, sig, t0, pan=0.0, stem=stem_low)

def add_rim_snare(beat_pos, gain=0.42, snappy=False, pan=0.04):
    t0 = beat_pos * BEAT
    dur = 0.22 if snappy else 0.13
    t = np.arange(int(dur * SR)) / SR
    # Woody/metallic rim modes
    modes = (
        0.55 * np.sin(2 * math.pi * 342.0 * t) * np.exp(-t * 42.0) +
        0.35 * np.sin(2 * math.pi * 688.0 * t) * np.exp(-t * 58.0) +
        0.22 * np.sin(2 * math.pi * 1420.0 * t) * np.exp(-t * 85.0)
    )
    noise = rng.standard_normal(len(t))
    # Simple 1-pole highpass via diff
    hp_noise = np.diff(noise, prepend=0.0) * 0.65
    env_n = np.exp(-t * (22.0 if snappy else 48.0))
    sig = np.tanh((modes + hp_noise * env_n * (0.75 if snappy else 0.35)) * 1.4) * gain
    mix_stereo(L, R, sig, t0, pan=pan, stem=stem_high)

def add_hat(beat_pos, gain=0.14, open_hat=False, pan=-0.18):
    t0 = beat_pos * BEAT
    dur = 0.24 if open_hat else 0.055
    t = np.arange(int(dur * SR)) / SR
    n = rng.standard_normal(len(t))
    # Double diff for crisp >6kHz shimmer
    hp = np.diff(np.diff(n, prepend=0.0), prepend=0.0) * 0.35
    metal = (
        np.sin(2 * math.pi * 4180 * t + 1.5 * np.sin(2 * math.pi * 5910 * t)) * 0.25
    )
    env = np.exp(-t * (12.0 if open_hat else 68.0))
    sig = (hp + metal) * env * gain
    mix_stereo(L, R, sig, t0, pan=pan, stem=stem_high)

def add_detent_click(time_s, freq=3400.0, gain=0.22, pan=0.0):
    dur = 0.018
    t = np.arange(int(dur * SR)) / SR
    sig = (
        0.7 * np.sin(2 * math.pi * freq * t) +
        0.3 * np.sin(2 * math.pi * (freq * 1.87) * t)
    ) * np.exp(-t * 260.0) * gain
    mix_stereo(L, R, sig, time_s, pan=pan, stem=stem_high)

def add_fm_chord(beat_start, beat_dur, midi_notes, gain=0.20, brightness=1.2):
    t0 = beat_start * BEAT
    dur = beat_dur * BEAT + 0.35
    n_samp = int(dur * SR)
    t = np.arange(n_samp) / SR
    # Smooth attack and musical release
    att = np.minimum(1.0, t / 0.025)
    rel_start = beat_dur * BEAT
    rel = np.where(t < rel_start, 1.0, np.exp(-(t - rel_start) * 5.5))
    env = att * rel

    chord_l = np.zeros(n_samp, dtype=np.float64)
    chord_r = np.zeros(n_samp, dtype=np.float64)
    for i, m in enumerate(midi_notes):
        f = midi_to_hz(m)
        # Slight stereo detune for lush Rhodes/Prophet width
        mod_env = brightness * np.exp(-t * 3.2) + 0.18
        mod = np.sin(2 * math.pi * (f * 2.0) * t) * mod_env
        v_l = np.sin(2 * math.pi * (f * 0.9985) * t + mod)
        v_r = np.sin(2 * math.pi * (f * 1.0015) * t + mod * 0.92)
        note_pan = -0.35 + 0.7 * (i / max(1, len(midi_notes) - 1))
        w_l = 0.5 * (1.0 - note_pan)
        w_r = 0.5 * (1.0 + note_pan)
        scale = 0.85 if i > 0 else 1.15
        chord_l += (v_l * 0.7 + v_r * 0.3) * w_l * scale
        chord_r += (v_r * 0.7 + v_l * 0.3) * w_r * scale

    norm = max(1.0, len(midi_notes) * 0.55)
    sig_l = np.tanh(chord_l / norm * 1.15) * env * gain
    sig_r = np.tanh(chord_r / norm * 1.15) * env * gain

    idx = int(round(t0 * SR))
    end = min(N, idx + n_samp)
    if end > idx:
        L[idx:end] += sig_l[:end - idx]
        R[idx:end] += sig_r[:end - idx]
        stem_mid[idx:end] += 0.5 * (np.abs(sig_l[:end - idx]) + np.abs(sig_r[:end - idx]))

def add_bass_note(beat_start, beat_dur, midi_note, gain=0.40):
    t0 = beat_start * BEAT
    dur = beat_dur * BEAT
    t = np.arange(int(dur * SR)) / SR
    f = midi_to_hz(midi_note)
    att = np.minimum(1.0, t / 0.008)
    rel = np.minimum(1.0, np.maximum(0.0, (dur - t) / 0.03))
    # Warm sub + filtered 2nd & 3rd harmonic pluck
    h_env = np.exp(-t * 6.5)
    sig = (
        0.78 * np.sin(2 * math.pi * f * t) +
        0.28 * np.sin(2 * math.pi * 2 * f * t) * h_env +
        0.12 * np.sin(2 * math.pi * 3 * f * t) * (h_env ** 2)
    ) * att * rel
    sig = np.tanh(sig * 1.4) * gain
    mix_stereo(L, R, sig, t0, pan=0.0, stem=stem_low)

def add_pluck(beat_pos, midi_note, gain=0.22, pan=0.0, decay=9.0):
    t0 = beat_pos * BEAT
    dur = 0.42
    t = np.arange(int(dur * SR)) / SR
    f = midi_to_hz(midi_note)
    att = np.minimum(1.0, t / 0.004)
    mod = np.sin(2 * math.pi * (f * 3.0) * t) * (1.8 * np.exp(-t * 24.0))
    sig = (
        0.75 * np.sin(2 * math.pi * f * t + mod) +
        0.25 * np.sin(2 * math.pi * (f * 2.0) * t) * np.exp(-t * 16.0)
    ) * att * np.exp(-t * decay) * gain
    mix_stereo(L, R, sig, t0, pan=pan, stem=stem_mid)

def add_whoosh(beat_target, sweep_beats=0.75, gain=0.26, direction=1):
    t_end = beat_target * BEAT
    dur = sweep_beats * BEAT + 0.08
    t0 = t_end - sweep_beats * BEAT
    n_samp = int(dur * SR)
    t = np.arange(n_samp) / SR
    peak_t = sweep_beats * BEAT
    # Asymmetric envelope peaking right at the cut!
    env = np.where(
        t <= peak_t,
        (t / max(1e-4, peak_t)) ** 2.6,
        np.exp(-(t - peak_t) * 28.0)
    )
    noise = rng.standard_normal(n_samp)
    # Time-varying resonant swept carrier + filtered noise
    f_sweep = 180.0 * (14.0 ** np.minimum(1.0, t / max(1e-4, peak_t)))
    phase = 2 * math.pi * np.cumsum(f_sweep) / SR
    tonal = np.sin(phase) * 0.35
    # Moving average -> bandpass feel
    bp = np.diff(noise, prepend=0.0) * 0.45
    sig = (bp + tonal) * env * gain
    idx = max(0, int(round(t0 * SR)))
    end = min(N, idx + n_samp)
    seg_len = end - idx
    if seg_len > 0:
        pan_curve = direction * np.linspace(-0.75, 0.75, seg_len)
        ang = (pan_curve + 1.0) * (math.pi / 4.0)
        L[idx:end] += sig[:seg_len] * np.cos(ang)
        R[idx:end] += sig[:seg_len] * np.sin(ang)
        stem_high[idx:end] += np.abs(sig[:seg_len]) * 0.7

# ==============================================================================
# SCORE CHOREOGRAPHY (32 Beats = 15.000s @ 128 BPM)
# ==============================================================================

# --- ACT 1: Kinetic Typography & Aperture Ignition (Beats 0..6) ---
add_detent_click(0.02, freq=2800, gain=0.26, pan=0.0)
# Beat 0.5: Horizontal Aperture Slice!
add_whoosh(0.5, sweep_beats=0.45, gain=0.22, direction=1)
add_kick(0.5, gain=0.78)
add_fm_chord(0.5, 3.5, [48, 55, 64, 71, 74, 79], gain=0.24, brightness=1.4)  # Cmaj9
add_bass_note(0.5, 2.5, 36, gain=0.38)  # C2

# Typography percussive accents on Beats 1.5, 2.0, 3.0, 4.0, 5.0
for b_hit, note, p in [(1.5, 76, -0.3), (2.0, 79, 0.3), (3.0, 83, -0.25), (4.0, 86, 0.25), (5.0, 84, 0.0)]:
    add_rim_snare(b_hit, gain=0.30, snappy=False, pan=p * 0.5)
    add_pluck(b_hit, note, gain=0.16, pan=p, decay=11.0)

add_kick(2.0, gain=0.68)
add_kick(3.5, gain=0.62)
add_kick(4.0, gain=0.76)
add_fm_chord(4.0, 2.0, [48, 55, 62, 69, 76], gain=0.22, brightness=1.6)  # C6/9
add_bass_note(4.0, 1.8, 40, gain=0.36)  # E2
add_whoosh(6.0, sweep_beats=0.85, gain=0.30, direction=-1)

# --- ACT 2: Bezier Rigging & Harmonic Physics (Beats 6..11) ---
add_fm_chord(6.0, 5.0, [45, 52, 60, 67, 71, 74], gain=0.22, brightness=1.25)  # Am11
add_bass_note(6.0, 2.25, 33, gain=0.42)  # A1
add_bass_note(8.5, 2.25, 36, gain=0.40)  # C2

for b in [6.0, 7.5, 8.5, 10.0]:
    add_kick(b, gain=0.80)
for b in [7.0, 9.0, 10.5]:
    add_rim_snare(b, gain=0.40, snappy=(b == 9.0))
for s16 in range(24, 44):  # 16th-note brushed shaker groove
    b = s16 * 0.25
    add_hat(b, gain=0.12 if s16 % 2 == 0 else 0.07, open_hat=(s16 % 8 == 6), pan=(-0.25 if s16 % 2 == 0 else 0.25))

# Curve mode switches on Beats 6.0, 7.5, 9.0
for idx_c, b_curve in enumerate([6.0, 7.5, 9.0]):
    add_detent_click(b_curve * BEAT, freq=3200 + idx_c * 600, gain=0.28, pan=-0.2 + 0.2 * idx_c)
    add_pluck(b_curve + 0.25, 69 + idx_c * 3, gain=0.20, pan=0.25)

add_whoosh(11.0, sweep_beats=0.8, gain=0.32, direction=1)

# --- ACT 3: 3D Isometric Spatial Mechanism (Beats 11..17) ---
# Luminous Fmaj7#11 -> G6 architectural lift
add_fm_chord(11.0, 3.0, [41, 48, 57, 64, 67, 71], gain=0.24, brightness=1.5)  # Fmaj9/#11
add_fm_chord(14.0, 3.0, [41, 52, 60, 67, 71, 76], gain=0.25, brightness=1.8)
add_bass_note(11.0, 2.75, 29, gain=0.44)  # F1 deep architectural sub!
add_bass_note(14.0, 2.75, 31, gain=0.42)  # G1

for b in [11.0, 12.0, 13.5, 14.0, 15.5, 16.0]:
    add_kick(b, gain=0.80)
for b in [12.0, 13.0, 15.0, 16.0]:
    add_rim_snare(b, gain=0.42, snappy=True)
for s16 in range(44, 68):
    add_hat(s16 * 0.25, gain=0.13 if s16 % 2 == 0 else 0.08, open_hat=(s16 % 8 == 7), pan=(0.3 if s16 % 2 == 0 else -0.3))

# Beat 14.0: 3D Axial Explosion crystalline arpeggio!
arp_3d = [72, 76, 79, 83, 86, 88, 91, 95]
for i, n_midi in enumerate(arp_3d):
    add_pluck(14.0 + i * 0.1875, n_midi, gain=0.19, pan=-0.55 + 1.1 * (i / 7.0), decay=8.5)
# Beat 16.0: Magnetic implosion lock!
add_detent_click(16.0 * BEAT, freq=2200, gain=0.34, pan=0.0)
add_detent_click(16.0 * BEAT + 0.035, freq=4400, gain=0.28, pan=0.0)
add_whoosh(17.0, sweep_beats=0.75, gain=0.30, direction=-1)

# --- ACT 4: Tactile Chronograph & Instrument UI (Beats 17..22) ---
add_fm_chord(17.0, 2.5, [50, 57, 60, 64, 69, 74], gain=0.21, brightness=1.3)  # Dm9
add_fm_chord(19.5, 2.5, [43, 53, 59, 64, 69, 74], gain=0.23, brightness=1.5)  # G13sus4
add_bass_note(17.0, 2.4, 38, gain=0.42)  # D2
add_bass_note(19.5, 2.4, 31, gain=0.44)  # G1

for b in [17.0, 18.0, 19.0, 19.5, 20.5, 21.5]:
    add_kick(b, gain=0.80)
for b in [18.0, 20.0, 21.0]:
    add_rim_snare(b, gain=0.44, snappy=True)

# Driving modular 16th-note stereo pluck + rotary encoder detent clicks!
arp_ui = [62, 65, 69, 72, 74, 72, 69, 65, 67, 71, 74, 76, 79, 76, 74, 71, 67, 71, 74, 81]
for idx_s, note in enumerate(arp_ui):
    b_pos = 17.0 + idx_s * 0.25
    add_pluck(b_pos, note, gain=0.17, pan=(-0.45 if idx_s % 2 == 0 else 0.45), decay=13.0)
    add_detent_click(b_pos * BEAT, freq=4600 if idx_s % 4 == 0 else 5800, gain=0.11, pan=(0.35 if idx_s % 2 == 0 else -0.35))

add_whoosh(22.0, sweep_beats=0.75, gain=0.34, direction=1)

# --- ACT 5: Rapid-Fire Generative Climax (Beats 22..27) ---
# Cut 5A (22.0), Cut 5B (23.5), Cut 5C (25.0 -> 26.85 micro-silence drop -> 27.0!)
add_fm_chord(22.0, 1.5, [40, 52, 59, 62, 67, 74], gain=0.25, brightness=1.7)  # Em7/9
add_fm_chord(23.5, 1.5, [41, 53, 60, 64, 69, 76], gain=0.26, brightness=1.9)  # Fmaj9
add_fm_chord(25.0, 1.8, [43, 55, 60, 65, 69, 74, 79], gain=0.28, brightness=2.2)  # G13sus4 climax!
add_bass_note(22.0, 1.4, 28, gain=0.45)  # E1
add_bass_note(23.5, 1.4, 29, gain=0.46)  # F1
add_bass_note(25.0, 1.8, 31, gain=0.48)  # G1

for b in [22.0, 22.75, 23.5, 24.25, 25.0, 25.5, 26.0, 26.5]:
    add_kick(b, gain=0.84)
for b in [22.5, 23.5, 24.5, 25.25, 25.75, 26.25, 26.5, 26.75]:
    add_rim_snare(b, gain=0.45, snappy=True)
for s16 in range(88, 107):
    add_hat(s16 * 0.25, gain=0.15, open_hat=(s16 in [93, 99]), pan=(-0.4 if s16 % 2 == 0 else 0.4))

# Rising 16th-note synth run from Beat 25.0 to 26.75
climb = [67, 71, 74, 76, 79, 81, 84, 86]
for i, n_m in enumerate(climb):
    add_pluck(25.0 + i * 0.21875, n_m, gain=0.22, pan=-0.5 + 1.0 * (i / 7.0), decay=10.0)

add_whoosh(23.5, sweep_beats=0.5, gain=0.28, direction=-1)
add_whoosh(25.0, sweep_beats=0.5, gain=0.30, direction=1)
add_whoosh(27.0, sweep_beats=1.2, gain=0.38, direction=-1)

# --- Dramatic 55ms pre-drop breath right before Beat 27.0! ---
gap_start = int((27.0 * BEAT - 0.055) * SR)
gap_end = int(27.0 * BEAT * SR)
fade_g = np.linspace(1.0, 0.08, gap_end - gap_start)
L[gap_start:gap_end] *= fade_g
R[gap_start:gap_end] *= fade_g

# --- ACT 6: Résumé End-Slate & Warm Studio Resolve (Beats 27..32) ---
add_kick(27.0, gain=0.88)
add_rim_snare(27.0, gain=0.36, snappy=False)
# Lush wide Cmaj9#11 resolve chord
add_fm_chord(27.0, 4.6, [36, 48, 55, 64, 71, 74, 78, 83], gain=0.28, brightness=1.45)
add_bass_note(27.0, 4.4, 36, gain=0.44)  # C2 warm resolve

# Four delicate crystalline discipline reveals on Beats 27.5, 28.0, 28.5, 29.0
for i, m_note in enumerate([76, 79, 83, 86]):
    add_pluck(27.5 + i * 0.5, m_note, gain=0.20, pan=-0.3 + 0.2 * i, decay=6.5)
    add_detent_click((27.5 + i * 0.5) * BEAT, freq=3800 + i * 350, gain=0.14, pan=-0.2 + 0.15 * i)

# Final subtle signature harmonic chime at Beat 30.0 (14.06s)
add_pluck(30.0, 91, gain=0.16, pan=0.0, decay=5.0)

# ==============================================================================
# STEREO REVERB (Cross-coupled multi-tap feedback delay network for studio space)
# ==============================================================================
rev_l = np.zeros(N, dtype=np.float64)
rev_r = np.zeros(N, dtype=np.float64)
taps = [
    (int(0.0297 * SR), 0.24, 1),
    (int(0.0371 * SR), 0.20, -1),
    (int(0.0437 * SR), 0.16, 1),
    (int(0.0531 * SR), 0.13, -1),
    (int(0.0793 * SR), 0.09, 1),
    (int(0.1130 * SR), 0.06, -1),
]
# High-pass the send slightly so sub-bass stays 100% mono-tight!
send_l = np.diff(L, prepend=0.0) * 0.8 + L * 0.25
send_r = np.diff(R, prepend=0.0) * 0.8 + R * 0.25
for d_samp, g_tap, cross in taps:
    if d_samp < N:
        if cross > 0:
            rev_l[d_samp:] += send_l[:-d_samp] * g_tap
            rev_r[d_samp:] += send_r[:-d_samp] * g_tap
        else:
            rev_l[d_samp:] += send_r[:-d_samp] * g_tap
            rev_r[d_samp:] += send_l[:-d_samp] * g_tap

L = L + rev_l * 0.34
R = R + rev_r * 0.34

# Smooth cosine fade-out on final 0.42s (14.58s -> 15.00s) + 3ms fade-in
fade_out_n = int(0.42 * SR)
fade_curve = 0.5 * (1.0 + np.cos(np.linspace(0.0, math.pi, fade_out_n)))
L[-fade_out_n:] *= fade_curve
R[-fade_out_n:] *= fade_curve
L[:144] *= np.linspace(0.0, 1.0, 144)
R[:144] *= np.linspace(0.0, 1.0, 144)

# Soft mastering limiter to -1.0 dBFS (0.891 peak)
peak = max(np.max(np.abs(L)), np.max(np.abs(R)), 1e-6)
drive = 1.25 / peak
L = np.tanh(L * drive) / math.tanh(1.25) * 0.891
R = np.tanh(R * drive) / math.tanh(1.25) * 0.891

# Export 48kHz 16-bit Stereo WAV
stereo_i16 = np.empty((N, 2), dtype=np.int16)
stereo_i16[:, 0] = np.clip(np.round(L * 32767.0), -32767, 32767).astype(np.int16)
stereo_i16[:, 1] = np.clip(np.round(R * 32767.0), -32767, 32767).astype(np.int16)

wav_path = "assets/audio/soundtrack.wav"
with wave.open(wav_path, "wb") as wf:
    wf.setnchannels(2)
    wf.setsampwidth(2)
    wf.setframerate(SR)
    wf.writeframes(stereo_i16.tobytes())

# ==============================================================================
# EXPORT PER-FRAME TELEMETRY (900 frames @ 60fps)
# ==============================================================================
FPS = 60
FRAMES = 900
SPF = SR // FPS  # 800 samples per frame!
mono = 0.5 * (L + R)

low_max = max(np.percentile(stem_low, 99.5), 1e-6)
mid_max = max(np.percentile(stem_mid, 99.5), 1e-6)
high_max = max(np.percentile(stem_high, 99.5), 1e-6)

frames_data = []
for f in range(FRAMES):
    s0 = f * SPF
    s1 = s0 + SPF
    seg = mono[s0:s1]
    rms = float(np.sqrt(np.mean(seg ** 2)))
    lo = float(min(1.0, np.mean(stem_low[s0:s1]) / low_max * 1.35))
    mi = float(min(1.0, np.mean(stem_mid[s0:s1]) / mid_max * 1.25))
    hi = float(min(1.0, np.mean(stem_high[s0:s1]) / high_max * 1.45))
    # 24 waveform points per frame for live vector/audio scope
    wv = [round(float(x), 4) for x in seg[::33][:24]]
    frames_data.append({
        "r": round(min(1.0, rms * 2.8), 4),
        "l": round(lo, 4),
        "m": round(mi, 4),
        "h": round(hi, 4),
        "w": wv
    })

with open("src/timeline_spec.json", "r", encoding="utf-8") as sf:
    spec_obj = json.load(sf)

with open("assets/audio/telemetry.json", "w", encoding="utf-8") as tf:
    json.dump(frames_data, tf, separators=(",", ":"))

with open("assets/audio/telemetry.js", "w", encoding="utf-8") as jf:
    jf.write("window.TIMELINE_SPEC = " + json.dumps(spec_obj) + ";\n")
    jf.write("window.AUDIO_TELEMETRY = " + json.dumps(frames_data, separators=(",", ":")) + ";\n")

peak_db = 20 * math.log10(max(np.max(np.abs(L)), np.max(np.abs(R))))
rms_db = 20 * math.log10(np.sqrt(np.mean(mono ** 2)))
print(f"Synthesized {wav_path}: {N/SR:.3f}s, Peak={peak_db:.2f} dBFS, Integrated RMS={rms_db:.2f} dBFS, Telemetry={len(frames_data)} frames")
