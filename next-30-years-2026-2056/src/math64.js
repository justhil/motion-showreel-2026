// Precision Float64 vector, spherical mapping, PCHIP monotonic clock, and C2 Quintic Hermite splines.

export const DEG2RAD = Math.PI / 180.0;
export const RAD2DEG = 180.0 / Math.PI;

export class Vec3d {
  constructor(x = 0, y = 0, z = 0) {
    this.x = +x;
    this.y = +y;
    this.z = +z;
  }
  clone() {
    return new Vec3d(this.x, this.y, this.z);
  }
  set(x, y, z) {
    this.x = +x;
    this.y = +y;
    this.z = +z;
    return this;
  }
  add(b) {
    return new Vec3d(this.x + b.x, this.y + b.y, this.z + b.z);
  }
  sub(b) {
    return new Vec3d(this.x - b.x, this.y - b.y, this.z - b.z);
  }
  scale(s) {
    return new Vec3d(this.x * s, this.y * s, this.z * s);
  }
  addScaled(b, s) {
    return new Vec3d(this.x + b.x * s, this.y + b.y * s, this.z + b.z * s);
  }
  dot(b) {
    return this.x * b.x + this.y * b.y + this.z * b.z;
  }
  cross(b) {
    return new Vec3d(
      this.y * b.z - this.z * b.y,
      this.z * b.x - this.x * b.z,
      this.x * b.y - this.y * b.x
    );
  }
  lenSq() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  len() {
    return Math.hypot(this.x, this.y, this.z);
  }
  distTo(b) {
    return Math.hypot(this.x - b.x, this.y - b.y, this.z - b.z);
  }
  normalize() {
    const l = this.len();
    return l > 1e-15 ? new Vec3d(this.x / l, this.y / l, this.z / l) : new Vec3d(0, 1, 0);
  }
  lerp(b, t) {
    return new Vec3d(
      this.x + (b.x - this.x) * t,
      this.y + (b.y - this.y) * t,
      this.z + (b.z - this.z) * t
    );
  }
  rotateY(angleRad) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    // Matches Three.js Object3D.rotation.y: x' = x*cos + z*sin, z' = -x*sin + z*cos
    return new Vec3d(this.x * c + this.z * s, this.y, -this.x * s + this.z * c);
  }
  rotateX(angleRad) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    return new Vec3d(this.x, this.y * c - this.z * s, this.y * s + this.z * c);
  }
  rotateZ(angleRad) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    return new Vec3d(this.x * c - this.y * s, this.x * s + this.y * c, this.z);
  }
}

/**
 * Exact match to Three.js SphereGeometry equirectangular UV mapping:
 * u = (lonDeg + 180) / 360, v = (latDeg + 90) / 180
 * u=0.5 (lon=0) -> (+r, 0, 0)
 * u=0.75 (lon=+90E) -> (0, 0, -r)
 * u=0.25 (lon=-90W) -> (0, 0, +r)
 */
export function latLonToLocalVec3d(latDeg, lonDeg, radius = 1.0) {
  const phi = latDeg * DEG2RAD;
  const lam = lonDeg * DEG2RAD;
  const cp = Math.cos(phi);
  return new Vec3d(
    radius * cp * Math.cos(lam),
    radius * Math.sin(phi),
    -radius * cp * Math.sin(lam)
  );
}

export function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export function smoothstep5(u) {
  const x = clamp(u, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

/**
 * 1D C2 Quintic Hermite interpolation on u in [0, 1].
 * v0, v1 are derivatives with respect to u (i.e. dt * df/dt).
 * a0, a1 are second derivatives with respect to u (i.e. dt^2 * d2f/dt2).
 */
export function quinticHermiteScalar(p0, v0, a0, p1, v1, a1, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const u4 = u2 * u2;
  const u5 = u3 * u2;
  const h0 = 1.0 - 10.0 * u3 + 15.0 * u4 - 6.0 * u5;
  const h1 = u - 6.0 * u3 + 8.0 * u4 - 3.0 * u5;
  const h2 = 0.5 * u2 - 1.5 * u3 + 1.5 * u4 - 0.5 * u5;
  const h3 = 10.0 * u3 - 15.0 * u4 + 6.0 * u5;
  const h4 = -4.0 * u3 + 7.0 * u4 - 3.0 * u5;
  const h5 = 0.5 * u3 - u4 + 0.5 * u5;
  return h0 * p0 + h1 * v0 + h2 * a0 + h3 * p1 + h4 * v1 + h5 * a1;
}

export function quinticHermiteVec3d(p0, v0, a0, p1, v1, a1, u) {
  return new Vec3d(
    quinticHermiteScalar(p0.x, v0.x, a0.x, p1.x, v1.x, a1.x, u),
    quinticHermiteScalar(p0.y, v0.y, a0.y, p1.y, v1.y, a1.y, u),
    quinticHermiteScalar(p0.z, v0.z, a0.z, p1.z, v1.z, a1.z, u)
  );
}

/**
 * C2-smooth multi-keyframe 1D spline with zero overshoot / controlled tangents
 * using Catmull-Rom / PCHIP slopes promoted to Quintic Hermite with zero knot curvature
 * or smooth second-derivative continuity.
 */
export function evalSmoothKeyframes1D(keys, t) {
  // keys: [{ t, v }, ...] sorted by t
  const n = keys.length;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;

  // Compute PCHIP / Fritsch-Carlson / Centripetal tangents
  const secants = new Array(n - 1);
  const h = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = keys[i + 1].t - keys[i].t;
    secants[i] = (keys[i + 1].v - keys[i].v) / h[i];
  }
  const m = new Array(n);
  m[0] = secants[0];
  m[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (secants[i - 1] * secants[i] <= 0) {
      m[i] = 0.0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / secants[i - 1] + w2 / secants[i]);
    }
  }

  let idx = 0;
  while (idx < n - 2 && t > keys[idx + 1].t) idx++;
  const dt = h[idx];
  const u = (t - keys[idx].t) / dt;
  return quinticHermiteScalar(
    keys[idx].v,
    m[idx] * dt,
    0.0,
    keys[idx + 1].v,
    m[idx + 1] * dt,
    0.0,
    u
  );
}

/**
 * Strictly monotonic PCHIP cubic interpolation (for Year(t) so dY/dt > 0 everywhere).
 */
export function evalMonotonicPCHIP(keys, t) {
  const n = keys.length;
  if (t <= keys[0].t) return keys[0].v;
  if (t >= keys[n - 1].t) return keys[n - 1].v;

  const h = new Array(n - 1);
  const d = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = keys[i + 1].t - keys[i].t;
    d[i] = (keys[i + 1].v - keys[i].v) / h[i];
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) {
      m[i] = 0;
    } else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  let idx = 0;
  while (idx < n - 2 && t > keys[idx + 1].t) idx++;
  const dt = h[idx];
  const u = (t - keys[idx].t) / dt;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * keys[idx].v +
    (u3 - 2 * u2 + u) * m[idx] * dt +
    (-2 * u3 + 3 * u2) * keys[idx + 1].v +
    (u3 - u2) * m[idx + 1] * dt
  );
}
