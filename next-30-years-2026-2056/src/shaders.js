import * as THREE from '../assets/vendor/three.module.min.js';

// Shared GLSL 3D value/simplex-style noise for solar magneto-convection & corona streamers
const GLSL_NOISE_3D = /* glsl */ `
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

float noise3d(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(
      mix(hash31(i + vec3(0,0,0)), hash31(i + vec3(1,0,0)), f.x),
      mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x),
      f.y
    ),
    mix(
      mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
      mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x),
      f.y
    ),
    f.z
  );
}

float fbm3d(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  for (int i = 0; i < 5; i++) {
    v += a * noise3d(p);
    p = rot * p * 2.03 + vec3(17.1, 31.7, 11.3);
    a *= 0.5;
  }
  return v;
}
`;

export function createStarSkyMaterial(starsTex) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      tStars: { value: starsTex },
      uExposure: { value: 0.72 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tStars;
      uniform float uExposure;
      varying vec2 vUv;
      void main() {
        vec3 s = texture2D(tStars, vUv).rgb;
        // Convert sRGB to physical linear & deepen vacuum black floor so space is true ink-black, never grey
        vec3 lin = pow(max(s, vec3(0.0)), vec3(2.35)) * uExposure;
        // Subtle warm dust-lane richness in Milky Way core
        lin *= vec3(1.04, 0.99, 0.95);
        gl_FragColor = vec4(lin, 1.0);
      }
    `,
  });
}

export function createStarPointsMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uPixelRatio: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      attribute float aSize;
      attribute vec3 aColor;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        vColor = aColor;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(aSize * uPixelRatio, 1.1, 4.2);
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec3 vColor;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float core = exp(-r2 * 22.0);
        gl_FragColor = vec4(vColor * core, core);
      }
    `,
  });
}

export function createEarthSurfaceMaterial({ dayTex, nightTex, normalTex, specTex, cloudsTex }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tDay: { value: dayTex },
      tNight: { value: nightTex },
      tNormal: { value: normalTex },
      tSpec: { value: specTex },
      tClouds: { value: cloudsTex },
      uSunDir: { value: new THREE.Vector3(-1, 0, 0) },
      uCloudUvShift: { value: 0.0 },
      uNightScale: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;
      varying vec3 vWorldBitangent;

      void main() {
        vUv = uv;
        vec3 objN = normalize(position);
        vec3 objT = length(vec2(position.x, position.z)) > 1e-4
          ? normalize(vec3(position.z, 0.0, -position.x))
          : vec3(1.0, 0.0, 0.0);
        vec3 objB = normalize(cross(objN, objT));

        mat3 m3 = mat3(modelMatrix);
        vWorldNormal = normalize(m3 * objN);
        vWorldTangent = normalize(m3 * objT);
        vWorldBitangent = normalize(m3 * objB);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDay;
      uniform sampler2D tNight;
      uniform sampler2D tNormal;
      uniform sampler2D tSpec;
      uniform sampler2D tClouds;
      uniform vec3 uSunDir;
      uniform float uCloudUvShift;
      uniform float uNightScale;

      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;
      varying vec3 vWorldBitangent;

      void main() {
        vec3 L = normalize(uSunDir);
        vec3 V = normalize(-vWorldPos);
        vec3 geoN = normalize(vWorldNormal);

        vec3 nSample = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
        nSample.xy *= 1.65;
        vec3 N = normalize(
          vWorldTangent * nSample.x +
          vWorldBitangent * nSample.y +
          geoN * nSample.z
        );

        vec3 dayAlbedo = pow(texture2D(tDay, vUv).rgb, vec3(2.2));
        float oceanMask = texture2D(tSpec, vUv).r;
        float cloudCover = texture2D(tClouds, vec2(fract(vUv.x + uCloudUvShift), vUv.y)).r;

        float ndl = dot(N, L);
        float geoNdl = dot(geoN, L);
        float sunLit = smoothstep(-0.06, 0.14, geoNdl);
        float diffuse = max(ndl, 0.0) * (1.0 - cloudCover * 0.45);

        // Warm sunset/sunrise terminator belt
        float twilight = exp(-pow((geoNdl - 0.01) / 0.085, 2.0));
        vec3 sunTint = mix(vec3(1.0, 0.98, 0.94), vec3(1.45, 0.62, 0.28), twilight * 0.72);

        // Ocean Fresnel solar glint
        vec3 H = normalize(L + V);
        float ndh = max(dot(mix(N, geoN, 0.65), H), 0.0);
        float fresnel = pow(1.0 - max(dot(geoN, V), 0.0), 4.0);
        float spec = oceanMask * (1.0 - cloudCover * 0.75) * pow(ndh, 96.0) * (0.38 + 0.9 * fresnel) * sunLit;
        vec3 specCol = vec3(1.35, 1.12, 0.86) * spec;

        // Subtle Rayleigh atmospheric aerial perspective across sunlit continents/oceans
        float rim = 1.0 - max(dot(geoN, V), 0.0);
        vec3 aerial = vec3(0.09, 0.24, 0.58) * pow(rim, 2.6) * smoothstep(-0.12, 0.35, geoNdl);

        // Nocturnal VIIRS Black Marble city lights + subtle upward diffusion into overcast clouds!
        vec3 nightRaw = texture2D(tNight, vUv).rgb;
        vec3 nightSharp = pow(max(nightRaw, vec3(0.0)), vec3(1.85));
        // Warm sodium/tungsten-amber core with crisp white-gold metropolitan centers
        float cityLum = dot(nightSharp, vec3(0.35, 0.45, 0.20));
        vec3 cityColor = mix(
          vec3(1.05, 0.54, 0.18),
          vec3(1.55, 1.28, 0.92),
          smoothstep(0.15, 0.78, cityLum)
        ) * cityLum * 2.55 * uNightScale;

        // Cloud diffusion softens & slightly scatters city glow
        cityColor *= (1.0 - cloudCover * 0.32);
        float nightMask = 1.0 - smoothstep(-0.16, 0.07, geoNdl);

        // Faint nocturnal starlight/airglow on dark oceans & continents so night horizon has real physical form
        vec3 nightAmbient = (dayAlbedo * 0.008 + oceanMask * vec3(0.003, 0.006, 0.012)) * nightMask;
        // Subtle 557.7nm + sodium atmospheric airglow near night limb
        vec3 nightAirglow = vec3(0.015, 0.032, 0.038) * pow(rim, 4.2) * nightMask;

        vec3 color = dayAlbedo * diffuse * sunTint * 1.32 + specCol + aerial + (cityColor + nightAmbient + nightAirglow) * nightMask;
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

export function createEarthCloudsMaterial({ cloudsTex, nightTex }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      tClouds: { value: cloudsTex },
      tNight: { value: nightTex },
      uSunDir: { value: new THREE.Vector3(-1, 0, 0) },
      uCloudUvShift: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normalize(position));
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D tClouds;
      uniform sampler2D tNight;
      uniform vec3 uSunDir;
      uniform float uCloudUvShift;
      varying vec2 vUv;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;

      void main() {
        vec2 cuv = vec2(fract(vUv.x + uCloudUvShift), vUv.y);
        float c = texture2D(tClouds, cuv).r;
        float alpha = smoothstep(0.08, 0.88, c) * 0.86;
        if (alpha < 0.005) discard;

        vec3 N = normalize(vWorldNormal);
        vec3 L = normalize(uSunDir);
        float ndl = dot(N, L);

        float dayFactor = smoothstep(-0.10, 0.22, ndl);
        float sunset = exp(-pow((ndl + 0.01) / 0.09, 2.0));
        vec3 dayCol = mix(vec3(0.98, 0.99, 1.02), vec3(1.35, 0.56, 0.24), sunset * 0.78) * (0.18 + 0.95 * max(ndl + 0.08, 0.0));

        // Night clouds faintly catch city glow from below
        vec3 cityBelow = pow(texture2D(tNight, vUv).rgb, vec3(2.0));
        float cityGlow = dot(cityBelow, vec3(0.4, 0.4, 0.2));
        float nightMask = 1.0 - smoothstep(-0.14, 0.06, ndl);
        vec3 nightCol = vec3(0.95, 0.52, 0.20) * cityGlow * 0.55 + vec3(0.005, 0.009, 0.016);

        vec3 col = mix(nightCol * nightMask, dayCol, dayFactor);
        gl_FragColor = vec4(col, alpha * mix(0.42, 0.92, dayFactor));
      }
    `,
  });
}

export function createAtmosphereMaterial({
  rayleighColor = new THREE.Color(0.18, 0.48, 1.0),
  sunsetColor = new THREE.Color(1.0, 0.42, 0.14),
  nightRimColor = new THREE.Color(0.03, 0.09, 0.16),
  intensity = 1.25,
  power = 4.2,
}) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uSunDir: { value: new THREE.Vector3(-1, 0, 0) },
      uRayleigh: { value: rayleighColor },
      uSunset: { value: sunsetColor },
      uNightRim: { value: nightRimColor },
      uIntensity: { value: intensity },
      uPower: { value: power },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vWorldNormal = normalize(mat3(modelMatrix) * normalize(position));
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uRayleigh;
      uniform vec3 uSunset;
      uniform vec3 uNightRim;
      uniform float uIntensity;
      uniform float uPower;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;

      void main() {
        vec3 V = normalize(-vWorldPos);
        vec3 N = normalize(vWorldNormal);
        vec3 L = normalize(uSunDir);

        // On BackSide sphere, N points outward while V points toward camera: limb grazing where dot(-N, V) is small
        float viewDot = clamp(dot(-N, V), 0.0, 1.0);
        float limb = pow(1.0 - viewDot, uPower);

        float sunAngle = dot(N, L);
        float dayWeight = smoothstep(-0.24, 0.35, sunAngle);
        float twilight = exp(-pow((sunAngle + 0.04) / 0.16, 2.0));
        float forwardMie = pow(max(dot(-V, L), 0.0), 8.0) * 0.45;

        vec3 dayGlow = mix(uRayleigh, uSunset, twilight * 0.65) * (dayWeight + forwardMie * dayWeight);
        vec3 nightGlow = uNightRim * (1.0 - dayWeight) * 0.65;

        vec3 col = (dayGlow + nightGlow) * limb * uIntensity;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createMoonMaterial({ colorTex, dispTex, normalTex, dispScale }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: colorTex },
      tDisp: { value: dispTex },
      tNormal: { value: normalTex },
      uDispScale: { value: dispScale },
      uSunDir: { value: new THREE.Vector3(-1, 0, 0) },
      uEarthDir: { value: new THREE.Vector3(-0.8, 0, 0.5) },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D tDisp;
      uniform float uDispScale;
      varying vec2 vUv;
      varying vec3 vObjPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;
      varying vec3 vWorldBitangent;

      void main() {
        vUv = uv;
        float h = texture2D(tDisp, uv).r;
        vec3 objN = normalize(position);
        vObjPos = objN;
        vec3 displaced = position + objN * (h * uDispScale);

        vec3 objT = length(vec2(position.x, position.z)) > 1e-4
          ? normalize(vec3(position.z, 0.0, -position.x))
          : vec3(1.0, 0.0, 0.0);
        vec3 objB = normalize(cross(objN, objT));

        mat3 m3 = mat3(modelMatrix);
        vWorldNormal = normalize(m3 * objN);
        vWorldTangent = normalize(m3 * objT);
        vWorldBitangent = normalize(m3 * objB);
        vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_NOISE_3D}
      uniform sampler2D tColor;
      uniform sampler2D tNormal;
      uniform vec3 uSunDir;
      uniform vec3 uEarthDir;

      varying vec2 vUv;
      varying vec3 vObjPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;
      varying vec3 vWorldBitangent;

      void main() {
        vec3 L = normalize(uSunDir);
        vec3 V = normalize(-vWorldPos);
        vec3 geoN = normalize(vWorldNormal);

        // Combine 4K LOLA macro normal with procedural sub-km regolith & micro-crater normal detail!
        vec3 nSample = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
        float micro1 = fbm3d(vObjPos * 380.0) - 0.5;
        float micro2 = noise3d(vObjPos * 1450.0) - 0.5;
        vec2 detailSlope = vec2(micro1 * 0.36 + micro2 * 0.22, -micro1 * 0.32 + micro2 * 0.24);
        nSample.xy = nSample.xy * 0.88 + detailSlope;

        vec3 N = normalize(
          vWorldTangent * nSample.x +
          vWorldBitangent * nSample.y +
          geoN * nSample.z
        );

        vec3 albedo = pow(texture2D(tColor, vUv).rgb, vec3(2.1)) * (0.92 + 0.16 * (micro1 + 0.5));
        float ndl = max(dot(N, L), 0.0);
        float ndv = max(dot(N, V), 0.06);
        float geoTerm = smoothstep(-0.06, 0.08, dot(geoN, L));

        // Lommel-Seeliger + Oren-Nayar lunar regolith BRDF
        float lommel = (ndl / (ndl + ndv * 0.62 + 1e-4)) * 1.42;
        float phase = pow(max(dot(L, V), 0.0), 4.0) * 0.15;
        float lit = lommel * (1.0 + phase) * geoTerm;

        // Subtle cool-blue Earthshine on lunar night shadow!
        float earthLight = max(dot(N, normalize(uEarthDir)), 0.0);
        vec3 earthshine = albedo * vec3(0.018, 0.026, 0.042) * earthLight * (1.0 - geoTerm * 0.7);

        vec3 col = albedo * lit * vec3(1.16, 1.13, 1.09) + earthshine + albedo * 0.008;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createMarsSurfaceMaterial({ colorTex, dispTex, normalTex, citiesTex, dispScale }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tColor: { value: colorTex },
      tDisp: { value: dispTex },
      tNormal: { value: normalTex },
      tCities: { value: citiesTex },
      uDispScale: { value: dispScale },
      uSunDir: { value: new THREE.Vector3(-1, 0, 0) },
      uCityScale: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      uniform sampler2D tDisp;
      uniform float uDispScale;
      varying vec2 vUv;
      varying vec3 vObjPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;
      varying vec3 vWorldBitangent;
      varying float vElev;

      void main() {
        vUv = uv;
        float h = texture2D(tDisp, uv).r;
        vElev = h;
        vec3 objN = normalize(position);
        vObjPos = objN;
        vec3 displaced = position + objN * ((h - 0.35) * uDispScale);

        vec3 objT = length(vec2(position.x, position.z)) > 1e-4
          ? normalize(vec3(position.z, 0.0, -position.x))
          : vec3(1.0, 0.0, 0.0);
        vec3 objB = normalize(cross(objN, objT));

        mat3 m3 = mat3(modelMatrix);
        vWorldNormal = normalize(m3 * objN);
        vWorldTangent = normalize(m3 * objT);
        vWorldBitangent = normalize(m3 * objB);
        vWorldPos = (modelMatrix * vec4(displaced, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_NOISE_3D}
      uniform sampler2D tColor;
      uniform sampler2D tNormal;
      uniform sampler2D tCities;
      uniform vec3 uSunDir;
      uniform float uCityScale;

      varying vec2 vUv;
      varying vec3 vObjPos;
      varying vec3 vWorldPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldTangent;
      varying vec3 vWorldBitangent;
      varying float vElev;

      void main() {
        vec3 L = normalize(uSunDir);
        vec3 V = normalize(-vWorldPos);
        vec3 geoN = normalize(vWorldNormal);

        vec3 nSample = texture2D(tNormal, vUv).xyz * 2.0 - 1.0;
        float rockDetail = fbm3d(vObjPos * 320.0) - 0.5;
        nSample.xy = nSample.xy * 1.45 + vec2(rockDetail, -rockDetail) * 0.25;
        vec3 N = normalize(
          vWorldTangent * nSample.x +
          vWorldBitangent * nSample.y +
          geoN * nSample.z
        );

        vec3 albedo = pow(texture2D(tColor, vUv).rgb, vec3(2.15)) * (0.94 + 0.14 * (rockDetail + 0.5));
        vec3 citySample = texture2D(tCities, vUv).rgb; // R=core/rail, G=biodome, B=dome glass mask

        float ndl = max(dot(N, L), 0.0);
        float geoNdl = dot(geoN, L);
        float dayTerm = smoothstep(-0.08, 0.14, geoNdl);

        // Authentic Perseverance/Curiosity twilight: warm butterscotch day, cool slate-blue sunset scatter right on terminator!
        float martianTwilight = exp(-pow((geoNdl - 0.01) / 0.095, 2.0));
        vec3 sunTint = mix(vec3(1.12, 0.95, 0.84), vec3(0.76, 0.88, 1.15), martianTwilight * 0.55);

        // Low-elevation canyon dust haze inside Valles Marineris & Hellas
        float basinDepth = clamp(0.45 - vElev, 0.0, 0.45);
        float rim = 1.0 - max(dot(geoN, V), 0.0);
        vec3 dustHaze = vec3(0.45, 0.24, 0.14) * (basinDepth * 0.30 + pow(rim, 3.0) * 0.26) * smoothstep(-0.12, 0.35, geoNdl);

        // High-resolution procedural street-grid & micro-dome lattice modulating MOLA canyon city mask (zero pixelation!)
        float gridA = abs(sin(vObjPos.x * 1650.0 + vObjPos.z * 420.0));
        float gridB = abs(sin(vObjPos.z * 1650.0 - vObjPos.x * 420.0));
        float gridC = abs(sin(vObjPos.y * 1750.0 + vObjPos.x * 620.0));
        float streetNet = smoothstep(0.82, 0.99, max(gridA, max(gridB, gridC)));
        float blockSparkle = pow(noise3d(vObjPos * 1250.0), 2.4);
        float fineUrban = 0.22 + 0.85 * streetNet + 1.15 * blockSparkle;

        // Sharpen corridor / hub envelope so maglev lines are hairline-crisp & city hubs sparkle like real VIIRS night imagery!
        float urbanEnv = smoothstep(0.46, 0.94, citySample.r);
        float hubCoreEnv = smoothstep(0.68, 0.99, citySample.r);
        float domeEnv = smoothstep(0.48, 0.94, citySample.g);

        // Pressurized geodesic megadome solar specular glint on day/twilight side
        vec3 H = normalize(L + V);
        float domeSpec = smoothstep(0.4, 0.9, citySample.b) * (0.4 + 0.6 * streetNet) * pow(max(dot(N, H), 0.0), 56.0) * dayTerm * 0.95 * uCityScale;

        // 2048 Martian Canyon Cities glowing with crisp filigree detail on night & twilight side!
        float nightMask = 1.0 - smoothstep(-0.16, 0.10, geoNdl);
        float cityVis = mix(0.16, 1.0, nightMask) * uCityScale;
        vec3 warmUrban = vec3(1.32, 0.66, 0.20) * urbanEnv * fineUrban * 0.88;
        vec3 brightHubCore = vec3(1.65, 1.18, 0.72) * hubCoreEnv * (0.35 + 0.95 * blockSparkle) * 0.85;
        vec3 agriDome = vec3(0.42, 0.92, 0.68) * domeEnv * blockSparkle * 0.45;
        vec3 cityEmit = (warmUrban + brightHubCore + agriDome) * cityVis;

        // Subtle upward canyon wall warm bounce light around Martian night cities + starlight terrain visibility!
        vec3 canyonWallBounce = albedo * vec3(0.38, 0.18, 0.07) * pow(citySample.r, 0.75) * nightMask * 0.55;
        vec3 nightAmbient = albedo * vec3(0.016, 0.012, 0.016) * nightMask;

        vec3 col = albedo * ndl * dayTerm * sunTint * 1.38 + dustHaze + vec3(1.25, 1.05, 0.90) * domeSpec + cityEmit + canyonWallBounce + nightAmbient;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createSunSurfaceMaterial({ sunTex }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      tSun: { value: sunTex },
      uTime: { value: 0.0 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vObjPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;
      void main() {
        vUv = uv;
        vObjPos = normalize(position);
        vWorldNormal = normalize(mat3(modelMatrix) * vObjPos);
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_NOISE_3D}
      uniform sampler2D tSun;
      uniform float uTime;
      varying vec2 vUv;
      varying vec3 vObjPos;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPos;

      void main() {
        vec3 V = normalize(-vWorldPos);
        vec3 N = normalize(vWorldNormal);
        float mu = clamp(dot(N, V), 0.0, 1.0);

        // Sample real SDO/SolarSystemScope photosphere map + animated 3D magneto-convection granulation
        vec3 baseMap = pow(texture2D(tSun, vUv).rgb, vec3(1.8));
        float gran1 = fbm3d(vObjPos * 18.0 + vec3(uTime * 0.045, -uTime * 0.03, uTime * 0.02));
        float gran2 = fbm3d(vObjPos * 46.0 - vec3(uTime * 0.08, uTime * 0.05, -uTime * 0.04));
        float plasma = gran1 * 0.65 + gran2 * 0.35;

        // Physical solar limb darkening with rich visible SDO granulation & sunspot contrast (never blown out!)
        float limbDark = 0.28 + 0.72 * pow(mu, 0.62);
        vec3 centerCol = vec3(2.05, 1.44, 0.78);
        vec3 limbCol = vec3(1.18, 0.36, 0.08);
        vec3 tempGrad = mix(limbCol, centerCol, pow(mu, 0.68));

        float mapLum = dot(baseMap, vec3(0.4, 0.4, 0.2));
        float spotFactor = smoothstep(0.10, 0.62, mapLum);
        float convContrast = smoothstep(0.22, 0.78, plasma);
        vec3 photosphere = tempGrad * (0.42 + 0.92 * convContrast) * (0.28 + 0.95 * spotFactor) * limbDark;

        // Chromospheric magnetic flare network right at grazing limb
        float spiculeRim = pow(1.0 - mu, 5.0) * (0.55 + 0.85 * gran2);
        photosphere += vec3(1.95, 0.65, 0.16) * spiculeRim;

        gl_FragColor = vec4(photosphere, 1.0);
      }
    `,
  });
}

export function createSunCoronaMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0.0 },
      uSunRadius: { value: 13.2 },
      uShellRadius: { value: 38.0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorldPos;
      varying vec3 vSunCenter;
      void main() {
        vSunCenter = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${GLSL_NOISE_3D}
      uniform float uTime;
      uniform float uSunRadius;
      uniform float uShellRadius;
      varying vec3 vWorldPos;
      varying vec3 vSunCenter;

      void main() {
        vec3 sunCenter = vSunCenter;
        vec3 rayDir = normalize(vWorldPos);
        float tClosest = max(dot(sunCenter, rayDir), 0.0);

        vec3 closestPt = rayDir * tClosest - sunCenter;
        float impactR = length(closestPt);

        // Occlude rays hitting inside solar disc (surface mesh renders those)
        float rNorm = impactR / uSunRadius;
        if (rNorm < 0.985) discard;

        vec3 radialDir = normalize(closestPt);
        // Streamer rays aligned radially via unit-direction noise
        float streamer = fbm3d(radialDir * 7.5 + vec3(0.0, uTime * 0.035, -uTime * 0.025));
        float fineRay = fbm3d(radialDir * 22.0 - vec3(uTime * 0.05, 0.0, uTime * 0.04));

        // Equatorial helmet streamer belt concentration
        float eqBoost = 1.0 + 0.42 * exp(-pow(radialDir.y / 0.42, 2.0));

        float distAbove = max(rNorm - 0.99, 0.0);
        float innerCorona = exp(-distAbove * 5.8) * (0.75 + 0.65 * streamer);
        float outerStreamers = exp(-distAbove * 1.95) * pow(streamer * 0.7 + fineRay * 0.35, 1.6) * eqBoost * 0.52;

        // Magnetic prominence loops hugging rNorm in [1.0 .. 1.12]
        float promMask = exp(-distAbove * 22.0) * smoothstep(0.58, 0.86, fineRay);

        vec3 col =
          vec3(2.2, 1.35, 0.68) * innerCorona +
          vec3(1.45, 0.78, 0.34) * outerStreamers +
          vec3(2.8, 0.65, 0.22) * promMask * 1.35;

        // Smooth outer shell fade so BackSide boundary is 100% invisible
        float edgeFade = smoothstep(uShellRadius / uSunRadius, 1.08, rNorm);
        gl_FragColor = vec4(col * edgeFade, 1.0);
      }
    `,
  });
}
