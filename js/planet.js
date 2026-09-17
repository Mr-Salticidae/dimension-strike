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
import { ShaderPass }       from '../vendor/jsm/postprocessing/ShaderPass.js';

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

/* ── 大气环流 ────────────────────────────────────────────
   云不是一整块贴图在平移。真实的云层被纬向风带撕开：信风带（0~30°）吹东风，
   云向西走；西风带（30~60°）反向，云向东走；极地东风（60~90°）又转向西，
   且弱而不稳。相邻两带方向相反，交界处因此持续剪切——那才叫云层在动，
   而不是在挪。

   云量也分带：赤道辐合带（ITCZ，实际中心约在 6°N 而不是赤道上）是最厚的一条；
   副热带约 25° 是哈德里环流的下沉支，最薄；中纬约 46° 的风暴轴又回升。 */
const WIND = `
float zonalWind(float s){          // s = sin(纬度)，带符号
  float a = abs(s);
  float trade = -0.60 * (1.0 - smoothstep(0.26, 0.56, a));
  float west  =  1.00 * smoothstep(0.32, 0.60, a) * (1.0 - smoothstep(0.76, 0.94, a));
  float polar = -0.32 * smoothstep(0.80, 0.97, a);
  return trade + west + polar;
}

float cloudBand(float s){
  float a = abs(s);
  float itcz  =  1.00 * (1.0 - smoothstep(0.02, 0.26, abs(s - 0.10)));
  float dry   = -0.62 * (1.0 - smoothstep(0.00, 0.24, abs(a - 0.42)));
  float storm =  0.42 * (1.0 - smoothstep(0.00, 0.32, abs(a - 0.72)));
  return itcz + dry + storm;
}
`;

/* ── 顶点形变（二向箔压平 + 引力挤压） ────────────────── */

const DEFORM = `
uniform float uFoilX;    // 二向箔扫掠位置（-1.9 → +1.9）
uniform float uShatter;  // 挤压进度 0 → 1
uniform float uSpread;   // 压平后铺开系数
uniform vec2  uFracWin;  // 断裂时间窗（起点, 离散量）：地壳先裂，地幔后裂
uniform float uBurstK;   // 飞散速度倍率：越往里越致密，飞得越慢

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
//
// 碎裂走「冲量 + 积分」，不是「位置 = f(进度)」。早先位移由 smoothstep 驱动，
// 导数在两端归零——所有碎片同时起步、同时刹停，那是整个效果里最假的一处。
// 断裂是瞬时冲量；此后真空中没有阻力，速度只被残核引力削减，于是慢的会落回、
// 快的一去不返。这条长尾是免费的，只要别把位移直接插值。
vec3 rotAxis(vec3 v, vec3 axis, float c, float s){
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}

vec3 deform(vec3 p, vec3 cen, vec3 dir, vec3 axis, float rnd, float mass,
            out float outFlat, out vec3 outNrm, out float outBurst){
  outNrm = normalize(p);     // 未形变时，球面法线就是方向本身
  outBurst = 0.0;
  p = flatten(p, outFlat);

  if(uShatter > 0.0){
    float s = uShatter;
    // rnd 已被飞散速度占用。再要一个独立随机量，否则「晚断裂的必定飞得慢」
    float r2 = fract(rnd * 43758.5453);

    // 裂纹不会同时到达每一处：每片有自己的断裂时刻，断裂前随整体塌缩、
    // 断裂后停止压缩。两者错开，塌缩末期的表面因此是碎的而不是光滑的。
    float tFrac = uFracWin.x + r2 * uFracWin.y;
    float cs = min(s, tFrac);
    float squeeze = pow(cs / (uFracWin.x + uFracWin.y), 2.4) * 0.26;   // 幂次：越塌缩引力越强
    p   *= 1.0 - squeeze;
    cen *= 1.0 - squeeze;

    float tb = s - tFrac;
    if(tb > 0.0){
      outBurst = tb;
      vec3 local = p - cen;
      // 绕独立随机轴匀速翻滚——真空里没有东西让它慢下来。若沿用飞散方向
      // 作转轴，碎片只会绕飞行轴自旋、始终正对镜头，看起来是一地彩纸屑。
      // 大块转得慢：同样的冲量矩，转动惯量大就是转不动。
      float ang = (rnd * 2.0 - 1.0) * 17.0 * mix(1.55, 0.40, mass) * tb;
      float c = cos(ang), si = sin(ang);
      local  = rotAxis(local,  axis, c, si);
      outNrm = rotAxis(outNrm, axis, c, si);   // 法线必须跟着碎片一起转
      // 初速离散：rnd 三次方拉长尾，再按质量分配——同一份冲量，小块飞得快。
      // 二次项是残核引力，慢碎片会被拉回来。
      float v0   = (0.42 + rnd * rnd * rnd * 3.4) * mix(1.50, 0.52, mass) * uBurstK;
      float disp = max(0.0, v0 * tb - 0.34 * tb * tb);
      p = cen + local + dir * disp;
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
attribute float aMass;

varying vec2 vUv;
varying vec3 vSurf;
varying vec3 vNrm;
varying vec3 vPos;
varying float vFlat;
varying float vBurst;

${DEFORM}

void main(){
  vUv   = uv;
  vSurf = normalize(position);   // 未形变方向：贴图与地表属性都按它取，碎裂时才不会滑移

  float f, burst;
  vec3 nrm;
  vec3 p = deform(position, aCentroid, aDir, aAxis, aRnd, aMass, f, nrm, burst);
  vFlat  = f;
  vNrm   = nrm;                  // 受光用它：翻滚的碎片必须跟着变明暗
  vPos   = p;                    // 网格无变换，物体空间即世界空间
  vBurst = burst;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const PLANET_FRAG = `
precision highp float;

uniform sampler2D uDay;      // NASA 日面色图
uniform sampler2D uNight;    // NASA 夜间灯光
uniform sampler2D uSpec;     // 水体遮罩（白 = 水）
uniform sampler2D uCloudTex; // 用于地表云影

// 四路温度，同一个目标值、四种跟随速度。滑块动的是注入的能量，
// 各子系统按自己的热容响应：冰盖最慢，岩石最快。常数见 planet.js 的 ENV_TAU。
uniform vec4  uTempLag;      // x=冰盖 y=植被 z=海洋 w=岩石，单位 K
uniform float uPop;          // 0..1
uniform float uSpinUV;       // 自转 = UV 横向偏移
uniform float uShatter;
uniform float uCover;        // 云量
uniform float uWind;         // 纬向风累计位移，与云层共用
uniform float uCrustT;       // 岩石圈温度：比冰盖更慢的一条通道
uniform float uFire;         // 当前火灾强度（由热冲击驱动）
uniform float uBurn;         // 累计过火面积
uniform float uCoreGlow;     // 内核亮度，用于照亮碎片内侧
uniform vec3  uLightDir;

varying vec2 vUv;
varying vec3 vSurf;
varying vec3 vNrm;
varying vec3 vPos;
varying float vFlat;
varying float vBurst;

${NOISE}
${WIND}

/* 冰量。抽成函数是为了能用第二条更慢的温度通道再算一遍：两者之差就是
   「冰刚刚退走的地方」。冰缘不是一条纬线——噪声打碎边界；海面先冻（薄冰
   铺得快，陆地冰盖要靠积雪一层层堆，故对水体额外下压）；干而亮的高地与
   荒漠辐射降温最快，也先白。 */
float iceAmount(float T, float lat, float water, float alt, float nLow, float nMid){
  float freeze = smoothstep(296.0, 214.0, T);
  float line = mix(1.16, -0.12, freeze)
             + (nLow - 0.5) * 0.17 + (nMid - 0.5) * 0.06
             - water * 0.13 - alt * 0.10;
  return smoothstep(line - 0.10, line + 0.05, lat) * freeze;
}

void main(){
  vec2 uv = vec2(vUv.x + uSpinUV, vUv.y);   // RepeatWrapping 负责环绕
  // n0 是地表属性的坐标（冰按纬度、岩浆按噪声），不随碎片翻滚；
  // N 是受光法线，必须跟着翻滚——这两者分开是碎片能「活」起来的前提。
  vec3 n0 = normalize(vSurf);
  vec3 N  = normalize(vNrm);
  if(!gl_FrontFacing) N = -N;               // 断面朝外时法线要翻过来
  float lat = abs(n0.y);

  vec3  base   = texture2D(uDay, uv).rgb;
  float water  = texture2D(uSpec, uv).r;
  float relief = dot(base, vec3(0.299, 0.587, 0.114));

  // 两张共用的噪声场：低频定斑块，中频打碎边缘。
  // 温度效果最容易露馅的地方不是配色，是「整颗星按同一条曲线一起变」——
  // 真实的相变有前沿、有先后、有参差，下面四段都是在给它们补这个。
  float nLow = fbm3(n0 * 3.4) * 0.5 + 0.5;
  float nMid = fbm3(n0 * 6.1) * 0.5 + 0.5;

  // ── 冰盖：低温时从两极推进
  float alt = clamp((relief - 0.44) * 2.2, 0.0, 1.0) * (1.0 - water);
  float ice = iceAmount(uTempLag.x, lat, water, alt, nLow, nMid);
  // 海冰的边缘是碎的。只在过渡带里掺高频噪声——(1-|2i-1|) 在 i=0.5 处最大、
  // 两端归零，所以冰盖内部和开阔水面都不受影响，碎的只有交界那一圈浮冰。
  // 陆地不参与：积雪的边界本来就比海冰整齐。
  float floe = snoise(n0 * 24.0) * 0.5 + 0.5;
  ice = clamp(ice + (floe - 0.5) * 1.15 * (1.0 - abs(ice * 2.0 - 1.0)) * water, 0.0, 1.0);
  // 海冰平坦偏青灰，陆雪亮而有起伏。反照率压在 bloom 阈值（1.10）之下，
  // 否则整颗雪球一起溢出成白板。
  vec3  seaIce  = vec3(0.612, 0.664, 0.716);
  vec3  snow    = vec3(0.716, 0.742, 0.776) * (0.88 + nMid * 0.16);
  vec3  iceCol  = mix(snow, seaIce, water);
  iceCol *= 0.86 + relief * 0.42;   // 底图的明暗透一点上来，雪原下仍辨得出山脉
  base = mix(base, iceCol, ice * 0.94);

  // ── 荒漠化：升温后植被褪成沙色
  float veg = clamp((base.g - (base.r + base.b) * 0.5) * 4.2, 0.0, 1.0);
  // 不是全球一起褪。副热带是哈德里环流的下沉支，最先干；赤道雨林水汽最足，
  // 最后才垮。再乘一层斑块噪声，干旱前沿因此是啃出来的，不是推平的。
  float belt = smoothstep(0.10, 0.40, lat) * (1.0 - smoothstep(0.60, 0.94, lat));
  float arid = smoothstep(292.0, 402.0, uTempLag.y);
  arid = clamp(arid * (0.42 + 0.88 * belt) * (0.52 + 0.80 * nLow), 0.0, 1.0);
  vec3 sand = mix(vec3(0.470, 0.392, 0.286), vec3(0.624, 0.498, 0.322), nMid);
  base = mix(base, sand, arid * veg * (1.0 - water) * 0.92);

  // ── 火灾：热冲击打在还没来得及适应的植被上
  // 强度由 uFire 给（目标温度与植被通道的落差 × 可燃温区），慢慢拧滑块不会着火，
  // 猛地拉上去才会——烧起来的是「跟不上」的那部分生物圈。
  float land = (1.0 - water) * (1.0 - ice);
  vec3  fq   = n0 * 7.4 + vec3(0.0, uWind * 3.2, 0.0);
  // 火头是锋面不是散点。取噪声的零交叉（脊线）才得到连续的火线；
  // 直接对噪声取高次幂只会得到稀疏的孤立亮点，暗到看不见。
  float fr    = 1.0 - abs(fbm3(fq)) * 2.6;
  float front = pow(clamp(fr, 0.0, 1.0), 4.0);
  float fire  = uFire * veg * land * front;

  // 过火痕迹：焦黑的斑块，随累计过火面积扩张，植被恢复后再慢慢褪去。
  // 复用低频噪声场——烧过的疤本来就是大片的。
  float scar = smoothstep(1.02 - uBurn * 1.18, 1.04 - uBurn * 1.18, nLow) * veg * land;
  base = mix(base, vec3(0.074, 0.060, 0.050), scar * 0.92);

  // 烟往下风方向拖：取上风处的火强度，就得到「这里的烟是那边烧出来的」。
  // east 是当地的向东切向；zonalWind 为负（信风带）时上风在东侧，符号自动反过来。
  vec3  east   = normalize(vec3(-n0.z, 0.0, n0.x) + vec3(1e-5));
  vec3  upwind = fq - east * (zonalWind(n0.y) * 1.15);
  float sr     = 1.0 - abs(fbm3(upwind)) * 2.6;
  float smoke  = pow(clamp(sr, 0.0, 1.0), 2.2) * uFire * land;
  base = mix(base, vec3(0.300, 0.266, 0.232), clamp(smoke * 1.15, 0.0, 0.78));

  // ── 海洋蒸干：先退浅海，再退深海
  // 近岸判定靠对水体遮罩做四点采样，邻域里出现陆地就是浅水。均匀地把整片海
  // 压暗，读起来是海水在褪色；先露大陆架再露海盆，才是海在退去。
  // 浅海和深海各走一条曲线：浅的先干，深的晚干，但两条最终都会到 1。
  // 早先只有一条曲线再按水深打折，结果深海盆无论多热都只干掉四成——
  // 温度拉满还剩一片蓝，那才是最假的。
  float boilShallow = smoothstep(362.0, 438.0, uTempLag.z);
  float boilDeep    = smoothstep(424.0, 516.0, uTempLag.z);
  float e = 0.010;
  float near = texture2D(uSpec, uv + vec2( e, 0.0)).r
             + texture2D(uSpec, uv + vec2(-e, 0.0)).r
             + texture2D(uSpec, uv + vec2(0.0,  e)).r
             + texture2D(uSpec, uv + vec2(0.0, -e)).r;
  float shelf = 1.0 - near * 0.25;                       // 0 = 深海盆，1 = 岸边
  float dry   = mix(boilDeep, boilShallow, shelf);
  vec3  bed   = mix(vec3(0.088, 0.076, 0.068), vec3(0.186, 0.158, 0.132),
                    shelf * (0.45 + 0.55 * nMid));
  base = mix(base, bed, water * dry);

  // ── 熔融：裂缝先出现，再变宽，最后连成岩浆海
  float melt  = smoothstep(620.0, 900.0, uTempLag.w);
  float rn    = fbm3(n0 * 3.1);
  float ridge = 1.0 - abs(rn) * 1.7;
  // 指数随熔融程度下降：细缝 → 宽缝 → 连片。固定指数下岩浆从头到尾一样粗，
  // 只是越来越亮——那不是在熔化，是在调亮度。
  float cracks = pow(clamp(ridge, 0.0, 1.0), mix(11.0, 3.4, melt));
  vec3  magma  = mix(vec3(0.120,0.024,0.010), vec3(1.000,0.398,0.098), cracks);
  // 白热只留给真正接近全熔的那一段。给早了，八百度就糊成一颗恒星。
  magma = mix(magma, vec3(1.000, 0.664, 0.302), cracks * smoothstep(0.80, 1.0, melt));
  base = mix(base, magma * 0.30, melt);
  vec3 emissive = magma * cracks * melt * 3.2;      // >1 交给 bloom

  // ── 地壳活动：熔融之前，热应力先把地壳撕开细缝；冰盖退走的地方另有一条通路。
  // 冰卸载 → 上地壳回弹减压 → 减压熔融。冰岛在末次冰消后喷发速率高出今日
  // 30~50 倍，持续千年以上；这里用「岩石圈通道比冰盖通道慢」来定位冰缘退到过
  // 哪里：两条通道算出的冰量之差，就是刚刚卸载的那一圈。
  float iceWas = iceAmount(uCrustT, lat, water, alt, nLow, nMid);
  float freed  = clamp(iceWas - ice, 0.0, 1.0);
  float rift   = clamp(smoothstep(455.0, 690.0, uTempLag.w) * (1.0 - melt) + freed * 0.55, 0.0, 1.0);
  // 裂缝要另取一条窄得多的脊线。ridge 的系数 1.7 是给岩浆海调的，宽得几乎处处为正，
  // 再高的指数也压不住——同一个噪声值换个系数重算才对。
  float fissure = pow(clamp(1.0 - abs(rn) * 10.0, 0.0, 1.0), 2.0);
  // 火山活动是分省的，不是沿着每一条缝均匀开口；海面下也有，但看不到那么亮
  fissure *= smoothstep(0.50, 0.86, nLow) * (1.0 - water * 0.62);
  emissive += vec3(1.00, 0.30, 0.05) * fissure * rift * 3.6;

  emissive += vec3(1.00, 0.34, 0.06) * fire * 3.0;

  float wet = water * (1.0 - dry) * (1.0 - ice);    // 当前仍是液态水的部分

  // ── 表面起伏。这一层是「整颗星在变」和「贴了一层图」的分界线：
  // 只改反照率，光照对每种材质一视同仁，读起来必然是贴纸；改法线，明暗交界
  // 处才会长出雪脊、沙丘和熔岩的坡面，材质才立得住。
  vec3  Tg = normalize(cross(vec3(0.0, 1.0, 0.0), n0) + vec3(1e-4));
  vec3  Bg = cross(n0, Tg);

  // 基础地形直接对底图取梯度：那是真实影像，山脉走向本来就在里面，
  // 比拿噪声凭空捏一层可信得多——噪声铺满大陆只会变成砂纸。
  float eT = 0.0026;
  float lu = dot(texture2D(uDay, uv + vec2(eT, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
  float lv = dot(texture2D(uDay, uv + vec2(0.0, eT)).rgb, vec3(0.299, 0.587, 0.114));
  vec2  gTex = vec2(lu - relief, lv - relief) * (1.0 - water * (1.0 - dry)) * 7.0;

  // 程序化那层只在材质真的换掉之后才出场：雪脊粗而缓，沙丘与熔岩坡细而密。
  // 288K 的地球因此几乎只有底图自己的起伏，不会平白多一层噪点。
  float procA = max(max(ice, arid * 0.70), melt * 0.85);
  float bumpK = mix(20.0, 5.2, ice);
  float eB = 0.030;
  float hC = snoise(n0 * bumpK);
  float hT = snoise((n0 + Tg * eB) * bumpK);
  float hB = snoise((n0 + Bg * eB) * bumpK);
  vec2  gPro = vec2(hT - hC, hB - hC) * procA * 0.28;

  N = normalize(N - Tg * (gTex.x + gPro.x) - Bg * (gTex.y + gPro.y));

  // ── 光照。网格不转，所以世界系法线可直接对太阳。
  vec3 L = normalize(uLightDir);
  float ndl = dot(N, L);
  float day = smoothstep(-0.06, 0.14, ndl);

  // 云影：沿光方向在 UV 上略偏移采样同一张云图。剪切项必须和云层用同一条
  // 公式，否则影子会从云底下滑出去；形变与密度波那两层略去不算，
  // 影子本来就是软的，为它再算几次噪声不划算。
  float shadowU = uv.x + 0.022 * zonalWind(n0.y) * sin(uWind * 1.6) + 0.008;
  float cShadow = texture2D(uCloudTex, vec2(shadowU, uv.y - 0.004)).r;
  float coverHere = clamp(uCover * (1.0 + 0.30 * cloudBand(n0.y)), 0.0, 1.4);
  day *= 1.0 - smoothstep(0.30, 0.82, cShadow) * coverHere * 0.42;

  // 终结线染色：掠射的光穿过更厚的大气，偏红
  vec3 warm = mix(vec3(1.0, 0.98, 0.95), vec3(1.0, 0.60, 0.34),
                  smoothstep(0.38, 0.0, ndl) * smoothstep(-0.14, 0.10, ndl));

  vec3 lit = base * day * warm * 1.22;
  lit += base * vec3(0.034, 0.044, 0.066) * (1.0 - day);   // 夜面天光，别压死成纯黑

  // ── 材质对光的反应。只有反照率不同的话，冰、沙、岩浆在光下是同一种东西，
  // 那正是「贴了一层」的来源。下面三项让它们各自有各自的光学行为。

  vec3 V = normalize(cameraPosition - vPos);
  vec3 H = normalize(L + V);

  // 水：极窄的镜面反射点
  float spec = pow(max(dot(N, H), 0.0), 1100.0) * wet * smoothstep(-0.02, 0.16, ndl);
  lit += vec3(1.0, 0.95, 0.86) * spec * 1.9;               // >1 交给 bloom

  // 冰：镜面瓣宽得多，而且阴影是蓝的——冰体内多次散射把红端吃掉了，
  // 这是雪地最好认的特征之一。它还会向四周散光，所以夜面不会压成全黑。
  float iceSpec = pow(max(dot(N, H), 0.0), 46.0) * ice * smoothstep(-0.04, 0.20, ndl);
  lit += vec3(0.80, 0.88, 1.00) * iceSpec * 0.85;
  lit += vec3(0.055, 0.085, 0.150) * ice * (1.0 - day) * 1.15;

  // 沙：粗糙表面的冲日效应——视线与光线接近时回散最强，沙漠因此在正午发白
  float back = pow(max(dot(V, L), 0.0), 3.5) * arid * (1.0 - water) * day;
  lit += vec3(0.42, 0.34, 0.22) * back * 0.55;

  // ── 城市灯火：NASA 夜间灯光原图
  vec3 night = texture2D(uNight, uv).rgb;
  lit += night * pow(1.0 - day, 1.5) * uPop * 2.3 * (1.0 - ice * 0.85);

  // 火线在夜面上才真正扎眼——卫星探火靠的就是这个热异常
  lit += vec3(1.00, 0.30, 0.05) * fire * (1.0 - day) * 4.5;

  // ── 热辐射。约 650K 起可见暗红，900K 已经明显。这一项对日面夜面一视同仁：
  // 温度一高，整个夜半球都会烧起来，而不是只有裂缝在亮——「整颗星在变」和
  // 「贴了一层」的区别，最后就落在这种不分昼夜的项上。
  float glowT = smoothstep(645.0, 1010.0, uTempLag.w);
  lit += vec3(1.00, 0.22, 0.040) * pow(glowT, 2.3) * 1.8;

  lit += emissive;

  // ── 二向箔：光照塌缩为无光，色彩信息一并流失——它变成一张画
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  vec3 flatLit = mix(base, vec3(lum), 0.26) * 1.42 + emissive * 0.55;
  lit = mix(lit, flatLit, vFlat);

  // ── 塌缩前沿。这一击的光来自物质本身失去一个维度时放出的能量，
  // 不是箔片在发光——所以它长在球面上、跟着曲率走，而不是浮在画面前。
  // vFlat 的过渡带就是前沿，取其峰值；必须叠在上面那次 mix 之后，
  // 否则会被压平后的无光配色稀释掉。
  if(vFlat > 0.001 && vFlat < 0.999){
    // 指数取高是为了把前沿收窄：过渡带本身有 0.6 个半径宽，直接用
    // 它的峰值会糊成一片，bloom 再一摊就是块白板。
    float front = pow(vFlat * (1.0 - vFlat) * 4.0, 7.0);
    // 物质不是均匀地塌缩，前沿因此是撕裂的而不是一条干净的线
    float grain = 0.30 + 0.70 * (fbm3(n0 * 16.0) * 0.5 + 0.5);
    // 红通道必须压在 1 以下。三个通道一起过 1，ACES 一压就是白——
    // 「蓝色的强光」和「白光」的区别全在这里，不在亮度。
    lit += vec3(0.12, 0.42, 1.00) * front * grain * 2.2;  // >1 交给 bloom
  }

  // ── 引力挤压
  if(uShatter > 0.0){
    // 余温挂在这块碎片自己的飞散时长上，不是全局进度——否则两千块同时
    // 亮、同时灭，再好的飞散也会露馅。
    float b     = vBurst;
    float heat  = smoothstep(0.0, 0.04, b) * (1.0 - smoothstep(0.06, 0.34, b));
    float grain = fbm3(n0 * 7.0) * 0.5 + 0.5;

    // 热在断面上，不在地壳上。地壳该是什么颜色还是什么颜色——把余温均匀刷满
    // 每一面，两千块碎片就会一起变成橙色的落叶。
    if(!gl_FrontFacing){
      // 背面是新剥出来的地幔：没有海陆没有云，只有岩石和地心带出来的温度。
      // 早先材质是 FrontSide，碎片翻到背面直接被剔掉——薄片忽闪忽灭，
      // 那比「像纸屑」更致命：它连个实体都不是。
      float d = fbm3(n0 * 11.0) * 0.5 + 0.5;
      vec3 rock = mix(vec3(0.052, 0.040, 0.036), vec3(0.128, 0.104, 0.092), d);
      lit = rock * (0.22 + 0.92 * max(dot(N, L), 0.0))
          + vec3(1.0, 0.36, 0.10) * heat * (0.40 + 0.80 * grain) * 1.75;
    }else{
      lit += vec3(1.0, 0.42, 0.14) * heat * grain * 0.20;   // 地壳面只沾一点：给多了海洋会泛紫
    }

    // 三角面没有厚度，掠射时会薄成一条线；真的石头这时候露出的是粗糙的侧面。
    // 拿视角衰减补一道暗边，至少让它读起来有体积。
    float edgeOn = 1.0 - abs(dot(N, V));
    lit = mix(lit, lit * 0.22, pow(edgeOn, 4.0));

    // 内核的照明。碎片内侧被它照亮，是「里面有东西」最直接的证据；
    // 没有这道光，碎开的行星就只是一层被吹散的皮。
    float cd = length(vPos);
    float cl = max(dot(N, -vPos / max(cd, 1e-4)), 0.0);
    lit += vec3(1.0, 0.44, 0.14) * cl * uCoreGlow / (0.30 + cd * cd);

    lit *= 1.0 - smoothstep(0.0, 0.18, uShatter) * 0.35;   // 塌缩期整体压暗
    lit *= 1.0 - smoothstep(0.10, 0.80, b) * 0.55;         // 飞远之后冷下来
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
uniform float uWind;
uniform float uCover;
uniform float uTint;
uniform vec3  uLightDir;
varying vec2 vUv;
varying vec3 vSurf;
varying float vFlat;

${NOISE}
${WIND}

void main(){
  vec3 n0 = normalize(vSurf);

  // 贴图层只能做「整体自转 + 有界剪切」。无界剪切是做不得的：相邻纬度的 UV
  // 会被越拉越远，采样器看到的导数爆掉，自动 mip 会直接选到几十像素宽的那一级，
  // 整片云糊成灰。所以这里的剪切是缓慢往复的，不累积。
  float shear = 0.022 * zonalWind(n0.y) * sin(uWind * 1.6);
  // 形变场：位移幅度必须远小于它自己的特征尺度，否则不是平流，是把云图搅碎。
  // 随时间演化比幅度大有用得多——第三维漂移，等于图样本身在生灭。
  vec3 q = n0 * 3.2 + vec3(0.0, uWind * 0.55, 0.0);
  vec2 warp = vec2(snoise(q), snoise(q + 31.7)) * 0.013;
  vec2 uv = vec2(vUv.x + uSpinUV + shear + warp.x, vUv.y + warp.y * 0.5);

  float c = texture2D(uCloudTex, uv).r;

  // 真正无界流动的是这一层：一个程序化密度场，绕 Y 轴按纬向风带做真正的平流。
  // 它是算出来的，没有 mip 可选，因此想转多远都不会糊。信风带与西风带方向相反，
  // 于是能看见两股反向的密度波在各自的纬度里推进。
  float ang = uWind * zonalWind(n0.y) * 6.2831853;
  float ca = cos(ang), sa = sin(ang);
  vec3  adv = vec3(n0.x * ca - n0.z * sa, n0.y, n0.x * sa + n0.z * ca);
  float flow = fbm3(adv * 4.2 + vec3(0.0, uWind * 0.9, 0.0)) * 0.5 + 0.5;

  // 云量分带：赤道辐合带最厚、副热带下沉支最薄、中纬风暴轴回升。
  // 权重给小：这张云图是真实观测，本来就含这套气候态，加重会把带切得太硬。
  float cover = clamp(uCover * (1.0 + 0.30 * cloudBand(n0.y)), 0.0, 1.4);

  // cover 推阈值（低气压时只剩最厚的云核），再整体缩放不透明度
  float a = smoothstep(0.30 - cover * 0.22, 0.74 - cover * 0.22, c);
  a *= clamp(cover * 2.4, 0.0, 1.0);
  a *= 0.62 + 0.98 * flow;          // 密度波：云在这里生，在那里消
  if(a < 0.012) discard;

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

/* ── 地幔与内核 ──────────────────────────────────────────
   只有外壳碎开，里面是空的——那颗行星看着就是个气球。地幔和内核平时藏在
   不透明的地壳后面，只在引力挤压时露出来：地幔比地壳晚裂、碎得更大更慢，
   内核根本不裂，被压实、烧亮，最后作为余烬留在原地。
   内核同时是碎片内侧的光源，「里面有东西」这件事主要靠那道光成立。 */

const MANTLE_FRAG = `
precision highp float;
uniform vec3  uLightDir;
uniform float uShatter;
uniform float uCoreGlow;

varying vec3 vSurf;
varying vec3 vNrm;
varying vec3 vPos;
varying float vBurst;

${NOISE}

void main(){
  vec3 n0 = normalize(vSurf);
  vec3 N  = normalize(vNrm);
  if(!gl_FrontFacing) N = -N;

  float d     = fbm3(n0 * 5.5) * 0.5 + 0.5;
  // 系数决定「缝」有多宽。取 1.9 会让 ridge 几乎处处为正——那不是裂缝，
  // 那是整颗球在发光。要的是窄缝，所以系数要大、指数要高。
  float ridge = 1.0 - abs(fbm3(n0 * 3.4)) * 3.4;
  float vein  = pow(clamp(ridge, 0.0, 1.0), 6.0);

  vec3 rock = mix(vec3(0.070, 0.052, 0.046), vec3(0.150, 0.118, 0.100), d);
  vec3 L = normalize(uLightDir);
  vec3 lit = rock * (0.16 + 0.86 * max(dot(N, L), 0.0));

  // 熔体脉络：压得越紧越亮，碎开之后随飞散冷却
  float squeezed = smoothstep(0.0, 0.28, uShatter) * (1.0 - smoothstep(0.0, 0.42, vBurst));
  lit += mix(vec3(0.85, 0.18, 0.03), vec3(1.0, 0.60, 0.20), vein)
         * vein * (0.30 + 0.90 * squeezed) * 1.6;

  // 内核的照明
  float cd = length(vPos);
  float cl = max(dot(N, -vPos / max(cd, 1e-4)), 0.0);
  lit += vec3(1.0, 0.44, 0.14) * cl * uCoreGlow / (0.30 + cd * cd);

  lit *= 1.0 - smoothstep(0.10, 0.85, vBurst) * 0.55;
  gl_FragColor = vec4(lit, 1.0);
}
`;

// 内核不碎，只被压实，所以不需要碎块属性，自己一套最省。
const CORE_VERT = `
uniform float uSquash;
varying vec3 vSurf;
varying vec3 vPos;
void main(){
  vSurf = normalize(position);
  vec3 p = position * (1.0 - uSquash);
  vPos = p;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}
`;

const CORE_BODY_FRAG = `
precision highp float;
uniform float uHeat;
varying vec3 vSurf;
varying vec3 vPos;

${NOISE}

void main(){
  vec3 n0 = normalize(vSurf);
  float d = fbm3(n0 * 4.2) * 0.5 + 0.5;
  // 边缘偏红：看过去光程更长、温度更低，中心才是白热
  float rim = pow(1.0 - abs(dot(n0, normalize(cameraPosition - vPos))), 1.6);
  vec3 hot = mix(vec3(1.00, 0.88, 0.66), vec3(1.00, 0.30, 0.05),
                 clamp(0.28 + 0.44 * d + 0.46 * rim, 0.0, 1.0));
  gl_FragColor = vec4(hot * uHeat, 1.0);   // >1 交给 bloom
}
`;

/* ── 二向箔与内核辉光 ─────────────────────────────────── */

const FOIL_VERT = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// 箔片本身几乎不发光——真正的光在行星表面的塌缩前沿（见 PLANET_FRAG）。
// 一个二维物体不该有可见的厚度梯度，所以这里不做柔和的辉光带：中线是一条
// 极窄的硬线，两侧是它扰动光路留下的干涉彩边。早先那版是 pow 5 的对称白带，
// 芯部直接顶到纯白 —— 读起来是一根光棒，不是一片零厚度的东西。
// 面片长 5.2：前缘之后要留足已转换区域，尾部靠 pow 衰减掉，不必真的无限远。
const FOIL_LEN = 5.2, FOIL_WID = 4.4;

const FOIL_FRAG = `
precision highp float;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;

// 薄膜干涉的廉价近似：相位决定被增强的波长。彩边是它唯一能被看见的方式。
vec3 spectrum(float t){
  return 0.5 + 0.5 * cos(6.2831853 * (t + vec3(0.0, 0.33, 0.67)));
}

void main(){
  float u = vUv.x;                    // 1 = 前缘，向后衰减

  float edge   = pow(u, 52.0);        // 转换锋面：极窄
  float tail   = pow(u, 3.2) * 0.16;  // 已经二维化的那片空间，留一层余辉
  float phase  = (1.0 - u) * 24.0 - uTime * 0.8;
  float fringe = pow(u, 7.0) * (0.5 + 0.5 * cos(phase * 6.2831853)) * 0.30;

  // 横向收在行星附近。二维化的是整个空间，但把它整块画亮就是一张发光板，
  // 远处交给想象——同时这也是「一根贯穿画面的光棒」的解药。
  float hz   = abs(vUv.y - 0.5) * ${FOIL_WID.toFixed(1)};
  float span = smoothstep(2.05, 0.30, hz);

  float a = (edge + tail + fringe) * span * uOpacity;

  // 冷蓝，不给纯白：三通道一起过 1，ACES 一压就是一块曝掉的板子。
  // 颜色叙事里冷蓝属于观测者，这一击本来就是观测者的手笔。
  vec3 col = vec3(0.30, 0.62, 1.15) * edge * 4.0
           + vec3(0.10, 0.34, 0.86) * tail * 2.2
           + spectrum(phase * 0.5) * fringe * 1.6;
  gl_FragColor = vec4(col, a);
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

/* ── 后期：景深与颗粒 ─────────────────────────────────────
   景深要深度，而 three 自带的 BokehPass 用 scene.overrideMaterial 自己渲一张，
   那会绕开我们的顶点形变——碎片的深度会停留在未碎裂的球面上，最该虚化的
   近处碎片反而全是实的。所以自己渲：逐对象换材质，形变共用同一套 uniform。

   深度存的是到相机的径向距离（不是视空间 z），对景深来说这更贴近实际光学。 */

// 深度的归一化上限。星空在 42~56，会被夹到 1.0，因此天然落在焦外。
const DEPTH_FAR = 20.0;

const DEPTH_FRAG = `
precision highp float;
uniform float uFar;
varying vec3 vPos;
void main(){
  gl_FragColor = vec4(clamp(length(vPos - cameraPosition) / uFar, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`;

const DOF_SHADER = {
  uniforms: {
    tDiffuse:{ value:null }, tDepth:{ value:null },
    uTexel:{ value:new THREE.Vector2() },
    uFocus:{ value:0.2 }, uRange:{ value:0.125 }, uMax:{ value:5 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform vec2 uTexel;
    uniform float uFocus, uRange, uMax;
    varying vec2 vUv;

    void main(){
      float z = texture2D(tDepth, vUv).r;
      float coc = clamp(abs(z - uFocus) / uRange, 0.0, 1.0);
      coc *= coc;                       // 焦内留宽一点，焦外掉得快
      float r = coc * uMax;

      // 画面绝大部分是合焦的，早退能省掉整屏的采样
      if(r < 0.6){ gl_FragColor = vec4(texture2D(tDiffuse, vUv).rgb, 1.0); return; }

      vec3 sum = vec3(0.0);
      float wsum = 0.0;
      for(int i = 0; i < 16; i++){
        // Vogel 螺旋：黄金角铺点，接近泊松盘，而且不需要常量数组
        // （GLSL ES 1.0 不支持带初始化的 const 数组）
        float fi = float(i);
        float a  = fi * 2.39996323;
        float rr = sqrt((fi + 0.5) / 16.0) * r;
        vec2 off = vec2(cos(a), sin(a)) * rr * uTexel;

        float zs = texture2D(tDepth, vUv + off).r;
        // 只让本身也在散焦的样点足额参与，否则清晰的前景会被糊到背景上
        float w = abs(zs - uFocus) / uRange >= coc * 0.6 ? 1.0 : 0.25;
        sum  += texture2D(tDiffuse, vUv + off).rgb * w;
        wsum += w;
      }
      gl_FragColor = vec4(sum / max(wsum, 1e-4), 1.0);
    }
  `
};

// 颗粒挂在 OutputPass 之后：它是胶片/传感器的产物，该落在色调映射之后的显示空间里。
const GRAIN_SHADER = {
  uniforms: {
    tDiffuse:{ value:null }, uTime:{ value:0 }, uAmount:{ value:0.060 }
  },
  vertexShader: DOF_SHADER.vertexShader,
  fragmentShader: `
    precision highp float;
    uniform sampler2D tDiffuse;
    uniform float uTime, uAmount;
    varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float n = fract(sin(dot(vUv * 1024.0 + uTime, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      // 中间调颗粒最重，纯黑和纯白处几乎没有——均匀加噪只会显脏
      float lum = dot(c, vec3(0.299, 0.587, 0.114));
      gl_FragColor = vec4(c + n * uAmount * (0.30 + 0.70 * (1.0 - abs(lum * 2.0 - 1.0))), 1.0);
    }
  `
};

/* ── 舞台 ────────────────────────────────────────────── */

const TEX = {
  day:    './textures/earth_day.jpg',
  night:  './textures/earth_night.jpg',
  clouds: './textures/earth_clouds.jpg',
  spec:   './textures/earth_spec.jpg'
};

/* ── 环境响应的时间常数（秒） ──────────────────────────
   滑块给的是目标值，各子系统按自己的热容去追它。数值按「你拖一秒、
   他们过四十七年」的时标折算：冰盖 4 秒约合两百年。
   这一层是「这是个天体」和「这是个控件」的分界——零延迟的跟手感，
   比任何贴图问题都更快地暴露出它不是模拟。 */
const ENV_TAU = {
  crust: 8.0,   // 岩石圈：比冰盖还慢。它落后于冰盖的那一截就是「冰刚退走的地方」
  ice:   4.0,   // 冰盖：热容最大，最后一个反应过来
  sea:   2.6,   // 海洋：蒸干与封冻都慢
  veg:   1.8,   // 植被：荒漠化要几代人
  rock:  0.9,   // 岩石熔融：一旦够温度就很快
  cloud: 0.75,  // 云量：成云消云以天计
  air:   0.35   // 大气密度与配色：几乎即时
};

// 帧率无关的指数逼近。朴素的 lerp(x, 0.1) 在 144Hz 上会抖、30Hz 上会黏，
// 因为它是「每帧走剩余距离的 10%」而不是「每秒衰减到 1/e」。
const damp = (cur, tgt, tau, dt) => cur + (tgt - cur) * (1 - Math.exp(-dt / tau));
const clamp01 = v => Math.min(1, Math.max(0, v));

/* ── 断裂图样 ──────────────────────────────────────────
   把球面上的三角面归进碎块。早先是一面一片：两万个同样大小的三角，
   飞散参数再怎么调也只能是一地彩纸屑——真实的断裂有尺寸谱。

   做法是 Worley：空间切成网格，每格放一个抖动过的种子，取最近的那个。
   等价于一次 Voronoi 剖分，但只需查 27 个邻格，不必和上千种子逐一比对
   （那是两千万次点积，够在加载时卡掉一帧）。
   两档网格密度由一层低频噪声挑选，于是有的区域裂成大板块、有的碎成渣，
   断裂本来就是不均匀的。 */
const _rand3 = (x, y, z, salt) => {
  let h = (x * 374761393 + y * 668265263 + z * 1442695040 + salt * 2654435761) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

function fractureCell(x, y, z){
  // 低频场决定这一带是裂成板还是碎成渣
  const gx = Math.floor(x * 1.6), gy = Math.floor(y * 1.6), gz = Math.floor(z * 1.6);
  const scale = _rand3(gx, gy, gz, 7) < 0.42 ? 7.0 : 14.5;

  const px = x * scale, py = y * scale, pz = z * scale;
  const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
  let best = 1e9, bx = 0, by = 0, bz = 0;
  for(let dx = -1; dx <= 1; dx++)
    for(let dy = -1; dy <= 1; dy++)
      for(let dz = -1; dz <= 1; dz++){
        const cx = ix + dx, cy = iy + dy, cz = iz + dz;
        const sx = cx + _rand3(cx, cy, cz, 1);
        const sy = cy + _rand3(cx, cy, cz, 2);
        const sz = cz + _rand3(cx, cy, cz, 3);
        const d = (sx-px)*(sx-px) + (sy-py)*(sy-py) + (sz-pz)*(sz-pz);
        if(d < best){ best = d; bx = cx; by = cy; bz = cz; }
      }
  // 两档网格的键必须分开，否则粗细两套格子会撞号
  return (((bx + 64) * 181 + (by + 64)) * 181 + (bz + 64)) * 2 + (scale > 10 ? 1 : 0);
}

/* 命中停顿：断裂那一帧把时间几乎冻住，再放回。2.7 秒的挤压里最关键的
   就是那一下，匀速滑过去等于没发生。 */
const STOP_HOLD = 0.13, STOP_RAMP = 0.24;

/* 观测者相对行星的倾角（弧度）。行星自转轴是世界 Y，若相机的 up 也取世界 Y，
   纬度带、自转方向、两极就全部与屏幕轴对齐——那会读成「一颗贴了滚动贴图的球」，
   而不是空间里一个有自己朝向的天体。给 up 一个倾角相当于给它一个黄赤交角
   （地球是 23.4°）。不动网格：「网格永不旋转」是二向箔的前提。 */
const CAM_TILT = 0.34;

/* 一维值噪声。镜头抖动的位移必须连续：逐帧随机数抖成的是高频噪点，
   噪声场抖出来的才是晃动。 */
const _hash1 = i => { const x = Math.sin(i * 127.1) * 43758.5453; return (x - Math.floor(x)) * 2 - 1; };
function noise1(t){
  const i = Math.floor(t), f = t - i;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  return _hash1(i) * (1 - u) + _hash1(i + 1) * u;
}

export class PlanetStage {
  constructor(canvas){
    this.canvas = canvas;
    this.spin = 0;
    this.wind = 0;
    this.state = 'idle';       // idle | foil | crush | done
    this.effectT = 0;
    this.driftT = 0;
    this.onEffectEnd = null;
    this.onShock = null;       // 断裂那一帧回调，供 HUD 同帧闪光

    this.aimX = 0; this.aimY = 0;   // 视轴的偏置，不让行星钉死在正中
    this.roll = CAM_TILT;

    this.trauma = 0;           // 0..1，实际位移取其平方
    this.shakeT = 0;
    this.stop = 0;             // 命中停顿剩余时长，走真实时间
    this.fractured = false;

    // 环境：tgt 是滑块要求的，cur 是各子系统实际达到的
    this.tgt = { temp:288, cover:0.5, ctint:0, density:0.85, tr:1, tg:1, tb:1 };
    this.cur = { ice:288, sea:288, veg:288, rock:288, crust:288,
                 cover:0.5, ctint:0, density:0.85, tr:1, tg:1, tb:1,
                 fire:0, burn:0 };
    this.warm = false;         // 首帧直接落到目标，免得开场几秒在「回暖」

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
    this._buildMantle();
    this._buildCoreBody();
    this._buildClouds();
    this._buildAtmo();
    this._buildFoil();
    this._buildCore();

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // threshold 1.10 高于一切漫反射表面的峰值（冰约 1.03、云 0.90），
    // 因此只有自发光项参与溢出：岩浆 3.2 / 灯火 2.3 / 海面反射 1.9 / 箔片 / 内核。
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.90, 0.34, 1.10);

    this._buildDepth();
    this.dof = new ShaderPass(DOF_SHADER);
    this.grain = new ShaderPass(GRAIN_SHADER);
    // 顺序：景深在 bloom 之前（虚化的高光仍该溢出），颗粒在色调映射之后
    this.composer.addPass(this.dof);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(this.grain);

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

  /* — 星空。均匀随机的单色点会读成一块平面背景板，行星就成了浮在它前面的
       贴片。两件事让它变成「一个有纵深的地方」：恒星按光谱类型分色（蓝白到
       橙红），以及把一部分密度压向一条倾斜的银道带。 — */
  _buildStars(){
    const N = 3400;
    const pos = new Float32Array(N * 3), sz = new Float32Array(N), tmp = new Float32Array(N);
    // 银道面的法线，与视轴和行星自转轴都错开，免得又出现一条与屏幕对齐的线
    const gn = new THREE.Vector3(0.36, 0.82, -0.44).normalize();
    const ga = new THREE.Vector3().crossVectors(gn, new THREE.Vector3(0, 1, 0)).normalize();
    const gb = new THREE.Vector3().crossVectors(gn, ga);

    for(let i = 0; i < N; i++){
      let x, y, z;
      if(i % 5 === 0){
        // 银道带：沿面内均匀、法向按高斯收窄
        const th = Math.random() * Math.PI * 2;
        const h = (Math.random() + Math.random() + Math.random() - 1.5) * 0.17;
        const c = Math.cos(th), s2 = Math.sin(th);
        x = ga.x * c + gb.x * s2 + gn.x * h;
        y = ga.y * c + gb.y * s2 + gn.y * h;
        z = ga.z * c + gb.z * s2 + gn.z * h;
        const L = Math.hypot(x, y, z) || 1;
        x /= L; y /= L; z /= L;
      }else{
        const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2;
        const s2 = Math.sqrt(1 - u * u);
        x = s2 * Math.cos(th); y = u; z = s2 * Math.sin(th);
      }
      const r = 42 + Math.random() * 14;
      pos[i*3] = x * r; pos[i*3+1] = y * r; pos[i*3+2] = z * r;
      sz[i] = Math.random() < 0.05 ? 0.30 : 0.045 + Math.random() * 0.095;
      // 偏向中段、少量走到两端：真实星场大多是白黄，蓝巨星和红矮星才是点缀
      tmp[i] = Math.min(1, Math.max(0, (Math.random() + Math.random() + Math.random()) / 3
                                        + (Math.random() - 0.5) * 0.55));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('aTemp', new THREE.BufferAttribute(tmp, 1));
    const m = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
      vertexShader:`
        attribute float aSize; attribute float aTemp;
        varying float vA; varying float vT;
        void main(){
          vA = aSize; vT = aTemp;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * 300.0 / -mv.z;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader:`
        varying float vA; varying float vT;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          if(d > 0.5) discard;
          // 光谱序列：橙红 → 白 → 蓝白
          vec3 col = vT < 0.5
            ? mix(vec3(1.00, 0.74, 0.55), vec3(1.00, 0.97, 0.92), vT * 2.0)
            : mix(vec3(1.00, 0.97, 0.92), vec3(0.74, 0.83, 1.00), (vT - 0.5) * 2.0);
          float a = (1.0 - d * 2.0) * clamp(vA * 6.0, 0.15, 0.95);
          gl_FragColor = vec4(col, a);
        }`
    });
    this.stars = new THREE.Points(g, m);
    this.scene.add(this.stars);
  }

  /* — 深度图。景深需要它，而它必须用和画面完全一致的顶点形变，
       否则碎片的深度会停在未碎裂的球面上。uniform 直接共用同一批对象。 — */
  _buildDepth(){
    this.depthRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer:true });
    const mk = (uni, vert, side) => new THREE.ShaderMaterial({
      uniforms: Object.assign({ uFar:{ value:DEPTH_FAR } }, uni),
      vertexShader: vert, fragmentShader: DEPTH_FRAG, side
    });
    this.depthMat = new Map([
      [this.planet,   mk(this.uPlanet,   PLANET_VERT, THREE.DoubleSide)],
      [this.mantle,   mk(this.uMantle,   PLANET_VERT, THREE.DoubleSide)],
      [this.coreBody, mk(this.uCoreBody, CORE_VERT,   THREE.FrontSide)]
    ]);
    // 透明层不写深度：它们本来就不该决定景深的对焦面
    this.depthHide = [this.clouds, this.atmo, this.foil, this.core, this.stars];
  }

  _renderDepth(){
    const vis = this.depthHide.map(o => o.visible);
    this.depthHide.forEach(o => { o.visible = false; });
    const keep = [];
    for(const [mesh, mat] of this.depthMat){
      keep.push(mesh.material);
      mesh.material = mat;
    }

    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.depthRT);
    this.renderer.setClearColor(0xffffff, 1);      // 空处 = 最远，星空因此会被虚化
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
    this.renderer.setClearColor(0x05070A, 1);

    let i = 0;
    for(const mesh of this.depthMat.keys()) mesh.material = keep[i++];
    this.depthHide.forEach((o, k) => { o.visible = vis[k]; });
  }

  /* — 断裂图样：把三角面归成碎块，再把每块的刚体属性摊回它的每个顶点。
       coarse 小于 1 表示裂得更大块——地幔比地壳韧，碎得也更粗。 — */
  _fracture(geo, coarse){
    const pos = geo.attributes.position;
    const n = pos.count;
    const cen = new Float32Array(n * 3);
    const dir = new Float32Array(n * 3);
    const axis = new Float32Array(n * 3);
    const rnd = new Float32Array(n);
    const mass = new Float32Array(n);

    // 一遍：把每个三角面归进碎块，顺便攒出各块的形心和面数
    const faces = n / 3;
    const keyOf = new Int32Array(faces);
    const blocks = new Map();
    for(let t = 0, f = 0; t < n; t += 3, f++){
      let cx = 0, cy = 0, cz = 0;
      for(let k = 0; k < 3; k++){
        cx += pos.getX(t + k); cy += pos.getY(t + k); cz += pos.getZ(t + k);
      }
      cx /= 3; cy /= 3; cz /= 3;

      // 归一化后再乘 coarse：不同半径的壳层才有可比的碎块尺度
      const inv = coarse / (Math.hypot(cx, cy, cz) || 1);
      const key = fractureCell(cx * inv, cy * inv, cz * inv);
      keyOf[f] = key;
      let b = blocks.get(key);
      if(!b){ b = { cx:0, cy:0, cz:0, c:0 }; blocks.set(key, b); }
      b.cx += cx; b.cy += cy; b.cz += cz; b.c++;
    }

    // 二遍：每块算一次刚体属性，整块共用——这才是「一块碎片」的含义
    for(const b of blocks.values()){
      b.cx /= b.c; b.cy /= b.c; b.cz /= b.c;

      let dx = b.cx + (Math.random() - 0.5) * 0.55;
      let dy = b.cy + (Math.random() - 0.5) * 0.55;
      let dz = b.cz + (Math.random() - 0.5) * 0.55;
      const L = Math.hypot(dx, dy, dz) || 1;
      b.dx = dx / L; b.dy = dy / L; b.dz = dz / L;

      let ax = Math.random() * 2 - 1, ay = Math.random() * 2 - 1, az = Math.random() * 2 - 1;
      const AL = Math.hypot(ax, ay, az) || 1;
      b.ax = ax / AL; b.ay = ay / AL; b.az = az / AL;

      b.rnd = Math.random();
      // 质量代理：面数开方后归一。同一份冲量下，它决定这块被推得多快、转得多急。
      b.mass = Math.min(1, Math.sqrt(b.c / 60));
    }

    for(let f = 0; f < faces; f++){
      const b = blocks.get(keyOf[f]);
      for(let k = 0; k < 3; k++){
        const v = f * 3 + k;
        cen[v*3] = b.cx; cen[v*3+1] = b.cy; cen[v*3+2] = b.cz;
        dir[v*3] = b.dx; dir[v*3+1] = b.dy; dir[v*3+2] = b.dz;
        axis[v*3] = b.ax; axis[v*3+1] = b.ay; axis[v*3+2] = b.az;
        rnd[v] = b.rnd;
        mass[v] = b.mass;
      }
    }
    geo.setAttribute('aCentroid', new THREE.BufferAttribute(cen, 3));
    geo.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    geo.setAttribute('aAxis', new THREE.BufferAttribute(axis, 3));
    geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 1));
    geo.setAttribute('aMass', new THREE.BufferAttribute(mass, 1));
    return geo;
  }

  /* — 行星。用 SphereGeometry 取其正确的等距柱状 UV；
       转 non-indexed 以便给每个三角面挂碎裂属性。 — */
  _buildPlanet(){
    const geo = this._fracture(new THREE.SphereGeometry(1, 128, 80).toNonIndexed(), 1.0);

    this.uPlanet = {
      uDay:{value:this.tex.day}, uNight:{value:this.tex.night},
      uSpec:{value:this.tex.spec}, uCloudTex:{value:this.tex.clouds},
      uTempLag:{value:new THREE.Vector4(288, 288, 288, 288)},
      uPop:{value:1}, uSpinUV:{value:0}, uCover:{value:0.5}, uWind:{value:0},
      uCrustT:{value:288}, uFire:{value:0}, uBurn:{value:0},
      uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1},
      uFracWin:{value:new THREE.Vector2(0.15, 0.09)}, uBurstK:{value:1.0},
      uCoreGlow:{value:0}
    };
    this.planet = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uPlanet, vertexShader:PLANET_VERT, fragmentShader:PLANET_FRAG,
      side:THREE.FrontSide
    }));
    this.scene.add(this.planet);
  }

  /* — 地幔：比地壳晚裂、碎得更大、飞得更慢。平时藏在不透明的地壳后面，
       只在引力挤压时才打开——完整球体挡着它，白渲一层没有意义。 — */
  _buildMantle(){
    const geo = this._fracture(new THREE.SphereGeometry(0.86, 96, 56).toNonIndexed(), 0.58);
    this.uMantle = {
      uLightDir:{value:this.lightDir},
      uFoilX:{value:-1.9}, uShatter:{value:0}, uSpread:{value:1},
      uFracWin:{value:new THREE.Vector2(0.27, 0.11)}, uBurstK:{value:0.62},
      uCoreGlow:{value:0}
    };
    this.mantle = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uMantle, vertexShader:PLANET_VERT, fragmentShader:MANTLE_FRAG,
      side:THREE.FrontSide
    }));
    this.mantle.visible = false;
    this.scene.add(this.mantle);
  }

  /* — 内核：不碎，只被压实、烧亮，最后作为余烬留在原地。
       它还是碎片内侧的光源，「里面有东西」主要靠那道光。 — */
  _buildCoreBody(){
    this.uCoreBody = { uSquash:{value:0}, uHeat:{value:0.5} };
    this.coreBody = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.40, 4),
      new THREE.ShaderMaterial({
        uniforms:this.uCoreBody, vertexShader:CORE_VERT, fragmentShader:CORE_BODY_FRAG
      })
    );
    this.coreBody.visible = false;
    this.scene.add(this.coreBody);
  }

  _buildClouds(){
    const geo = new THREE.SphereGeometry(1.012, 96, 60);
    this.uCloud = {
      uCloudTex:{value:this.tex.clouds},
      uSpinUV:{value:0}, uWind:{value:0}, uCover:{value:0.5}, uTint:{value:0},
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

  /* — 二向箔就是行星要塌缩进去的那个平面本身，所以它是水平的。
       早先它是一块竖直面片横着扫过去，压出来的却是一张水平的饼——刀面和切面
       差 90°，那是再怎么调亮度也救不回来的。现在它躺在 y≈0 上，前缘沿 X 推进，
       与压平后的薄片共面；未转换的那半边球会把前缘挡住，薄片从褶皱底下露出来。 — */
  _buildFoil(){
    const geo = new THREE.PlaneGeometry(FOIL_LEN, FOIL_WID);
    this.uFoil = { uOpacity:{value:0}, uTime:{value:0} };
    // depthTest 必须开。关掉它箔片就画在所有东西之上，永远不会被行星挡住——
    // 那是「贴在画面上的一道光」和「场景里的一个东西」之间最直接的区别。
    this.foil = new THREE.Mesh(geo, new THREE.ShaderMaterial({
      uniforms:this.uFoil, vertexShader:FOIL_VERT, fragmentShader:FOIL_FRAG,
      transparent:true, depthWrite:false, depthTest:true,
      blending:THREE.AdditiveBlending, side:THREE.DoubleSide
    }));
    this.foil.rotation.x = -Math.PI / 2;   // 躺平，法线沿 +Y
    this.foil.position.y = 0.06;           // 略高于薄片，免得共面打架
    this._placeFoil(-1.9);
    this.foil.renderOrder = 10;
    this.scene.add(this.foil);
  }

  // 前缘落在 x 处：面片中心要往后退半个身位
  _placeFoil(x){ this.foil.position.x = x - FOIL_LEN / 2; }

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
    this.camera.up.set(Math.sin(this.roll), Math.cos(this.roll), 0);
    // 视轴不锁死在球心。把主体钉在正中央是「浮在画面上」最直接的来源——
    // 没有任何真实机位能做到那件事。
    this.camera.lookAt(this.aimX, this.aimY, 0);
  }

  /* ── 外部接口 ── */

  // 只记录目标值。写进 uniform 的是 _dampEnv() 里按各自时间常数逼近的结果。
  setEnv(tempK, pressureAtm, popNorm){
    this.uPlanet.uPop.value = popNorm;
    const t = this.tgt;
    t.temp = tempK;

    // 云量：气压给上限，极端温度抑制（冻干 / 蒸散殆尽）
    const pc = Math.min(1, Math.pow(pressureAtm / 9, 0.60));
    const tk = Math.min(1, Math.max(0, (tempK - 150) / 120)) *
               Math.min(1, Math.max(0, (760 - tempK) / 180));
    // 海水蒸干的那一段，蒸汽会先把整颗星裹起来，再随高温散掉。
    // 少了这一步，海洋就是「悄悄变暗」——水去哪了？
    const steam = Math.min(1, Math.max(0, (tempK - 362) / 70)) *
                  Math.min(1, Math.max(0, (560 - tempK) / 130));
    t.cover = Math.min(1, pc * (0.25 + 0.75 * tk) + steam * 0.55);
    t.ctint = Math.min(1, Math.max(0, (tempK - 340) / 260));

    // 大气不能只听气压。地表干了会起沙尘、海干了会腾蒸汽、冻透了气体会冻析到
    // 地面——大气的厚度本来就是地表状态的一部分。少了这条耦合，地表怎么变，
    // 边上那圈光晕都纹丝不动，「只改了一层」的观感有一半来自这里。
    // 沙尘在荒漠温区达峰，熔融之前就该退掉——线性外推到八百度还满值，
    // 会把整层大气顶成橙色泛光，把地表糊掉
    const dust     = clamp01((tempK - 300) / 140) * clamp01((620 - tempK) / 140) * 0.45;
    const condense = clamp01((248 - tempK) / 90) * 0.42;    // 低温 → 气体冻析到地表
    t.density = Math.min(2.6, Math.pow(pressureAtm / 1.2, 0.55) * 0.80
                              * (1 + dust + steam * 0.55) * (1 - condense));
    // 高温大气偏橙（尘与硫），低温偏青白
    const hot = Math.min(1, Math.max(0, (tempK - 320) / 320));
    const cold = Math.min(1, Math.max(0, (250 - tempK) / 130));
    t.tr = 1 + hot * 1.10 + cold * 0.15;
    t.tg = 1 - hot * 0.22 + cold * 0.18;
    t.tb = 1 - hot * 0.62 + cold * 0.10;
  }

  _dampEnv(dt){
    const t = this.tgt, c = this.cur;
    if(this.warm){
      c.crust = damp(c.crust, t.temp, ENV_TAU.crust, dt);
      c.ice  = damp(c.ice,  t.temp, ENV_TAU.ice,  dt);
      c.sea  = damp(c.sea,  t.temp, ENV_TAU.sea,  dt);
      c.veg  = damp(c.veg,  t.temp, ENV_TAU.veg,  dt);
      c.rock = damp(c.rock, t.temp, ENV_TAU.rock, dt);
      c.cover   = damp(c.cover,   t.cover,   ENV_TAU.cloud, dt);
      c.ctint   = damp(c.ctint,   t.ctint,   ENV_TAU.cloud, dt);
      c.density = damp(c.density, t.density, ENV_TAU.air,   dt);
      c.tr = damp(c.tr, t.tr, ENV_TAU.air, dt);
      c.tg = damp(c.tg, t.tg, ENV_TAU.air, dt);
      c.tb = damp(c.tb, t.tb, ENV_TAU.air, dt);
    }else{
      Object.assign(c, { ice:t.temp, sea:t.temp, veg:t.temp, rock:t.temp, crust:t.temp,
                         cover:t.cover, ctint:t.ctint, density:t.density,
                         tr:t.tr, tg:t.tg, tb:t.tb });
      this.warm = true;
    }

    /* 热冲击 = 目标温度与植被通道之间的落差。慢慢拧滑块它始终接近零，
       猛地拉上去它会飙起来、再随慢通道追上而回落——这正是「生物圈跟不上」
       的量化形式，不必另外记录变化率。火灾就挂在它上面。 */
    const shock = clamp01((t.temp - c.veg) / 55);
    const flam  = clamp01((t.temp - 300) / 45) * clamp01((525 - t.temp) / 70);
    c.fire = damp(c.fire, shock * flam, 0.6, dt);
    // 过火面积：烧的时候涨，之后随植被恢复缓慢褪去（τ 约 22 秒）
    c.burn = Math.min(1, Math.max(0, c.burn + dt * (c.fire * 0.24 - c.burn * 0.045)));

    this.uPlanet.uTempLag.value.set(c.ice, c.veg, c.sea, c.rock);
    this.uPlanet.uCover.value = this.uCloud.uCover.value = c.cover;
    this.uCloud.uTint.value = c.ctint;
    this.uPlanet.uCrustT.value = c.crust;
    this.uPlanet.uFire.value = c.fire;
    this.uPlanet.uBurn.value = c.burn;
    // 燃烧本身也加载气溶胶，让大气跟着变浑
    const smoke = Math.min(0.55, c.fire * 1.1);
    this.uAtmo.uDensity.value = c.density * (1 + smoke * 0.45);
    this.uAtmo.uTint.value.setRGB(c.tr + smoke * 0.34, c.tg - smoke * 0.10, c.tb - smoke * 0.28);
  }

  triggerFoil(){
    if(this.state !== 'idle') return false;
    this.state = 'foil'; this.effectT = 0;
    return true;
  }

  triggerCrush(){
    if(this.state !== 'idle') return false;
    this.state = 'crush'; this.effectT = 0;
    // 碎开之后才看得到断面。完整球体是闭合的，背面全被剔掉也无妨，
    // 始终开双面等于白付一倍的片元着色。
    this.planet.material.side = THREE.DoubleSide;
    this.mantle.material.side = THREE.DoubleSide;
    this.mantle.visible = this.coreBody.visible = true;
    return true;
  }

  reset(){
    this.state = 'idle'; this.effectT = 0;
    this.trauma = 0; this.stop = 0; this.fractured = false;
    for(const u of [this.uPlanet, this.uCloud]){
      u.uFoilX.value = -1.9; u.uShatter.value = 0; u.uSpread.value = 1;
    }
    this.uAtmo.uFade.value = 1;
    this.uFoil.uOpacity.value = 0;
    this._placeFoil(-1.9);
    this.uCore.uOpacity.value = 0;
    this.core.visible = false;
    this.planet.material.side = THREE.FrontSide;
    this.mantle.material.side = THREE.FrontSide;
    this.mantle.visible = this.coreBody.visible = false;
    this.uMantle.uShatter.value = 0;
    this.uPlanet.uCoreGlow.value = this.uMantle.uCoreGlow.value = 0;
    this.uCoreBody.uSquash.value = 0; this.uCoreBody.uHeat.value = 0.5;
    this.camAz = 0; this.camEl = 0; this.camPush = 0;
    this.aimX = 0; this.aimY = 0; this.roll = CAM_TILT;
    this._applyCam();
  }

  update(dt){
    const edt = this._timeScale(dt);   // 场景时间：命中停顿期间被压慢
    this._dampEnv(edt);

    this.spin += edt * 0.055;
    const spinUV = this.spin / (Math.PI * 2);
    this.uPlanet.uSpinUV.value = spinUV;
    this.uCloud.uSpinUV.value = spinUV;
    // 云相对地面的位移交给纬向风带，不再是「整层比地表快 1.18 倍」那种刚体平移
    this.wind += edt * 0.0125;
    this.uPlanet.uWind.value = this.uCloud.uWind.value = this.wind;

    if(this.state === 'idle'){
      // 观测平台的漂移。原先是两条纯正弦，每约四十秒反向一次——那正是「浮在
      // 水里」的运动学签名：没有方向、没有尽头、完美光滑。改成噪声场：它不周期，
      // 方向能连续保持很久，读起来是被载着走而不是在原地上下晃。
      this.driftT += edt;
      const d = this.driftT;
      this.camAz = noise1(d * 0.021) * 0.17 + noise1(d * 0.079 + 11.0) * 0.030;
      this.camEl = noise1(d * 0.017 + 41.0) * 0.115 + 0.055;
      // 主体在画面里也要呼吸，连滚转一起漂
      this.aimX = noise1(d * 0.013 + 63.0) * 0.105;
      this.aimY = noise1(d * 0.011 + 87.0) * 0.080;
      this.roll = CAM_TILT + noise1(d * 0.009 + 29.0) * 0.05;
    }
    else if(this.state === 'foil'){
      this.effectT += edt / 7.4;                    // 全程约 7.4 秒，缓慢不可抗
      const t = Math.min(1, this.effectT);
      // 箔片是被投下的，不是被插值的：全程只会越来越快。早先用 smoothstep，
      // 末端速度归零，扫掠看起来像是自己停在了行星另一侧。
      const x = -1.9 + t * (0.74 + 0.26 * t) * 3.8;
      for(const u of [this.uPlanet, this.uCloud]) u.uFoilX.value = x;
      // 大气随压平进程整体淡出：二维空间里没有大气层
      this.uAtmo.uFade.value = 1 - this._ss(0.0, 0.62, t);
      this._placeFoil(x);
      this.uFoil.uTime.value = this.effectT;
      this.uFoil.uOpacity.value = Math.sin(Math.min(1, t * 1.12) * Math.PI) * 0.78;

      // 箔片压过行星期间的持续低鸣。它不是撞击，是那块空间在塌缩。
      if(x > -1.05 && x < 1.05) this.trauma = Math.max(this.trauma, 0.30);

      // 相机抢在箔片抵达前转到掠射角。正面观察压平是看不出来的——
      // 厚度归零需要视差才能读出，这一转是整个效果成立的前提。
      const c = Math.min(1, t / 0.24);
      const ce = c * c * (3 - 2 * c);
      this.camAz = ce * 0.30;
      this.camEl = ce * 0.36;
      this.camPush = ce * 1.25;

      if(t >= 1) this._finish();
    }
    else if(this.state === 'crush'){
      this.effectT += edt / 2.7;
      const t = Math.min(1, this.effectT);
      for(const u of [this.uPlanet, this.uCloud, this.uMantle]) u.uShatter.value = t;
      this.uAtmo.uFade.value = 1 - this._ss(0.0, 0.26, t);

      if(t < 0.17){
        this.trauma = Math.max(this.trauma, 0.10 + t * 1.2);   // 塌缩期越压越响
      }else if(!this.fractured){
        // 断裂。停顿、震动、闪光必须落在同一帧上，否则三件事各说各的。
        this.fractured = true;
        this.stop = STOP_HOLD + STOP_RAMP;
        this.trauma = 1;
        if(this.onShock) this.onShock();
      }

      // 断裂后退开，而且要退得比碎片云长得快——慢半拍就只剩一屏碎屑糊脸。
      // 这也是这一击唯一的镜头语言：做完了，然后往后站。
      this.camPush = this._ss(0.16, 0.95, this.effectT) * 2.40;

      this._updateInterior();

      // 辉光晕必须等碎片开始分离才亮——提前亮就是在一颗完整球体前面糊一团白
      const op = this._ss(0.17, 0.30, t) * (1 - this._ss(0.34, 0.72, t)) * 0.55;
      this.uCore.uOpacity.value = Math.max(0, op);
      this.core.visible = op > 0.002;
      const k = 0.42 + this._ss(0.15, 0.90, t) * 1.45;
      this.core.scale.set(k, k, 1);
      this.core.quaternion.copy(this.camera.quaternion);

      if(t >= 1) this._finish();
    }
    else if(this.state === 'done' && this.uPlanet.uShatter.value > 0 && this.effectT < 1.8){
      // 碎片不会在动画「结束」那一帧停住——真空里没有东西能让它们停下来。
      // 继续积分到 1.8：快的出画，慢的被残核引力拉回，剩下一团瓦砾。
      this.effectT += edt / 2.7;
      const v = Math.min(1.8, this.effectT);
      this.uPlanet.uShatter.value = this.uCloud.uShatter.value = this.uMantle.uShatter.value = v;
      this.camPush = 2.40 + this._ss(1.0, 1.8, v) * 1.20;
      this._updateInterior();
    }

    this._applyCam();
    this._shake(dt);          // 抖动走真实时间：停顿期间画面照样在震

    this._renderDepth();
    this.dof.uniforms.tDepth.value = this.depthRT.texture;
    // 对焦面永远落在行星中心：镜头退开时焦点要跟着退，否则一退就全虚了
    this.dof.uniforms.uFocus.value = (this.baseR + this.camPush) / DEPTH_FAR;
    this.grain.uniforms.uTime.value = (this.grain.uniforms.uTime.value + dt * 61.0) % 1000.0;

    this.composer.render();
  }

  /* 内核与地幔的状态。挂在 effectT 上而不是夹到 1 的 t 上，
     这样动画「结束」之后余烬还会继续冷下去。 */
  _updateInterior(){
    const e = this.effectT;
    // 压实：塌缩期越压越紧，断裂之后就定在那儿了
    this.uCoreBody.uSquash.value = Math.pow(Math.min(e, 0.30) / 0.30, 2.2) * 0.42;
    // 亮度：塌缩点火 → 断裂时最亮 → 之后作为余烬慢慢冷
    this.uCoreBody.uHeat.value = Math.max(
      0.12, 0.35 + this._ss(0.05, 0.24, e) * 1.60 - this._ss(0.34, 1.5, e) * 1.45);
    // 照亮碎片内侧的那道光，比内核本身收得快——碎片飞远后平方反比也会接管
    const g = this._ss(0.10, 0.26, e) * 1.10 - this._ss(0.38, 1.25, e) * 1.00;
    this.uPlanet.uCoreGlow.value = this.uMantle.uCoreGlow.value = Math.max(0, g);
  }

  // 命中停顿。先几乎冻住，再放回，返回缩放后的时间步。
  _timeScale(dt){
    if(this.stop <= 0) return dt;
    this.stop = Math.max(0, this.stop - dt);
    const k = this.stop > STOP_RAMP ? 0.14
                                    : 0.14 + 0.86 * (1 - this.stop / STOP_RAMP);
    return dt * k;
  }

  // 镜头震动。trauma 线性衰减，位移取其平方——人对强度的感知是指数的，
  // 平方让抖动起得猛、收得干净。抖旋转不抖平移：镜头是被震到，不是被推走，
  // 构图也就不会跑掉。
  _shake(dt){
    this.trauma = Math.max(0, this.trauma - dt * 1.35);
    if(this.trauma <= 0.001) return;
    const a = this.trauma * this.trauma;
    this.shakeT += dt;
    const f = this.shakeT * 26;
    this.camera.rotateX(noise1(f)        * a * 0.050);
    this.camera.rotateY(noise1(f + 37.1) * a * 0.044);
    this.camera.rotateZ(noise1(f + 91.7) * a * 0.062);
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
      // 深度图与合成链同分辨率；模糊半径按像素给，所以要连 dpr 一起算
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      this.depthRT.setSize(pw, ph);
      this.dof.uniforms.uTexel.value.set(1 / pw, 1 / ph);
      this.dof.uniforms.uMax.value = Math.max(3, ph * 0.008);
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
