// 第 3,241 号文明 —— 状态演化与通讯记录
//
// 设计意图：读数保持临床式的冷静，文明的声音从中穿透出来。
// 反差本身就是内容——你在无所谓地拖滑块，他们在里面经历纪元。

const IDEAL_T = 288;      // K
const IDEAL_P = 1.0;      // atm
const POP_BASE = 78.4;    // 亿

export class Civilization {
  constructor(){ this.reset(); }

  reset(){
    this.pop = 1;
    this.tech = 2.41;
    this.hab = 1;
    this.effHab = 1;
    this.dead = false;
    this.struck = null;
    this.fired = new Set();
    this.cooldown = 0;
    this.minPop = 1;
    this.queue = [];
    this.elapsed = 0;
  }

  /** 宜居指数：温度按线性尺度、气压按对数尺度各自衰减 */
  static habitability(T, P){
    const t = Math.exp(-Math.pow((T - IDEAL_T) / 44, 2));
    if(P < 0.008) return 0;
    const p = Math.exp(-Math.pow(Math.log(P / IDEAL_P) / 0.98, 2));
    return t * p;
  }

  update(dt, T, P){
    if(this.struck) return;
    this.elapsed += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);

    this.hab = Civilization.habitability(T, P);

    // 技术抵抗：等级 2.0 以上开始能对抗环境，但有上限
    const resist = Math.max(0, Math.min(0.30, (this.tech - 2.0) * 0.17));
    this.effHab = Math.min(1, this.hab + resist * (this.pop > 0.08 ? 1 : 0));

    // 人口：死得快，长得慢
    const prevPop = this.pop;
    const rate = this.effHab < this.pop ? 0.62 : 0.085;
    this.pop += (this.effHab - this.pop) * rate * dt;
    if(this.pop < 0.004) this.pop = 0;
    this.minPop = Math.min(this.minPop, this.pop);

    // 技术：人口稳定时缓慢积累
    if(this.pop > 0.22) this.tech += dt * 0.016 * this.pop;

    this._check(T, P, prevPop, resist);
  }

  _say(id, text, tone){
    if(this.fired.has(id)) return;
    if(this.cooldown > 0 && tone !== 'final') return;
    this.fired.add(id);
    this.cooldown = tone === 'final' ? 0 : 1.4;
    this.queue.push({ text, tone: tone || 'normal' });
  }

  _check(T, P, prevPop, resist){
    this._say('hello', '检测到窄带信号。第 3,241 号文明向未知观察者致意。');

    // ── 温度
    if(T > 302) this._say('warm', '行星均温上升 14 K。他们注意到了，归因于恒星活动周期。');
    if(T > 334) this._say('hot1', '赤道带作物连续三季绝收。人口开始向两极迁徙。');
    if(T > 402) this._say('hot2', '海洋表层沸腾。对外广播中止，转为地下求生。');
    if(T > 620) this._say('hot3', '地表已无液态水。仍有七座避难所在运转。');
    if(T < 262) this._say('cold1', '冰盖越过北纬 40 度。他们烧掉了最后的森林。');
    if(T < 228) this._say('cold2', '海洋封冻。地热城市成为唯一的居住形式。');
    if(T < 196) this._say('cold3', '信号收束至单一坐标，循环播发一段乐曲。');

    // ── 气压
    if(P < 0.42) this._say('thin1', '大气正在逃逸。十二座城市加盖了穹顶。');
    if(P < 0.09) this._say('thin2', '穹顶结构相继失效。');
    if(P > 7.5) this._say('thick1', '大气压达到标准值七倍。地表建筑被逐一压毁。');
    if(P > 24) this._say('thick2', '地壳承压超限。没有信号传出。');

    // ── 技术抵抗（他们真的在反击）
    if(resist > 0.11 && this.hab < 0.55)
      this._say('resist', '他们在拉格朗日点建起了反射镜阵列。有效。暂时。');

    // ── 人口节点
    if(this.pop < 0.52) this._say('p50', '人口减半。广播内容从问候变成了坐标。');
    if(this.pop < 0.21) this._say('p20', '第 3,241 号文明请求对话。任何形式的对话。');
    if(this.pop < 0.06) this._say('p05', '广播功率衰减至背景噪声水平。');
    if(this.pop <= 0 && prevPop > 0){
      this.dead = true;
      this._say('gone', '……信号中断。', 'final');
    }

    // ── 恢复（奖励把参数调回来的人）
    if(this.minPop < 0.32 && this.pop > 0.72 && !this.dead)
      this._say('revive', '人口回升。他们把这段时期写进经典，称之为「长夜」。');
  }

  /** 发动打击 */
  strike(kind){
    this.struck = kind;
    this.pop = 0;
    this.dead = true;
  }

  verdict(){
    return this.struck === 'foil'
      ? '跌落到二维的过程持续了 1,341 年。\n从他们的视角看，宇宙只是慢慢变薄了。'
      : '行星解体耗时 94 秒。\n第 3,241 号文明未能发出任何讯息。';
  }

  /** 取出待播报的消息并清空队列 */
  drain(){ const q = this.queue; this.queue = []; return q; }

  get popText(){
    const v = this.pop * POP_BASE;
    if(v <= 0) return '0';
    if(v < 0.01) return '< 100 万';
    if(v < 1) return (v * 10000).toFixed(0) + ' 万';
    return v.toFixed(1) + ' 亿';
  }
  get techText(){ return this.tech.toFixed(2); }
  get habText(){ return this.hab.toFixed(2); }
}
