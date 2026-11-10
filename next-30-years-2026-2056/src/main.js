import * as THREE from '../assets/vendor/three.module.min.js';
import {
  FILM_DURATION,
  R_EARTH,
  R_MOON,
  R_MARS,
  R_SUN,
  MOON_DISP_SCALE,
  MARS_DISP_SCALE,
  STOPS,
  getShotFrameState,
  getTimeForYear,
} from './ephemeris.js';
import {
  createStarSkyMaterial,
  createStarPointsMaterial,
  createEarthSurfaceMaterial,
  createEarthCloudsMaterial,
  createAtmosphereMaterial,
  createMoonMaterial,
  createMarsSurfaceMaterial,
  createSunSurfaceMaterial,
  createSunCoronaMaterial,
} from './shaders.js';
import {
  buildLeoSatelliteSystem,
  buildOrbitalRingAndElevators,
  buildLunarBase,
  buildMarsCities3D,
  buildSolarMirrorSwarm,
} from './megastructures.js';
import { createHdrPostPipeline } from './postfx.js';
import { createSpaceAudioEngine } from './audio.js';

const params = new URLSearchParams(window.location.search);
const IS_CAPTURE_MODE = params.get('capture') === '1';

if (IS_CAPTURE_MODE) {
  document.documentElement.classList.add('capture-mode');
}

const viewportEl = document.getElementById('viewport');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingProgressText = document.getElementById('loading-progress');
const loadingBarFill = document.getElementById('loading-bar-fill');

// UI Elements
const elYearInt = document.getElementById('hud-year-int');
const elYearFrac = document.getElementById('hud-year-frac');
const elStopIndex = document.getElementById('hud-stop-index');
const elStopTitle = document.getElementById('hud-stop-title');
const elStopSub = document.getElementById('hud-stop-sub');
const elMapCredit = document.getElementById('hud-map-credit');
const elTelBody = document.getElementById('tel-body');
const elTelAlt = document.getElementById('tel-alt');
const elTelHelio = document.getElementById('tel-helio');
const elTelFov = document.getElementById('tel-fov');
const elTimeReadout = document.getElementById('time-readout');

const btnPlay = document.getElementById('btn-play');
const btnSound = document.getElementById('btn-sound');
const btnHud = document.getElementById('btn-hud');
const btnRecenter = document.getElementById('btn-recenter');
const timelineTrack = document.getElementById('timeline-track');
const timelineFill = document.getElementById('timeline-fill');
const timelinePlayhead = document.getElementById('timeline-playhead');
const stopButtonsContainer = document.getElementById('stop-detents');
const rulerTicksContainer = document.getElementById('ruler-ticks');

// Build renderer
const renderer = new THREE.WebGLRenderer({
  antialias: false, // Handled by 4x MSAA HalfFloat HDR RenderTarget in postfx.js!
  powerPreference: 'high-performance',
  preserveDrawingBuffer: IS_CAPTURE_MODE,
});
renderer.autoClear = false;
renderer.setPixelRatio(IS_CAPTURE_MODE ? 1.0 : Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(viewportEl.clientWidth, viewportEl.clientHeight);
viewportEl.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(
  46,
  viewportEl.clientWidth / Math.max(1, viewportEl.clientHeight),
  0.0005,
  1600.0
);

const skyScene = new THREE.Scene();
const scene = new THREE.Scene();

const postfx = createHdrPostPipeline(
  renderer,
  viewportEl.clientWidth * renderer.getPixelRatio(),
  viewportEl.clientHeight * renderer.getPixelRatio()
);
const audioEngine = createSpaceAudioEngine();

// Load all 13 real planetary maps + landmarks JSON
async function loadAllAssets() {
  const texList = [
    ['earthDay', 'assets/maps/earth_day_4k.jpg', true],
    ['earthNight', 'assets/maps/earth_night_4k.jpg', true],
    ['earthClouds', 'assets/maps/earth_clouds_2k.jpg', false],
    ['earthNormal', 'assets/maps/earth_normal_2k.jpg', false],
    ['earthSpec', 'assets/maps/earth_spec_2k.jpg', false],
    ['moonColor', 'assets/maps/moon_color_4k.jpg', true],
    ['moonDisp', 'assets/maps/moon_disp_4k.png', false],
    ['moonNormal', 'assets/maps/moon_normal_4k.jpg', false],
    ['marsColor', 'assets/maps/mars_color_4k.jpg', true],
    ['marsDisp', 'assets/maps/mars_disp_4k.jpg', false],
    ['marsNormal', 'assets/maps/mars_normal_4k.jpg', false],
    ['marsCities', 'assets/maps/mars_cities_4k.png', false],
    ['sun', 'assets/maps/sun_4k.jpg', true],
    ['stars', 'assets/maps/stars_4k.jpg', true],
  ];

  const totalItems = texList.length + 1;
  let done = 0;
  function bump(label) {
    done++;
    const pct = Math.round((done / totalItems) * 100);
    if (loadingProgressText) loadingProgressText.textContent = `${pct}% · ${label}`;
    if (loadingBarFill) loadingBarFill.style.transform = `scaleX(${done / totalItems})`;
  }

  const loader = new THREE.TextureLoader();
  const maxAniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const texPromises = texList.map(
    ([key, url, isColor]) =>
      new Promise((resolve, reject) => {
        loader.load(
          url,
          (tex) => {
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.ClampToEdgeWrapping;
            tex.anisotropy = maxAniso;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            renderer.initTexture(tex);
            bump(key);
            resolve([key, tex]);
          },
          undefined,
          (err) => reject(new Error(`Failed texture ${url}: ${err?.message || err}`))
        );
      })
  );

  const landmarksPromise = fetch('assets/maps/planetary_landmarks.json')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then((data) => {
      bump('landmarks');
      return data;
    });

  const [entries, landmarks] = await Promise.all([Promise.all(texPromises), landmarksPromise]);
  return { textures: Object.fromEntries(entries), landmarks };
}

// Build ruler & 5 Stop detents in timeline
function buildTimelineMarkers(onSelectTime) {
  if (rulerTicksContainer) {
    for (let y = 2026; y <= 2056; y++) {
      const t = getTimeForYear(y);
      const pct = (t / FILM_DURATION) * 100;
      const tick = document.createElement('div');
      tick.className = y % 5 === 0 || y === 2026 || y === 2056 ? 'ruler-tick major' : 'ruler-tick';
      tick.style.left = `${pct.toFixed(3)}%`;
      rulerTicksContainer.appendChild(tick);
    }
  }

  if (stopButtonsContainer) {
    STOPS.forEach((s) => {
      const pct = (s.tHero / FILM_DURATION) * 100;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'stop-detent';
      btn.dataset.stopId = s.id;
      btn.style.left = `${pct.toFixed(3)}%`;
      btn.innerHTML = `<span class="detent-dot"></span><span class="detent-year">${s.year}</span>`;
      btn.title = `${s.year} — ${s.title}`;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelectTime(s.tHero);
      });
      stopButtonsContainer.appendChild(btn);
    });
  }
}

let worldController = null;

window.__readyPromise = (async () => {
  const { textures, landmarks } = await loadAllAssets();

  // 1. Deep-Space Milky Way + 14,000 Tycho Spectral Point Stars (centered on camera origin 0,0,0)
  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(60, 64, 32), createStarSkyMaterial(textures.stars));
  skyScene.add(skyMesh);

  const starCount = 14000;
  const starGeo = new THREE.BufferGeometry();
  const sPos = new Float32Array(starCount * 3);
  const sSize = new Float32Array(starCount);
  const sCol = new Float32Array(starCount * 3);
  let seed = 1337;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const spectralPalette = [
    [0.72, 0.84, 1.15], // O/B blue-white
    [0.95, 0.97, 1.05], // A white
    [1.05, 0.98, 0.86], // F/G solar yellow-white
    [1.12, 0.85, 0.62], // K warm orange
    [1.08, 0.68, 0.44], // M amber-red
  ];
  for (let i = 0; i < starCount; i++) {
    const u = rnd() * 2 - 1;
    const th = rnd() * Math.PI * 2;
    const sq = Math.sqrt(Math.max(0, 1 - u * u));
    const r = 55.0;
    sPos[i * 3 + 0] = r * sq * Math.cos(th);
    sPos[i * 3 + 1] = r * u;
    sPos[i * 3 + 2] = r * sq * Math.sin(th);

    const magPow = Math.pow(rnd(), 4.5);
    sSize[i] = 1.1 + magPow * 2.8;
    const sp = spectralPalette[Math.min(4, Math.floor(Math.pow(rnd(), 1.3) * 5))];
    const lum = 0.22 + magPow * 1.45;
    sCol[i * 3 + 0] = sp[0] * lum;
    sCol[i * 3 + 1] = sp[1] * lum;
    sCol[i * 3 + 2] = sp[2] * lum;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(sPos, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(sSize, 1));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(sCol, 3));
  const starPointsMat = createStarPointsMaterial();
  starPointsMat.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  skyScene.add(new THREE.Points(starGeo, starPointsMat));

  // 2. EARTH GROUP (Surface + Clouds + Rayleigh/Mie Atmosphere + 2026 LEO Satellites + 2032 Orbital Ring & Space Elevators)
  const earthGroup = new THREE.Group();
  const earthSurfaceMat = createEarthSurfaceMaterial({
    dayTex: textures.earthDay,
    nightTex: textures.earthNight,
    normalTex: textures.earthNormal,
    specTex: textures.earthSpec,
    cloudsTex: textures.earthClouds,
  });
  const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH, 192, 96), earthSurfaceMat);
  earthGroup.add(earthMesh);

  const earthCloudsMat = createEarthCloudsMaterial({
    cloudsTex: textures.earthClouds,
    nightTex: textures.earthNight,
  });
  const earthCloudsMesh = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 1.0068, 128, 64), earthCloudsMat);
  earthGroup.add(earthCloudsMesh);

  const earthAtmosMat = createAtmosphereMaterial({
    rayleighColor: new THREE.Color(0.20, 0.52, 1.08),
    sunsetColor: new THREE.Color(1.25, 0.48, 0.16),
    nightRimColor: new THREE.Color(0.025, 0.08, 0.14),
    intensity: 1.35,
    power: 4.0,
  });
  const earthAtmosMesh = new THREE.Mesh(new THREE.SphereGeometry(R_EARTH * 1.034, 128, 64), earthAtmosMat);
  earthGroup.add(earthAtmosMesh);

  const leoSystem = buildLeoSatelliteSystem();
  earthGroup.add(leoSystem.group);

  const orbitalRingSystem = buildOrbitalRingAndElevators(landmarks);
  earthGroup.add(orbitalRingSystem.group);

  scene.add(earthGroup);

  // 3. MOON GROUP (NASA LROC + LOLA Displaced Surface + 2040 Copernicus Rim Lunar Base)
  const moonGroup = new THREE.Group();
  const moonMat = createMoonMaterial({
    colorTex: textures.moonColor,
    dispTex: textures.moonDisp,
    normalTex: textures.moonNormal,
    dispScale: MOON_DISP_SCALE,
  });
  const moonMesh = new THREE.Mesh(new THREE.SphereGeometry(R_MOON, 256, 128), moonMat);
  moonGroup.add(moonMesh);

  const lunarBaseSystem = buildLunarBase(landmarks, MOON_DISP_SCALE, moonMat);
  moonGroup.add(lunarBaseSystem.group);

  scene.add(moonGroup);

  // 4. MARS GROUP (USGS/MOLA Displaced Surface + 2048 Topographic Canyon Cities + 3D Megadomes + Dust Limb)
  const marsGroup = new THREE.Group();
  const marsSurfaceMat = createMarsSurfaceMaterial({
    colorTex: textures.marsColor,
    dispTex: textures.marsDisp,
    normalTex: textures.marsNormal,
    citiesTex: textures.marsCities,
    dispScale: MARS_DISP_SCALE,
  });
  const marsMesh = new THREE.Mesh(new THREE.SphereGeometry(R_MARS, 256, 128), marsSurfaceMat);
  marsGroup.add(marsMesh);

  const marsAtmosMat = createAtmosphereMaterial({
    rayleighColor: new THREE.Color(0.88, 0.48, 0.26), // Martian butterscotch dust day limb
    sunsetColor: new THREE.Color(0.56, 0.76, 1.08),   // Authentic Martian cool blue twilight scatter!
    nightRimColor: new THREE.Color(0.03, 0.02, 0.02),
    intensity: 0.85,
    power: 4.6,
  });
  const marsAtmosMesh = new THREE.Mesh(new THREE.SphereGeometry(R_MARS * 1.028, 128, 64), marsAtmosMat);
  marsGroup.add(marsAtmosMesh);

  const marsCities3D = buildMarsCities3D(landmarks, MARS_DISP_SCALE);
  marsGroup.add(marsCities3D.group);

  scene.add(marsGroup);

  // 5. SUN GROUP (NASA SDO Photosphere + Volumetric Corona + 2056 Dyson Mirror Swarm)
  const sunGroup = new THREE.Group();
  const sunSurfaceMat = createSunSurfaceMaterial({ sunTex: textures.sun });
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(R_SUN, 160, 80), sunSurfaceMat);
  sunGroup.add(sunMesh);

  const sunCoronaMat = createSunCoronaMaterial();
  const sunCoronaMesh = new THREE.Mesh(new THREE.SphereGeometry(38.0, 96, 64), sunCoronaMat);
  sunCoronaMesh.frustumCulled = false;
  sunGroup.add(sunCoronaMesh);

  const dysonSwarm = buildSolarMirrorSwarm();
  sunGroup.add(dysonSwarm.group);

  scene.add(sunGroup);

  // Precompile all shaders so frame 0 has zero hitching!
  renderer.compile(skyScene, camera);
  renderer.compile(scene, camera);

  // Interactive Gimbal Free-Look Offset (yaw, pitch in radians, damped inertia)
  let gimbalYaw = 0.0;
  let gimbalPitch = 0.0;
  let targetGimbalYaw = 0.0;
  let targetGimbalPitch = 0.0;

  // Reusable Three.js vectors
  const tmpSunDirE = new THREE.Vector3();
  const tmpSunDirELocal = new THREE.Vector3();
  const tmpSunDirM = new THREE.Vector3();
  const tmpSunDirMLocal = new THREE.Vector3();
  const tmpEarthDirM = new THREE.Vector3();
  const tmpSunDirMa = new THREE.Vector3();
  const tmpSunDirMaLocal = new THREE.Vector3();

  function updateHud(st) {
    const yFloor = Math.floor(st.year + 1e-6);
    const yFrac = Math.floor((st.year - yFloor) * 10);
    if (elYearInt) elYearInt.textContent = String(yFloor);
    if (elYearFrac) elYearFrac.textContent = `.${Math.max(0, Math.min(9, yFrac))}`;

    if (st.isEarthReturnFlyby) {
      if (elStopIndex) elStopIndex.textContent = 'SLINGSHOT';
      if (elStopTitle) elStopTitle.textContent = 'EARTH GRAVITY-ASSIST FLYBY → INNER HELIOSPHERE';
      if (elStopSub) elStopSub.textContent = '2052 · 掠过赤道行星环地球向太阳俯冲';
      if (elMapCredit) elMapCredit.textContent = 'NASA Blue Marble · SDO Heliosphere';
    } else {
      const s = st.activeStop;
      if (elStopIndex) elStopIndex.textContent = `STOP 0${s.index} / 05`;
      if (elStopTitle) elStopTitle.textContent = s.title;
      if (elStopSub) elStopSub.textContent = s.zhTitle;
      if (elMapCredit) elMapCredit.textContent = s.mapCredit;
    }

    // Physical telemetry formatting
    const d = st.distances;
    let focusName = 'EARTH';
    let surfKm = d.dEarth * 6371.0;
    if (d.dMoon < d.dEarth && d.dMoon < d.dMars && d.dMoon < d.dSun) {
      focusName = 'MOON';
      surfKm = d.dMoon * 6371.0;
    } else if (d.dMars < d.dEarth && d.dMars < d.dSun) {
      focusName = 'MARS';
      surfKm = d.dMars * 6371.0;
    } else if (st.t > 55.2) {
      focusName = 'SOL';
      surfKm = d.dSun * 6371.0;
    }

    if (elTelBody) elTelBody.textContent = focusName;
    if (elTelAlt) {
      elTelAlt.textContent =
        surfKm < 10000
          ? `${Math.max(12, Math.round(surfKm)).toLocaleString('en-US')} km`
          : `${(surfKm / 1e6).toFixed(2)}M km`;
    }
    const helioAu = st.camera.pos.len() / 240.0;
    if (elTelHelio) elTelHelio.textContent = `${helioAu.toFixed(3)} AU`;
    if (elTelFov) elTelFov.textContent = `${st.camera.fov.toFixed(1)}°`;

    if (elTimeReadout) {
      const sec = st.t.toFixed(1).padStart(4, '0');
      elTimeReadout.textContent = `${sec}s / ${FILM_DURATION.toFixed(0)}s`;
    }

    const pct = (st.t / FILM_DURATION) * 100.0;
    if (timelineFill) timelineFill.style.transform = `scaleX(${st.t / FILM_DURATION})`;
    if (timelinePlayhead) timelinePlayhead.style.left = `${pct.toFixed(3)}%`;

    if (stopButtonsContainer) {
      for (const child of stopButtonsContainer.children) {
        child.classList.toggle('active', child.dataset.stopId === st.activeStop.id && !st.isEarthReturnFlyby);
      }
    }
  }

  /**
   * Render exact deterministic frame at film time t in [0, FILM_DURATION].
   * Camera-Centered Floating Origin: camera sits at (0,0,0) in Float32 WebGL space!
   */
  function renderFrameAtTime(t) {
    const st = getShotFrameState(t);
    const camPos = st.camera.pos;
    const cs = st.celestial;

    // Position all bodies relative to camera in Float64 before assigning Float32 .position!
    const eRel = cs.earth.pos.sub(camPos);
    earthGroup.position.set(eRel.x, eRel.y, eRel.z);
    earthGroup.rotation.y = cs.earth.rotY;

    const mRel = cs.moon.pos.sub(camPos);
    moonGroup.position.set(mRel.x, mRel.y, mRel.z);
    moonGroup.rotation.y = cs.moon.rotY;

    const maRel = cs.mars.pos.sub(camPos);
    marsGroup.position.set(maRel.x, maRel.y, maRel.z);
    marsGroup.rotation.y = cs.mars.rotY;

    const sRel = cs.sun.pos.sub(camPos);
    sunGroup.position.set(sRel.x, sRel.y, sRel.z);
    sunMesh.rotation.y = cs.sun.rotY;

    // Update lighting directions (world & body-local)
    const sDirE = cs.sun.pos.sub(cs.earth.pos).normalize();
    tmpSunDirE.set(sDirE.x, sDirE.y, sDirE.z);
    const sDirELoc = sDirE.rotateY(-cs.earth.rotY);
    tmpSunDirELocal.set(sDirELoc.x, sDirELoc.y, sDirELoc.z);

    earthSurfaceMat.uniforms.uSunDir.value.copy(tmpSunDirE);
    earthSurfaceMat.uniforms.uCloudUvShift.value = st.t * 0.00055;
    earthSurfaceMat.uniforms.uNightScale.value = 1.0 + 0.24 * Math.min(1.0, (st.year - 2026) / 26.0);
    earthCloudsMat.uniforms.uSunDir.value.copy(tmpSunDirE);
    earthCloudsMat.uniforms.uCloudUvShift.value = st.t * 0.00055;
    earthAtmosMat.uniforms.uSunDir.value.copy(tmpSunDirE);

    leoSystem.update(st.t, tmpSunDirELocal, eRel.len());
    orbitalRingSystem.update(st.t, st.year, tmpSunDirELocal);

    const sDirM = cs.sun.pos.sub(cs.moon.pos).normalize();
    tmpSunDirM.set(sDirM.x, sDirM.y, sDirM.z);
    const sDirMLoc = sDirM.rotateY(-cs.moon.rotY);
    tmpSunDirMLocal.set(sDirMLoc.x, sDirMLoc.y, sDirMLoc.z);
    const eDirM = cs.earth.pos.sub(cs.moon.pos).normalize();
    tmpEarthDirM.set(eDirM.x, eDirM.y, eDirM.z);

    moonMat.uniforms.uSunDir.value.copy(tmpSunDirM);
    moonMat.uniforms.uEarthDir.value.copy(tmpEarthDirM);
    lunarBaseSystem.update(st.t, tmpSunDirMLocal);

    const sDirMa = cs.sun.pos.sub(cs.mars.pos).normalize();
    tmpSunDirMa.set(sDirMa.x, sDirMa.y, sDirMa.z);
    const sDirMaLoc = sDirMa.rotateY(-cs.mars.rotY);
    tmpSunDirMaLocal.set(sDirMaLoc.x, sDirMaLoc.y, sDirMaLoc.z);

    marsSurfaceMat.uniforms.uSunDir.value.copy(tmpSunDirMa);
    marsSurfaceMat.uniforms.uCityScale.value = Math.min(1.0, Math.max(0.15, (st.year - 2032.0) / 14.0));
    marsAtmosMat.uniforms.uSunDir.value.copy(tmpSunDirMa);
    marsCities3D.update(st.t, tmpSunDirMaLocal);

    sunSurfaceMat.uniforms.uTime.value = st.t;
    sunCoronaMat.uniforms.uTime.value = st.t;
    dysonSwarm.update(st.t, sRel.len());

    // Camera setup at Floating Origin (0, 0, 0) + optional user gimbal look-offset
    camera.position.set(0, 0, 0);
    camera.near = Math.max(0.00035, Math.min(0.05, st.camera.minSurfDist * 0.08));
    camera.far = 1400.0;
    camera.fov = st.camera.fov;
    camera.updateProjectionMatrix();

    camera.up.set(st.camera.up.x, st.camera.up.y, st.camera.up.z);
    camera.lookAt(st.camera.forward.x * 10.0, st.camera.forward.y * 10.0, st.camera.forward.z * 10.0);

    if (Math.abs(gimbalYaw) > 1e-5 || Math.abs(gimbalPitch) > 1e-5) {
      camera.rotateY(gimbalYaw);
      camera.rotateX(gimbalPitch);
    }

    // Adjust exposure smoothly when plunging close to the blazing Sun so solar granulation & mirrors retain crisp detail!
    const sunProx = Math.max(0.0, Math.min(1.0, (55.0 - st.distances.dSun) / 42.0));
    postfx.compositeMat.uniforms.uExposure.value = 1.08 - 0.24 * sunProx;
    postfx.compositeMat.uniforms.uBloomStrength.value = 0.46 + 0.14 * sunProx;

    postfx.render(scene, camera, skyScene, st.t);
    updateHud(st);
    return st;
  }

  // Playback & smooth scrubbing state machine
  let currentTime = 0.0;
  let targetTime = 0.0;
  let isPlaying = !IS_CAPTURE_MODE;
  let isScrubbing = false;
  let lastWallMs = performance.now();

  function setPlayState(play) {
    isPlaying = play;
    if (btnPlay) {
      btnPlay.textContent = isPlaying ? 'PAUSE' : 'PLAY';
      btnPlay.classList.toggle('active', isPlaying);
    }
  }

  buildTimelineMarkers((tJump) => {
    targetTime = tJump;
    if (currentTime >= FILM_DURATION - 0.05 && tJump < FILM_DURATION - 0.1) {
      // keep playing or stay paused naturally
    }
  });

  if (btnPlay) {
    btnPlay.addEventListener('click', () => {
      if (currentTime >= FILM_DURATION - 0.05) {
        currentTime = 0.0;
        targetTime = 0.0;
        setPlayState(true);
      } else {
        setPlayState(!isPlaying);
      }
    });
  }

  if (btnSound) {
    btnSound.addEventListener('click', () => {
      const on = audioEngine.setEnabled(!audioEngine.isEnabled());
      btnSound.textContent = on ? 'AUDIO ON' : 'AUDIO OFF';
      btnSound.classList.toggle('active', on);
    });
  }

  if (btnHud) {
    btnHud.addEventListener('click', () => {
      const minimal = document.documentElement.classList.toggle('minimal-hud');
      btnHud.textContent = minimal ? 'HUD: MIN' : 'HUD: FULL';
    });
  }

  if (btnRecenter) {
    btnRecenter.addEventListener('click', () => {
      targetGimbalYaw = 0.0;
      targetGimbalPitch = 0.0;
      btnRecenter.hidden = true;
    });
  }

  // Precision pointer-captured timeline scrubbing
  if (timelineTrack) {
    const scrubFromEvent = (e) => {
      const rect = timelineTrack.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
      targetTime = frac * FILM_DURATION;
    };
    timelineTrack.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.stop-detent')) return;
      isScrubbing = true;
      timelineTrack.setPointerCapture(e.pointerId);
      scrubFromEvent(e);
    });
    timelineTrack.addEventListener('pointermove', (e) => {
      if (!isScrubbing) return;
      scrubFromEvent(e);
    });
    const endScrub = (e) => {
      if (!isScrubbing) return;
      isScrubbing = false;
      if (timelineTrack.hasPointerCapture(e.pointerId)) {
        timelineTrack.releasePointerCapture(e.pointerId);
      }
    };
    timelineTrack.addEventListener('pointerup', endScrub);
    timelineTrack.addEventListener('pointercancel', endScrub);
  }

  // Smooth 360 gimbal drag on viewport canvas
  let draggingLook = false;
  let lastPtrX = 0;
  let lastPtrY = 0;
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (IS_CAPTURE_MODE) return;
    draggingLook = true;
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;
    renderer.domElement.setPointerCapture(e.pointerId);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!draggingLook) return;
    const dx = e.clientX - lastPtrX;
    const dy = e.clientY - lastPtrY;
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;
    targetGimbalYaw -= dx * 0.0032;
    targetGimbalPitch = Math.max(-1.2, Math.min(1.2, targetGimbalPitch - dy * 0.0032));
    if (btnRecenter) btnRecenter.hidden = false;
  });
  const endLook = (e) => {
    if (!draggingLook) return;
    draggingLook = false;
    if (renderer.domElement.hasPointerCapture(e.pointerId)) {
      renderer.domElement.releasePointerCapture(e.pointerId);
    }
  };
  renderer.domElement.addEventListener('pointerup', endLook);
  renderer.domElement.addEventListener('pointercancel', endLook);

  // Keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
      e.preventDefault();
      btnPlay?.click();
    } else if (e.key === 'h' || e.key === 'H') {
      btnHud?.click();
    } else if (e.key === 'm' || e.key === 'M') {
      btnSound?.click();
    } else if (e.key >= '1' && e.key <= '5') {
      const idx = Number(e.key) - 1;
      if (STOPS[idx]) targetTime = STOPS[idx].tHero;
    } else if (e.key === 'r' || e.key === 'R') {
      currentTime = 0;
      targetTime = 0;
      targetGimbalYaw = 0;
      targetGimbalPitch = 0;
      if (btnRecenter) btnRecenter.hidden = true;
      setPlayState(true);
    }
  });

  window.addEventListener('resize', () => {
    const w = viewportEl.clientWidth;
    const h = Math.max(1, viewportEl.clientHeight);
    renderer.setPixelRatio(IS_CAPTURE_MODE ? 1.0 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const pr = renderer.getPixelRatio();
    starPointsMat.uniforms.uPixelRatio.value = pr;
    postfx.setSize(w * pr, h * pr);
    if (!isPlaying) renderFrameAtTime(currentTime);
  });

  // Hide loading curtain cleanly
  if (loadingOverlay) {
    loadingOverlay.remove();
  }

  // Deterministic capture API for Playwright -> FFmpeg 60fps master video pipeline!
  window.__renderAtTime = (tSec) => {
    isPlaying = false;
    gimbalYaw = 0.0;
    gimbalPitch = 0.0;
    currentTime = tSec;
    targetTime = tSec;
    return renderFrameAtTime(tSec);
  };

  renderFrameAtTime(0.0);

  if (!IS_CAPTURE_MODE) {
    const tick = (nowMs) => {
      const dt = Math.min(0.05, Math.max(0.001, (nowMs - lastWallMs) / 1000.0));
      lastWallMs = nowMs;

      if (isPlaying && !isScrubbing) {
        targetTime = Math.min(FILM_DURATION, targetTime + dt);
        if (targetTime >= FILM_DURATION) {
          setPlayState(false);
        }
      }

      // Critically damped smoothing when scrubbing or jumping to a stop; exact 1:1 tracking in normal playback
      const diff = targetTime - currentTime;
      if (Math.abs(diff) < 0.08 && isPlaying && !isScrubbing) {
        currentTime = targetTime;
      } else {
        currentTime += diff * (1.0 - Math.exp(-dt * 12.0));
      }

      gimbalYaw += (targetGimbalYaw - gimbalYaw) * (1.0 - Math.exp(-dt * 14.0));
      gimbalPitch += (targetGimbalPitch - gimbalPitch) * (1.0 - Math.exp(-dt * 14.0));

      const st = renderFrameAtTime(currentTime);
      audioEngine.update(st, dt, isPlaying);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  worldController = { renderFrameAtTime };
  return true;
})();
