import * as THREE from '../assets/vendor/three.module.min.js';

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export function createHdrPostPipeline(renderer, width, height) {
  const fsScene = new THREE.Scene();
  const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quadGeo = new THREE.PlaneGeometry(2, 2);

  function makeRT(w, h, samples = 0) {
    return new THREE.WebGLRenderTarget(Math.max(2, Math.floor(w)), Math.max(2, Math.floor(h)), {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: samples > 0,
      samples,
    });
  }

  let sceneRT = makeRT(width, height, 4);
  let bloomA = makeRT(width * 0.5, height * 0.5, 0);
  let bloomB = makeRT(width * 0.25, height * 0.25, 0);
  let bloomC = makeRT(width * 0.125, height * 0.125, 0);
  let bloomUpB = makeRT(width * 0.25, height * 0.25, 0);
  let bloomUpA = makeRT(width * 0.5, height * 0.5, 0);

  // Soft-knee HDR threshold + 13-tap / 9-tap box-tent downsample
  const brightDownMat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tInput: { value: null },
      uTexel: { value: new THREE.Vector2(1 / width, 1 / height) },
      uThreshold: { value: 0.92 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tInput;
      uniform vec2 uTexel;
      uniform float uThreshold;
      varying vec2 vUv;

      vec3 extractBright(vec3 c) {
        // Clamp extreme single-pixel fireflies while keeping rich solar HDR
        c = min(c, vec3(18.0));
        float br = max(c.r, max(c.g, c.b));
        float knee = uThreshold * 0.55;
        float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
        soft = (soft * soft) / (4.0 * knee + 1e-4);
        float contrib = max(soft, br - uThreshold) / max(br, 1e-4);
        return c * max(contrib, 0.0);
      }

      void main() {
        vec2 o = uTexel;
        vec3 s = extractBright(texture2D(tInput, vUv).rgb) * 0.25;
        s += extractBright(texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb) * 0.1875;
        s += extractBright(texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb) * 0.1875;
        s += extractBright(texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb) * 0.1875;
        s += extractBright(texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb) * 0.1875;
        gl_FragColor = vec4(s, 1.0);
      }
    `,
  });

  const blurDownMat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tInput: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tInput;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec2 o = uTexel * 1.35;
        vec3 c = texture2D(tInput, vUv).rgb * 4.0;
        c += texture2D(tInput, vUv + vec2(-o.x, -o.y)).rgb;
        c += texture2D(tInput, vUv + vec2( o.x, -o.y)).rgb;
        c += texture2D(tInput, vUv + vec2(-o.x,  o.y)).rgb;
        c += texture2D(tInput, vUv + vec2( o.x,  o.y)).rgb;
        gl_FragColor = vec4(c / 8.0, 1.0);
      }
    `,
  });

  const blurUpMat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tLow: { value: null },
      tHigh: { value: null },
      uTexel: { value: new THREE.Vector2(1, 1) },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tLow;
      uniform sampler2D tHigh;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        vec2 o = uTexel * 1.25;
        vec3 s = vec3(0.0);
        s += texture2D(tLow, vUv + vec2(-o.x * 2.0, 0.0)).rgb;
        s += texture2D(tLow, vUv + vec2( o.x * 2.0, 0.0)).rgb;
        s += texture2D(tLow, vUv + vec2(0.0, -o.y * 2.0)).rgb;
        s += texture2D(tLow, vUv + vec2(0.0,  o.y * 2.0)).rgb;
        s += texture2D(tLow, vUv + vec2(-o.x, -o.y)).rgb * 2.0;
        s += texture2D(tLow, vUv + vec2( o.x, -o.y)).rgb * 2.0;
        s += texture2D(tLow, vUv + vec2(-o.x,  o.y)).rgb * 2.0;
        s += texture2D(tLow, vUv + vec2( o.x,  o.y)).rgb * 2.0;
        vec3 combined = texture2D(tHigh, vUv).rgb + (s / 12.0) * 0.85;
        gl_FragColor = vec4(combined, 1.0);
      }
    `,
  });

  const compositeMat = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      tScene: { value: null },
      tBloom: { value: null },
      uBloomStrength: { value: 0.48 },
      uExposure: { value: 1.06 },
      uTime: { value: 0.0 },
    },
    vertexShader: QUAD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D tScene;
      uniform sampler2D tBloom;
      uniform float uBloomStrength;
      uniform float uExposure;
      uniform float uTime;
      varying vec2 vUv;

      // Narkowicz ACES Filmic Tone Mapping
      vec3 acesFilm(vec3 x) {
        float a = 2.51;
        float b = 0.03;
        float c = 2.43;
        float d = 0.59;
        float e = 0.14;
        return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
      }

      void main() {
        vec3 hdr = texture2D(tScene, vUv).rgb + texture2D(tBloom, vUv).rgb * uBloomStrength;
        hdr *= uExposure;

        // Subtle Leica optical lens falloff (gentle 6% peripheral vignette, zero muddying)
        vec2 centered = vUv - vec2(0.5);
        float vig = 1.0 - dot(centered, centered) * 0.22;
        hdr *= vig;

        vec3 mapped = acesFilm(hdr);
        // Linear -> sRGB + tiny 0.4% anti-banding film dither so night sky gradients have zero 8-bit banding in H.264!
        vec3 srgb = pow(max(mapped, vec3(0.0)), vec3(1.0 / 2.2));
        float dither = fract(sin(dot(vUv + fract(uTime * 0.13), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
        srgb += dither * (1.2 / 255.0);

        gl_FragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
      }
    `,
  });

  const quad = new THREE.Mesh(quadGeo, brightDownMat);
  fsScene.add(quad);

  function runPass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  }

  function setSize(w, h) {
    sceneRT.dispose();
    bloomA.dispose();
    bloomB.dispose();
    bloomC.dispose();
    bloomUpB.dispose();
    bloomUpA.dispose();

    sceneRT = makeRT(w, h, 4);
    bloomA = makeRT(w * 0.5, h * 0.5, 0);
    bloomB = makeRT(w * 0.25, h * 0.25, 0);
    bloomC = makeRT(w * 0.125, h * 0.125, 0);
    bloomUpB = makeRT(w * 0.25, h * 0.25, 0);
    bloomUpA = makeRT(w * 0.5, h * 0.5, 0);
  }

  function render(scene, camera, skyScene, t) {
    // 1. Render deep-space Milky Way + stars first, then main 3D scene into 4x MSAA HalfFloat HDR target
    renderer.setRenderTarget(sceneRT);
    renderer.clear(true, true, false);
    if (skyScene) {
      renderer.render(skyScene, camera);
    }
    renderer.render(scene, camera);

    // 2. HDR Bloom pyramid
    brightDownMat.uniforms.tInput.value = sceneRT.texture;
    brightDownMat.uniforms.uTexel.value.set(1.0 / sceneRT.width, 1.0 / sceneRT.height);
    runPass(brightDownMat, bloomA);

    blurDownMat.uniforms.tInput.value = bloomA.texture;
    blurDownMat.uniforms.uTexel.value.set(1.0 / bloomA.width, 1.0 / bloomA.height);
    runPass(blurDownMat, bloomB);

    blurDownMat.uniforms.tInput.value = bloomB.texture;
    blurDownMat.uniforms.uTexel.value.set(1.0 / bloomB.width, 1.0 / bloomB.height);
    runPass(blurDownMat, bloomC);

    blurUpMat.uniforms.tLow.value = bloomC.texture;
    blurUpMat.uniforms.tHigh.value = bloomB.texture;
    blurUpMat.uniforms.uTexel.value.set(1.0 / bloomC.width, 1.0 / bloomC.height);
    runPass(blurUpMat, bloomUpB);

    blurUpMat.uniforms.tLow.value = bloomUpB.texture;
    blurUpMat.uniforms.tHigh.value = bloomA.texture;
    blurUpMat.uniforms.uTexel.value.set(1.0 / bloomUpB.width, 1.0 / bloomUpB.height);
    runPass(blurUpMat, bloomUpA);

    // 3. Final ACES Filmic Composite to screen
    compositeMat.uniforms.tScene.value = sceneRT.texture;
    compositeMat.uniforms.tBloom.value = bloomUpA.texture;
    compositeMat.uniforms.uTime.value = t;
    runPass(compositeMat, null);
  }

  return { render, setSize, compositeMat };
}
