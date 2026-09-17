// 降维打击模拟器 —— 装配
import { PlanetStage } from './planet.js';
import { Civilization } from './civ.js';
// gesture.js 走动态 import：它会拖进 11MB 的 MediaPipe 运行时和 8MB 模型，
// 而绝大多数访客从不开摄像头。等点了「开启摄像头」再加载。

const $ = id => document.getElementById(id);

const el = {
  stage:$('stage'), temp:$('temp'), pres:$('pres'), tempOut:$('tempOut'), presOut:$('presOut'),
  reset:$('reset'), statusTag:$('statusTag'), pop:$('popOut'), tech:$('techOut'),
  hab:$('habOut'), habBar:$('habBar'), log:$('log'),
  crush:$('crush'), foil:$('foil'), flash:$('flash'),
  verdict:$('verdict'), verdictText:$('verdictText'),
  cam:$('cam'), camBtn:$('camBtn'), video:$('video'), hand:$('hand'), gestState:$('gestState'),
  again:$('again'), specId:$('specId'), specTag:$('specTag')
};

const stage = new PlanetStage(el.stage);
const civ = new Civilization();
window.__ds = { stage, civ };   // 调试用句柄

/* ── 气压：对数刻度。滑块 0..100 → 0.01..100 atm，50 处正好 1 atm ── */
const toPressure = v => Math.pow(10, (v - 50) / 25);
const fmtPressure = p =>
  p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(2) : p >= 0.1 ? p.toFixed(3) : p.toFixed(4);

let T = 288, P = 1;

function readControls(){
  T = +el.temp.value;
  P = toPressure(+el.pres.value);
  el.tempOut.innerHTML = `${T}<i>K</i>`;
  el.presOut.innerHTML = `${fmtPressure(P)}<i>atm</i>`;
}
el.temp.addEventListener('input', readControls);
el.pres.addEventListener('input', readControls);
readControls();

/* ── 琥珀抽干：文明消亡时，界面上代表「他们」的颜色向死灰收敛 ── */
const AMBER = [232, 176, 75], DEAD = [90, 103, 115];
let shownAmber = -1;
function paintLife(life){
  const q = Math.round(life * 24) / 24;          // 量化，避免每帧写样式
  if(q === shownAmber) return;
  shownAmber = q;
  const c = AMBER.map((a, i) => Math.round(DEAD[i] + (a - DEAD[i]) * q));
  document.documentElement.style.setProperty('--amber-live', `rgb(${c.join(',')})`);
}

/* ── 通讯记录 ── */
let year = 0;
function pushLog({ text, tone }){
  const li = document.createElement('li');
  li.className = tone === 'final' ? 'is-final' : 'is-new';
  const t = document.createElement('time');
  t.textContent = `T+${String(Math.floor(year)).padStart(4, '0')} 标准年`;
  li.appendChild(t);
  li.appendChild(document.createTextNode(text));
  el.log.appendChild(li);
  // 仅最新一条高亮
  [...el.log.children].forEach(n => { if(n !== li && n.classList.contains('is-new')) n.classList.remove('is-new'); });
  while(el.log.children.length > 14) el.log.removeChild(el.log.firstChild);
}

/* ── 状态标签 ── */
function statusOf(){
  if(civ.struck === 'foil') return ['二维化', true];
  if(civ.struck === 'crush') return ['已解体', true];
  if(civ.dead) return ['SILENT', true];
  if(civ.pop < 0.25) return ['CRITICAL', true];
  if(civ.pop < 0.7) return ['STRESSED', false];
  return ['OBSERVING', false];
}

/* ── 打击 ── */
function fire(kind){
  if(civ.struck) return;
  const ok = kind === 'foil' ? stage.triggerFoil() : stage.triggerCrush();
  if(!ok) return;
  civ.strike(kind);
  el.crush.disabled = el.foil.disabled = true;
}

// 闪光挂在断裂那一帧上，不能按秒数预定：命中停顿会把场景时间拉长，
// 写死的延时必然和画面错开。
stage.onShock = () => {
  el.flash.animate(
    [{ opacity:0 }, { opacity:.88, offset:.08 }, { opacity:0 }],
    { duration:520, easing:'ease-out' }
  );
};

function showVerdict(){
  if(el.verdict.classList.contains('is-on')) return;
  el.verdictText.textContent = civ.verdict();
  el.verdict.classList.add('is-on');
  el.verdict.setAttribute('aria-hidden', 'false');
}
stage.onEffectEnd = showVerdict;

/* ── 重玩：换下一个样本 ──
   编号只往上走，其余一律不变——对观测者而言它们本来就是可互换的。
   这比「重新开始」更贴这个设定：你不是在重来，你是在处理下一个。 */
function newSpecimen(){
  civ.nextSpecimen();
  stage.reset();
  year = 0; shownAmber = -1;
  el.log.replaceChildren();
  el.crush.disabled = el.foil.disabled = false;
  el.verdict.classList.remove('is-on');
  el.verdict.setAttribute('aria-hidden', 'true');
  el.specId.textContent = civ.idText;
  el.specTag.textContent = civ.tag;
  el.temp.value = 288; el.pres.value = 50;
  readControls();
}
el.again.addEventListener('click', newSpecimen);

el.crush.addEventListener('click', () => fire('crush'));
el.foil.addEventListener('click', () => fire('foil'));

/* ── 操控：像转地球仪一样转它 ──
   指针事件只挂在画布上，HUD 面板是它上层的独立元素，落在面板上的按下不会到这儿来。
   用 pointer 事件而不是 mouse/touch 两套：一套代码同时吃鼠标、触摸和手写笔。 */
let dragId = null, lastX = 0, lastY = 0;

el.stage.addEventListener('pointerdown', ev => {
  if(dragId !== null || !stage.grab()) return;
  dragId = ev.pointerId;
  lastX = ev.clientX; lastY = ev.clientY;
  el.stage.setPointerCapture(dragId);   // 拖出画布外也不丢事件
  el.stage.classList.add('is-grabbing');
});

el.stage.addEventListener('pointermove', ev => {
  if(ev.pointerId !== dragId) return;
  stage.dragBy(ev.clientX - lastX, ev.clientY - lastY);
  lastX = ev.clientX; lastY = ev.clientY;
});

const endDrag = ev => {
  if(ev.pointerId !== dragId) return;
  stage.release();
  el.stage.classList.remove('is-grabbing');
  dragId = null;
};
el.stage.addEventListener('pointerup', endDrag);
el.stage.addEventListener('pointercancel', endDrag);

/* ── 复位 ── */
el.reset.addEventListener('click', () => {
  el.temp.value = 288; el.pres.value = 50;
  readControls();
  civ.reset(); stage.reset();
  year = 0; shownAmber = -1;
  el.log.replaceChildren();
  el.crush.disabled = el.foil.disabled = false;
  el.verdict.classList.remove('is-on');
  el.verdict.setAttribute('aria-hidden', 'true');
});

/* ── 手势 ── */
const setGestState = (txt, cls) => {
  el.gestState.textContent = txt;
  el.gestState.className = 'cam-state' + (cls ? ` is-${cls}` : '');
};

let gesture = null;
async function ensureGesture(){
  if(gesture) return gesture;
  setGestState('加载中…');
  const { GestureInput } = await import('./gesture.js');
  gesture = new GestureInput({
    video: el.video,
    canvas: el.hand,
    onGesture: g => fire(g === 'fist' ? 'crush' : 'foil'),
    onState: setGestState,
    // 手势拨动走和鼠标完全相同的那条通路，惯性、封顶、打击期禁用一并继承。
    // 指针优先：真有人在拖的时候，别让摄像头和他抢同一颗星球。
    onDrag: (kind, dx, dy) => {
      if(dragId !== null) return;
      if(kind === 'start') stage.grab();
      else if(kind === 'move') stage.dragBy(dx, dy);
      else stage.release();
    }
  });
  return gesture;
}

let camOn = false;
el.camBtn.addEventListener('click', async () => {
  if(camOn){
    gesture?.stop(); camOn = false;
    el.cam.classList.remove('is-live');
    el.camBtn.textContent = '开启摄像头';
    return;
  }
  el.camBtn.disabled = true;
  try{
    await (await ensureGesture()).start();
    camOn = true;
    el.cam.classList.add('is-live');
    el.camBtn.textContent = '关闭摄像头';
  }catch(err){
    console.error('[手势]', err);
    el.gestState.textContent = el.gestState.textContent.includes('需 HTTPS') ? '需 HTTPS' : '不可用';
    el.gestState.className = 'cam-state is-err';
  }finally{
    el.camBtn.disabled = false;
  }
});

/* ── 主循环 ── */
let last = performance.now();
function frame(now){
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if(!civ.struck) year += dt * 47;     // 你拖一秒，他们过四十七年

  civ.update(dt, T, P, stage.spinAnomaly);
  stage.setEnv(T, P, civ.pop);
  stage.update(dt);

  el.pop.textContent = civ.popText;
  el.tech.textContent = civ.techText;
  el.hab.textContent = civ.habText;
  el.habBar.style.width = (civ.hab * 100).toFixed(1) + '%';

  const [tag, alert] = statusOf();
  if(el.statusTag.textContent !== tag){
    el.statusTag.textContent = tag;
    el.statusTag.classList.toggle('is-alert', alert);
  }

  paintLife(civ.struck ? 0 : civ.pop);
  for(const m of civ.drain()) pushLog(m);

  // 不动手也能把他们耗光。那条路径原先没有结局也没有出口，只剩一颗空行星。
  if(civ.dead && !civ.struck) showVerdict();
}
requestAnimationFrame(frame);

addEventListener('resize', () => stage.resize());
