import * as THREE from '../assets/vendor/three.module.min.js';
import { DEG2RAD, R_EARTH, R_MOON, R_MARS, R_SUN } from './ephemeris.js';

function latLonToVec3(latDeg, lonDeg, radius) {
  const phi = latDeg * DEG2RAD;
  const lam = lonDeg * DEG2RAD;
  const cp = Math.cos(phi);
  return new THREE.Vector3(
    radius * cp * Math.cos(lam),
    radius * Math.sin(phi),
    -radius * cp * Math.sin(lam)
  );
}

// Deterministic PRNG (Mulberry32) so every frame & every run is 100% reproducible
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================================
// STOP 1 (2026): LEO SATELLITE CONSTELLATION CLOUD (18,000 GPU Keplerian + 220 3D Close-Pass)
// ============================================================================
export function buildLeoSatelliteSystem() {
  const group = new THREE.Group();
  const rng = makeRng(202601);

  const N = 18000;
  // Orbital shells modeled after real LEO mega-constellations (53 deg, 70 deg, 97.6 SSO, 87.9 polar, 43 deg, 33 deg)
  const shells = [
    { inc: 53.0 * DEG2RAD, rMin: 1.052, rMax: 1.088, weight: 0.38 },
    { inc: 43.0 * DEG2RAD, rMin: 1.048, rMax: 1.078, weight: 0.20 },
    { inc: 70.0 * DEG2RAD, rMin: 1.068, rMax: 1.105, weight: 0.16 },
    { inc: 97.6 * DEG2RAD, rMin: 1.075, rMax: 1.125, weight: 0.14 },
    { inc: 87.9 * DEG2RAD, rMin: 1.115, rMax: 1.175, weight: 0.07 },
    { inc: 33.0 * DEG2RAD, rMin: 1.044, rMax: 1.068, weight: 0.05 },
  ];

  // Each satellite rendered as a crisp velocity-aligned glint ribbon quad (2 triangles) so fast LEO motion has cinematic optical presence!
  const baseGeo = new THREE.PlaneGeometry(1, 1);
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = baseGeo.index;
  instGeo.attributes.position = baseGeo.attributes.position;
  instGeo.attributes.uv = baseGeo.attributes.uv;

  const aOrbitA = new Float32Array(N * 4); // radius, inclination, raan, phase0
  const aOrbitB = new Float32Array(N * 3); // speed, sizeScale, tintSeed

  for (let i = 0; i < N; i++) {
    let pick = rng();
    let sh = shells[0];
    for (const s of shells) {
      if (pick <= s.weight) {
        sh = s;
        break;
      }
      pick -= s.weight;
    }
    const r = sh.rMin + (sh.rMax - sh.rMin) * rng();
    const inc = sh.inc + (rng() - 0.5) * 0.035;
    // Structured orbital planes (72 planes) + slight jitter for authentic Walker-delta constellation lattice!
    const planeIdx = Math.floor(rng() * 72);
    const raan = (planeIdx / 72.0) * Math.PI * 2.0 + (rng() - 0.5) * 0.012;
    const phase0 = rng() * Math.PI * 2.0;
    const speed = 0.085 * Math.pow(1.06 / r, 1.5);

    aOrbitA[i * 4 + 0] = r;
    aOrbitA[i * 4 + 1] = inc;
    aOrbitA[i * 4 + 2] = raan;
    aOrbitA[i * 4 + 3] = phase0;

    aOrbitB[i * 3 + 0] = speed;
    aOrbitB[i * 3 + 1] = 0.65 + rng() * 0.95;
    aOrbitB[i * 3 + 2] = rng();
  }

  instGeo.setAttribute('aOrbitA', new THREE.InstancedBufferAttribute(aOrbitA, 4));
  instGeo.setAttribute('aOrbitB', new THREE.InstancedBufferAttribute(aOrbitB, 3));
  instGeo.instanceCount = N;

  const satMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0.0 },
      uSunDirLocal: { value: new THREE.Vector3(-1, 0, 0) },
      uVisibility: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aOrbitA; // r, inc, raan, phase0
      attribute vec3 aOrbitB; // speed, size, seed
      uniform float uTime;
      uniform vec3 uSunDirLocal;
      uniform float uVisibility;

      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;

      void main() {
        vUv = uv;
        float r = aOrbitA.x;
        float inc = aOrbitA.y;
        float raan = aOrbitA.z;
        float u = aOrbitA.w + uTime * aOrbitB.x;

        float cu = cos(u), su = sin(u);
        float ci = cos(inc), si = sin(inc);
        float cr = cos(raan), sr = sin(raan);

        // Position & tangent velocity in Earth-local space (+Y = North Pole, XZ = Equator)
        vec3 pOrb = vec3(r * cu, r * su * si, -r * su * ci);
        vec3 vOrb = normalize(vec3(-su, cu * si, -cu * ci));

        vec3 pLocal = vec3(pOrb.x * cr + pOrb.z * sr, pOrb.y, -pOrb.x * sr + pOrb.z * cr);
        vec3 vLocal = vec3(vOrb.x * cr + vOrb.z * sr, vOrb.y, -vOrb.x * sr + vOrb.z * cr);

        vec3 wPos = (modelMatrix * vec4(pLocal, 1.0)).xyz;
        vec3 wVel = normalize(mat3(modelMatrix) * vLocal);

        // Distance from camera (camera at 0,0,0)
        float camDist = length(wPos);
        vec3 viewDir = wPos / max(camDist, 1e-5);
        vec3 sideDir = normalize(cross(viewDir, wVel));

        // Check Earth umbral shadow cylinder in Earth-local space!
        float sunProj = dot(pLocal, uSunDirLocal);
        float perpDist = length(pLocal - uSunDirLocal * sunProj);
        float inSun = sunProj > 0.0 ? 1.0 : smoothstep(0.985, 1.035, perpDist);

        // Solar flare glint right near terminator / grazing angle + crisp LEO optical visibility over night side
        float terminatorBoost = exp(-pow((sunProj + 0.14) / 0.48, 2.0));
        float flare = mix(0.42, 1.65 + 1.25 * terminatorBoost, inSun);

        // Crisp visible star-point + subtle orbital motion streak
        float sizeWorld = clamp(camDist * 0.0021, 0.00048, 0.0034) * aOrbitB.y;
        float streakLen = sizeWorld * (1.75 + 1.25 * inSun);

        vec3 worldVertex = wPos + wVel * (position.x * streakLen) + sideDir * (position.y * sizeWorld);

        vec3 sunlitCol = mix(vec3(1.65, 1.32, 0.92), vec3(1.05, 1.32, 1.75), aOrbitB.z * 0.45);
        vec3 umbraCol = mix(vec3(1.45, 0.88, 0.42), vec3(0.88, 1.12, 1.52), aOrbitB.z);
        vColor = mix(umbraCol, sunlitCol, inSun) * flare;

        float distFade = 1.0 - smoothstep(2.8, 9.0, camDist);
        vAlpha = distFade * uVisibility;

        gl_Position = projectionMatrix * viewMatrix * vec4(worldVertex, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vColor;
      varying float vAlpha;
      void main() {
        vec2 d = (vUv - vec2(0.5)) * 2.0;
        float falloff = exp(-(d.x * d.x * 3.8 + d.y * d.y * 6.2));
        if (falloff * vAlpha < 0.004) discard;
        gl_FragColor = vec4(vColor * falloff, falloff * vAlpha);
      }
    `,
  });

  const satMesh = new THREE.Mesh(instGeo, satMat);
  satMesh.frustumCulled = false;
  group.add(satMesh);

  // Subtle gossamer Walker-delta orbital shell filaments so the LEO constellation cage reads unmistakably in 2026!
  const shellLineMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.55, 0.72, 0.98),
    transparent: true,
    opacity: 0.055,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const shellGroup = new THREE.Group();
  for (let p = 0; p < 28; p++) {
    const sh = shells[p % shells.length];
    const r = (sh.rMin + sh.rMax) * 0.5 + (p % 3) * 0.012;
    const g = new THREE.TorusGeometry(r, 0.00045, 4, 160);
    g.rotateX(Math.PI * 0.5);
    const m = new THREE.Mesh(g, shellLineMat);
    const holder = new THREE.Group();
    holder.rotation.y = (p / 28) * Math.PI * 2.0;
    m.rotation.x = sh.inc;
    holder.add(m);
    shellGroup.add(holder);
  }
  group.add(shellGroup);

  function update(t, sunDirLocal, camDistToEarth = 1.0) {
    satMat.uniforms.uTime.value = t;
    satMat.uniforms.uSunDirLocal.value.copy(sunDirLocal);
    shellLineMat.opacity = 0.022 * (1.0 - Math.min(1.0, Math.max(0.0, (camDistToEarth - 1.35) / 1.2)));
  }

  return { group, update };
}

// ============================================================================
// STOP 2 (2032): EQUATORIAL ORBITAL RING & 8 SPACE ELEVATORS
// ============================================================================
export function buildOrbitalRingAndElevators(landmarks) {
  const group = new THREE.Group();
  const RING_R = 1.48;
  const COUNTERWEIGHT_R = 2.06;

  // Custom shader for structural ring & tethers: sunlit titanium specular + Earth umbral shadow + warm amber night beacons!
  const structureMat = new THREE.ShaderMaterial({
    transparent: true,
    uniforms: {
      uSunDirLocal: { value: new THREE.Vector3(-1, 0, 0) },
      uBuild: { value: 1.0 },
      uTime: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vLocalPos = position;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDirLocal;
      uniform float uBuild;
      uniform float uTime;
      varying vec3 vLocalPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;

      void main() {
        // Progressive construction reveal around azimuth during 2026->2031
        float az = fract(atan(vLocalPos.z, vLocalPos.x) / 6.2831853 + 0.5);
        float seg = fract(az * 8.0);
        if (seg > uBuild) discard;

        vec3 N = normalize(vWorldNormal);
        vec3 V = normalize(-vWorldPos);
        // Check Earth shadow cylinder in Earth-local space
        float sunProj = dot(vLocalPos, uSunDirLocal);
        float perpDist = length(vLocalPos - uSunDirLocal * sunProj);
        float inSun = sunProj > 0.0 ? 1.0 : smoothstep(0.98, 1.04, perpDist);

        // Sunlit warm aerospace titanium-ceramic truss + Fresnel solar sheen (calibrated so individual tracks stay crisp!)
        float rim = 1.0 - abs(dot(N, V));
        vec3 dayMetal = vec3(0.86, 0.83, 0.78) * (0.34 + 0.68 * rim) * inSun * 0.92;

        // Running amber/tungsten navigation & maglev track lights along the ring
        float trackWave = smoothstep(0.55, 0.98, sin(az * 360.0 - uTime * 3.5));
        float portGlow = exp(-pow(fract(az * 36.0) - 0.5, 2.0) * 90.0);
        vec3 beacon = vec3(1.55, 0.78, 0.24) * (0.22 + 0.52 * trackWave + 0.78 * portGlow);

        vec3 col = dayMetal + beacon * mix(1.15, 0.48, inSun);
        gl_FragColor = vec4(col, clamp(uBuild * 1.25, 0.0, 1.0));
      }
    `,
  });

  // Inner & outer concentric orbital ring spines in Earth equatorial XZ plane
  const innerRingGeo = new THREE.TorusGeometry(RING_R - 0.011, 0.0032, 14, 512);
  innerRingGeo.rotateX(Math.PI * 0.5);
  const outerRingGeo = new THREE.TorusGeometry(RING_R + 0.011, 0.0036, 14, 512);
  outerRingGeo.rotateX(Math.PI * 0.5);
  const centerTrackGeo = new THREE.TorusGeometry(RING_R, 0.0018, 10, 512);
  centerTrackGeo.rotateX(Math.PI * 0.5);

  group.add(new THREE.Mesh(innerRingGeo, structureMat));
  group.add(new THREE.Mesh(outerRingGeo, structureMat));
  group.add(new THREE.Mesh(centerTrackGeo, structureMat));

  // 180 radial cross-truss struts + 36 Orbital Port Stations around equator
  const strutGeo = new THREE.BoxGeometry(0.028, 0.0022, 0.0026);
  const strutInst = new THREE.InstancedMesh(strutGeo, structureMat, 180);
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 180; i++) {
    const lon = (i / 180) * 360.0 - 180.0;
    const p = latLonToVec3(0, lon, RING_R);
    dummy.position.copy(p);
    dummy.lookAt(0, 0, 0);
    dummy.rotateY(Math.PI * 0.5);
    dummy.updateMatrix();
    strutInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(strutInst);

  // 36 Orbital Docking Nodes + Rotating Habitat Rings
  const hubGeo = new THREE.CylinderGeometry(0.009, 0.009, 0.034, 12);
  const hubInst = new THREE.InstancedMesh(hubGeo, structureMat, 36);
  const solarFinGeo = new THREE.BoxGeometry(0.0012, 0.052, 0.012);
  const finInst = new THREE.InstancedMesh(solarFinGeo, structureMat, 36);
  for (let i = 0; i < 36; i++) {
    const lon = (i / 36) * 360.0 - 180.0;
    const p = latLonToVec3(0, lon, RING_R);
    dummy.position.copy(p);
    dummy.lookAt(0, 0, 0);
    dummy.updateMatrix();
    hubInst.setMatrixAt(i, dummy.matrix);
    finInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(hubInst);
  group.add(finInst);

  // 8 Equatorial Space Elevators (Surface Anchor -> Tether Ribbon -> Ring Transfer Station -> Counterweight!)
  const anchors = landmarks.earth_elevators;
  const tetherLen = COUNTERWEIGHT_R - 1.0005;
  const tetherGeo = new THREE.CylinderGeometry(0.0019, 0.0014, tetherLen, 8, 16);
  // Rotate cylinder (+Y) so lookAt(0,0,0) aligns its axis radially!
  tetherGeo.rotateX(Math.PI * 0.5);

  const anchorRingGeo = new THREE.TorusGeometry(0.014, 0.0022, 10, 32);
  const anchorBeaconMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.1, 1.05, 0.32) });

  const cwGeo = new THREE.OctahedronGeometry(0.015, 1);

  anchors.forEach((a) => {
    const midP = latLonToVec3(a.lat, a.lon, 1.0005 + tetherLen * 0.5);
    const tetherMesh = new THREE.Mesh(tetherGeo, structureMat);
    tetherMesh.position.copy(midP);
    tetherMesh.lookAt(0, 0, 0);
    group.add(tetherMesh);

    // Glowing equatorial marine/coastal anchor port on Earth's surface!
    const surfP = latLonToVec3(a.lat, a.lon, 1.0022);
    const surfRing = new THREE.Mesh(anchorRingGeo, anchorBeaconMat);
    surfRing.position.copy(surfP);
    surfRing.lookAt(0, 0, 0);
    group.add(surfRing);

    // Major Transfer Station at Ring intersection (r = RING_R)
    const xferRing = new THREE.Mesh(new THREE.TorusGeometry(0.022, 0.0032, 12, 36), structureMat);
    xferRing.position.copy(latLonToVec3(a.lat, a.lon, RING_R));
    xferRing.lookAt(0, 0, 0);
    group.add(xferRing);

    // Outer Asteroid/Station Counterweight at r = 2.06
    const cwMesh = new THREE.Mesh(cwGeo, structureMat);
    cwMesh.position.copy(latLonToVec3(a.lat, a.lon, COUNTERWEIGHT_R));
    cwMesh.lookAt(0, 0, 0);
    group.add(cwMesh);
  });

  // 320 Luminous Space-Elevator Climber Pods ascending & descending all 8 tethers
  // + 240 Maglev Shuttles racing around the Orbital Ring!
  const climberCount = 320;
  const shuttleCount = 240;
  const podGeo = new THREE.SphereGeometry(0.0036, 8, 6);
  const podMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(2.4, 1.28, 0.42),
  });
  const climberInst = new THREE.InstancedMesh(podGeo, podMat, climberCount + shuttleCount);
  climberInst.frustumCulled = false;
  group.add(climberInst);

  function update(t, year, sunDirLocal) {
    // Hidden in 2026..2027.7 so Stop 1 is pure LEO satellites; assembles 2027.8 -> 2031.2 and remains 1.0 through 2056!
    const build = Math.min(1.0, Math.max(0.0, (year - 2027.8) / 3.3));
    group.visible = build > 0.005;
    if (!group.visible) return;
    structureMat.uniforms.uBuild.value = build;
    structureMat.uniforms.uTime.value = t;
    structureMat.uniforms.uSunDirLocal.value.copy(sunDirLocal);

    let idx = 0;
    const perTether = Math.floor(climberCount / anchors.length);
    for (let aIdx = 0; aIdx < anchors.length; aIdx++) {
      const a = anchors[aIdx];
      for (let k = 0; k < perTether; k++) {
        const dir = k % 2 === 0 ? 1.0 : -1.0;
        const prog = (((k / perTether) + dir * t * 0.045 + aIdx * 0.13) % 1.0 + 1.0) % 1.0;
        const maxR = 1.01 + (COUNTERWEIGHT_R - 1.02) * Math.min(1.0, build * 1.15);
        const r = 1.01 + prog * (maxR - 1.01);
        const p = latLonToVec3(a.lat, a.lon, r);
        dummy.position.copy(p);
        dummy.scale.setScalar(build > 0.25 ? (0.65 + 0.55 * Math.sin(t * 4.0 + k)) : 0.001);
        dummy.updateMatrix();
        climberInst.setMatrixAt(idx++, dummy.matrix);
      }
    }

    for (let s = 0; s < shuttleCount; s++) {
      const dir = s % 2 === 0 ? 1.0 : -1.0;
      const lon = (((s / shuttleCount) * 360.0 + dir * t * 8.5) % 360.0 + 360.0) % 360.0 - 180.0;
      const rOff = s % 2 === 0 ? RING_R - 0.011 : RING_R + 0.011;
      const p = latLonToVec3(0, lon, rOff);
      dummy.position.copy(p);
      dummy.scale.setScalar(build > 0.7 ? 0.75 : 0.001);
      dummy.updateMatrix();
      climberInst.setMatrixAt(idx++, dummy.matrix);
    }
    climberInst.instanceMatrix.needsUpdate = true;
  }

  return { group, update };
}

// ============================================================================
// STOP 3 (2040): LUNAR BASE ON COPERNICUS CRATER RIM (Real NASA LOLA Terrain!)
// ============================================================================
export function buildLunarBase(landmarks, moonDispScale) {
  const group = new THREE.Group();
  const lb = landmarks.lunar_base;
  const span = lb.patch_span_deg;
  const gn = lb.patch_grid_n;
  const patch = lb.patch_h01;

  // Exact bilinear height lookup on the 41x41 NASA LOLA Copernicus Rim terrain grid
  function sampleBaseRadius(latDeg, lonDeg) {
    const fi = ((lb.lat + span * 0.5 - latDeg) / span) * (gn - 1);
    const fj = ((lonDeg - (lb.lon - span * 0.5)) / span) * (gn - 1);
    const i0 = Math.max(0, Math.min(gn - 2, Math.floor(fi)));
    const j0 = Math.max(0, Math.min(gn - 2, Math.floor(fj)));
    const ty = Math.max(0, Math.min(1, fi - i0));
    const tx = Math.max(0, Math.min(1, fj - j0));
    const h =
      patch[i0][j0] * (1 - tx) * (1 - ty) +
      patch[i0][j0 + 1] * tx * (1 - ty) +
      patch[i0 + 1][j0] * (1 - tx) * ty +
      patch[i0 + 1][j0 + 1] * tx * ty;
    return R_MOON + h * moonDispScale;
  }

  // Materials for 2040 Lunar Base architecture
  const habShellMat = new THREE.ShaderMaterial({
    uniforms: {
      uSunDirLocal: { value: new THREE.Vector3(-1, 0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vLocalNormal;
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vLocalNormal = normalize(mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDirLocal;
      varying vec3 vLocalNormal;
      varying vec2 vUv;
      void main() {
        float ndl = max(dot(normalize(vLocalNormal), normalize(uSunDirLocal)), 0.0);
        // Sintered titanium-regolith shell + warm pressurized viewport band + geodesic ribs!
        float rib = smoothstep(0.92, 0.98, abs(sin(vUv.x * 37.699))) + smoothstep(0.92, 0.98, abs(sin(vUv.y * 18.85)));
        vec3 shell = vec3(0.90, 0.88, 0.84) * (0.14 + 1.15 * ndl) * (1.0 - rib * 0.25);
        float windowBand = smoothstep(0.26, 0.32, vUv.y) * (1.0 - smoothstep(0.48, 0.54, vUv.y));
        float mullions = step(0.24, fract(vUv.x * 20.0));
        vec3 windows = vec3(1.95, 1.08, 0.36) * windowBand * mullions;
        gl_FragColor = vec4(shell + windows, 1.0);
      }
    `,
  });

  const solarWingMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    uniforms: {
      uSunDirLocal: { value: new THREE.Vector3(-1, 0, 0) },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vLocalNormal;
      void main() {
        vUv = uv;
        vLocalNormal = normalize(mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        float cellX = step(0.08, fract(vUv.x * 8.0));
        float cellY = step(0.06, fract(vUv.y * 16.0));
        vec3 panel = mix(vec3(0.18, 0.14, 0.10), vec3(1.38, 1.05, 0.56), cellX * cellY);
        gl_FragColor = vec4(panel, 1.0);
      }
    `,
  });

  const tunnelMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.68, 0.66, 0.64) });
  const beaconAmberMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.32, 0.72, 0.24) });
  const floodCoolMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 1.18, 1.48) });

  const rng = makeRng(204009);
  const dummy = new THREE.Object3D();
  const upRef = new THREE.Vector3(0, 1, 0);

  function orientOnSurface(lat, lon, extraAlt = 0, yaw = 0) {
    const r = sampleBaseRadius(lat, lon) + extraAlt;
    const p = latLonToVec3(lat, lon, r);
    const n = p.clone().normalize();
    dummy.position.copy(p);
    dummy.quaternion.setFromUnitVectors(upRef, n);
    if (yaw !== 0) dummy.rotateY(yaw);
    return p;
  }

  // 1. 48 Pressurized Geodesic & Cylindrical Habitat Domes spread naturally across 7 Copernicus Rim Districts!
  const domeGeo = new THREE.SphereGeometry(0.00082, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.54);
  const domeCount = 48;
  const domeInst = new THREE.InstancedMesh(domeGeo, habShellMat, domeCount);
  domeInst.frustumCulled = false;

  const hubOffsets = [
    [0.0, 0.0, 1.45],
    [0.42, -0.58, 1.22],
    [-0.38, 0.48, 1.18],
    [0.68, 0.34, 1.08],
    [-0.64, -0.45, 1.08],
    [0.18, 0.92, 1.05],
    [-0.16, -1.05, 1.08],
  ];

  const domeCenters = [];
  for (let i = 0; i < domeCount; i++) {
    let dLat, dLon, scale;
    if (i < hubOffsets.length) {
      [dLat, dLon, scale] = hubOffsets[i];
    } else {
      const cluster = hubOffsets[i % hubOffsets.length];
      const ang = rng() * Math.PI * 2;
      const rad = 0.14 + rng() * 0.36;
      dLat = cluster[0] + Math.sin(ang) * rad * 0.85;
      dLon = cluster[1] + Math.cos(ang) * rad;
      scale = 0.42 + rng() * 0.55;
    }
    const p = orientOnSurface(lb.lat + dLat, lb.lon + dLon, -0.00006, rng() * Math.PI);
    domeCenters.push(p);
    dummy.scale.set(scale, scale * 0.72, scale);
    dummy.updateMatrix();
    domeInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(domeInst);

  // Pressurized Inter-Hub Transit Tubes connecting the 7 main district hubs!
  const tubeLinks = [[0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [1, 6], [2, 5], [1, 4], [2, 3]];
  const tunnelGeo = new THREE.CylinderGeometry(0.00015, 0.00015, 1.0, 8);
  tunnelGeo.rotateX(Math.PI * 0.5);
  const tunnelInst = new THREE.InstancedMesh(tunnelGeo, tunnelMat, tubeLinks.length);
  tunnelInst.frustumCulled = false;
  tubeLinks.forEach(([ia, ib], idx) => {
    const pa = domeCenters[ia];
    const pb = domeCenters[ib];
    const mid = pa.clone().add(pb).multiplyScalar(0.5);
    mid.normalize().multiplyScalar((pa.length() + pb.length()) * 0.5 + 0.00012);
    dummy.position.copy(mid);
    dummy.lookAt(pb);
    dummy.scale.set(1, 1, pa.distanceTo(pb));
    dummy.updateMatrix();
    tunnelInst.setMatrixAt(idx, dummy.matrix);
  });
  group.add(tunnelInst);

  // 2. 24 Spaced Vertical Solar-Tracking Array Towers along the high sunlit ridge (clean spacing, zero overlap!)
  const towerCount = 24;
  const towerGeo = new THREE.BoxGeometry(0.00012, 0.0028, 0.00085);
  towerGeo.translate(0, 0.0014, 0);
  const towerInst = new THREE.InstancedMesh(towerGeo, solarWingMat, towerCount);
  towerInst.frustumCulled = false;
  for (let i = 0; i < towerCount; i++) {
    const row = Math.floor(i / 12);
    const frac = ((i % 12) / 11.0) - 0.5;
    const dLat = 0.75 + row * 0.28 + Math.sin(frac * 3.0) * 0.08;
    const dLon = frac * 2.35;
    orientOnSurface(lb.lat + dLat, lb.lon + dLon, 0.0, 0.28);
    dummy.scale.setScalar(0.85 + (i % 3) * 0.14);
    dummy.updateMatrix();
    towerInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(towerInst);

  // 3. Linear Electromagnetic Mass-Driver Launch Track (56 glowing accelerator ring gantries!)
  const gantryCount = 56;
  const gantryGeo = new THREE.TorusGeometry(0.00038, 0.000065, 8, 18);
  const gantryInst = new THREE.InstancedMesh(gantryGeo, beaconAmberMat, gantryCount);
  gantryInst.frustumCulled = false;
  for (let i = 0; i < gantryCount; i++) {
    const u = i / (gantryCount - 1);
    const dLat = -0.55 - u * 0.55;
    const dLon = -1.35 + u * 2.85;
    orientOnSurface(lb.lat + dLat, lb.lon + dLon, 0.00022 + u * u * 0.0012, -0.25);
    dummy.rotateY(Math.PI * 0.5);
    dummy.scale.setScalar(1.0);
    dummy.updateMatrix();
    gantryInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(gantryInst);

  // 4. 6 Spaced Circular Blast-Berm Spaceport Landing Pads
  const padCount = 6;
  const padGeo = new THREE.TorusGeometry(0.00088, 0.000075, 8, 32);
  padGeo.rotateX(Math.PI * 0.5);
  const padInst = new THREE.InstancedMesh(padGeo, beaconAmberMat, padCount);
  padInst.frustumCulled = false;
  for (let i = 0; i < padCount; i++) {
    const row = Math.floor(i / 3);
    const col = (i % 3) - 1;
    const dLat = -0.78 - row * 0.34;
    const dLon = 0.85 + col * 0.42;
    orientOnSurface(lb.lat + dLat, lb.lon + dLon, 0.00008, 0);
    dummy.scale.setScalar(1.0);
    dummy.updateMatrix();
    padInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(padInst);

  // 180 Roadway / Ice-Mine Floodlights & Accelerating Mass-Driver Cargo Sleds
  const lightCount = 180;
  const lightGeo = new THREE.SphereGeometry(0.00026, 8, 6);
  const roadLightInst = new THREE.InstancedMesh(lightGeo, beaconAmberMat, lightCount);
  roadLightInst.frustumCulled = false;
  const mineLightInst = new THREE.InstancedMesh(lightGeo, floodCoolMat, 60);
  mineLightInst.frustumCulled = false;

  for (let i = 0; i < 60; i++) {
    const row = Math.floor(i / 15);
    const col = (i % 15) / 14.0 - 0.5;
    const dLat = -0.58 - row * 0.13;
    const dLon = -0.35 + col * 0.95;
    orientOnSurface(lb.lat + dLat, lb.lon + dLon, 0.00015, 0);
    dummy.scale.setScalar(1.1);
    dummy.updateMatrix();
    mineLightInst.setMatrixAt(i, dummy.matrix);
  }
  group.add(mineLightInst);
  group.add(roadLightInst);

  function update(t, sunDirLocal) {
    habShellMat.uniforms.uSunDirLocal.value.copy(sunDirLocal);
    solarWingMat.uniforms.uSunDirLocal.value.copy(sunDirLocal);

    for (let i = 0; i < 155; i++) {
      const spoke = i % 7;
      const u = (i / 155.0 + (spoke % 2 === 0 ? 1 : -1) * t * 0.014 + spoke * 0.17) % 1.0;
      const frac = (u + 1.0) % 1.0;
      const targetHub = hubOffsets[spoke % hubOffsets.length];
      const dLat = targetHub[0] * (1 - frac) + (-0.52 + (spoke - 3) * 0.12) * frac;
      const dLon = targetHub[1] * (1 - frac) + (0.62 * Math.sin(spoke * 1.3)) * frac;
      orientOnSurface(lb.lat + dLat, lb.lon + dLon, 0.00014, 0);
      dummy.scale.setScalar(0.7 + 0.3 * Math.sin(t * 3.0 + i));
      dummy.updateMatrix();
      roadLightInst.setMatrixAt(i, dummy.matrix);
    }
    for (let s = 0; s < 25; s++) {
      const u = ((t * 0.35 + s * 0.04) % 1.0 + 1.0) % 1.0;
      const accelU = u * u;
      const dLat = -0.32 - accelU * 0.52;
      const dLon = -0.95 + accelU * 2.65;
      orientOnSurface(lb.lat + dLat, lb.lon + dLon, 0.0003 + accelU * accelU * 0.0024, 0);
      dummy.scale.setScalar(1.55);
      dummy.updateMatrix();
      roadLightInst.setMatrixAt(155 + s, dummy.matrix);
    }
    roadLightInst.instanceMatrix.needsUpdate = true;
  }

  return { group, update };
}

// ============================================================================
// STOP 4 (2048): 3D MARTIAN MEGADOMES, CANYON RAIL TRAINS & ORBITAL CYCLERS
// ============================================================================
export function buildMarsCities3D(landmarks, marsDispScale) {
  const group = new THREE.Group();
  const domes = landmarks.mars_domes;
  const corridors = landmarks.mars_corridors;

  // 1. 366 Topographically-Anchored 3D Faceted Geodesic Megadomes in Valles Marineris & Martian Basins!
  const domeGeo = new THREE.IcosahedronGeometry(1.0, 2);
  // Flatten lower hemisphere so only upper geodesic dome rises above canyon floor
  const posAttr = domeGeo.attributes.position;
  for (let i = 0; i < posAttr.count; i++) {
    const y = posAttr.getY(i);
    if (y < 0) posAttr.setY(i, 0);
    else posAttr.setY(i, y * 0.52);
  }
  domeGeo.computeVertexNormals();

  const marsDomeMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSunDirLocal: { value: new THREE.Vector3(-1, 0, 0) },
      uTime: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      attribute float aTier;
      varying vec3 vLocalNormal;
      varying vec3 vObjPos;
      varying float vTier;
      void main() {
        vTier = aTier;
        vObjPos = position;
        vLocalNormal = normalize(mat3(instanceMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDirLocal;
      uniform float uTime;
      varying vec3 vLocalNormal;
      varying vec3 vObjPos;
      varying float vTier;
      void main() {
        float ndl = dot(normalize(vLocalNormal), normalize(uSunDirLocal));
        float dayGlint = pow(max(ndl, 0.0), 4.0) * 0.95;
        float nightGlow = 1.0 - smoothstep(-0.18, 0.25, ndl);

        // Geodesic perimeter ring + warm tungsten/amber interior civic dome light
        float rHoriz = length(vObjPos.xz);
        float ring = smoothstep(0.76, 0.99, rHoriz);
        vec3 warmCore = mix(vec3(1.25, 0.64, 0.22), vec3(0.55, 1.05, 0.78), 0.25 * (1.0 - ring));
        vec3 col = warmCore * (0.18 + 0.55 * ring) * mix(0.25, 0.82, nightGlow) * vTier
                 + vec3(1.10, 0.88, 0.70) * dayGlint * 0.65;
        gl_FragColor = vec4(col, 0.65);
      }
    `,
  });

  const domeInst = new THREE.InstancedMesh(domeGeo, marsDomeMat, domes.length);
  domeInst.frustumCulled = false;
  const aTier = new Float32Array(domes.length);
  const dummy = new THREE.Object3D();
  const upRef = new THREE.Vector3(0, 1, 0);

  for (let i = 0; i < domes.length; i++) {
    const d = domes[i];
    const r = R_MARS + (d.h01 - 0.35) * marsDispScale + 0.00015;
    const p = latLonToVec3(d.lat, d.lon, r);
    dummy.position.copy(p);
    dummy.quaternion.setFromUnitVectors(upRef, p.clone().normalize());
    const s = Math.max(0.0014, Math.min(0.0056, d.r_km * 0.000095));
    dummy.scale.set(s, s, s);
    dummy.updateMatrix();
    domeInst.setMatrixAt(i, dummy.matrix);
    aTier[i] = 0.55 + d.tier * 0.65;
  }
  domeGeo.setAttribute('aTier', new THREE.InstancedBufferAttribute(aTier, 1));
  group.add(domeInst);

  // 2. Express Maglev Trains streaking through MOLA-routed Valles Marineris corridors!
  const trainCount = corridors.length * 10;
  const trainGeo = new THREE.SphereGeometry(0.0012, 8, 6);
  const trainMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 1.18, 0.42) });
  const trainInst = new THREE.InstancedMesh(trainGeo, trainMat, trainCount);
  trainInst.frustumCulled = false;
  group.add(trainInst);

  // 3. 8 Low-Mars-Orbit Tethered Skyhooks / Cycler Stations (realistic compact orbital scale)
  const cyclerCount = 8;
  const cyclerGeo = new THREE.TorusGeometry(0.0015, 0.00024, 8, 24);
  const cyclerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1.65, 1.15, 0.68) });
  const cyclerInst = new THREE.InstancedMesh(cyclerGeo, cyclerMat, cyclerCount);
  cyclerInst.frustumCulled = false;
  group.add(cyclerInst);

  function update(t, sunDirLocal) {
    marsDomeMat.uniforms.uSunDirLocal.value.copy(sunDirLocal);
    marsDomeMat.uniforms.uTime.value = t;

    let tIdx = 0;
    for (let c = 0; c < corridors.length; c++) {
      const pts = corridors[c];
      if (pts.length < 2) continue;
      for (let k = 0; k < 10; k++) {
        const dir = k % 2 === 0 ? 1 : -1;
        const u = (((k / 10.0) + dir * t * 0.055 + c * 0.13) % 1.0 + 1.0) % 1.0;
        const fIdx = u * (pts.length - 1);
        const i0 = Math.min(pts.length - 2, Math.floor(fIdx));
        const frac = fIdx - i0;
        const la = pts[i0][0] + (pts[i0 + 1][0] - pts[i0][0]) * frac;
        const lo = pts[i0][1] + (pts[i0 + 1][1] - pts[i0][1]) * frac;
        const h = pts[i0][2] + (pts[i0 + 1][2] - pts[i0][2]) * frac;
        const r = R_MARS + (h - 0.35) * marsDispScale + 0.00045;
        dummy.position.copy(latLonToVec3(la, lo, r));
        dummy.scale.setScalar(1.0);
        dummy.updateMatrix();
        trainInst.setMatrixAt(tIdx++, dummy.matrix);
      }
    }
    trainInst.instanceMatrix.needsUpdate = true;

    for (let s = 0; s < cyclerCount; s++) {
      const lon = ((s / cyclerCount) * 360.0 + t * 5.2) % 360.0 - 180.0;
      const lat = Math.sin((s * 1.7) + t * 0.2) * 12.0;
      const p = latLonToVec3(lat, lon, R_MARS + 0.105 + (s % 3) * 0.025);
      dummy.position.copy(p);
      dummy.lookAt(0, 0, 0);
      dummy.rotateZ(t * 0.6 + s);
      dummy.updateMatrix();
      cyclerInst.setMatrixAt(s, dummy.matrix);
    }
    cyclerInst.instanceMatrix.needsUpdate = true;
  }

  return { group, update };
}

// ============================================================================
// STOP 5 (2056): DYSON SWARM OF 36,000 HELIOSTAT MIRRORS CIRCLING THE SUN
// ============================================================================
export function buildSolarMirrorSwarm() {
  const group = new THREE.Group();
  const rng = makeRng(205612);

  const MIRROR_COUNT = 36000;
  // Hexagonal thin-film solar-sail reflector!
  const hexGeo = new THREE.CircleGeometry(1.0, 6);
  const instGeo = new THREE.InstancedBufferGeometry();
  instGeo.index = hexGeo.index;
  instGeo.attributes.position = hexGeo.attributes.position;
  instGeo.attributes.uv = hexGeo.attributes.uv;

  // 24 distinct tilted Keplerian orbital streams weaving a 3D Matrioshka/Dyson lattice around the Sun (R_SUN = 13.2)
  const streamCount = 24;
  const streams = [];
  for (let s = 0; s < streamCount; s++) {
    const u = s / streamCount;
    streams.push({
      radius: 17.5 + u * 23.5, // r = 17.5 .. 41.0
      inc: ((s % 2 === 0 ? 1 : -1) * (10.0 + (s * 2.45))) * DEG2RAD,
      raan: (s * 137.508) * DEG2RAD, // Golden-angle node precession -> zero overlapping flat rings!
      ecc: 0.015 + (s % 4) * 0.012,
    });
  }

  // 12 Collector / Laser Power Relay Stations outside the mirror swarm at r = 42.5
  const collectorDirs = [];
  for (let c = 0; c < 12; c++) {
    const phi = Math.acos(1 - 2 * (c + 0.5) / 12);
    const theta = Math.PI * (1 + Math.sqrt(5)) * c;
    collectorDirs.push(
      new THREE.Vector3(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi) * 0.65,
        Math.sin(phi) * Math.sin(theta)
      ).normalize()
    );
  }

  const aMirrorOrbit = new Float32Array(MIRROR_COUNT * 4); // r, inc, raan, phase0
  const aMirrorMeta = new Float32Array(MIRROR_COUNT * 4);  // speed, scale, collectorIdx, seed

  for (let i = 0; i < MIRROR_COUNT; i++) {
    const st = streams[i % streamCount];
    // Clustered ribbon formations along each orbital stream with micro radial/inclination spread
    const r = st.radius + (rng() - 0.5) * 1.15;
    const inc = st.inc + (rng() - 0.5) * 0.028;
    const raan = st.raan + (rng() - 0.5) * 0.022;
    const phase0 = rng() * Math.PI * 2.0;
    const speed = 0.055 * Math.pow(24.0 / r, 1.5);
    const scale = 0.085 + Math.pow(rng(), 2.2) * 0.19; // 0.085 .. 0.275 world units (~540 - 1,750 km megasails!)

    aMirrorOrbit[i * 4 + 0] = r;
    aMirrorOrbit[i * 4 + 1] = inc;
    aMirrorOrbit[i * 4 + 2] = raan;
    aMirrorOrbit[i * 4 + 3] = phase0;

    aMirrorMeta[i * 4 + 0] = speed;
    aMirrorMeta[i * 4 + 1] = scale;
    aMirrorMeta[i * 4 + 2] = i % 12;
    aMirrorMeta[i * 4 + 3] = rng();
  }

  instGeo.setAttribute('aMirrorOrbit', new THREE.InstancedBufferAttribute(aMirrorOrbit, 4));
  instGeo.setAttribute('aMirrorMeta', new THREE.InstancedBufferAttribute(aMirrorMeta, 4));
  instGeo.instanceCount = MIRROR_COUNT;

  const mirrorMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: true,
    uniforms: {
      uTime: { value: 0.0 },
      uCollectorDirs: { value: collectorDirs },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aMirrorOrbit; // r, inc, raan, phase0
      attribute vec4 aMirrorMeta;  // speed, scale, collectorIdx, seed
      uniform float uTime;
      uniform vec3 uCollectorDirs[12];

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vMirrorNormal;
      varying vec3 vSunToMirror;
      varying float vSeed;

      void main() {
        vUv = uv;
        vSeed = aMirrorMeta.w;

        float r = aMirrorOrbit.x;
        float inc = aMirrorOrbit.y;
        float raan = aMirrorOrbit.z;
        float u = aMirrorOrbit.w + uTime * aMirrorMeta.x;

        float cu = cos(u), su = sin(u);
        float ci = cos(inc), si = sin(inc);
        float cr = cos(raan), sr = sin(raan);

        vec3 pOrb = vec3(r * cu, r * su * si, -r * su * ci);
        vec3 pLocal = vec3(pOrb.x * cr + pOrb.z * sr, pOrb.y, -pOrb.x * sr + pOrb.z * cr);

        // True Heliostat Reflection Law: mirror normal bisects vector TO Sun (-normalize(pLocal)) and vector TO Collector!
        int cIdx = int(aMirrorMeta.z + 0.5);
        vec3 collectorPos = uCollectorDirs[0] * 42.5;
        for (int k = 0; k < 12; k++) {
          if (k == cIdx) collectorPos = uCollectorDirs[k] * 42.5;
        }
        vec3 toSun = normalize(-pLocal);
        vec3 toCol = normalize(collectorPos - pLocal);
        // Subtle attitude control oscillation so glints shimmer across the swarm!
        float wobble = sin(uTime * 0.9 + aMirrorMeta.w * 31.4) * 0.14;
        vec3 mNorm = normalize(toSun + toCol * 0.65 + vec3(wobble, -wobble * 0.6, wobble * 0.8));

        vec3 refUp = abs(mNorm.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
        vec3 mTan = normalize(cross(refUp, mNorm));
        vec3 mBit = cross(mNorm, mTan);

        // Natural angular scale: invisible as discrete plates from 1 AU, emerging majestically inside 130 units!
        vec3 centerWorld = (modelMatrix * vec4(pLocal, 1.0)).xyz;
        float distCam = length(centerWorld);
        float nearHelio = smoothstep(155.0, 48.0, distCam);
        float s = aMirrorMeta.y * (0.25 + 0.75 * nearHelio);

        vec3 localVert = pLocal + (mTan * position.x + mBit * position.y) * s;
        vWorldPos = (modelMatrix * vec4(localVert, 1.0)).xyz;
        vMirrorNormal = normalize(mat3(modelMatrix) * mNorm);
        vSunToMirror = normalize(mat3(modelMatrix) * pLocal);

        gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vMirrorNormal;
      varying vec3 vSunToMirror;
      varying float vSeed;

      void main() {
        vec3 V = normalize(-vWorldPos);
        vec3 N = normalize(vMirrorNormal);
        if (dot(N, V) < 0.0) N = -N;

        // Incident sunlight direction at mirror is -vSunToMirror (from Sun center outward is +vSunToMirror)
        vec3 L = normalize(-vSunToMirror);
        vec3 R = reflect(-L, N);

        // Specular solar reflection into camera + broad metallic kapton-gold sheen
        float specSharp = pow(max(dot(R, V), 0.0), 42.0);
        float specBroad = pow(max(dot(R, V), 0.0), 5.5);
        float sunFace = max(dot(N, L), 0.08);

        // Hexagonal gossamer structural frame ribs visible on close-pass mirrors!
        vec2 p = (vUv - vec2(0.5)) * 2.0;
        float rad = length(p);
        float angle = atan(p.y, p.x);
        float spoke = smoothstep(0.05, 0.0, abs(sin(angle * 3.0)));
        float rim = smoothstep(0.82, 0.96, rad);
        float truss = clamp(rim + spoke * 0.45, 0.0, 1.0);

        vec3 foilGold = mix(vec3(1.15, 0.72, 0.26), vec3(1.55, 1.25, 0.82), vSeed * 0.5);
        vec3 col =
          foilGold * (0.28 + 1.45 * specBroad) * sunFace +
          vec3(4.2, 3.1, 1.85) * specSharp +
          vec3(0.55, 0.32, 0.14) * truss * 0.65;

        // Backlit corona transmission rim when mirror silhouettes near solar disc
        float forwardScatter = pow(max(dot(-V, vSunToMirror), 0.0), 6.0);
        col += vec3(1.6, 0.82, 0.24) * rim * forwardScatter * 0.85;

        gl_FragColor = vec4(col, 0.94);
      }
    `,
  });

  const swarmMesh = new THREE.Mesh(instGeo, mirrorMat);
  swarmMesh.frustumCulled = false;
  group.add(swarmMesh);

  // 12 Colossal Collector / Laser Relay Stations + Gossamer Volumetric Solar Energy Beams!
  const nodeGeo = new THREE.IcosahedronGeometry(0.42, 1);
  const nodeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 1.85, 0.82), wireframe: true });

  const beamGeo = new THREE.CylinderGeometry(0.06, 1.85, 18.0, 16, 1, true);
  const beamMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vUv = uv;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vPosW = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vPosW;
      void main() {
        vec3 V = normalize(-vPosW);
        float edge = pow(abs(dot(normalize(vNormalW), V)), 1.8);
        float lenFade = sin(vUv.y * 3.14159265);
        vec3 col = vec3(1.85, 1.12, 0.42) * edge * lenFade * 0.14;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  collectorDirs.forEach((dir) => {
    const pos = dir.clone().multiplyScalar(42.5);
    const node = new THREE.Mesh(nodeGeo, nodeMat);
    node.position.copy(pos);
    group.add(node);

    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.copy(dir.clone().multiplyScalar(33.5));
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(beam);
  });

  // Subtle orbital ring guide filaments so the colossal 3D orbital geometry reads from afar too!
  const ringGuideMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.85, 0.48, 0.18),
    transparent: true,
    opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  for (let s = 0; s < streamCount; s += 2) {
    const st = streams[s];
    const g = new THREE.TorusGeometry(st.radius, 0.022, 6, 192);
    g.rotateX(Math.PI * 0.5);
    const m = new THREE.Mesh(g, ringGuideMat);
    // Apply orbital inclination and RAAN matching the mirror stream!
    const holder = new THREE.Group();
    holder.rotation.y = st.raan;
    m.rotation.x = st.inc;
    holder.add(m);
    group.add(holder);
  }

  function update(t, sunDist = 30.0) {
    mirrorMat.uniforms.uTime.value = t;
    const vis = Math.max(0.0, Math.min(1.0, (165.0 - sunDist) / 95.0));
    group.visible = vis > 0.01;
    ringGuideMat.opacity = 0.14 * vis;
  }

  return { group, update };
}
