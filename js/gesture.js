// 手势输入 —— MediaPipe GestureRecognizer
//
// 用官方训练好的手势分类器，而不是自己量关节距离定阈值：
// 模型直接输出 Closed_Fist / Open_Palm 等八类标签并带置信度，
// 对光照、手的朝向和个体差异的鲁棒性远好于手搓规则。
// gesture_recognizer.task 内部已打包 hand_landmarker，无需另外加载。
//
// 路径解析有两套规则，别写混：
//   import 语句  → 相对本模块（js/），故用 '../vendor/...'
//   运行时 fetch → 相对文档 URL（根目录），故用 './vendor/...'
//
// 资源全部本地化，不访问 storage.googleapis.com，国内可直连。

import { GestureRecognizer, FilesetResolver } from '../vendor/vision_bundle.mjs';

const CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17]
];

// 只关心这两个，其余（Victory / Thumb_Up …）一律当作无输入
const WANTED = { Closed_Fist:'fist', Open_Palm:'palm' };
const MIN_SCORE = 0.62;
const HOLD_FRAMES = 6;     // 约 0.2 秒，防抖

/* 拨动：手在画面里移动多少，折算成多少「像素」交给舞台，用的是和鼠标同一条通路。
   0.5 个归一化单位（半个画面）约合 350px，也就是两个多弧度——一次挥手拨小半圈。
   x 要取反：预览用 scaleX(-1) 做了镜像，而关键点是原始图像坐标，不反过来
   手往右挥星球会往左转。 */
const DRAG_PX_X = -700, DRAG_PX_Y = 500;
const PALM_SMOOTH = 0.35;   // 关键点抖得厉害，差分前必须低通，否则星球自己会发抖
const DEAD_ZONE = 0.0015;   // 低于这个位移当作静止，免得握着不动也在慢慢转

export class GestureInput {
  constructor({ video, canvas, onGesture, onState, onDrag }){
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onGesture = onGesture;
    this.onState = onState || (() => {});
    this.onDrag = onDrag || (() => {});
    this.palm = null;        // 低通后的掌心位置
    this.dragging = false;

    this.rec = null;
    this.stream = null;
    this.running = false;
    this.lastVideoTime = -1;
    this.held = null;
    this.heldCount = 0;
    this.armed = true;     // 发动一次后需回到无手势才重新武装
  }

  async start(){
    if(!window.isSecureContext){
      this.onState('需 HTTPS', 'err');
      throw new Error('getUserMedia 需要安全上下文（HTTPS 或 localhost）');
    }
    if(!navigator.mediaDevices?.getUserMedia){
      this.onState('不支持', 'err');
      throw new Error('此浏览器不支持 getUserMedia');
    }

    this.onState('加载模型…');
    const fileset = await FilesetResolver.forVisionTasks('./vendor/wasm');
    this.rec = await GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: './models/gesture_recognizer.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 1,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.6,
      minTrackingConfidence: 0.6
    });

    this.onState('请求摄像头…');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
    this.video.srcObject = this.stream;
    await this.video.play();

    this.canvas.width = this.video.videoWidth || 640;
    this.canvas.height = this.video.videoHeight || 480;

    this.running = true;
    this.onState('待机', 'live');
    this._loop();
  }

  stop(){
    this.running = false;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.held = null; this.heldCount = 0; this.armed = true;
    this._endDrag();
    this.onState('未启用');
  }

  _loop(){
    if(!this.running) return;
    requestAnimationFrame(() => this._loop());

    if(this.video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = this.video.currentTime;

    let res;
    try{
      res = this.rec.recognizeForVideo(this.video, performance.now());
    }catch{ return; }

    this._draw(res?.landmarks?.[0]);

    const lm = res?.landmarks?.[0];
    const top = res?.gestures?.[0]?.[0];
    const g = (top && top.score >= MIN_SCORE && WANTED[top.categoryName]) || null;

    if(g === this.held){ this.heldCount++; }
    else { this.held = g; this.heldCount = 1; }

    // 握拳和摊掌是武器，其余一切姿势都是「拨」：手在那儿、又没在下令，
    // 那就是在推这颗星球。不给它单独指定一个手势，是为了不用先学会什么。
    if(lm && !g){
      this._drag(lm);
      return;
    }
    this._endDrag();

    if(!g){
      this.armed = true;
      this.onState('待机', 'live');
      return;
    }

    const label = g === 'fist' ? '握拳' : '摊掌';
    if(this.heldCount < HOLD_FRAMES){
      this.onState(`${label} ${this.heldCount}/${HOLD_FRAMES}`, 'live');
      return;
    }

    this.onState(`${label} ${(top.score * 100).toFixed(0)}%`, 'live');
    if(this.armed){
      this.armed = false;
      this.onGesture(g);
    }
  }

  /* 掌心取腕点与四个掌指关节的平均：比任何单点都稳，手指乱动也不会带偏。 */
  _drag(lm){
    let cx = 0, cy = 0;
    for(const i of [0, 5, 9, 13, 17]){ cx += lm[i].x; cy += lm[i].y; }
    cx /= 5; cy /= 5;

    if(!this.palm){
      this.palm = { x:cx, y:cy };
      this.dragging = true;
      this.onDrag('start');
      this.onState('拨动', 'live');
      return;
    }

    const px = this.palm.x, py = this.palm.y;
    this.palm.x += (cx - px) * PALM_SMOOTH;
    this.palm.y += (cy - py) * PALM_SMOOTH;

    const dx = this.palm.x - px, dy = this.palm.y - py;
    if(Math.abs(dx) > DEAD_ZONE || Math.abs(dy) > DEAD_ZONE){
      this.onDrag('move', dx * DRAG_PX_X, dy * DRAG_PX_Y);
    }
    this.onState('拨动', 'live');
  }

  _endDrag(){
    this.palm = null;
    if(this.dragging){ this.dragging = false; this.onDrag('end'); }
  }

  _draw(lm){
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    if(!lm) return;

    const amber = getComputedStyle(document.documentElement)
      .getPropertyValue('--amber-live').trim() || '#E8B04B';

    ctx.strokeStyle = amber;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for(const [a, b] of CONNECTIONS){
      ctx.moveTo(lm[a].x * W, lm[a].y * H);
      ctx.lineTo(lm[b].x * W, lm[b].y * H);
    }
    ctx.stroke();

    ctx.fillStyle = amber;
    ctx.globalAlpha = 1;
    for(const p of lm){
      ctx.beginPath();
      ctx.arc(p.x * W, p.y * H, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
