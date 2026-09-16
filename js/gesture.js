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

export class GestureInput {
  constructor({ video, canvas, onGesture, onState }){
    this.video = video;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onGesture = onGesture;
    this.onState = onState || (() => {});

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

    const top = res?.gestures?.[0]?.[0];
    const g = (top && top.score >= MIN_SCORE && WANTED[top.categoryName]) || null;

    if(g === this.held){ this.heldCount++; }
    else { this.held = g; this.heldCount = 1; }

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
