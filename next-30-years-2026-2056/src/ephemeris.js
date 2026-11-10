// Unified Float64 Heliocentric Ephemeris & Unbroken Single-Shot Camera Choreography (2026 -> 2056)
import {
  Vec3d,
  DEG2RAD,
  latLonToLocalVec3d,
  clamp,
  smoothstep5,
  quinticHermiteVec3d,
  evalSmoothKeyframes1D,
  evalMonotonicPCHIP,
} from './math64.js';

export { DEG2RAD };
export const FILM_DURATION = 66.0; // seconds (3,960 frames @ 60fps)
export const FILM_FPS = 60;

// World radii (1.0 unit = Earth radius = 6,371 km)
export const R_EARTH = 1.0;
export const R_MOON = 0.2727;
export const R_MARS = 0.62;
export const R_SUN = 13.2;

export const STOPS = [
  {
    id: '2026',
    index: 1,
    year: 2026,
    tHero: 4.5,
    tStart: 0.0,
    tEnd: 11.2,
    title: 'EARTH AT NIGHT · LEO SATELLITE CLOUD',
    zhTitle: '2026 · 近地夜空与低轨卫星云',
    body: 'EARTH',
    mapCredit: 'NASA VIIRS Black Marble · Blue Marble · ETOPO1',
  },
  {
    id: '2032',
    index: 2,
    year: 2032,
    tHero: 16.5,
    tStart: 11.2,
    tEnd: 23.5,
    title: 'EQUATORIAL ORBITAL RING & SPACE ELEVATORS',
    zhTitle: '2032 · 赤道行星环与八座太空电梯',
    body: 'EARTH',
    mapCredit: 'NASA Blue Marble Next Gen · MODIS Cloud Deck',
  },
  {
    id: '2040',
    index: 3,
    year: 2040,
    tHero: 31.5,
    tStart: 23.5,
    tEnd: 37.2,
    title: 'LUNAR BASE · COPERNICUS CRATER RIM',
    zhTitle: '2040 · 月球哥白尼环形山基地',
    body: 'MOON',
    mapCredit: 'NASA LRO LROC WAC 4K · LOLA 16-bit Laser Altimetry',
  },
  {
    id: '2048',
    index: 4,
    year: 2048,
    tHero: 45.8,
    tStart: 37.2,
    tEnd: 51.4,
    title: 'CITIES ON MARS · VALLES MARINERIS',
    zhTitle: '2048 · 火星水手号峡谷城市群',
    body: 'MARS',
    mapCredit: 'USGS / NASA Viking MDIM2.1 · MGS MOLA Altimetry',
  },
  {
    id: '2056',
    index: 5,
    year: 2056,
    tHero: 62.0,
    tStart: 51.4,
    tEnd: 66.0,
    title: 'SOLAR MIRROR SWARM · INNER HELIOSPHERE',
    zhTitle: '2056 · 掠地回航与环日戴森镜群',
    body: 'SUN',
    mapCredit: 'NASA SDO Photosphere · Tycho/Gaia Celestial Map',
  },
];

// Monotonic Year(t) mapping [0..66s] -> [2026.0..2056.0]
const YEAR_KEYS = [
  { t: 0.0, v: 2026.0 },
  { t: 6.5, v: 2026.85 },
  { t: 12.5, v: 2031.2 },
  { t: 14.8, v: 2032.05 },
  { t: 19.8, v: 2032.88 },
  { t: 26.8, v: 2039.2 },
  { t: 30.2, v: 2040.05 },
  { t: 35.0, v: 2040.9 },
  { t: 41.2, v: 2047.2 },
  { t: 44.5, v: 2048.05 },
  { t: 49.5, v: 2048.95 },
  { t: 53.8, v: 2052.3 }, // High-speed Earth return slingshot
  { t: 59.8, v: 2056.0 },
  { t: 66.0, v: 2056.0 },
];

export function getYearAtTime(t) {
  return evalMonotonicPCHIP(YEAR_KEYS, clamp(t, 0.0, FILM_DURATION));
}

export function getTimeForYear(targetYear) {
  if (targetYear <= 2026.0) return 0.0;
  if (targetYear >= 2056.0) return FILM_DURATION;
  let lo = 0.0;
  let hi = FILM_DURATION;
  for (let i = 0; i < 32; i++) {
    const mid = 0.5 * (lo + hi);
    if (getYearAtTime(mid) < targetYear) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Compute exact Float64 heliocentric body states at film time t in [0, 66].
 */
export function getCelestialState(t) {
  const tc = clamp(t, 0.0, FILM_DURATION);
  const tau = tc / FILM_DURATION;

  // Sun at heliocentric origin
  const sunPos = new Vec3d(0, 0, 0);
  const sunRotY = tc * 0.018;

  // Earth gentle heliocentric progression along r = 240
  const thetaE = 0.09 * tau;
  const rE = 240.0;
  const earthPos = new Vec3d(rE * Math.cos(thetaE), 0.0, rE * Math.sin(thetaE));
  // Axial spin calibrated so:
  // t=0..10s: Europe/Nile/India in deep night (+X), East Asia on glowing sunrise limb (-Z/-X)
  // t=13..21s: Singapore/Halmahera/Pacific Space Elevators straddle sunlit crescent & terminator
  const earthRotY = -0.36 + tc * 0.0085;

  // Moon orbiting Earth at ~17.2 units
  const moonAngle = -0.58 + tc * 0.0022;
  const moonDist = 17.2;
  const moonPos = earthPos.add(
    new Vec3d(
      moonDist * Math.cos(moonAngle),
      1.35 * Math.sin(moonAngle * 0.7 + 0.8),
      moonDist * Math.sin(moonAngle)
    )
  );
  // Calibrated so Copernicus Rim Base (lat 10.87N, lon -19.04W) sits at ~7 deg solar elevation near morning terminator!
  const moonRotY = 2.045 + (tc - 31.5) * 0.0018;

  // Mars at ~425 units outward along sweeping arc
  const thetaM = -0.218 + tau * 0.018;
  const rM = 425.0;
  const marsPos = new Vec3d(rM * Math.cos(thetaM), -4.8, rM * Math.sin(thetaM));
  // Calibrated so Western Valles Marineris is in dramatic rust-gold Martian sunset while Eastern Valles Marineris glows in twilight/night!
  const marsRotY = -0.34 + (tc - 45.5) * 0.0045;

  return {
    t: tc,
    year: getYearAtTime(tc),
    sun: { pos: sunPos, radius: R_SUN, rotY: sunRotY },
    earth: { pos: earthPos, radius: R_EARTH, rotY: earthRotY },
    moon: { pos: moonPos, radius: R_MOON, rotY: moonRotY },
    mars: { pos: marsPos, radius: R_MARS, rotY: marsRotY },
  };
}

/**
 * Helper: convert body-local geographic (latDeg, lonDeg, radius) to heliocentric world Vec3d
 */
export function bodyGeoToWorld(bodyState, latDeg, lonDeg, radius) {
  const local = latLonToLocalVec3d(latDeg, lonDeg, radius);
  return bodyState.pos.add(local.rotateY(bodyState.rotY));
}

// ============================================================================
// PHASE DEFINITIONS FOR UNBROKEN SINGLE-SHOT CAMERA FLIGHT
// Each anchored phase interpolates smoothly in body-spherical coordinates so
// it can NEVER clip inside a planet, and interplanetary transfers connect
// exact boundary (pos, vel, acc) via C2 Quintic Hermite splines!
// ============================================================================

// Phase A [0.0 .. 22.4s]: Earth Night LEO Satellites (2026) -> Climb to Orbital Ring & Space Elevators (2032)
const EARTH_OUTBOUND_LAT = [
  { t: 0.0, v: 31.0 },
  { t: 5.5, v: 23.5 },
  { t: 10.8, v: 8.5 },
  { t: 15.2, v: -5.2 }, // Dip slightly south of equator to view Orbital Ring thickness & trusses in 3D perspective!
  { t: 19.2, v: 7.8 },
  { t: 22.4, v: 11.5 },
];
const EARTH_OUTBOUND_LON = [
  { t: 0.0, v: 8.0 },    // Night over Mediterranean / Sahara / Europe
  { t: 5.5, v: 46.0 },   // Gliding over Nile / Middle East / Arabian Sea under dense LEO constellation
  { t: 10.8, v: 84.0 },  // Crossing glowing India toward Singapore Space Elevator
  { t: 15.2, v: 114.0 }, // Sweeping right past Singapore (104E) & Halmahera (127.8E) Space Elevator Transfer Nodes!
  { t: 19.2, v: 146.0 }, // Wide panoramic view of Ringed Earth crescent + tethers + climbers
  { t: 22.4, v: 168.0 }, // Banking outward toward Moon!
];
const EARTH_OUTBOUND_ALT = [
  { t: 0.0, v: 0.24 },   // Crisp 4K VIIRS night-city & full LEO satellite shell view!
  { t: 5.5, v: 0.26 },   // Gliding through outer LEO constellation shell above night cities
  { t: 10.8, v: 0.42 },  // Climbing toward Equatorial Orbital Ring (r=1.48 -> alt=0.48)
  { t: 15.2, v: 0.62 },  // Detailed architectural pass beside Orbital Ring & Space Elevator hub
  { t: 19.2, v: 1.42 },  // Pulling back to reveal full planetary ring & 8 space elevators
  { t: 22.4, v: 2.35 },  // Trans-lunar departure altitude
];

const EARTH_LOOK_LAT = [
  { t: 0.0, v: 22.0 },
  { t: 5.5, v: 16.0 },
  { t: 10.8, v: 2.0 },
  { t: 15.2, v: 0.0 },
  { t: 19.2, v: 0.0 },
  { t: 22.4, v: 2.0 },
];
const EARTH_LOOK_LON = [
  { t: 0.0, v: 48.0 },
  { t: 5.5, v: 85.0 },
  { t: 10.8, v: 112.0 },
  { t: 15.2, v: 128.0 },
  { t: 19.2, v: 118.0 },
  { t: 22.4, v: 130.0 },
];
const EARTH_LOOK_RAD = [
  { t: 0.0, v: 0.96 },
  { t: 5.5, v: 0.98 },
  { t: 10.8, v: 1.32 },
  { t: 15.2, v: 1.35 },
  { t: 19.2, v: 0.45 }, // Look near Earth center / ring chord for majestic full-planet ring framing
  { t: 22.4, v: 0.25 },
];

function evalEarthOutbound(t) {
  const cs = getCelestialState(t);
  const lat = evalSmoothKeyframes1D(EARTH_OUTBOUND_LAT, t);
  const lon = evalSmoothKeyframes1D(EARTH_OUTBOUND_LON, t);
  const alt = evalSmoothKeyframes1D(EARTH_OUTBOUND_ALT, t);
  const pos = bodyGeoToWorld(cs.earth, lat, lon, R_EARTH + alt);

  const lLat = evalSmoothKeyframes1D(EARTH_LOOK_LAT, t);
  const lLon = evalSmoothKeyframes1D(EARTH_LOOK_LON, t);
  const lRad = evalSmoothKeyframes1D(EARTH_LOOK_RAD, t);
  let target = bodyGeoToWorld(cs.earth, lLat, lLon, lRad);

  const b = smoothstep5((t - 19.8) / 2.6);
  if (t > 19.8) {
    target = target.lerp(cs.moon.pos, b * 0.85);
  }
  return { pos, lookDir: target.sub(pos).normalize() };
}

// Phase B [26.4 .. 36.6s]: Lunar Base on Copernicus North-East Rim (lat=10.870, lon=-19.038, h01=0.5137)
// Moon displacement amplitude in world units: DISP_MOON = 0.0085 (~0.031 R_MOON)
export const MOON_DISP_SCALE = 0.0085;
const BASE_LAT = 10.870;
const BASE_LON = -19.038;
const BASE_R = R_MOON + 0.5137 * MOON_DISP_SCALE;

// Note: With moonRotY ~ +117 deg:
// lon = +22 deg -> Earth-facing sunlit approach flank
// lon = -19.04 deg -> Copernicus Crater Rim Lunar Base (terminator!)
// lon = -62 deg -> Mars-facing departure flank (pointing straight toward Mars!)
const MOON_PASS_LAT = [
  { t: 26.4, v: 18.5 },
  { t: 29.5, v: 15.2 },
  { t: 31.8, v: 13.35 }, // Oblique grazing angle overlooking Copernicus Base + curved lunar horizon + starry sky!
  { t: 34.2, v: 10.2 },
  { t: 36.6, v: 4.5 },
];
const MOON_PASS_LON = [
  { t: 26.4, v: 24.0 },   // Approaching from Earth-facing sunlit side
  { t: 29.5, v: -2.0 },   // Sweeping across sunlit mare toward Copernicus rim
  { t: 31.8, v: -13.2 },  // Grazing side-oblique pass looking across base (-19.04W) toward lunar horizon!
  { t: 34.2, v: -31.5 },  // Gliding over dramatic terminator crater shadows
  { t: 36.6, v: -64.0 },  // Exiting cleanly on Mars-facing flank!
];
const MOON_PASS_ALT = [
  { t: 26.4, v: 0.95 },   // Smooth high cislunar entry
  { t: 29.5, v: 0.075 },  // Dropping toward Copernicus crater rim
  { t: 31.8, v: 0.032 },  // Low oblique spacecraft window view across 2040 Lunar Base & curved limb!
  { t: 34.2, v: 0.075 },  // Climbing across crater terrace
  { t: 36.6, v: 1.05 },   // Smooth cislunar departure toward Mars
];

function evalMoonPass(t) {
  const cs = getCelestialState(t);
  const lat = evalSmoothKeyframes1D(MOON_PASS_LAT, t);
  const lon = evalSmoothKeyframes1D(MOON_PASS_LON, t);
  const alt = evalSmoothKeyframes1D(MOON_PASS_ALT, t);
  const pos = bodyGeoToWorld(cs.moon, lat, lon, BASE_R + alt);

  // Frame Copernicus Rim Lunar Base squarely in center-foreground with curved lunar horizon & starry sky above!
  const baseHorizonWorld = bodyGeoToWorld(cs.moon, BASE_LAT - 0.32, BASE_LON - 1.35, BASE_R + 0.0036);
  const forwardTrack = bodyGeoToWorld(cs.moon, lat - 2.0, lon - 18.0, BASE_R + alt * 0.72);
  const postBaseBlend = smoothstep5(clamp((t - 32.3) / 3.2, 0.0, 1.0));
  let target = baseHorizonWorld.lerp(forwardTrack, postBaseBlend);

  if (t < 28.6) {
    const b = smoothstep5((28.6 - t) / 2.2);
    target = target.lerp(cs.moon.pos, b * 0.35);
  }
  let lookDir = target.sub(pos).normalize();
  if (t > 33.6) {
    const b = smoothstep5((t - 33.6) / 3.0);
    const toMars = cs.mars.pos.sub(pos).normalize();
    lookDir = lookDir.lerp(toMars, b * 0.90).normalize();
  }
  return { pos, lookDir };
}

// Phase C [40.8 .. 51.2s]: Cities on Mars (Prograde approach -> Valles Marineris sunset into glowing Night Cities -> Dawn limb slingshot homeward!)
export const MARS_DISP_SCALE = 0.014;
const MARS_PASS_LAT = [
  { t: 40.8, v: -2.0 },
  { t: 43.4, v: -6.5 },  // Sunlit western Valles Marineris & Tharsis canyon cliffs
  { t: 45.8, v: -11.0 }, // Half-sunlit rusty-ochre canyon walls + half-night glowing Valles Marineris cities!
  { t: 48.6, v: -10.5 }, // Sweeping across night metropolis & dawn horizon
  { t: 51.2, v: 8.0 },   // Rounding Mars northern-dawn limb toward Earth & Sun
];
const MARS_PASS_LON = [
  { t: 40.8, v: -136.0 },
  { t: 43.4, v: -102.0 },
  { t: 45.8, v: -82.0 },  // Straddling the exact Martian twilight terminator looking east into glowing Valles Marineris!
  { t: 48.6, v: -36.0 },
  { t: 51.2, v: 62.0 },
];
const MARS_PASS_ALT = [
  { t: 40.8, v: 1.65 },
  { t: 43.4, v: 0.30 },
  { t: 45.8, v: 0.24 },   // Majestic orbital framing of sunlit canyon cliffs + twilight terminator + night city webs!
  { t: 48.6, v: 0.28 },
  { t: 51.2, v: 1.45 },
];

const MARS_LOOK_LAT = [
  { t: 40.8, v: -8.0 },
  { t: 43.4, v: -9.8 },
  { t: 46.0, v: -12.2 },
  { t: 48.6, v: -9.0 },
  { t: 51.2, v: 2.0 },
];
const MARS_LOOK_LON = [
  { t: 40.8, v: -96.0 },
  { t: 43.4, v: -82.0 },
  { t: 45.8, v: -66.0 },
  { t: 48.6, v: -18.0 },
  { t: 51.2, v: 115.0 },
];

function evalMarsPass(t) {
  const cs = getCelestialState(t);
  const lat = evalSmoothKeyframes1D(MARS_PASS_LAT, t);
  const lon = evalSmoothKeyframes1D(MARS_PASS_LON, t);
  const alt = evalSmoothKeyframes1D(MARS_PASS_ALT, t);
  const pos = bodyGeoToWorld(cs.mars, lat, lon, R_MARS + alt);

  const lLat = evalSmoothKeyframes1D(MARS_LOOK_LAT, t);
  const lLon = evalSmoothKeyframes1D(MARS_LOOK_LON, t);
  const horizonClimb = smoothstep5(clamp((t - 46.8) / 3.2, 0.0, 1.0));
  const lookRadius = R_MARS * 0.62 + (R_MARS * 0.34 + alt * 0.78) * horizonClimb;
  let target = bodyGeoToWorld(cs.mars, lLat, lLon, lookRadius);

  if (t < 42.6) {
    const b = smoothstep5((42.6 - t) / 1.8);
    target = target.lerp(cs.mars.pos, b * 0.65);
  }
  let lookDir = target.sub(pos).normalize();
  if (t > 47.6) {
    const b = smoothstep5((t - 47.6) / 3.6);
    const toEarth = cs.earth.pos.sub(pos).normalize();
    lookDir = lookDir.lerp(toEarth, b * 0.94).normalize();
  }
  return { pos, lookDir };
}

// Phase D [53.2 .. 55.0s]: High-Speed Return Flyby RIGHT PAST Ringed Earth on the way to the Sun!
function evalEarthReturnFlyby(t) {
  const cs = getCelestialState(t);
  const u = (t - 53.2) / 1.8; // [0..1]
  const ox = 9.2 - 17.5 * u;
  const oy = 0.85 - 0.35 * u;
  const oz = -3.45 + 1.55 * u;
  const pos = cs.earth.pos.add(new Vec3d(ox, oy, oz));

  // Frame Ringed Earth prominently in left/center-left foreground while the golden Sun blazes ahead-right!
  const earthFocus = cs.earth.pos.add(new Vec3d(-0.35, -0.05, 0.1));
  const sunFocus = cs.sun.pos;
  const lookBlend = smoothstep5(clamp((t - 53.3) / 2.0, 0.0, 1.0));
  const dirToEarth = earthFocus.sub(pos).normalize();
  const dirToSun = sunFocus.sub(pos).normalize();
  const lookDir = dirToEarth.lerp(dirToSun, 0.18 + 0.78 * lookBlend).normalize();
  return { pos, lookDir };
}

// Phase E [58.0 .. 66.0s]: 2056 — Swarm of Mirrors Circling the Sun (R_SUN = 13.2)
const SUN_SWARM_LAT = [
  { t: 58.0, v: 10.5 },
  { t: 61.5, v: 4.0 },
  { t: 66.0, v: -5.5 },
];
const SUN_SWARM_LON = [
  { t: 58.0, v: 6.0 },   // Arriving from Earth direction (+X -> lon ~ 0)
  { t: 61.5, v: 34.0 },  // Gliding right through dense Keplerian mirror streams!
  { t: 66.0, v: 70.0 },  // Grand sweeping cathedral panorama of the Sun & 36,000 Dyson Mirrors!
];
const SUN_SWARM_RAD = [
  { t: 58.0, v: 39.0 },  // Entering outer heliostat streams
  { t: 62.0, v: 33.2 },  // Framing the full blazing solar sphere + 24 intersecting mirror streams!
  { t: 66.0, v: 35.5 },  // Wide iconic closing tableau of the star & mirror swarm
];

function evalSunSwarm(t) {
  const cs = getCelestialState(t);
  const lat = evalSmoothKeyframes1D(SUN_SWARM_LAT, t);
  const lon = evalSmoothKeyframes1D(SUN_SWARM_LON, t);
  const rad = evalSmoothKeyframes1D(SUN_SWARM_RAD, t);
  const pos = latLonToLocalVec3d(lat, lon, rad);

  // Place the Sun in upper-center / center-right so dark space & mirror streams sit cleanly behind bottom-left 2056 HUD!
  const offsetAim = latLonToLocalVec3d(lat - 5.5, lon + 46.0, R_SUN * 0.48);
  const b = smoothstep5((t - 58.0) / 7.5);
  const target = cs.sun.pos.lerp(offsetAim, 0.25 + 0.35 * b);
  return { pos, lookDir: target.sub(pos).normalize() };
}

/**
 * Sample (p, dp/dt, d2p/dt2) of an evaluator fn(t) -> { pos, lookDir } via central finite differences
 */
function sampleBoundaryJet(evalFn, t, spanDt) {
  const eps = 1e-3;
  const sM = evalFn(t - eps);
  const s0 = evalFn(t);
  const sP = evalFn(t + eps);

  const vPos = sP.pos.sub(sM.pos).scale((0.5 / eps) * spanDt);
  const aPos = sP.pos.add(sM.pos).sub(s0.pos.scale(2.0)).scale((1.0 / (eps * eps)) * spanDt * spanDt);

  const vDir = sP.lookDir.sub(sM.lookDir).scale((0.5 / eps) * spanDt);
  const aDir = sP.lookDir.add(sM.lookDir).sub(s0.lookDir.scale(2.0)).scale((1.0 / (eps * eps)) * spanDt * spanDt);

  return { pos: s0.pos, vPos, aPos, lookDir: s0.lookDir, vDir, aDir };
}

function evalHermiteBridge(fnA, tA, fnB, tB, t) {
  const span = tB - tA;
  const u = clamp((t - tA) / span, 0.0, 1.0);
  const j0 = sampleBoundaryJet(fnA, tA, span);
  const j1 = sampleBoundaryJet(fnB, tB, span);
  const zero = new Vec3d(0, 0, 0);
  return {
    pos: quinticHermiteVec3d(j0.pos, j0.vPos, j0.aPos, j1.pos, j1.vPos, j1.aPos, u),
    lookDir: quinticHermiteVec3d(j0.lookDir, j0.vDir, zero, j1.lookDir, j1.vDir, zero, u).normalize(),
  };
}

// Smooth Cinematic Field-of-View schedule (IMAX 40mm-50mm feel on closeups, wider 56deg for megastructures)
const FOV_KEYS = [
  { t: 0.0, v: 46.0 },
  { t: 6.0, v: 48.0 },
  { t: 16.5, v: 53.0 }, // Wide grandeur for full Planetary Orbital Ring & Space Elevators
  { t: 25.0, v: 44.0 },
  { t: 31.8, v: 42.0 }, // Crisp telephoto Apollo lens over Copernicus Lunar Base
  { t: 39.0, v: 45.0 },
  { t: 46.0, v: 47.0 }, // Sweeping Valles Marineris canyon perspective
  { t: 54.0, v: 52.0 }, // Dynamic wide framing as Ringed Earth whips past!
  { t: 60.0, v: 54.0 }, // Colossal scale for the Sun & 36,000 Dyson Mirrors
  { t: 66.0, v: 56.0 },
];

function evalRawCameraPosTarget(t) {
  const tc = clamp(t, 0.0, FILM_DURATION);
  if (tc <= 22.4) return evalEarthOutbound(tc);
  if (tc < 26.4) return evalHermiteBridge(evalEarthOutbound, 22.4, evalMoonPass, 26.4, tc);
  if (tc <= 36.6) return evalMoonPass(tc);
  if (tc < 40.8) return evalHermiteBridge(evalMoonPass, 36.6, evalMarsPass, 40.8, tc);
  if (tc <= 51.2) return evalMarsPass(tc);
  if (tc < 53.2) return evalHermiteBridge(evalMarsPass, 51.2, evalEarthReturnFlyby, 53.2, tc);
  if (tc <= 55.0) return evalEarthReturnFlyby(tc);
  if (tc < 58.0) return evalHermiteBridge(evalEarthReturnFlyby, 55.0, evalSunSwarm, 58.0, tc);
  return evalSunSwarm(tc);
}

/**
 * Compute complete camera + celestial state at film time t in [0, 66.0].
 * Includes smooth horizon-aligned banking up-vector (zero poles/gimbal flips!).
 */
export function getShotFrameState(t) {
  const tc = clamp(t, 0.0, FILM_DURATION);
  const celestial = getCelestialState(tc);
  const { pos, lookDir } = evalRawCameraPosTarget(tc);
  const forward = lookDir;
  const target = pos.addScaled(forward, 10.0);

  // Compute instantaneous velocity (world units / sec)
  const dt = 0.01;
  const pPrev = evalRawCameraPosTarget(Math.max(0.0, tc - dt)).pos;
  const pNext = evalRawCameraPosTarget(Math.min(FILM_DURATION, tc + dt)).pos;
  const vel = pNext.sub(pPrev).scale(1.0 / (Math.min(FILM_DURATION, tc + dt) - Math.max(0.0, tc - dt) || 0.01));

  // Smooth local-horizon blended Up vector:
  // Blend ecliptic north (0, 1, 0) with local surface radial normal when skimming low over Earth/Moon/Mars
  // so planetary horizons tilt naturally like an orbital spacecraft!
  const worldNorth = new Vec3d(0, 1, 0);
  const earthUp = pos.sub(celestial.earth.pos).normalize();
  const moonUp = pos.sub(celestial.moon.pos).normalize();
  const marsUp = pos.sub(celestial.mars.pos).normalize();

  const wEarth = (1.0 - smoothstep5((tc - 8.0) / 8.0)) * 0.72;
  const wMoon = Math.exp(-Math.pow((tc - 31.8) / 3.4, 2)) * 0.78;
  const wMars = Math.exp(-Math.pow((tc - 46.0) / 3.8, 2)) * 0.65;

  let up = worldNorth
    .scale(1.0)
    .addScaled(earthUp, wEarth)
    .addScaled(moonUp, wMoon)
    .addScaled(marsUp, wMars)
    .normalize();

  // Orthogonalize up against forward view vector to prevent any roll instability
  const right = forward.cross(up).normalize();
  up = right.cross(forward).normalize();

  const fov = evalSmoothKeyframes1D(FOV_KEYS, tc);

  // Determine nearest body & physical telemetry for HUD + dynamic near/far clipping
  const dEarth = pos.distTo(celestial.earth.pos) - R_EARTH;
  const dMoon = pos.distTo(celestial.moon.pos) - R_MOON;
  const dMars = pos.distTo(celestial.mars.pos) - R_MARS;
  const dSun = pos.distTo(celestial.sun.pos) - R_SUN;
  const minSurfDist = Math.max(0.0005, Math.min(dEarth, dMoon, dMars, dSun));

  // Active narrative stop / phase label
  let activeStop = STOPS[0];
  for (const s of STOPS) {
    if (tc >= s.tStart && tc <= s.tEnd) {
      activeStop = s;
      break;
    }
  }
  const isEarthReturnFlyby = tc >= 52.3 && tc <= 55.6;

  return {
    t: tc,
    year: celestial.year,
    celestial,
    camera: {
      pos,
      target,
      forward,
      up,
      fov,
      speedUnitsPerSec: vel.len(),
      minSurfDist,
    },
    distances: { dEarth, dMoon, dMars, dSun },
    activeStop,
    isEarthReturnFlyby,
  };
}
