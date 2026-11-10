import * as THREE from 'three';

// ============================================================================
// DETERMINISTIC MATH, EASING & TIMELINE UTILITIES
// ============================================================================
const SPEC = window.TIMELINE_SPEC;
const TELEMETRY = window.AUDIO_TELEMETRY;
const FPS = SPEC.fps; // 60
const TOTAL_FRAMES = SPEC.totalFrames; // 900
const BPM = SPEC.bpm; // 128.0
const W = 1920;
const H = 1080;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const invLerp = (a, b, v) => clamp((v - a) / (b - a || 1e-6), 0, 1);

// Exact Newton-Raphson + Bisection Cubic-Bezier solver: y(x) and dy/dx
function solveBezierX(x1, x2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const mt = 1 - t;
    const bx = 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t - x;
    if (Math.abs(bx) < 1e-7) return t;
    const dbx = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
    if (Math.abs(dbx) < 1e-6) break;
    t -= bx / dbx;
  }
  let lo = 0, hi = 1;
  t = x;
  for (let i = 0; i < 12; i++) {
    const mt = 1 - t;
    const bx = 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t;
    if (bx < x) lo = t; else hi = t;
    t = 0.5 * (lo + hi);
  }
  return t;
}

function cubicBezier(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const t = solveBezierX(x1, x2, x);
  const mt = 1 - t;
  return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
}

function cubicBezierSlope(x1, y1, x2, y2, x) {
  const xc = clamp(x, 0.002, 0.998);
  const t = solveBezierX(x1, x2, xc);
  const mt = 1 - t;
  const dx = 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
  const dy = 3 * mt * mt * y1 + 6 * mt * t * (y2 - y1) + 3 * t * t * (1 - y2);
  return dy / Math.max(0.02, dx);
}

// Signature Studio Curves
const easeSilk = (t) => cubicBezier(0.16, 1.0, 0.30, 1.0, clamp(t, 0, 1));
const easeSnap = (t) => cubicBezier(0.72, 0.0, 0.18, 1.0, clamp(t, 0, 1));
const easeOvershoot = (t) => cubicBezier(0.34, 1.56, 0.64, 1.0, clamp(t, 0, 1));
const easeOutQuint = (t) => 1 - Math.pow(1 - clamp(t, 0, 1), 5);

// Analytical critically-damped / underdamped spring response (0 -> 1)
function springEval(u, freq = 14.0, zeta = 0.62) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  if (zeta >= 0.999) {
    const e = Math.exp(-freq * u);
    return 1 - (1 + freq * u) * e;
  }
  const wd = freq * Math.sqrt(1 - zeta * zeta);
  const env = Math.exp(-zeta * freq * u);
  return 1 - env * (Math.cos(wd * u) + (zeta * freq / wd) * Math.sin(wd * u));
}

// Seeded deterministic PRNG
function mulberry32(a) {
  return function () {
    let t = (a += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// DOM ELEMENT CACHE & GRAIN INITIALIZATION
// ============================================================================
const isRenderMode = new URLSearchParams(window.location.search).get('render') === '1';
if (isRenderMode) {
  document.body.classList.add('render-mode');
}

const stageEl = document.getElementById('stage');
const stageWrapperEl = document.getElementById('stage-wrapper');
const bgLayer = document.getElementById('bg-layer');
const bgGrid = document.getElementById('bg-grid');
const hudEl = document.getElementById('vernier-hud');
const hudActCode = document.getElementById('hud-act-code');
const hudTimecode = document.getElementById('hud-timecode');
const hudFrameCounter = document.getElementById('hud-frame-counter');
const hudProgressFill = document.getElementById('hud-progress-fill');
const hudPulseDot = document.getElementById('hud-pulse-dot');

const feBlurX = document.getElementById('fe-blur-x');
const feBlurY = document.getElementById('fe-blur-y');

const domScenes = {
  act1: document.getElementById('act1-dom'),
  act2: document.getElementById('act2-dom'),
  act3: document.getElementById('act3-dom'),
  act3Back: document.getElementById('act3-back'),
  act4: document.getElementById('act4-dom'),
  act5: document.getElementById('act5-dom'),
  act6: document.getElementById('act6-dom'),
};

// Responsive scaling for interactive preview mode
function syncStageScale() {
  if (isRenderMode) {
    stageEl.style.transform = 'none';
    return;
  }
  const rect = stageWrapperEl.getBoundingClientRect();
  const scale = rect.width / W;
  stageEl.style.transform = `scale(${scale})`;
}
window.addEventListener('resize', syncStageScale);
syncStageScale();

// Pre-bake deterministic fine grain tiles (4 tiles cycled cleanly)
const grainCanvas = document.getElementById('grain-overlay');
const grainCtx = grainCanvas.getContext('2d');
const grainTiles = [];
for (let g = 0; g < 4; g++) {
  const img = grainCtx.createImageData(256, 256);
  const prng = mulberry32(9001 + g * 777);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.floor(prng() * 255);
    img.data[i] = v;
    img.data[i + 1] = v;
    img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  grainTiles.push(img);
}

// ============================================================================
// LAYER 3: THREE.JS WEBGL2 3D STAGE (Rigs A, B, C)
// ============================================================================
const glCanvas = document.getElementById('webgl-canvas');
const renderer = new THREE.WebGLRenderer({
  canvas: glCanvas,
  alpha: true,
  antialias: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: true,
});
renderer.setSize(W, H, false);
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();

// Crisp Studio Lighting Rig
const ambientLight = new THREE.AmbientLight(0xffffff, 1.35);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(7, 11, 9);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xd8e8ff, 1.15);
fillLight.position.set(-9, 4, 6);
scene.add(fillLight);

const rimLight = new THREE.DirectionalLight(0xff5a2a, 1.35);
rimLight.position.set(0, -8, -7);
scene.add(rimLight);

const orthoAspect = W / H;
const orthoFrustum = 5.4;
const orthoCam = new THREE.OrthographicCamera(
  -orthoFrustum * orthoAspect,
  orthoFrustum * orthoAspect,
  orthoFrustum,
  -orthoFrustum,
  0.1,
  100
);
const perspCam = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);

// --- RIG A: Act 3 — 27-Module Precision Kinetic Sculpture ---
const rigA = new THREE.Group();
scene.add(rigA);

const matAlloy = new THREE.MeshStandardMaterial({ color: 0xe3e7ee, roughness: 0.28, metalness: 0.25 });
const matForest = new THREE.MeshStandardMaterial({ color: 0x0d231c, roughness: 0.34, metalness: 0.35 });
const matCobalt = new THREE.MeshStandardMaterial({ color: 0x1847f0, roughness: 0.25, metalness: 0.20 });
const matVermilionCore = new THREE.MeshStandardMaterial({
  color: 0xe03e24,
  emissive: 0xc82b14,
  emissiveIntensity: 0.55,
  roughness: 0.18,
  metalness: 0.15,
});
const edgeMatDark = new THREE.LineBasicMaterial({ color: 0x0b1d17, transparent: true, opacity: 0.42 });
const edgeMatLight = new THREE.LineBasicMaterial({ color: 0xe6efe9, transparent: true, opacity: 0.48 });

const modulesA = [];
const boxGeo = new THREE.BoxGeometry(0.76, 0.76, 0.76);
const boxEdges = new THREE.EdgesGeometry(boxGeo);
const spacingA = 0.84;

for (let ix = -1; ix <= 1; ix++) {
  for (let iy = -1; iy <= 1; iy++) {
    for (let iz = -1; iz <= 1; iz++) {
      if (ix === 0 && iy === 0 && iz === 0) continue; // Center houses the Vermilion Gyro Core!
      const sumAbs = Math.abs(ix) + Math.abs(iy) + Math.abs(iz);
      let mat = matAlloy;
      let eMat = edgeMatDark;
      if (sumAbs === 3) {
        mat = (ix * iy * iz > 0) ? matForest : matAlloy;
        eMat = (ix * iy * iz > 0) ? edgeMatLight : edgeMatDark;
      } else if (sumAbs === 1) {
        mat = matCobalt;
        eMat = edgeMatLight;
      }
      const mesh = new THREE.Mesh(boxGeo, mat);
      const wire = new THREE.LineSegments(boxEdges, eMat);
      mesh.add(wire);
      rigA.add(mesh);
      modulesA.push({ mesh, ix, iy, iz });
    }
  }
}

// Inner Vermilion Core + Dual Gimbal Rings inside Rig A
const coreGroupA = new THREE.Group();
const coreSphere = new THREE.Mesh(new THREE.OctahedronGeometry(0.56, 1), matVermilionCore);
const coreWire = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.60, 1)),
  new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75 })
);
coreGroupA.add(coreSphere, coreWire);

const outerGimbalA1 = new THREE.Mesh(
  new THREE.TorusGeometry(2.45, 0.022, 12, 96),
  new THREE.MeshStandardMaterial({ color: 0x0b1d17, roughness: 0.3, metalness: 0.6 })
);
const outerGimbalA2 = new THREE.Mesh(
  new THREE.TorusGeometry(2.75, 0.016, 12, 96),
  new THREE.MeshStandardMaterial({ color: 0xe03e24, roughness: 0.3, metalness: 0.4 })
);
rigA.add(coreGroupA, outerGimbalA1, outerGimbalA2);

// --- RIG B: Act 5C — Parametric Orbital Vortex ---
const rigB = new THREE.Group();
scene.add(rigB);

const knotMesh = new THREE.Mesh(
  new THREE.TorusKnotGeometry(1.35, 0.24, 180, 28, 2, 3),
  new THREE.MeshStandardMaterial({
    color: 0xe6efe9,
    roughness: 0.22,
    metalness: 0.65,
  })
);
const knotWire = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.TorusKnotGeometry(1.37, 0.25, 96, 14, 2, 3), 18),
  new THREE.LineBasicMaterial({ color: 0xe03e24, transparent: true, opacity: 0.65 })
);
rigB.add(knotMesh, knotWire);

const vortexRings = [];
for (let r = 0; r < 4; r++) {
  const rm = new THREE.Mesh(
    new THREE.TorusGeometry(2.1 + r * 0.55, 0.028 - r * 0.004, 12, 96),
    new THREE.MeshStandardMaterial({
      color: r % 2 === 0 ? 0xe03e24 : 0x8fb8a3,
      emissive: r % 2 === 0 ? 0x901f0d : 0x10281e,
      emissiveIntensity: 0.5,
      roughness: 0.3,
    })
  );
  rigB.add(rm);
  vortexRings.push(rm);
}

// --- RIG C: Act 6 — Architectural Gimbal Polyhedron in Right Résumé Box ---
const rigC = new THREE.Group();
scene.add(rigC);

const icoSolid = new THREE.Mesh(
  new THREE.IcosahedronGeometry(0.92, 0),
  new THREE.MeshStandardMaterial({
    color: 0xe6efe9,
    roughness: 0.45,
    metalness: 0.1,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
);
const icoEdges = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.93, 0)),
  new THREE.LineBasicMaterial({ color: 0x0b1d17 })
);
const icoCore = new THREE.Mesh(
  new THREE.OctahedronGeometry(0.42, 0),
  matVermilionCore
);
const gimbalC1 = new THREE.Mesh(
  new THREE.TorusGeometry(1.32, 0.018, 10, 80),
  new THREE.MeshStandardMaterial({ color: 0x0b1d17, roughness: 0.4 })
);
const gimbalC2 = new THREE.Mesh(
  new THREE.TorusGeometry(1.52, 0.014, 10, 80),
  new THREE.MeshStandardMaterial({ color: 0xe03e24, roughness: 0.4 })
);
rigC.add(icoSolid, icoEdges, icoCore, gimbalC1, gimbalC2);

// ============================================================================
// LAYER 4: 2D CANVAS PROCEDURAL & PHYSICS RENDERER
// ============================================================================
const canvas2d = document.getElementById('canvas-2d');
const ctx = canvas2d.getContext('2d');
const wipeCanvas = document.getElementById('wipe-canvas');
const wipeCtx = wipeCanvas.getContext('2d');

// Helper: Draw crisp drafted technical crosshair
function drawCrosshair(cx, cy, r, color, lineW = 1.5, gap = 6) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineW;
  ctx.beginPath();
  ctx.moveTo(cx - r, cy); ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy); ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap); ctx.lineTo(cx, cy + r);
  ctx.stroke();
  ctx.restore();
}

// Helper: Rounded pill / capsule
function drawCapsule(cx, cy, length, thickness, angleRad, fillStyle) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angleRad);
  ctx.fillStyle = fillStyle;
  const r = thickness * 0.5;
  const hw = length * 0.5;
  ctx.beginPath();
  ctx.roundRect(-hw, -r, length, thickness, r);
  ctx.fill();
  ctx.restore();
}

// ============================================================================
// PER-ACT CHOREOGRAPHY FUNCTIONS (100% Pure Functions of frame, t, beat)
// ============================================================================

function setHudTheme(mode) {
  if (mode === 'light') {
    hudEl.style.setProperty('--hud-ink', '#0B1D17');
    hudEl.style.setProperty('--hud-muted', 'rgba(11, 29, 23, 0.54)');
    hudEl.style.setProperty('--hud-line', 'rgba(11, 29, 23, 0.16)');
    hudEl.style.setProperty('--hud-accent', '#E03E24');
  } else if (mode === 'carbon') {
    hudEl.style.setProperty('--hud-ink', '#F0F3F7');
    hudEl.style.setProperty('--hud-muted', 'rgba(240, 243, 247, 0.52)');
    hudEl.style.setProperty('--hud-line', 'rgba(240, 243, 247, 0.14)');
    hudEl.style.setProperty('--hud-accent', '#FF5A1F');
  } else if (mode === 'vermilion') {
    hudEl.style.setProperty('--hud-ink', '#E6EFE9');
    hudEl.style.setProperty('--hud-muted', 'rgba(230, 239, 233, 0.72)');
    hudEl.style.setProperty('--hud-line', 'rgba(230, 239, 233, 0.26)');
    hudEl.style.setProperty('--hud-accent', '#0B1D17');
  } else {
    // forest dark
    hudEl.style.setProperty('--hud-ink', '#E6EFE9');
    hudEl.style.setProperty('--hud-muted', 'rgba(230, 239, 233, 0.52)');
    hudEl.style.setProperty('--hud-line', 'rgba(230, 239, 233, 0.16)');
    hudEl.style.setProperty('--hud-accent', '#E03E24');
  }
}

function setShutterBlur(dx, dy) {
  feBlurX.setAttribute('stdDeviation', `${dx.toFixed(2)},0`);
  feBlurY.setAttribute('stdDeviation', `0,${dy.toFixed(2)}`);
}

// ----------------------------------------------------------------------------
// ACT 1: KINETIC TYPOGRAPHY & APERTURE IGNITION (Frames 0..168, Beats 0..6)
// ----------------------------------------------------------------------------
function renderAct1(frame, t, beat, tel) {
  domScenes.act1.style.display = 'block';
  bgLayer.style.background = '#E6EFE9';
  bgGrid.style.opacity = '1';
  bgGrid.style.backgroundPosition = `${(-beat * 18).toFixed(1)}px 0px`;
  setHudTheme(beat > 5.55 ? 'forest' : 'light');

  // 1. Pre-slice Calibration & Horizontal Aperture Slice at Beat 0.5
  const sliceProg = easeSilk(invLerp(0.42, 1.05, beat));
  const formProg = easeSilk(invLerp(0.48, 1.35, beat));
  const inProg = easeSilk(invLerp(0.95, 1.75, beat));
  const motionProg = easeSilk(invLerp(1.08, 1.92, beat));

  // Directional vertical shutter blur while rising fast!
  const formVel = (1 - formProg) * (beat > 0.48 ? 14 : 0);
  setShutterBlur(0, formVel);

  const kickerEl = document.getElementById('a1-kicker');
  kickerEl.style.opacity = easeSilk(invLerp(0.2, 0.85, beat)).toFixed(3);
  kickerEl.style.transform = `translate3d(0, ${((1 - easeSilk(invLerp(0.2, 0.85, beat))) * 18).toFixed(1)}px, 0)`;

  const formEl = document.getElementById('a1-form');
  formEl.style.transform = `translate3d(0, ${((1 - formProg) * 108).toFixed(2)}%, 0)`;
  formEl.style.filter = formVel > 0.6 ? 'url(#shutter-blur-y)' : 'none';

  const inEl = document.getElementById('a1-in');
  inEl.style.transform = `translate3d(0, ${((1 - inProg) * 112).toFixed(2)}%, 0)`;

  const motionEl = document.getElementById('a1-motion');
  motionEl.style.transform = `translate3d(0, ${((1 - motionProg) * 112).toFixed(2)}%, 0)`;
  motionEl.style.letterSpacing = `${lerp(-0.09, -0.05, motionProg).toFixed(4)}em`;

  // Right Swiss spec column staggered reveal on Beats 1.4..2.6
  for (let i = 1; i <= 4; i++) {
    const sp = document.getElementById(`a1-sp-${i}`);
    const p = easeSilk(invLerp(1.1 + i * 0.22, 1.8 + i * 0.22, beat));
    sp.style.opacity = p.toFixed(3);
    sp.style.transform = `translate3d(${((1 - p) * 28).toFixed(1)}px, 0, 0)`;
  }

  // Bottom 4-Cell Kinetic Rhythm Strip (Beats 1.5, 2.0, 3.0, 4.0)
  const stripEl = document.getElementById('a1-strip');
  const stripIn = easeSilk(invLerp(1.25, 1.95, beat));
  stripEl.style.opacity = stripIn.toFixed(3);
  stripEl.style.transform = `scaleX(${lerp(0.92, 1.0, stripIn).toFixed(4)})`;

  const hitBeats = [1.5, 2.0, 3.0, 4.0];
  for (let c = 0; c < 4; c++) {
    const cell = document.getElementById(`a1-cell-${c}`);
    const word = document.getElementById(`a1-cw-${c}`);
    const wp = easeSilk(invLerp(hitBeats[c] - 0.08, hitBeats[c] + 0.55, beat));
    word.style.transform = `translate3d(0, ${((1 - wp) * 115).toFixed(1)}%, 0)`;

    // Active rhythmic highlight block!
    const nextB = c < 3 ? hitBeats[c + 1] : 5.15;
    const isActive = beat >= hitBeats[c] && beat < nextB;
    if (isActive) {
      cell.style.background = '#0B1D17';
      word.style.color = '#E6EFE9';
      cell.querySelector('.a1-cell-tag').style.color = '#E03E24';
    } else {
      cell.style.background = 'transparent';
      word.style.color = '#0B1D17';
      cell.querySelector('.a1-cell-tag').style.color = '#537466';
    }
  }

  // 2D Canvas: Calibration Vernier + Golden Caliper + Match-Cut #1 Iris!
  if (beat < 0.65) {
    const calP = invLerp(0, 0.5, beat);
    const calR = lerp(92, 16, easeSnap(calP));
    ctx.strokeStyle = '#0B1D17';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, calR, 0, Math.PI * 2);
    ctx.stroke();
    drawCrosshair(W / 2, H / 2, calR + 24, '#E03E24', 1.5, 8);
    ctx.fillStyle = '#E03E24';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Horizontal Vermilion Laser Slice at Beat 0.5
  if (beat >= 0.42 && beat <= 1.8) {
    const fadeSlice = 1 - invLerp(1.1, 1.8, beat);
    const halfSpan = lerp(0, 848, sliceProg);
    ctx.strokeStyle = `rgba(224, 62, 36, ${fadeSlice.toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(W / 2 - halfSpan, 434);
    ctx.lineTo(W / 2 + halfSpan, 434);
    ctx.stroke();
  }

  // Architectural Vernier Rotary Caliper & Audio Telemetry Needles (cleanly in open Swiss zone x: 1055..1330)
  if (beat >= 0.85) {
    const calIn = easeSilk(invLerp(0.85, 1.65, beat));
    const cx = 1132, cy = 304, rad = 76 * calIn;
    ctx.save();
    ctx.globalAlpha = calIn;
    ctx.strokeStyle = 'rgba(11, 29, 23, 0.25)';
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.stroke();

    // Rotating vernier arc synced to beat
    const a0 = beat * 1.15;
    ctx.strokeStyle = '#E03E24';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, a0, a0 + Math.PI * (0.45 + tel.m * 0.45));
    ctx.stroke();

    // Radial precision ticks
    for (let k = 0; k < 24; k++) {
      const ang = (k / 24) * Math.PI * 2 - beat * 0.35;
      const rIn = rad - (k % 6 === 0 ? 12 : 6);
      ctx.strokeStyle = k % 6 === 0 ? '#0B1D17' : 'rgba(11,29,23,0.35)';
      ctx.lineWidth = k % 6 === 0 ? 1.6 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * rIn, cy + Math.sin(ang) * rIn);
      ctx.lineTo(cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad);
      ctx.stroke();
    }
    drawCrosshair(cx, cy, 18, '#0B1D17', 1.2, 4);

    // Mini 14-bar live audio meter beside caliper
    for (let b = 0; b < 14; b++) {
      const wVal = Math.abs(tel.w[b] || 0);
      const bh = clamp(6 + wVal * 85 + (b < 5 ? tel.l * 26 : tel.h * 20), 4, 66);
      const bx = 1230 + b * 7;
      ctx.fillStyle = b % 4 === 0 ? '#E03E24' : '#0B1D17';
      ctx.fillRect(bx, cy + 32 - bh, 4, bh);
    }
    ctx.restore();
  }

  // MATCH-CUT #1 (Beats 5.12 -> 6.0): Radial Iris Expansion on Top Wipe Layer!
  if (beat >= 5.12) {
    const u = invLerp(5.12, 6.0, beat);
    const irisR = lerp(8, 2250, cubicBezier(0.68, 0.0, 0.22, 1.0, u));
    const ox = 1175, oy = 528;
    wipeCtx.save();
    wipeCtx.fillStyle = '#0B1D17';
    wipeCtx.beginPath();
    wipeCtx.arc(ox, oy, irisR, 0, Math.PI * 2);
    wipeCtx.fill();
    wipeCtx.strokeStyle = '#E03E24';
    wipeCtx.lineWidth = lerp(3, 14, u);
    wipeCtx.beginPath();
    wipeCtx.arc(ox, oy, irisR, 0, Math.PI * 2);
    wipeCtx.stroke();
    wipeCtx.restore();
  }
}

// ----------------------------------------------------------------------------
// ACT 2: LIVE CUBIC-BEZIER GRAPH & HARMONIC PENDULUM (Frames 169..309, Beats 6..11)
// ----------------------------------------------------------------------------
const CURVE_MODES = [
  { name: 'SYMMETRIC SNAP', p: [0.68, 0.00, 0.24, 1.00] },
  { name: 'ELASTIC OVERSHOOT', p: [0.34, 1.40, 0.64, 1.00] },
  { name: 'CRITICALLY DAMPED', p: [0.16, 1.00, 0.30, 1.00] },
];

function renderAct2(frame, t, beat, tel) {
  domScenes.act2.style.display = 'block';
  bgLayer.style.background = '#0B1D17';
  bgGrid.style.opacity = '0.35';
  bgGrid.style.backgroundImage =
    'linear-gradient(to right, rgba(230,239,233,0.06) 1px, transparent 1px), linear-gradient(to bottom, rgba(230,239,233,0.06) 1px, transparent 1px)';
  setHudTheme(beat > 10.65 ? 'light' : 'forest');
  setShutterBlur(0, 0);

  const enterP = easeSilk(invLerp(6.0, 6.65, beat));
  document.getElementById('a2-t1').style.transform = `translate3d(0, ${((1 - enterP) * 105).toFixed(1)}%, 0)`;
  document.getElementById('a2-t2').style.transform = `translate3d(0, ${((1 - enterP) * 105).toFixed(1)}%, 0)`;
  document.getElementById('a2-readout').style.opacity = enterP.toFixed(3);
  document.getElementById('a2-right-cap').style.opacity = enterP.toFixed(3);

  // Smoothly morph control points across the 3 curve regimes (6.0..7.5, 7.5..9.0, 9.0..11.0)
  let cIdx = 0;
  let p1x, p1y, p2x, p2y;
  if (beat < 7.5) {
    cIdx = 0;
    const m = easeSilk(invLerp(7.2, 7.5, beat));
    p1x = lerp(CURVE_MODES[0].p[0], CURVE_MODES[1].p[0], m);
    p1y = lerp(CURVE_MODES[0].p[1], CURVE_MODES[1].p[1], m);
    p2x = lerp(CURVE_MODES[0].p[2], CURVE_MODES[1].p[2], m);
    p2y = lerp(CURVE_MODES[0].p[3], CURVE_MODES[1].p[3], m);
  } else if (beat < 9.0) {
    cIdx = 1;
    const m = easeSilk(invLerp(8.7, 9.0, beat));
    p1x = lerp(CURVE_MODES[1].p[0], CURVE_MODES[2].p[0], m);
    p1y = lerp(CURVE_MODES[1].p[1], CURVE_MODES[2].p[1], m);
    p2x = lerp(CURVE_MODES[1].p[2], CURVE_MODES[2].p[2], m);
    p2y = lerp(CURVE_MODES[1].p[3], CURVE_MODES[2].p[3], m);
  } else {
    cIdx = 2;
    [p1x, p1y, p2x, p2y] = CURVE_MODES[2].p;
  }

  const activeMode = beat >= 8.85 ? CURVE_MODES[2] : (beat >= 7.35 ? CURVE_MODES[1] : CURVE_MODES[0]);
  document.getElementById('a2-mode-badge').textContent = activeMode.name;
  document.getElementById('a2-formula').textContent =
    `cubic-bezier(${p1x.toFixed(2)}, ${p1y.toFixed(2)}, ${p2x.toFixed(2)}, ${p2y.toFixed(2)})`;

  // Local cycle phase u (0..1) inside each regime
  let u = 0;
  let dir = 1;
  if (beat < 7.5) {
    u = invLerp(6.05, 7.35, beat);
    dir = 1;
  } else if (beat < 9.0) {
    u = invLerp(7.55, 8.85, beat);
    dir = -1;
  } else {
    u = invLerp(9.05, 10.55, beat);
    dir = 1;
  }

  const yVal = cubicBezier(p1x, p1y, p2x, p2y, u);
  const slope = cubicBezierSlope(p1x, p1y, p2x, p2y, u);
  document.getElementById('a2-vel-metric').textContent =
    `dy/dt = ${(slope >= 0 ? '+' : '') + slope.toFixed(2)}x`;

  // --- LEFT STAGE: Drafted Cubic-Bezier Graph Editor ---
  const gx = 112, gy = 420, gw = 720, gh = 365;
  const toSX = (nx) => gx + nx * gw;
  const toSY = (ny) => gy + gh - ny * gh;

  ctx.save();
  ctx.globalAlpha = enterP;

  // Overshoot ceiling zone highlight
  ctx.fillStyle = 'rgba(224, 62, 36, 0.07)';
  ctx.fillRect(gx, gy - 95, gw, 95);
  ctx.strokeStyle = 'rgba(224, 62, 36, 0.35)';
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(gx, gy);
  ctx.lineTo(gx + gw, gy);
  ctx.stroke();
  ctx.setLineDash([]);

  // Main Graph Frame & Subdivisions
  ctx.strokeStyle = 'rgba(230, 239, 233, 0.22)';
  ctx.lineWidth = 1.2;
  ctx.strokeRect(gx, gy, gw, gh);
  for (let i = 1; i < 4; i++) {
    ctx.strokeStyle = 'rgba(230, 239, 233, 0.08)';
    ctx.beginPath();
    ctx.moveTo(gx + (gw * i) / 4, gy); ctx.lineTo(gx + (gw * i) / 4, gy + gh);
    ctx.moveTo(gx, gy + (gh * i) / 4); ctx.lineTo(gx + gw, gy + (gh * i) / 4);
    ctx.stroke();
  }

  // Linear diagonal reference
  ctx.strokeStyle = 'rgba(230, 239, 233, 0.16)';
  ctx.setLineDash([4, 6]);
  ctx.beginPath();
  ctx.moveTo(toSX(0), toSY(0));
  ctx.lineTo(toSX(1), toSY(1));
  ctx.stroke();
  ctx.setLineDash([]);

  // Tangent Handle Levers (P0 -> P1 and P3 -> P2)
  const s0x = toSX(0), s0y = toSY(0);
  const s1x = toSX(p1x), s1y = toSY(p1y);
  const s2x = toSX(p2x), s2y = toSY(p2y);
  const s3x = toSX(1), s3y = toSY(1);

  ctx.strokeStyle = '#E03E24';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(s0x, s0y); ctx.lineTo(s1x, s1y);
  ctx.moveTo(s3x, s3y); ctx.lineTo(s2x, s2y);
  ctx.stroke();

  // Sampled Bezier Curve
  ctx.strokeStyle = '#E6EFE9';
  ctx.lineWidth = 4;
  ctx.beginPath();
  for (let k = 0; k <= 80; k++) {
    const ku = k / 80;
    const ky = cubicBezier(p1x, p1y, p2x, p2y, ku);
    const px = toSX(ku), py = toSY(ky);
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Active Progress Highlight Arc (0 -> u)
  ctx.strokeStyle = '#8FE3B8';
  ctx.lineWidth = 5;
  ctx.beginPath();
  const stepsU = Math.max(2, Math.floor(u * 80));
  for (let k = 0; k <= stepsU; k++) {
    const ku = (k / stepsU) * u;
    const ky = cubicBezier(p1x, p1y, p2x, p2y, ku);
    const px = toSX(ku), py = toSY(ky);
    if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Control Handle Grips & Live Coordinate Labels
  for (const [hx, hy, lbl] of [
    [s1x, s1y, `P1(${p1x.toFixed(2)}, ${p1y.toFixed(2)})`],
    [s2x, s2y, `P2(${p2x.toFixed(2)}, ${p2y.toFixed(2)})`],
  ]) {
    ctx.fillStyle = '#0B1D17';
    ctx.strokeStyle = '#E03E24';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(hx, hy, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#E6EFE9';
    ctx.font = '500 13px MapleMonoLocal, monospace';
    ctx.fillText(lbl, hx + 14, hy + 4);
  }

  // Live Traveling Bead + Crosshair Drop Lines
  const beadX = toSX(u), beadY = toSY(yVal);
  ctx.strokeStyle = 'rgba(143, 227, 184, 0.32)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(beadX, gy + gh); ctx.lineTo(beadX, beadY);
  ctx.moveTo(gx, beadY); ctx.lineTo(beadX, beadY);
  ctx.stroke();

  ctx.fillStyle = '#E03E24';
  ctx.beginPath();
  ctx.arc(beadX, beadY, 9, 0, Math.PI * 2);
  ctx.fill();

  // Velocity Derivative Histogram along bottom (y: 815..915)
  const histY = 915;
  for (let b = 0; b < 48; b++) {
    const bu = (b + 0.5) / 48;
    const bs = Math.abs(cubicBezierSlope(p1x, p1y, p2x, p2y, bu));
    const barH = clamp(bs * 22, 3, 88);
    const bx = gx + b * (gw / 48);
    ctx.fillStyle = bu <= u ? '#8FE3B8' : 'rgba(230,239,233,0.16)';
    ctx.fillRect(bx, histY - barH, gw / 48 - 3, barH);
  }

  // --- RIGHT STAGE: Articulated Bauhaus Pendulum + 6x Onion-Skin Echoes ---
  const pivotX = 1420, pivotY = 258, armLen = 430;
  const angleFor = (uSample) => {
    const ey = cubicBezier(p1x, p1y, p2x, p2y, clamp(uSample, 0, 1));
    const signed = dir > 0 ? lerp(-0.92, 0.92, ey) : lerp(0.92, -0.92, ey);
    return signed;
  };

  // Pivot Rail & Protractor Arc
  ctx.strokeStyle = 'rgba(230, 239, 233, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, armLen, Math.PI * 0.5 - 1.08, Math.PI * 0.5 + 1.08);
  ctx.stroke();

  // 6 Onion-Skin Echo Ghosts!
  for (let g = 6; g >= 1; g--) {
    const uGhost = u - g * 0.036;
    if (uGhost < 0) continue;
    const angG = angleFor(uGhost);
    const bx = pivotX + Math.sin(angG) * armLen;
    const by = pivotY + Math.cos(angG) * armLen;
    const alphaG = (1 - g / 7) * 0.34;
    ctx.strokeStyle = `rgba(224, 62, 36, ${alphaG.toFixed(3)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pivotX, pivotY);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(bx, by, 44, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Primary Pendulum Arm & Precision Bob
  const curAng = angleFor(u);
  const bobX = pivotX + Math.sin(curAng) * armLen;
  const bobY = pivotY + Math.cos(curAng) * armLen;

  ctx.strokeStyle = '#E6EFE9';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(pivotX, pivotY);
  ctx.lineTo(bobX, bobY);
  ctx.stroke();

  // Pivot Housing
  ctx.fillStyle = '#0B1D17';
  ctx.strokeStyle = '#E6EFE9';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(pivotX, pivotY, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Geometric Bauhaus Bob
  ctx.save();
  ctx.translate(bobX, bobY);
  ctx.rotate(-curAng);
  ctx.fillStyle = '#E6EFE9';
  ctx.beginPath();
  ctx.arc(0, 0, 48, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#E03E24';
  ctx.beginPath();
  ctx.arc(0, 0, 18, 0, Math.PI * 2);
  ctx.fill();
  drawCrosshair(0, 0, 66, '#8FE3B8', 1.5, 24);
  ctx.restore();

  // Horizontal Linear Counter-Shuttle Track at y=835
  const railX0 = 1060, railX1 = 1780, railY = 845;
  ctx.strokeStyle = 'rgba(230, 239, 233, 0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(railX0, railY);
  ctx.lineTo(railX1, railY);
  ctx.stroke();

  const shuttleT = dir > 0 ? yVal : (1 - yVal);
  const shuttleX = lerp(railX0 + 60, railX1 - 60, shuttleT);
  ctx.fillStyle = '#E03E24';
  ctx.fillRect(shuttleX - 38, railY - 14, 76, 28);
  ctx.strokeStyle = '#E6EFE9';
  ctx.strokeRect(shuttleX - 44, railY - 20, 88, 40);

  ctx.restore();

  // MATCH-CUT #2 (Beats 10.35 -> 11.0): Diagonal Architectural Slats on Top Wipe Layer!
  if (beat >= 10.35) {
    const wProg = easeSnap(invLerp(10.35, 11.0, beat));
    wipeCtx.save();
    const slats = 5;
    const slatH = H / slats;
    for (let s = 0; s < slats; s++) {
      const localP = clamp((wProg * 1.38) - s * 0.08, 0, 1);
      const eP = easeSilk(localP);
      const sx = lerp(-W * 0.15, W * 1.18, eP);
      wipeCtx.fillStyle = '#F4F6F9';
      wipeCtx.beginPath();
      wipeCtx.moveTo(-200, s * slatH);
      wipeCtx.lineTo(sx + 180, s * slatH);
      wipeCtx.lineTo(sx, (s + 1) * slatH + 2);
      wipeCtx.lineTo(-200, (s + 1) * slatH + 2);
      wipeCtx.closePath();
      wipeCtx.fill();
      // Crisp Cobalt leading bevel edge on middle slat!
      if (s === 2 && localP < 0.99) {
        wipeCtx.strokeStyle = '#1847F0';
        wipeCtx.lineWidth = 10;
        wipeCtx.beginPath();
        wipeCtx.moveTo(sx + 180, s * slatH);
        wipeCtx.lineTo(sx, (s + 1) * slatH + 2);
        wipeCtx.stroke();
      }
    }
    wipeCtx.restore();
  }
}

// ----------------------------------------------------------------------------
// ACT 3: 3D SPATIAL MECHANISM & DEPTH INTERLEAVING (Frames 310..478, Beats 11..17)
// ----------------------------------------------------------------------------
function renderAct3(frame, t, beat, tel) {
  domScenes.act3.style.display = 'block';
  domScenes.act3Back.style.display = 'flex';
  bgLayer.style.background = '#F4F6F9';
  bgGrid.style.opacity = '0.9';
  bgGrid.style.backgroundImage =
    'linear-gradient(to right, rgba(24,71,240,0.065) 1px, transparent 1px), linear-gradient(to bottom, rgba(24,71,240,0.065) 1px, transparent 1px)';
  bgGrid.style.backgroundPosition = `${(beat * 14).toFixed(1)}px ${(-beat * 14).toFixed(1)}px`;
  setHudTheme(beat > 16.7 ? 'carbon' : 'light');
  setShutterBlur(0, 0);

  // Depth-Interleaved Giant Typography (Back solid + Front 2px wireframe outline!)
  const enterT = easeSilk(invLerp(11.0, 11.8, beat));
  const driftX = (beat - 14.0) * 34;
  const b1 = document.getElementById('a3-back-1');
  const b2 = document.getElementById('a3-back-2');
  const f1 = document.getElementById('a3-front-1');
  const f2 = document.getElementById('a3-front-2');

  const yReveal = (1 - enterT) * 105;
  b1.style.transform = `translate3d(${(-driftX).toFixed(1)}px, ${yReveal.toFixed(1)}%, 0)`;
  b2.style.transform = `translate3d(${(driftX).toFixed(1)}px, ${yReveal.toFixed(1)}%, 0)`;
  f1.style.transform = `translate3d(${(-driftX).toFixed(1)}px, 0, 0)`;
  f2.style.transform = `translate3d(${(driftX).toFixed(1)}px, 0, 0)`;
  f1.style.opacity = enterT.toFixed(3);
  f2.style.opacity = enterT.toFixed(3);

  // 3D Rig A Choreography
  rigA.visible = true;
  orthoCam.position.set(10, 8.2, 10);
  orthoCam.lookAt(0, 0, 0);

  // Beat 11..12: Arrival scale spring
  const arriveScale = lerp(0.55, 1.0, springEval(invLerp(11.0, 12.1, beat), 13.0, 0.62));
  // Beat 14..16: Axial Explosion & Beat 16 Magnetic Implosion!
  const expUp = easeSilk(invLerp(13.95, 14.85, beat));
  const impDown = easeSnap(invLerp(15.85, 16.25, beat));
  const explodeAmt = expUp * (1 - impDown); // 0 -> 1 -> 0!

  const stateEl = document.getElementById('a3-state-label');
  if (beat < 13.95) {
    stateEl.textContent = 'SERVO LOCK // ISOMETRIC 35.26°';
  } else if (beat < 15.85) {
    stateEl.textContent = `AXIAL EXPLOSION // Δ +${Math.round(explodeAmt * 148)}mm`;
  } else {
    stateEl.textContent = 'MAGNETIC IMPLOSION // LOCKED';
  }

  // Whole-assembly orbital rotation
  rigA.rotation.y = (beat - 11.0) * 0.42 + easeSnap(invLerp(12.0, 12.8, beat)) * (Math.PI * 0.25);
  rigA.rotation.x = Math.sin((beat - 11.0) * 0.65) * 0.16;

  // Slice rotations: Top slice rotates 90 deg at Beat 12.0; Mid X slice rotates 90 deg at Beat 13.0
  const topTurn = easeSilk(invLerp(11.85, 12.65, beat)) * (Math.PI * 0.5);
  const midTurn = easeSilk(invLerp(12.85, 13.65, beat)) * (Math.PI * 0.5);

  // Zoom punch on Beat 16.5 -> 17.0 into Match-Cut #3!
  const exitZoom = Math.pow(invLerp(16.45, 17.0, beat), 3) * 4.2;
  rigA.scale.setScalar(arriveScale * (1 + exitZoom));

  for (const mod of modulesA) {
    const { mesh, ix, iy, iz } = mod;
    const distMult = spacingA * (1 + explodeAmt * 1.45);
    const v = new THREE.Vector3(ix * distMult, iy * distMult, iz * distMult);

    if (iy === 1) {
      v.applyAxisAngle(new THREE.Vector3(0, 1, 0), topTurn);
    }
    if (ix === 0) {
      v.applyAxisAngle(new THREE.Vector3(1, 0, 0), midTurn);
    }

    mesh.position.copy(v);
    mesh.rotation.set(
      explodeAmt * ix * 0.45 + (ix === 0 ? midTurn : 0),
      explodeAmt * iy * 0.45 + (iy === 1 ? topTurn : 0),
      explodeAmt * iz * 0.45
    );
  }

  coreGroupA.rotation.y = beat * 1.8;
  coreGroupA.rotation.z = beat * 1.1;
  coreGroupA.scale.setScalar(1 + explodeAmt * 0.55 + tel.l * 0.18);

  outerGimbalA1.rotation.x = Math.PI * 0.35 + beat * 0.55;
  outerGimbalA1.rotation.y = beat * 0.4;
  outerGimbalA2.rotation.x = -Math.PI * 0.28 + beat * 0.7;
  outerGimbalA2.rotation.z = beat * 0.5;

  renderer.render(scene, orthoCam);

  // --- Dynamic 2D SVG Leader Callouts tracking projected 3D coordinates! ---
  const svgEl = document.getElementById('a3-callout-svg');
  if (beat >= 13.8 && beat <= 16.3) {
    const callAlpha = Math.min(invLerp(13.8, 14.25, beat), 1 - invLerp(15.9, 16.3, beat));
    orthoCam.updateMatrixWorld();

    const projectWorld = (obj) => {
      const wp = new THREE.Vector3();
      obj.getWorldPosition(wp);
      wp.project(orthoCam);
      return {
        x: (wp.x * 0.5 + 0.5) * W,
        y: (-wp.y * 0.5 + 0.5) * H,
      };
    };

    const pCore = projectWorld(coreSphere);
    const pCorner = projectWorld(modulesA[modulesA.length - 1].mesh);
    const pLeft = projectWorld(modulesA[0].mesh);

    const makePin = (pt, targetX, targetY, alignRight, title, sub, color) => {
      const boxW = 176;
      const hx = alignRight ? targetX + boxW : targetX - boxW;
      const boxX = alignRight ? targetX : hx;
      const tx = boxX + 10;
      return `
        <g opacity="${callAlpha.toFixed(3)}">
          <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="5" fill="${color}" />
          <circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="11" fill="none" stroke="${color}" stroke-width="1.5" />
          <polyline points="${pt.x.toFixed(1)},${pt.y.toFixed(1)} ${targetX.toFixed(1)},${targetY.toFixed(1)} ${hx.toFixed(1)},${targetY.toFixed(1)}"
            fill="none" stroke="#0B1D17" stroke-width="1.5" />
          <rect x="${boxX.toFixed(1)}" y="${(targetY - 30).toFixed(1)}" width="${boxW}" height="26" fill="#0B1D17" />
          <rect x="${boxX.toFixed(1)}" y="${(targetY + 3).toFixed(1)}" width="${boxW}" height="22" fill="rgba(244,246,249,0.92)" />
          <text x="${tx.toFixed(1)}" y="${(targetY - 12).toFixed(1)}" fill="#F4F6F9" font-family="MapleMonoLocal, monospace" font-size="12" font-weight="700">${title}</text>
          <text x="${tx.toFixed(1)}" y="${(targetY + 18).toFixed(1)}" fill="#1847F0" font-family="MapleMonoLocal, monospace" font-size="12" font-weight="700">${sub}</text>
        </g>
      `;
    };

    svgEl.innerHTML =
      makePin(pCore, 1380, 215, true, 'SDF GYRO CORE', `EMISSIVE · ${(1 + explodeAmt * 0.55).toFixed(2)}x`, '#E03E24') +
      makePin(pCorner, 1380, 815, true, 'MODULE (+1,+1,+1)', 'CHAMFER ALLOY', '#1847F0') +
      makePin(pLeft, 510, 235, false, 'LATTICE NODE', 'ZERO BACKLASH', '#0B1D17');
  } else {
    svgEl.innerHTML = '';
  }

  // MATCH-CUT #3 (Beats 16.55 -> 17.0): Matte Carbon Iris Aperture Lock on Top Wipe Layer!
  if (beat >= 16.55) {
    const p = easeSnap(invLerp(16.55, 17.0, beat));
    wipeCtx.save();
    wipeCtx.fillStyle = '#141517';
    const rw = lerp(0, W, p), rh = lerp(0, H, p);
    wipeCtx.fillRect((W - rw) / 2, (H - rh) / 2, rw, rh);
    wipeCtx.strokeStyle = '#FF5A1F';
    wipeCtx.lineWidth = 4;
    wipeCtx.strokeRect((W - rw) / 2, (H - rh) / 2, rw, rh);
    wipeCtx.restore();
  }
}

// ----------------------------------------------------------------------------
// ACT 4: TACTILE CHRONOGRAPH & MULTI-TRACK UI (Frames 479..618, Beats 17..22)
// ----------------------------------------------------------------------------
function renderAct4(frame, t, beat, tel) {
  domScenes.act4.style.display = 'block';
  bgLayer.style.background = '#141517';
  bgGrid.style.opacity = '0.45';
  bgGrid.style.backgroundImage =
    'linear-gradient(to right, rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.04) 1px, transparent 1px)';
  setHudTheme('carbon');
  setShutterBlur(0, 0);

  const inP = easeSilk(invLerp(17.0, 17.6, beat));
  const topStrip = document.getElementById('a4-top-strip');
  topStrip.style.opacity = inP.toFixed(3);
  topStrip.style.transform = `translate3d(0, ${((1 - inP) * -20).toFixed(1)}px, 0)`;

  const step16 = clamp(Math.floor((beat - 17.0) * 4) + 1, 1, 20);
  document.getElementById('a4-pill-detent').textContent = `DETENT ${String(step16).padStart(2, '0')}/20`;
  document.getElementById('a4-pill-phase').textContent = `AUDIO ${(-14 + tel.r * 13).toFixed(1)} dBFS`;

  ctx.save();
  ctx.globalAlpha = inP;

  // --- PANEL 1 (Left Top): Precision Rotary Chronograph Encoder ---
  const p1x = 108, p1y = 212, p1w = 500, p1h = 435;
  ctx.fillStyle = '#1B1E22';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.fillRect(p1x, p1y, p1w, p1h);
  ctx.strokeRect(p1x, p1y, p1w, p1h);

  ctx.fillStyle = '#8C95A2';
  ctx.font = '500 12px MapleMonoLocal, monospace';
  ctx.fillText('01 // ROTARY DETENT CHRONOGRAPH', p1x + 22, p1y + 30);

  const cx = p1x + p1w / 2, cy = p1y + 232, outerR = 148;
  // Stepped + smoothed encoder angle synced to 16th notes!
  const rawStep = (beat - 17.0) * 4;
  const detentIdx = Math.floor(rawStep);
  const detentFrac = easeSilk(rawStep - detentIdx);
  const smoothSteps = detentIdx + detentFrac;
  const dialAngle = -Math.PI * 0.75 + (smoothSteps / 20) * (Math.PI * 1.5);

  // Outer radial vernier ticks (60 ticks)
  for (let i = 0; i <= 48; i++) {
    const a = -Math.PI * 0.75 + (i / 48) * (Math.PI * 1.5);
    const activeTick = a <= dialAngle + 0.02;
    const r0 = outerR - (i % 4 === 0 ? 16 : 8);
    ctx.strokeStyle = activeTick ? '#FF5A1F' : 'rgba(255,255,255,0.18)';
    ctx.lineWidth = i % 4 === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * outerR, cy + Math.sin(a) * outerR);
    ctx.stroke();
  }

  // Active Signal Amber Arc
  ctx.strokeStyle = '#FF5A1F';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cy, outerR + 10, -Math.PI * 0.75, dialAngle);
  ctx.stroke();

  // Machined Anodized Rotor Knob
  const knobR = 98;
  const grad = ctx.createLinearGradient(cx - knobR, cy - knobR, cx + knobR, cy + knobR);
  grad.addColorStop(0, '#2B3037');
  grad.addColorStop(1, '#15181C');
  ctx.fillStyle = grad;
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, knobR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // Rotor Indicator Line
  ctx.strokeStyle = '#FF5A1F';
  ctx.lineWidth = 3.5;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(dialAngle) * 42, cy + Math.sin(dialAngle) * 42);
  ctx.lineTo(cx + Math.cos(dialAngle) * (knobR - 10), cy + Math.sin(dialAngle) * (knobR - 10));
  ctx.stroke();

  // Center Digital Degree Readout
  const deg = clamp(((smoothSteps / 20) * 270), 0, 270);
  ctx.fillStyle = '#F2F4F7';
  ctx.font = '700 24px MapleMonoLocal, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${deg.toFixed(1)}°`, cx, cy + 8);
  ctx.textAlign = 'left';

  // --- PANEL 2 (Left Bottom): Lissajous Phase Scope + Audio Waveform ---
  const p2x = 108, p2y = 668, p2w = 500, p2h = 280;
  ctx.fillStyle = '#1B1E22';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.fillRect(p2x, p2y, p2w, p2h);
  ctx.strokeRect(p2x, p2y, p2w, p2h);
  ctx.fillStyle = '#8C95A2';
  ctx.font = '500 12px MapleMonoLocal, monospace';
  ctx.fillText('02 // LISSAJOUS PHASE & DSP TELEMETRY', p2x + 22, p2y + 30);

  // Lissajous figure on left half of Panel 2
  const lx = p2x + 132, ly = p2y + 158, lr = 82;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.strokeRect(lx - lr, ly - lr, lr * 2, lr * 2);
  ctx.strokeStyle = '#8FE3B8';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let s = 0; s <= 160; s++) {
    const th = (s / 160) * Math.PI * 2;
    const px = lx + Math.sin(3 * th + beat * 2.4) * lr * (0.78 + tel.m * 0.18);
    const py = ly + Math.sin(4 * th + beat * 1.2) * lr * (0.78 + tel.l * 0.18);
    if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.stroke();

  // Live 24-Band Audio Spectrum on right half of Panel 2
  const sx0 = p2x + 255, sy0 = p2y + 242;
  for (let b = 0; b < 24; b++) {
    const wSample = Math.abs(tel.w[b] || 0);
    const hVal = clamp(8 + wSample * 175 + (b < 8 ? tel.l * 55 : tel.h * 45), 6, 165);
    ctx.fillStyle = b % 6 === 0 ? '#FF5A1F' : '#8FE3B8';
    ctx.fillRect(sx0 + b * 9, sy0 - hVal, 6, hVal);
  }

  // --- PANEL 3 (Right 64%): 4-Track Keyframe Dope-Sheet & Hardware Toggles ---
  const p3x = 632, p3y = 212, p3w = 1180, p3h = 736;
  ctx.fillStyle = '#1B1E22';
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1;
  ctx.fillRect(p3x, p3y, p3w, p3h);
  ctx.strokeRect(p3x, p3y, p3w, p3h);

  const trackX0 = p3x + 240, trackX1 = p3x + p3w - 150;
  const trackW = trackX1 - trackX0;
  const playU = clamp((beat - 17.0) / 4.85, 0, 1);
  const playX = trackX0 + playU * trackW;

  const lanes = [
    { name: '01 / CAMERA.FOV', freq: 2.2, phase: 0.0, keys: [0.12, 0.38, 0.68, 0.90], color: '#FF5A1F' },
    { name: '02 / SPRING.ZETA', freq: 3.1, phase: 1.2, keys: [0.20, 0.50, 0.78], color: '#8FE3B8' },
    { name: '03 / SHADER.DISP', freq: 1.7, phase: 2.4, keys: [0.16, 0.44, 0.62, 0.86], color: '#F2F4F7' },
    { name: '04 / AUDIO.GAIN', freq: 4.0, phase: 0.7, keys: [0.08, 0.30, 0.56, 0.74, 0.94], color: '#FF5A1F' },
  ];

  // Ruler ticks
  ctx.fillStyle = '#8C95A2';
  ctx.font = '500 12px MapleMonoLocal, monospace';
  ctx.fillText('CHANNEL', p3x + 28, p3y + 36);
  for (let r = 0; r <= 8; r++) {
    const rx = trackX0 + (r / 8) * trackW;
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.beginPath();
    ctx.moveTo(rx, p3y + 48); ctx.lineTo(rx, p3y + p3h - 24);
    ctx.stroke();
    ctx.fillText(`0${r}:00`, rx - 16, p3y + 36);
  }

  for (let li = 0; li < lanes.length; li++) {
    const ln = lanes[li];
    const lyTop = p3y + 68 + li * 162;
    const lyMid = lyTop + 72;

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.strokeRect(p3x + 24, lyTop, p3w - 48, 144);

    ctx.fillStyle = '#F2F4F7';
    ctx.font = '700 14px Space Grotesk, sans-serif';
    ctx.fillText(ln.name, p3x + 42, lyMid - 8);

    // Live evaluated value at playhead
    const evalY = (uVal) => Math.sin(uVal * Math.PI * ln.freq + ln.phase) * 0.65 + Math.cos(uVal * 7.0 + li) * 0.25;
    const curVal = evalY(playU);
    ctx.fillStyle = ln.color;
    ctx.font = '500 13px MapleMonoLocal, monospace';
    ctx.fillText(`VAL ${(curVal >= 0 ? '+' : '') + curVal.toFixed(3)}`, p3x + 42, lyMid + 18);

    // Automation Spline
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let k = 0; k <= 90; k++) {
      const ku = k / 90;
      const kx = trackX0 + ku * trackW;
      const ky = lyMid - evalY(ku) * 44;
      if (k === 0) ctx.moveTo(kx, ky); else ctx.lineTo(kx, ky);
    }
    ctx.stroke();

    // Active illuminated spline left of playhead
    ctx.strokeStyle = ln.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    const maxK = Math.max(1, Math.floor(playU * 90));
    for (let k = 0; k <= maxK; k++) {
      const ku = (k / maxK) * playU;
      const kx = trackX0 + ku * trackW;
      const ky = lyMid - evalY(ku) * 44;
      if (k === 0) ctx.moveTo(kx, ky); else ctx.lineTo(kx, ky);
    }
    ctx.stroke();

    // Keyframe Diamonds ◆
    let triggeredCount = 0;
    for (const ku of ln.keys) {
      const kx = trackX0 + ku * trackW;
      const ky = lyMid - evalY(ku) * 44;
      const passed = playU >= ku;
      if (passed) triggeredCount++;
      const flash = passed ? Math.exp(-(playU - ku) * 16) : 0;

      if (flash > 0.04) {
        ctx.strokeStyle = ln.color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(kx, ky, 8 + (1 - flash) * 20, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.save();
      ctx.translate(kx, ky);
      ctx.rotate(Math.PI / 4);
      ctx.fillStyle = passed ? ln.color : '#1B1E22';
      ctx.strokeStyle = passed ? '#FFF' : 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1.5;
      ctx.fillRect(-6, -6, 12, 12);
      ctx.strokeRect(-6, -6, 12, 12);
      ctx.restore();
    }

    // Hardware Spring Toggle Switch on Right Margin!
    const swOn = triggeredCount % 2 === 1;
    const swX = trackX1 + 36, swY = lyMid - 14, swW = 68, swH = 28;
    ctx.fillStyle = swOn ? 'rgba(255, 90, 31, 0.22)' : '#121417';
    ctx.strokeStyle = swOn ? '#FF5A1F' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(swX, swY, swW, swH, 14);
    ctx.fill();
    ctx.stroke();

    const knobX = swOn ? swX + swW - 14 : swX + 14;
    ctx.fillStyle = swOn ? '#FF5A1F' : '#78808C';
    ctx.beginPath();
    ctx.arc(knobX, swY + 14, 9, 0, Math.PI * 2);
    ctx.fill();
  }

  // Master Signal Amber Playhead Line
  ctx.strokeStyle = '#FF5A1F';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(playX, p3y + 44);
  ctx.lineTo(playX, p3y + p3h - 16);
  ctx.stroke();
  ctx.fillStyle = '#FF5A1F';
  ctx.fillRect(playX - 7, p3y + 40, 14, 10);

  ctx.restore();

  // MATCH-CUT #4 (Beats 21.5 -> 22.0): High-Velocity Celadon Shutter Sweep on Top Wipe Layer!
  if (beat >= 21.5) {
    const wp = easeSnap(invLerp(21.5, 22.0, beat));
    wipeCtx.fillStyle = '#E6EFE9';
    wipeCtx.fillRect(0, 0, W * wp, H);
    wipeCtx.fillStyle = '#E03E24';
    wipeCtx.fillRect(W * wp - 10, 0, 10, H);
  }
}

// ----------------------------------------------------------------------------
// ACT 5: RAPID-FIRE GENERATIVE MONTAGE (Frames 619..759, Beats 22..27)
//   5A (22.0..23.5): 400-Node Magnetic Vector Field (Celadon #E6EFE9)
//   5B (23.5..25.0): Optical Slit-Scan Kinetic Poster (Vermilion #E03E24)
//   5C (25.0..27.0): 3D Orbital Gyroscope Vortex & Pre-Drop Iris (Forest #081510)
// ----------------------------------------------------------------------------
function renderAct5(frame, t, beat, tel) {
  domScenes.act5.style.display = 'block';
  const badge = document.getElementById('a5-badge');
  const cLabel = document.getElementById('a5c-label');
  setShutterBlur(0, 0);

  if (beat < 23.5) {
    // === CUT 5A: 400-NODE CAVALRY MAGNETIC VECTOR FIELD ===
    bgLayer.style.background = '#E6EFE9';
    bgGrid.style.opacity = '0.6';
    setHudTheme('light');
    badge.style.display = 'block';
    badge.style.background = '#0B1D17';
    badge.style.color = '#E6EFE9';
    badge.textContent = '05A // 400-NODE MAGNETIC VECTOR FIELD';
    cLabel.style.display = 'none';

    const localU = invLerp(22.0, 23.5, beat);
    const a1x = lerp(240, 1680, localU);
    const a1y = H * 0.5 + Math.sin(localU * Math.PI * 2.2) * 250;
    const a2x = lerp(1680, 240, localU);
    const a2y = H * 0.5 - Math.sin(localU * Math.PI * 2.2) * 230;

    const cols = 25, rows = 14;
    const x0 = 128, x1 = W - 128, y0 = 175, y1 = H - 115;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const px = lerp(x0, x1, c / (cols - 1));
        const py = lerp(y0, y1, r / (rows - 1));
        const dx1 = a1x - px, dy1 = a1y - py;
        const d1 = Math.hypot(dx1, dy1);
        const dx2 = a2x - px, dy2 = a2y - py;
        const d2 = Math.hypot(dx2, dy2);

        const vx = dx1 / (d1 * d1 + 4500) - dy2 / (d2 * d2 + 5500);
        const vy = dy1 / (d1 * d1 + 4500) + dx2 / (d2 * d2 + 5500);
        const ang = Math.atan2(vy, vx);
        const minD = Math.min(d1, d2);
        const excite = clamp(1 - minD / 360, 0, 1);

        const len = lerp(24, 56, excite) + tel.l * 8;
        const thick = lerp(5, 13, excite);
        const col = excite > 0.42 ? '#E03E24' : (excite > 0.18 ? '#1D4437' : '#0B1D17');
        drawCapsule(px, py, len, thick, ang, col);
      }
    }

    // Subtle attractor crosshairs
    drawCrosshair(a1x, a1y, 32, '#E03E24', 2, 8);
    drawCrosshair(a2x, a2y, 26, '#0B1D17', 2, 8);

  } else if (beat < 25.0) {
    // === CUT 5B: OPTICAL SLIT-SCAN KINETIC POSTER ON VERMILION ===
    bgLayer.style.background = '#E03E24';
    bgGrid.style.opacity = '0.2';
    setHudTheme('vermilion');
    badge.style.display = 'block';
    badge.style.background = '#E6EFE9';
    badge.style.color = '#0B1D17';
    badge.textContent = '05B // OPTICAL SLIT-SCAN REFRACTION';
    cLabel.style.display = 'none';

    const localU = invLerp(23.5, 25.0, beat);
    // Wave amplitude decays cleanly toward Beat 24.75 so words lock razor-sharp!
    const waveAmp = (1 - easeSilk(invLerp(0.58, 0.92, localU))) * 145;
    const slices = 18;
    const sliceH = (H - 220) / slices;
    const words = ['TYPE · RHYTHM', 'SPACE · SHADER', 'SOUND · PHYSICS'];

    for (let s = 0; s < slices; s++) {
      const sy = 150 + s * sliceH;
      const offset = Math.sin(localU * Math.PI * 5.0 + s * 0.58) * waveAmp * (s % 2 === 0 ? 1 : -0.75);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, sy, W, sliceH + 1);
      ctx.clip();

      ctx.textAlign = 'center';
      ctx.font = '800 104px Syne, Space Grotesk, sans-serif';
      for (let wi = 0; wi < words.length; wi++) {
        ctx.fillStyle = wi === 1 ? '#0B1D17' : '#E6EFE9';
        ctx.fillText(words[wi], W * 0.5 + offset, 355 + wi * 215);
      }
      ctx.restore();
    }
    ctx.textAlign = 'left';

  } else {
    // === CUT 5C: 3D ORBITAL GYROSCOPE CLIMAX & PRE-DROP BREATH ===
    bgLayer.style.background = '#081510';
    bgGrid.style.opacity = '0.25';
    setHudTheme('forest');
    badge.style.display = 'block';
    badge.style.background = '#E03E24';
    badge.style.color = '#FFF';
    badge.textContent = '05C // TOROIDAL VORTEX · 128 BPM DROP';
    cLabel.style.display = 'block';

    const u = invLerp(25.0, 27.0, beat);
    const accel = Math.pow(u, 2.4);

    // Three.js Rig B Vortex
    rigB.visible = true;
    perspCam.position.set(0, 0, lerp(6.8, 2.65, accel));
    perspCam.lookAt(0, 0, 0);

    knotMesh.rotation.x = beat * 1.4 + accel * 4.5;
    knotMesh.rotation.y = beat * 1.9 + accel * 5.2;
    knotWire.rotation.copy(knotMesh.rotation);

    vortexRings.forEach((rm, idx) => {
      rm.rotation.x = (idx % 2 === 0 ? 1 : -1) * (beat * 1.2 + accel * 3.5) + idx * 0.5;
      rm.rotation.y = (idx % 2 === 1 ? 1 : -1) * (beat * 1.5 + accel * 4.0);
    });

    renderer.render(scene, perspCam);

    // Radial Speed Streaks on 2D Canvas
    ctx.save();
    const cx = W / 2, cy = H / 2;
    for (let k = 0; k < 48; k++) {
      const ang = (k / 48) * Math.PI * 2 + u * 0.4;
      const r0 = lerp(260, 120, accel) + (k % 3) * 45;
      const r1 = r0 + lerp(40, 340, accel);
      ctx.strokeStyle = k % 4 === 0 ? 'rgba(224, 62, 36, 0.7)' : 'rgba(230, 239, 233, 0.25)';
      ctx.lineWidth = k % 4 === 0 ? 2.5 : 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      ctx.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
      ctx.stroke();
    }
    ctx.restore();

    // Pre-drop compression at 26.82 -> 27.0!
    const preDrop = invLerp(26.80, 27.0, beat);
    const scaleTxt = preDrop > 0 ? lerp(1.18, 0.72, easeSnap(preDrop)) : lerp(0.86, 1.18, easeSilk(u));
    cLabel.style.transform = `translate(-50%, -50%) scale(${scaleTxt.toFixed(3)})`;

    if (preDrop > 0.05) {
      const irisC = lerp(0, 1220, Math.pow(preDrop, 2.5));
      wipeCtx.fillStyle = '#E6EFE9';
      wipeCtx.beginPath();
      wipeCtx.arc(W / 2, H / 2, irisC, 0, Math.PI * 2);
      wipeCtx.fill();
    }
  }
}

// ----------------------------------------------------------------------------
// ACT 6: ASYMMETRIC SWISS RÉSUMÉ END-SLATE (Frames 760..899, Beats 27..32)
// ----------------------------------------------------------------------------
function renderAct6(frame, t, beat, tel) {
  domScenes.act6.style.display = 'block';
  bgLayer.style.background = '#E6EFE9';
  bgGrid.style.opacity = '1';
  bgGrid.style.backgroundImage =
    'linear-gradient(to right, rgba(11,29,23,0.055) 1px, transparent 1px), linear-gradient(to bottom, rgba(11,29,23,0.055) 1px, transparent 1px)';
  bgGrid.style.backgroundPosition = '0px 0px';
  setHudTheme('light');
  setShutterBlur(0, 0);

  // Expanding Vermilion Shockwave Ring out of Beat 27.0 drop!
  if (beat < 28.2) {
    const sw = easeOutQuint(invLerp(27.0, 28.2, beat));
    ctx.save();
    ctx.strokeStyle = `rgba(224, 62, 36, ${(1 - sw).toFixed(3)})`;
    ctx.lineWidth = lerp(16, 1, sw);
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, lerp(80, 1400, sw), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // Left Résumé Lockup Staggered Baseline Reveals
  const pEye = easeSilk(invLerp(27.0, 27.6, beat));
  const pN1 = easeSilk(invLerp(27.08, 27.85, beat));
  const pN2 = easeSilk(invLerp(27.22, 28.05, beat));
  const pRole = easeSilk(invLerp(27.45, 28.25, beat));
  const pAvail = easeSilk(invLerp(27.7, 28.45, beat));

  document.getElementById('a6-eyebrow').style.transform = `translate3d(0, ${((1 - pEye) * 110).toFixed(1)}%, 0)`;
  document.getElementById('a6-name-1').style.transform = `translate3d(0, ${((1 - pN1) * 108).toFixed(1)}%, 0)`;
  document.getElementById('a6-name-2').style.transform = `translate3d(0, ${((1 - pN2) * 108).toFixed(1)}%, 0)`;
  document.getElementById('a6-role').style.transform = `translate3d(0, ${((1 - pRole) * 115).toFixed(1)}%, 0)`;
  const pMet = easeSilk(invLerp(27.55, 28.35, beat));
  document.getElementById('a6-metrics').style.opacity = pMet.toFixed(3);
  document.getElementById('a6-metrics').style.transform = `translate3d(0, ${((1 - pMet) * 18).toFixed(1)}px, 0)`;
  document.getElementById('a6-avail').style.opacity = pAvail.toFixed(3);

  // 4 Discipline Rows synced to Crystalline Plucks on Beats 27.5, 28.0, 28.5, 29.0!
  for (let r = 0; r < 4; r++) {
    const rp = easeSilk(invLerp(27.45 + r * 0.48, 28.15 + r * 0.48, beat));
    const rowEl = document.getElementById(`a6-row-${r}`);
    rowEl.style.transform = `translate3d(0, ${((1 - rp) * 115).toFixed(1)}%, 0)`;
  }

  // Right Top Emblem Box: Render Three.js Rig C positioned cleanly over #a6-emblem-box!
  rigC.visible = true;
  // Emblem box center in 1920x1080 coords is approximately (x=1476, y=277)
  // Shift orthographic camera view offset so (0,0,0) projects to (1476, 277)!
  orthoCam.position.set(0, 0, 10);
  orthoCam.lookAt(0, 0, 0);
  const shiftX = -((1544 - W / 2) / W) * (orthoFrustum * 2 * orthoAspect);
  const shiftY = ((277 - H / 2) / H) * (orthoFrustum * 2);
  rigC.position.set(-shiftX, -shiftY, 0);

  const cScale = easeSilk(invLerp(27.1, 28.0, beat)) * 0.76;
  rigC.scale.setScalar(cScale);
  rigC.rotation.y = (beat - 27.0) * 0.55;
  rigC.rotation.x = 0.35 + Math.sin((beat - 27.0) * 0.8) * 0.15;
  gimbalC1.rotation.x = Math.PI * 0.4 + beat * 0.7;
  gimbalC2.rotation.y = beat * 0.9;

  const degTheta = ((rigC.rotation.y * 180) / Math.PI) % 360;
  document.getElementById('a6-gimbal-angle').textContent = `θ = ${degTheta.toFixed(1).padStart(5, '0')}°`;

  renderer.render(scene, orthoCam);
}

// ============================================================================
// MASTER DETERMINISTIC FRAME DISPATCHER: window.seekToFrame(frameIndex)
// ============================================================================
let currentFrame = 0;

export function seekToFrame(rawFrame) {
  const frame = clamp(Math.round(rawFrame), 0, TOTAL_FRAMES - 1);
  currentFrame = frame;
  const t = frame / FPS;
  const beat = t * (BPM / 60.0);
  const tel = TELEMETRY[frame] || { r: 0, l: 0, m: 0, h: 0, w: [] };

  // Reset all scene layers cleanly before rendering target frame (guarantees zero bleed!)
  for (const key of Object.keys(domScenes)) {
    domScenes[key].style.display = 'none';
  }
  rigA.visible = false;
  rigB.visible = false;
  rigC.visible = false;
  const uses3D = (frame >= 310 && frame <= 478) || (frame >= 703 && frame <= 899);
  glCanvas.style.display = uses3D ? 'block' : 'none';
  if (uses3D) renderer.clear();
  ctx.clearRect(0, 0, W, H);
  wipeCtx.clearRect(0, 0, W, H);

  // Update deterministic grain tile
  grainCtx.putImageData(grainTiles[frame % 4], 0, 0);

  // Dispatch active Act
  let actCode = '01 / KINETIC TYPE';
  if (frame <= 168) {
    actCode = '01 / KINETIC TYPE';
    renderAct1(frame, t, beat, tel);
  } else if (frame <= 309) {
    actCode = '02 / CURVE RIGGING';
    renderAct2(frame, t, beat, tel);
  } else if (frame <= 478) {
    actCode = '03 / SPATIAL 3D';
    renderAct3(frame, t, beat, tel);
  } else if (frame <= 618) {
    actCode = '04 / INSTRUMENT UI';
    renderAct4(frame, t, beat, tel);
  } else if (frame <= 759) {
    actCode = '05 / PROCEDURAL FIELD';
    renderAct5(frame, t, beat, tel);
  } else {
    actCode = '06 / SHOWREEL \'26';
    renderAct6(frame, t, beat, tel);
  }

  // Update Peripheral Vernier Studio HUD
  const secs = Math.floor(t);
  const ff = frame % FPS;
  const bar = Math.floor(beat / 4) + 1;
  const beatInBar = Math.floor(beat % 4) + 1;

  hudActCode.textContent = actCode;
  hudTimecode.textContent =
    `00:00:${String(secs).padStart(2, '0')}:${String(ff).padStart(2, '0')} · BAR ${String(bar).padStart(2, '0')}.${beatInBar} · 128.0 BPM`;
  hudFrameCounter.textContent = `FRAME ${String(frame).padStart(3, '0')} / 899`;
  hudProgressFill.style.width = `${((frame / (TOTAL_FRAMES - 1)) * 100).toFixed(3)}%`;
  hudPulseDot.style.transform = `scale(${(1 + tel.l * 0.55).toFixed(3)})`;

  // Sync Interactive Studio Controls if not in render mode
  if (!isRenderMode) {
    scrubberEl.value = String(frame);
    readoutEl.textContent = `${t.toFixed(2).padStart(5, '0')}s · F${String(frame).padStart(3, '0')} · 60FPS`;
    jumpPills.forEach((btn) => {
      const bf = Number(btn.dataset.frame);
      btn.classList.toggle('active', frame >= bf && (btn.nextElementSibling ? frame < Number(btn.nextElementSibling.dataset.frame) : true));
    });
  }

  return true;
}

window.seekToFrame = seekToFrame;
window.REEL_READY = false;

// ============================================================================
// INTERACTIVE STUDIO TRANSPORT (Play/Pause synced with WebAudioWAV + Scrubber)
// ============================================================================
const audioEl = document.getElementById('reel-audio');
const btnPlay = document.getElementById('btn-play');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const scrubberEl = document.getElementById('scrubber');
const readoutEl = document.getElementById('ctrl-readout');
const jumpPills = Array.from(document.querySelectorAll('.jump-pill'));

let isPlaying = false;
let rafId = null;
let fallbackStartWall = 0;
let fallbackStartFrame = 0;

function tickPlayback() {
  if (!isPlaying) return;
  let f = 0;
  if (!audioEl.paused && Number.isFinite(audioEl.currentTime)) {
    f = Math.floor(audioEl.currentTime * FPS);
  } else {
    const elapsed = (performance.now() - fallbackStartWall) / 1000;
    f = fallbackStartFrame + Math.floor(elapsed * FPS);
  }
  if (f >= TOTAL_FRAMES) {
    pauseReel();
    seekToFrame(TOTAL_FRAMES - 1);
    return;
  }
  seekToFrame(f);
  rafId = requestAnimationFrame(tickPlayback);
}

function playReel() {
  if (currentFrame >= TOTAL_FRAMES - 1) {
    seekToFrame(0);
  }
  isPlaying = true;
  btnPlay.textContent = 'PAUSE';
  fallbackStartFrame = currentFrame;
  fallbackStartWall = performance.now();
  audioEl.currentTime = currentFrame / FPS;
  audioEl.play().catch(() => {});
  rafId = requestAnimationFrame(tickPlayback);
}

function pauseReel() {
  isPlaying = false;
  btnPlay.textContent = 'PLAY';
  audioEl.pause();
  if (rafId) cancelAnimationFrame(rafId);
}

if (!isRenderMode) {
  btnPlay.addEventListener('click', () => (isPlaying ? pauseReel() : playReel()));
  btnPrev.addEventListener('click', () => { pauseReel(); seekToFrame(currentFrame - 1); });
  btnNext.addEventListener('click', () => { pauseReel(); seekToFrame(currentFrame + 1); });
  scrubberEl.addEventListener('input', (e) => {
    pauseReel();
    seekToFrame(Number(e.target.value));
  });
  jumpPills.forEach((btn) => {
    btn.addEventListener('click', () => {
      pauseReel();
      seekToFrame(Number(btn.dataset.frame));
    });
  });
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') { e.preventDefault(); isPlaying ? pauseReel() : playReel(); }
    if (e.code === 'ArrowLeft') { e.preventDefault(); pauseReel(); seekToFrame(currentFrame - 1); }
    if (e.code === 'ArrowRight') { e.preventDefault(); pauseReel(); seekToFrame(currentFrame + 1); }
  });
}

// Wait for all local fonts to finish decoding before signaling REEL_READY!
document.fonts.ready.then(() => {
  seekToFrame(0);
  window.REEL_READY = true;
});
