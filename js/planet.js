// 行星渲染 —— Three.js
//
// 美术方向：照片级写实。NASA 底图（Solar System Scope，CC BY 4.0）作基底，
// 温度/气压的效果以程序化图层叠加其上——冰盖、荒漠化、海洋蒸干、熔融裂缝
// 各自是一层遮罩。贴图保证质感，程序化图层保证滑块仍然有效。
//
// 网格永不旋转：自转由 UV 偏移实现（贴图 RepeatWrapping，导数连续无接缝）。
// 这样二向箔沿固定世界平面压缩才不会跟着转，光照也能直接用世界系法线。

import * as THREE from 'three';
import { EffectComposer }   from '../vendor/jsm/postprocessing/EffectComposer.js';
import { RenderPass }       from '../vendor/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass }  from '../vendor/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass }       from '../vendor/jsm/postprocessing/OutputPass.js';

/* ── 噪声（仅熔融裂缝还需要） ─────────────────────────── */

const NOISE = `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}

float fbm3(vec3 p){
  float a = 0.5, s = 0.0;
  for(int i = 0; i < 3; i++){ s += a * snoise(p); p = p * 2.03 + 19.7; a *= 0.5; }
  return s;
}
`;

/* ── 顶点形变（二向箔压平 + 引力挤压） ────────────────── */

const DEFORM = `
uniform float uFoilX;    // 二向箔扫掠位置（-1.9 → +1.9）
uniform float uShatter;  // 挤压进度 0 → 1
uniform float uSpread;   // 压平后铺开系数

float flatAmount(vec3 p){
  return smoothstep(uFoilX + 0.30, uFoilX - 0.30, p.x);
}

// 仅压平。云层与大气用这个——它们不碎裂，只随行星摊平/消散。
vec3 flatten(vec3 p, out float outFlat){
  float f = flatAmount(p);
  outFlat = f;
  float spread = smoothstep(0.12, 1.0, f) * uSpread;
  p.xz *= 1.0 + spread * 0.52;
  p.y  *= 1.0 - f * 0.98;   // 残留 2% 厚度，避免正反面 z-fighting
  return p;
}

// 压平 + 碎裂。只有行星本体走这条。
vec3 deform(vec3 p, vec3 cen, vec3 dir, vec3 axis, float rnd, out float outFlat){
  p = flatten(p, outFlat);

  if(uShatter > 0.0){
    float s = uShatter;
    float implode = smoothstep(0.0, 0.16, s) * (1.0 - smoothstep(0.16, 0.30, s));
    p *= 1.0 - implode * 0.24;

    float burst = smoothstep(0.20, 1.0, s);
    if(burst > 0.0){
      vec3 local = (p - cen) * (1.0 - burst * 0.40);
      // 绕独立随机轴翻滚。若沿用飞散方向，碎片只会绕飞行轴自旋、
      // 始终正对镜头，看起来是一地彩纸屑。
      float ang = burst * (rnd * 2.0 - 1.0) * 16.0;
      float c = cos(ang), si = sin(ang);
      local = local * c + cross(axis, local) * si + axis * dot(axis, local) * (1.0 - c);
      // 速度离散：rnd 的三次方拉开长尾，少数碎片冲得远，多数留在近处
      float speed = 0.35 + rnd * rnd * rnd * 4.6;
      p = cen + local + dir * burst * speed;
    }
  }
  return p;
}
`;

/* ── 行星本体 ────────────────────────────────────────── */

const PLANET_VERT = `
attribute vec3 aCentroid;
attribute vec3 aDir;
attribute vec3 aAxis;
attribute float aRnd;

varying vec2 vUv;
varying vec3 vSurf;
varying float vFlat;

${DEFORM}

void main(){
  vUv   = uv;
  vSurf = normalize(position);   // 未形变方向：碎裂时贴图不随碎片滑移

  float f;
  vec3 p = deform(position, aCentroid, aDir, aAxis, aRnd, f);
  vFlat = f;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const PLANET_FRAG = `
precision highp float;

uniform sampler2D uDay;      // NASA 日面色图
uniform sampler2D uNight;    // NASA 夜间灯光
uniform sampler2D uSpec;     // 水体遮罩（白 = 水）
uniform sampler2D uCloudTex; // 用于地表云影

uniform float uTemp;         // K
uniform float uPop;          // 0..1
uniform float uSpinUV;       // 自转 = UV 横向偏移
uniform float uShatter;
uniform float uCover;        // 云量
uniform vec3  uLightDir;

varying vec2 vUv;
varying vec3 vSurf;
varying float vFlat;

${NOISE}

void main(){
  vec2 uv = vec2(vUv.x + uSpinUV, vUv.y);   // RepeatWrapping 负责环绕
  vec3 n0 = normalize(vSurf);
  float lat = abs(n0.y);
  float T = uTemp;

  vec3  base  = texture2D(uDay, uv).rgb;
  float water = texture2D(uSpec, uv).r;

  // ── 冰盖：低温时从两极推进。水面结整片冰，陆地积雪。
  float freeze  = smoothstep(296.0, 214.0, T);
  float iceLine = mix(1.16, -0.12, freeze);
  float ice     = smoothstep(iceLine - 0.13, iceLine + 0.02, lat) * freeze;
  // 冰的反照率保持在 bloom 阈值（1.10）之下，否则整颗雪球一起溢出成白板。
  vec3  iceCol  = mix(vec3(0.640,0.672,0.706), vec3(0.706,0.740,0.782), water);
  // 底图的明暗透一点上来，山脉和冰裂在雪原下仍可辨认
  float relief  = dot(base, vec3(0.299, 0.587, 0.114));
  iceCol *= 0.86 + relief * 0.42;
  base = mix(base, iceCol, ice * 0.94);

  // ── 荒漠化：靠绿通道占优识别植被，升温后褪成沙色
  float veg  = clamp((base.g - (base.r + base.b) * 0.5) * 4.2, 0.0, 1.0);
  float arid = smoothstep(292.0, 402.0, T);
  base = mix(base, vec3(0.560, 0.452, 0.298), arid * veg * (1.0 - water) * 0.92);

  // ── 海洋蒸干，露出海床
  float boil = smoothstep(368.0, 452.0, T);
  base = mix(base, vec3(0.132, 0.114, 0.098), water * boil);

  // ── 熔融：程序化岩浆裂缝
  float melt   = smoothstep(620.0, 900.0, T);
  float ridge  = 1.0 - abs(fbm3(n0 * 3.1)) * 1.7;
  float cracks = pow(clamp(ridge, 0.0, 1.0), 6.0);
  vec3  magma  = mix(vec3(0.120,0.024,0.010), vec3(1.000,0.398,0.098), cracks);
  base = mix(base, magma * 0.30, melt);
  vec3 emissive = magma * cracks * melt * 3.2;      // >1 交给 bloom

  float wet = water * (1.0 - boil) * (1.0 - ice);   // 当前仍是液态水的部分

  // ── 光照。网格不转，所以世界系法线可直接对太阳。
  vec3 L = normalize(uLightDir);
  float ndl = dot(n0, L);
  float day = smoothstep(-0.06, 0.14, ndl);

  // 云影：沿光方向在 UV 上略偏移采样同一张云图
  float cShadow = texture2D(uCloudTex, vec2(uv.x + 0.008, uv.y - 0.004)).r;
  day *= 1.0 - smoothstep(0.30, 0.82, cShadow) * uCover * 0.42;

  // 终结线染色：掠射的光穿过更厚的大气，偏红
  vec3 warm = mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.60, 0.34),
                  smoothstep(0.38, 0.0, ndl) * smoothstep(-0.14, 0.10, ndl));

  vec3 lit = base * day * warm * 1.22;
  lit += base * vec3(0.034, 0.044, 0.066) * (1.0 - day);   // 夜面天光，别压死成纯黑

  // ── 海洋太阳反射点
  vec3 V = normalize(cameraPosition - vSurf);
  vec3 H = normalize(L + V);
  float spec = pow(max(dot(n0, H), 0.0), 1100.0) * wet * smoothstep(-0.02, 0.16, ndl);
  lit += vec3(1.0, 0.95, 0.86) * spec * 1.9;               // >1 交给 bloom

  // ── 城市灯火：NASA 夜间灯光原图
  vec3 night = texture2D(uNight, uv).rgb;
  lit += night * pow(1.0 - day, 1.5) * uPop * 2.3 * (1.0 - ice * 0.85);

  lit += emissive;

  // ── 二向箔：光照塌缩为无光，色彩信息一并流失——它变成一张画
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  vec3 flatLit = mix(base, vec3(lum), 0.26) * 1.42 + emissive * 0.55;
  lit = mix(lit, flatLit, vFlat);

  // ── 引力挤压：碎片带着塌缩余温，挂在分离度上而非总进度
  if(uShatter > 0.0){
    float burst = smoothstep(0.20, 1.0, uShatter);
    float heat  = smoothstep(0.02, 0.26, burst) * (1.0 - smoothstep(0.32, 0.92, burst));
    float grain = fbm3(n0 * 7.0) * 0.5 + 0.5;
    lit += vec3(1.0, 0.42, 0.14) * heat * (0.42 + 0.78 * grain) * 1.55;
    lit *= 1.0 - smoothstep(0.0, 0.18, uShatter) * 0.35;
    lit *= 1.0 - smoothstep(0.30, 0.95, burst) * 0.55;
  }

  gl_FragColor = vec4(lit, 1.0);
}
`;

/* ── 大气 ────────────────────────────────────────────── */

const ATMO_VERT = `
varying vec3 vWorld;
void main(){
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}

`;

const ATMO_FRAG = `
precision highp float;

// 解析式单次散射。不靠网格形状表现大气：对每条视线求它实际穿过
// 大气层的弦长并沿途积分，密度随高度指数衰减，因此到外缘自然归零，
// 不存在可见的边界。之前用球壳 + fresnel，球壳的几何外边界就是
// 那层「膜」的来源。
uniform vec3  uLightDir;
uniform float uDensity;   // 气压驱动
uniform float uFade;      // 二向箔/挤压时整体淡出
uniform vec3  uTint;      // 温度驱动的偏色

varying vec3 vWorld;

const float Rp = 1.00;    // 行星半径
const float Ra = 1.14;    // 大气外缘（真实约 1.016，此处夸张以便可见）
const float H  = 4.2;     // 标高倒数：越大衰减越快

// 射线与球求交。无交点时返回一个空区间。
vec2 raySphere(vec3 ro, vec3 rd, float R){
  float b = dot(ro, rd);
  float c = dot(ro, ro) - R * R;
  float d = b * b - c;
  if(d < 0.0) return vec2(1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

void main(){
  vec3 ro = cameraPosition;
  vec3 rd = normalize(vWorld - cameraPosition);

  vec2 atm = raySphere(ro, rd, Ra);
  if(atm.y <= 0.0 || atm.x >= atm.y) discard;

  float t0 = max(atm.x, 0.0);
  float t1 = atm.y;

  // 视线若打到行星本体，积分到那里为止——行星背后的大气看不见
  vec2 pl = raySphere(ro, rd, Rp);
  if(pl.x < pl.y && pl.y > 0.0) t1 = min(t1, max(pl.x, 0.0));
  if(t1 <= t0) discard;

  vec3 L = normalize(uLightDir);
  // 逐像素抖动起点。等距采样在这种薄壳积分上会留下肉眼可见的同心条纹。
  float jit = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  const int STEPS = 12;
  float seg = (t1 - t0) / float(STEPS);

  vec3 acc = vec3(0.0);

  for(int i = 0; i < STEPS; i++){
    vec3 p = ro + rd * (t0 + (float(i) + jit) * seg);
    float h = clamp((length(p) - Rp) / (Ra - Rp), 0.0, 1.0);
    float dens = exp(-h * H) * seg;

    // 该采样点是否被行星挡住阳光（决定晨昏线的位置）
    vec2 toSun = raySphere(p, L, Rp);
    float lit = (toSun.x < toSun.y && toSun.y > 0.0) ? 0.0 : 1.0;

    // 阳光到达该点前穿过的大气厚度。越厚，蓝光被散射掉得越多，
    // 剩下的就越红——日落的颜色由此自然产生，不需要手调。
    vec2 sunExit = raySphere(p, L, Ra);
    float sunDepth = exp(-h * H) * max(sunExit.y, 0.0) * 1.20;
    vec3 sunCol = exp(-sunDepth * vec3(0.40, 1.00, 2.30));

    acc += dens * lit * sunCol;
  }

  // 瑞利散射强度按 1/λ⁴，蓝端最强
  vec3 rayleigh = vec3(0.30, 0.54, 1.00) * uTint;
  vec3 col = acc * rayleigh * 3.4 * uDensity;

  gl_FragColor = vec4(col * uFade, 1.0);
}

`;

/* ── 云层 ────────────────────────────────────────────── */

const CLOUD_VERT = `
varying vec2 vUv;
varying vec3 vSurf;
varying float vFlat;

${DEFORM}

void main(){
  vUv   = uv;
  vSurf = normalize(position);
  float f;
  vec3 p = flatten(position, f);
  vFlat = f;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const CLOUD_FRAG = `
precision highp float;
uniform sampler2D uCloudTex;
uniform float uShatter;
uniform float uSpinUV;
uniform float uCover;
uniform float uTint;
uniform vec3  uLightDir;
varying vec2 vUv;
varying vec3 vSurf;
varying float vFlat;

void main(){
  vec2 uv = vec2(vUv.x + uSpinUV, vUv.y);
  float c = texture2D(uCloudTex, uv).r;

  // uCover 推阈值（低气压时只剩最厚的云核），再整体缩放不透明度
  float a = smoothstep(0.30 - uCover * 0.22, 0.74 - uCover * 0.22, c);
  a *= clamp(uCover * 2.4, 0.0, 1.0);
  if(a < 0.012) discard;

  vec3 n0 = normalize(vSurf);
  vec3 L  = normalize(uLightDir);
  float ndl = dot(n0, L);
  float day = smoothstep(-0.10, 0.18, ndl);

  vec3 warm = mix(vec3(1.0, 0.99, 0.97), vec3(1.0, 0.64, 0.40),
                  smoothstep(0.38, 0.0, ndl) * smoothstep(-0.16, 0.12, ndl));

  vec3 col = mix(vec3(0.95, 0.96, 0.98), vec3(0.72, 0.44, 0.28), uTint);
  // 云的反照率约 0.7，是日面最亮的东西，不能比海面暗。
  col *= (0.040 + day * 1.02) * warm;

  gl_FragColor = vec4(col, a * (1.0 - vFlat * 0.55) * (1.0 - smoothstep(0.0, 0.22, uShatter)));
}
`;

/* ── 二向箔与内核 ────────────────────────────────────── */

const FOIL_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FOIL_FRAG = `
precision highp float;
uniform float uOpacity;
varying vec2 vUv;
void main(){
  float band = 1.0 - abs(vUv.x - 0.5) * 2.0;
  band = pow(clamp(band, 0.0, 1.0), 5.0);
  float fade = smoothstep(0.0, 0.16, vUv.y) * smoothstep(1.0, 0.84, vUv.y);
  float a = band * fade * uOpacity;
  vec3 col = mix(vec3(0.44, 0.66, 0.86), vec3(1.0, 1.0, 1.0), band);
  gl_FragColor = vec4(col * a * 1.6, a);
}
`;

const CORE_FRAG = `
precision highp float;
uniform float uOpacity;
varying vec2 vUv;
void main(){
  float d = length(vUv - 0.5) * 2.0;
  float k = clamp(1.0 - d, 0.0, 1.0);
  float core = pow(k, 2.4);
  float halo = pow(k, 0.7) * 0.32;
  vec3 col = mix(vec3(1.0, 0.46, 0.14), vec3(1.0, 0.96, 0.88), core);
  float a = (core + halo) * uOpacity;
  gl_FragColor = vec4(col * a, a);
}
`;

/* ── 舞台 ────────────────────────────────────────────── */

const TEX = {
  day:    './textures/earth_day.jpg',
  night:  './textures/earth_night.jpg',
  clouds: './textures/earth_clouds.jpg',
  spec:   './textures/earth_spec.jpg'
};

export class PlanetStage {
  constructor(canvas){
    this.canvas = canvas;
    this.spin = 0;
    this.state = 'idle';       // idle | foil | crush | done
    this.effectT = 0;
    this.driftT = 0;
    this.onEffectEnd = null;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias:true, alpha:false });
    this.renderer.setClearColor(0x05070A, 1);
    // 线性 HDR 渲染，自发光超过 1.0 供 bloom 提取，链尾 OutputPass 做 ACES + sRGB
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    this.baseR = 4.1; this.camAz = 0; this.camEl = 0; this.camPush = 0;
    this.camera.position.set(0, 0, this.baseR);

    this.lightDir = new THREE.Vector3(0.68, 0.26, 0.69).normalize();

    this._loadTextures();
    this._buildStars();
    this._buildPlanet();
    this._buildClouds();
    this._buildAtmo();
    this._buildFoil();
    this._buildCore();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // threshold 1.10 高于一切漫反射表面的峰值（冰约 1.03、云 0.90），
    // 因此只有自发光项参与溢出：岩浆 3.2 / 灯火 2.3 / 海面反射 1.9 / 箔片 / 内核。
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.90, 0.34, 1.10);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.resize();
  }

  /* — 贴图。先塞 1×1 占位，加载完再换，避免首帧空采样 — */
  _loadTextures(){
    const solid = (r, g, b) => {
      const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
      t.needsUpdate = true;
      return t;
    };
    this.tex = {
      day:    solid(12, 20, 34),
      night:  solid(0, 0, 0),
      clouds: solid(0, 0, 0),
      spec:   solid(0, 0, 0)
    };

    const loader = new THREE.TextureLoader();
    for(const [key, url] of Object.entries(TEX)){
      loader.load(url, t => {
        t.wrapS = THREE.RepeatWrapping;       // 自转靠 UV 偏移，必须能环绕
        t.wrapT = THREE.ClampToEdgeWrapping;
        t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        // 色图是 sRGB 编码的照片；spec 是数据图，保持线性
        t.colorSpace = (key === 'spec') ? THREE.NoColorSpace : THREE.SRGBColorSpace;
        this.tex[key] = t;
        if(this.uPlanet){
          this.uPlanet.uDay.value      = this.tex.day;
          this.uPlanet.uNight.value    = this.tex.night;
          this.uPlanet.uSpec.value     = this.tex.spec;
          this.uPlanet.uCloudTex.value = this.tex.clouds;
          this.uCloud.uCloudTex.value  = this.tex.clouds;
        }
      }, undefined, () => {
        console.warn('[贴图] 加载失败：' + url + '（先跑 fetch-assets.sh）');
      });
    }
  }

  _buildStars(){
    const N = 2600, pos = new Float32Array(N * 3), sz = new Float32Array(N);
    for(let i = 0; i < N; i++){
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
      const r = 42 + Math.random() * 14, s = Math.sqrt(1 - u * u);
      pos[i*3] = r * s * Math.cos(th);
      pos[i*3+1] = r * u;
      pos[i*3+2] = r * s * Math.sin(th);
      sz[i] = Math.random() < 0.06 ? 0.30 : 0.055 + Math.random() * 0.10;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    const m = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
      vertexShader:`
        attribute float aSize; varying float vA;
        void main(){
          vA = aSize;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * 300.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader:`
        varying float vA;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if(d > 0.5) discard;
          float a = (1.0 - d * 2.0) * clamp(vA * 6.0, 0.15, 0.95);
          gl_FragColor = vec4(vec3(0.85, 0.90, 1.0), a);
        }`
    });
    this.scene.add(new THREE.Points(g, m));
  }

  /* — 行星。用 SphereGeometry 取其正确的等距柱状 UV；
       转 non-indexed 以便给每个三角面挂碎裂属性。 — */
  _buildPlanet(){
    const geo = new THREE.SphereGeometry(1, 128, 80).toNonIndexed();
    const pos = geo.attributes.position;
    const n = pos.count;
    const cen = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const axis = new Float32Array(n * 3);
    const rnd = new Float32Array(n);

    for(let t = 0; t < n; t += 3){
      let cx = 0, cy = 0, cz = 0;
      for(let k = 0; k < 3; k++){
        cx += pos.getX(t + k); cy += pos.getY(t + k); cz += pos.getZ(t + k);
      }
      cx /= 3; cy /= 3; cz /= 3;

      let dx = cx + (Math.random() - 0.5) * 0.85;
      let dy = cy + (Math.random() - 0.5) * 0.85;
      let dz = cz + (Math.random() - 0.5) * 0.85;
      const L = Math.hypot(dx, dy, dz) || 1;
      dx /= L; dy /= L; dz /= L;

      let ax = Math.random() * 2 - 1, ay = Math.random() * 2 - 1, az = Math.random() * 2 - 1;
      const AL = Math.hypot(ax, ay, az) || 1;
      ax /= AL; ay /= AL; az /= AL;

      const r = Math.random();
      for(let k = 0; k < 3; k++){
        cen[(t+k)*3] = cx; cen[(t+k)*3+1] = cy; cen[(t+k)*3+2] = cz;
        dir[(t+k)*3] = dx; dir[(t+k)*3+1] = dy; dir[(t+k)*3+2] = dz;
        axis[(t+k)*3] = ax; axis[(t+k)*3+1] = ay; axis[(t+k)*3+2] = az;
        rnd[t+k] = r;
      }
    }
    geo.setAttribute('aCentroid', new THREE.BufferAttribute(cen, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aAxis', new THREE.BufferAttribute(axis, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));

    this.uPlanet = {
      uDay:{value:this.tex.day}, uNight:{value:this.tex.night},
      uSpec:{value:this.tex.spec}, uCloudTex:{value:this.tex.clouds},
      uTemp:{value:288}, uPop:{value:1}, uSpinUV:{value:0}, uCover:{value:0.5},
      uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1}
    };
    this.planet = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uPlanet, vertexShader:PLANET_VERT, fragmentShader:PLANET_FRAG,
      side:THREE.FrontSide
    }));
    this.scene.add(this.planet);
  }

  _buildClouds(){
    const geo = new THREE.SphereGeometry(1.012, 96, 60);
    this.uCloud = {
      uCloudTex:{value:this.tex.clouds},
      uSpinUV:{value:0}, uCover:{value:0.5}, uTint:{value:0},
      uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1}
    };
    this.clouds = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uCloud, vertexShader:CLOUD_VERT, fragmentShader:CLOUD_FRAG,
      transparent:true, depthWrite:false, side:THREE.FrontSide
    }));
    this.scene.add(this.clouds);
  }

  _buildAtmo(){
    // 球壳只是积分的载体，本身不该被看见——半径必须覆盖大气外缘 Ra=1.55。
    // 遮挡关系由着色器内的射线求交解决，故关闭深度测试。
    const geo = new THREE.IcosahedronGeometry(1.17, 5);
    this.uAtmo = {
      uLightDir:{value:this.lightDir},
      uDensity:{value:0.85},
      uFade:{value:1},
      uTint:{value:new THREE.Color(1, 1, 1)}
    };
    this.atmo = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uAtmo, vertexShader:ATMO_VERT, fragmentShader:ATMO_FRAG,
      transparent:true, depthWrite:false, depthTest:false,
      blending:THREE.AdditiveBlending, side:THREE.BackSide
    }));
    this.atmo.renderOrder = 5;
    this.scene.add(this.atmo);
  }

  _buildFoil(){
    const geo = new THREE.PlaneGeometry(3.2, 5.6);
    this.uFoil = { uOpacity:{value:0} };
    this.foil = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uFoil, vertexShader:FOIL_VERT, fragmentShader:FOIL_FRAG,
      transparent:true, depthWrite:false, depthTest:false,
      blending:THREE.AdditiveBlending, side:THREE.DoubleSide
    }));
    this.foil.rotation.y = Math.PI / 2;   // YZ 平面，沿 X 扫掠
    this.foil.position.x = -1.9;
    this.foil.renderOrder = 10;
    this.scene.add(this.foil);
  }

  _buildCore(){
    this.uCore = { uOpacity:{value:0} };
    this.core = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShaderMaterial({
      uniforms:this.uCore, vertexShader:FOIL_VERT, fragmentShader:CORE_FRAG,
      transparent:true, depthWrite:false, depthTest:false,
      blending:THREE.AdditiveBlending
    }));
    this.core.renderOrder = 9;
    this.core.visible = false;
    this.scene.add(this.core);
  }

  _applyCam(){
    const r = this.baseR + this.camPush;
    const { camAz: a, camEl: e } = this;
    this.camera.position.set(
      r * Math.sin(a) * Math.cos(e),
      r * Math.sin(e),
      r * Math.cos(a) * Math.cos(e)
    );
    this.camera.lookAt(0, 0, 0);
  }

  /* ── 外部接口 ── */

  setEnv(tempK, pressureAtm, popNorm){
    this.uPlanet.uTemp.value = tempK;
    this.uPlanet.uPop.value = popNorm;

    // 云量：气压给上限，极端温度抑制（冻干 / 蒸散殆尽）
    const pc = Math.min(1, Math.pow(pressureAtm / 9, 0.60));
    const tk = Math.min(1, Math.max(0, (tempK - 150) / 120)) *
               Math.min(1, Math.max(0, (760 - tempK) / 180));
    const cover = pc * (0.25 + 0.75 * tk);
    this.uCloud.uCover.value = cover;
    this.uPlanet.uCover.value = cover;
    this.uCloud.uTint.value = Math.min(1, Math.max(0, (tempK - 340) / 260));

    this.uAtmo.uDensity.value = Math.min(2.2, Math.pow(pressureAtm / 1.2, 0.55) * 0.80);
    // 高温大气偏橙（尘与硫），低温偏青白
    const hot = Math.min(1, Math.max(0, (tempK - 320) / 320));
    const cold = Math.min(1, Math.max(0, (250 - tempK) / 130));
    this.uAtmo.uTint.value.setRGB(
      1 + hot * 1.10 + cold * 0.15,
      1 - hot * 0.22 + cold * 0.18,
      1 - hot * 0.62 + cold * 0.10
    );
  }

  triggerFoil(){
    if(this.state !== 'idle') return false;
    this.state = 'foil'; this.effectT = 0;
    return true;
  }

  triggerCrush(){
    if(this.state !== 'idle') return false;
    this.state = 'crush'; this.effectT = 0;
    return true;
  }

  reset(){
    this.state = 'idle'; this.effectT = 0;
    for(const u of [this.uPlanet, this.uCloud]){
      u.uFoilX.value = -1.9; u.uShatter.value = 0; u.uSpread.value = 1;
    }
    this.uAtmo.uFade.value = 1;
    this.uFoil.uOpacity.value = 0;
    this.foil.position.x = -1.9;
    this.uCore.uOpacity.value = 0;
    this.core.visible = false;
    this.camAz = 0; this.camEl = 0; this.camPush = 0;
    this._applyCam();
  }

  update(dt){
    this.spin += dt * 0.055;
    const spinUV = this.spin / (Math.PI * 2);
    this.uPlanet.uSpinUV.value = spinUV;
    this.uCloud.uSpinUV.value = spinUV * 1.18;   // 云走得比地表略快

    if(this.state === 'idle'){
      // 极慢的机位漂移。完全静止的机位是「粗糙」最容易被察觉的一处。
      this.driftT += dt;
      this.camAz = Math.sin(this.driftT * 0.074) * 0.085;
      this.camEl = Math.sin(this.driftT * 0.053 + 1.7) * 0.062 + 0.045;
      this._applyCam();
    }
    else if(this.state === 'foil'){
      this.effectT += dt / 7.4;                     // 全程约 7.4 秒，缓慢不可抗
      const t = Math.min(1, this.effectT);
      const e = t * t * (3 - 2 * t);
      const x = -1.9 + e * 3.8;
      for(const u of [this.uPlanet, this.uCloud]) u.uFoilX.value = x;
      // 大气随压平进程整体淡出：二维空间里没有大气层
      this.uAtmo.uFade.value = 1 - this._ss(0.0, 0.62, t);
      this.foil.position.x = x;
      this.uFoil.uOpacity.value = Math.sin(Math.min(1, t * 1.12) * Math.PI) * 0.78;

      // 相机抢在箔片抵达前转到掠射角。正面观察压平是看不出来的——
      // 厚度归零需要视差才能读出，这一转是整个效果成立的前提。
      const c = Math.min(1, t / 0.24);
      const ce = c * c * (3 - 2 * c);
      this.camAz = ce * 0.30;
      this.camEl = ce * 0.36;
      this.camPush = ce * 1.25;
      this._applyCam();

      if(t >= 1) this._finish();
    }
    else if(this.state === 'crush'){
      this.effectT += dt / 2.7;
      const t = Math.min(1, this.effectT);
      for(const u of [this.uPlanet, this.uCloud]) u.uShatter.value = t;
      this.uAtmo.uFade.value = 1 - this._ss(0.0, 0.26, t);

      // 内核必须等碎片开始分离才亮——提前亮就是在一颗完整球体前面糊一团白
      const op = this._ss(0.17, 0.30, t) * (1 - this._ss(0.34, 0.72, t)) * 0.82;
      this.uCore.uOpacity.value = Math.max(0, op);
      this.core.visible = op > 0.002;
      const k = 0.42 + this._ss(0.15, 0.90, t) * 1.45;
      this.core.scale.set(k, k, 1);
      this.core.quaternion.copy(this.camera.quaternion);

      if(t >= 1) this._finish();
    }

    this.composer.render();
  }

  _ss(a, b, x){
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }

  _finish(){
    const was = this.state;
    this.state = 'done';
    if(this.onEffectEnd) this.onEffectEnd(was);
  }

  resize(){
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    if(this.composer){
      this.composer.setPixelRatio(dpr);
      this.composer.setSize(w, h);
    }
    this.camera.aspect = w / h;
    // 按视场角和宽高比反算距离。竖屏时限制维度是宽度，写死距离必然裁切；
    // 窄屏还要多留余量——上下各被一块面板压掉约三分之一高度。
    const vFov = this.camera.fov * Math.PI / 180;
    const margin = w < 760 ? 1.52 : 1.45;
    this.baseR = margin / (Math.tan(vFov / 2) * Math.min(1, w / h));
    this.camera.updateProjectionMatrix();
    this._applyCam();
  }
}
