# 降维打击模拟器

扮演高维文明，操控一颗行星的温度与气压，观察其上文明的兴衰；或投放二向箔把它压成二维，
或用引力把它挤碎。支持摄像头手势输入：**握拳 = 引力挤压，摊开手掌 = 二向箔投放**。

纯静态站点，无构建步骤。Three.js 自研 shader + MediaPipe 手势识别。

美术方向是**照片级写实**：NASA 底图作基底，温度/气压的效果以程序化图层叠加其上——
冰盖、荒漠化、海洋蒸干、熔融裂缝各自是一层遮罩。贴图保证质感，程序化图层保证滑块
仍然有效。地表影像来自 [Solar System Scope](https://www.solarsystemscope.com/textures/)，
授权 CC BY 4.0，页面内已署名。

## 快速开始

```bash
bash fetch-assets.sh && python serve.py 8123
```

打开 http://localhost:8123 。`localhost` 属于安全上下文，摄像头可用。

`fetch-assets.sh` 拉的是两样二进制产物（合计约 18MB，不入 git）：MediaPipe 的 WASM
运行时和手势识别模型。脚本幂等，已存在就跳过。**不跑它页面也能开**——星球、滑块、
两种打击效果全部可用，只有摄像头手势会报「不可用」。

## 线上地址

**https://mr-salticidae.github.io/dimension-strike/**

GitHub Pages，`gh-pages` 分支根目录，强制 HTTPS（摄像头可用）。更新站点：

```bash
bash fetch-assets.sh && bash deploy.sh
```

`deploy.sh` 把当前目录连同二进制产物一并推到 `gh-pages`——那些文件在 main 里被
`.gitignore` 排除，而 Pages 没有构建步骤可以跑 `fetch-assets.sh`，只能由部署分支带着。

Pages 自己就把下面第 1、3 条办妥了：`.js`/`.mjs` 回 `text/javascript`、`.wasm` 回
`application/wasm`，gzip 默认开着（9.5MB 的 WASM 实际传 2.9MB）。唯一办不到的是自定义
响应头，所以 COOP/COEP 那对跨源隔离头没有，MediaPipe 会走 XNNPACK 而非 GPU delegate ——
手势识别照常工作，只是吃 CPU。

## 部署（其他环境）

拷贝整个目录到任意 Web 服务器即可，但有三件事必须确认：

**1. 必须 HTTPS。** `getUserMedia` 只在安全上下文下可用。纯 HTTP 域名下页面照常渲染、
滑块和按钮都能用，但摄像头会被浏览器直接拒绝（页面会显示「需 HTTPS」）。

**2. 二进制依赖要单独拉。** `models/*.task` 和 `vendor/wasm/` 都在 `.gitignore` 里，
部署后跑一次 `bash fetch-assets.sh`。

**3. MIME 类型要配对。** `.mjs` 和 `.wasm` 如果回错类型，ES module 导入和 WASM 实例化
都会静默失败。nginx 参考配置：

```nginx
types {
    text/javascript   js mjs;
    application/wasm  wasm;
}

gzip on;
gzip_types text/javascript application/wasm application/json text/css;
gzip_min_length 1024;
# .task 本身是 zip 包，再压无益
gzip_proxied any;

# 可选：为 MediaPipe 的 GPU delegate 开启跨源隔离
add_header Cross-Origin-Opener-Policy   same-origin;
add_header Cross-Origin-Embedder-Policy credentialless;
```

## 体积

| 阶段 | 传输量 | 说明 |
|---|---|---|
| 首屏 | **1.3 MB** | Three.js + 页面代码，星球立即可玩 |
| 点「开启摄像头」后 | +19 MB | MediaPipe 运行时 9.5MB + 模型 8.4MB |

手势模块走动态 `import()`，不开摄像头的访客永远不会下载这 19MB。
WASM 经 gzip 约 3MB，务必开压缩。

## 代码结构

```
index.html          HUD 结构
css/style.css       控制台样式。颜色叙事：琥珀=文明，冷蓝=观测者
js/planet.js        Three.js 场景与全部 shader（行星/大气/云层/二向箔/内核）
js/civ.js           文明状态演化与通讯记录
js/gesture.js       MediaPipe GestureRecognizer 封装
js/main.js          装配与主循环
vendor/             Three.js（入 git）、MediaPipe 运行时（fetch-assets.sh 拉取）
models/             手势模型（fetch-assets.sh 拉取）
serve.py            开发服务器。补了 .mjs / .wasm 的 MIME，内置 http.server 不认
```

## 实现要点

几个踩过的坑，改动前先读：

**行星网格永不旋转。** 自转是 shader 里偏移噪声采样实现的（`uSpin`）。这样物体空间的
坐标轴相对场景恒定，二向箔沿固定平面压缩才不会跟着转。想改自转方式前先想清楚这一点。

**二向箔沿 Y 轴塌缩到水平面，不是沿视线方向。** 正对相机压平是看不出来的——厚度归零
需要视差才能读出。塌缩到水平面 + 相机俯角掠射，才能看见那片薄片。相机在扫掠开始的
前 24% 就转到位，赶在箔片抵达行星之前。

**压平量是逐顶点算的**（`flatAmount()` 按顶点 x 相对箔片位置），所以扫掠中途会出现
「左半边已是二维画、右半边还是球体」的画面——那是整个效果最好的一帧。

**光源在 +X。** 箔片由 -X 扫向 +X，残留的三维半球必须留在受光面，否则最后剩下的是一
团黑影。

**`IcosahedronGeometry` 的 detail 是每面切 `(detail+1)²`，不是 `4^detail`。**
当前 detail 28 = 20×29² = 16820 面，碎片投影约 9px。

**云层和大气只压平、不碎裂。** 它们调 `flatten()` 而非 `deform()`，挤压时整体消散。
早期版本让它们走了碎片路径，结果整个云壳作为一个刚体在翻滚。

**碎片余温挂在「分离度」`burst` 上，不是总进度 `uShatter`。** 挂错了会让尚未裂开的
完整球体整颗自发光，配合 bloom 就是一个纯白圆盘。内核辉光同理，必须等碎片开始分离。

**碎片的翻滚轴 `aAxis` 与飞散方向 `aDir` 必须独立。** 共用一个的话碎片只会绕自己的
飞行轴自旋、始终正对镜头，看起来是一地彩纸屑。飞散速度用 `rnd³` 拉长尾，
少数冲得远、多数留在近处。

## 渲染管线

场景在**线性 HDR 空间**渲染，自发光项（城市灯火 / 岩浆 / 海洋高光 / 箔片 / 内核）
刻意输出大于 1.0 的值，由 `UnrealBloomPass` 提取溢出，最后 `OutputPass` 做 ACES
色调映射并转 sRGB。

**bloom 阈值 1.10 高于一切漫反射表面的峰值**（冰约 1.03、云 0.90），因此只有自发光项
参与溢出：岩浆 3.2 / 灯火 2.3 / 海面反射 1.9 / 箔片 / 内核。这比逐个压低材质亮度干净
得多——早期版本把阈值压到 0.78，结果得反复为云和冰反推系数，压暗了又比海面还暗。

**终结线过渡区要窄。** `smoothstep(-0.06, 0.14, ndl)`。过宽（早期是 0.48 的跨度）会在
高反照率表面上把明暗交界拉成一大片渐变，行星边缘读起来是糊的而不是轮廓。

**网格永不旋转，自转靠 UV 横向偏移**（贴图 `RepeatWrapping` 自动环绕，导数连续、无接缝；
不要用 `fract()`，那会把不连续点挪到画面中间）。这样二向箔沿固定世界平面压缩才不会跟着
转，光照也能直接用世界系法线对太阳，省掉一整套坐标系换算。

**大气是解析式单次散射，不是球壳边缘光。** 对每条视线求它实际穿过大气层的弦长再沿途
积分，密度随高度指数衰减，所以到外缘自然归零。早先用球壳 + fresnel，球壳的几何外边界
就成了一层肉眼可见的「膜」——那是形状带来的，调参数救不回来。

散射系数按量纲反推，别凭手感调：掠射路径长约 1.09、平均密度约 0.5，要让蓝端光学深度
落在 1.5 附近（exp 内已乘 2.30），太阳方向的系数就该是 1.2 量级。设成 7.5 会把日面的
蓝光全散掉，只剩一圈过曝白边。日落的红色是算出来的，不是调出来的——蓝光散射最强，
穿过厚大气时先被散掉。

大气厚度 Ra=1.14 是夸张值（地球真实约 1.016，在这个尺度下几乎看不见）。取到 1.55
会让大气占满整个视场。薄壳积分必须加逐像素抖动，等距采样会留下同心条纹。

**温度效果全部是叠在贴图上的遮罩**，见 `PLANET_FRAG` 中依次排列的四段：冰盖按纬度推进、
荒漠化靠绿通道占优识别植被、海洋蒸干用水体遮罩、熔融用程序化噪声画裂缝。改温度阈值只需
动这几段的 `smoothstep` 边界。

## 调参

`js/civ.js` 顶部是文明模型的常数（理想温度 288K、理想气压 1atm、基准人口）。
通讯记录的文案在 `_check()` 里，按触发条件排列。

`js/planet.js` 的 `setEnv()` 把温度气压映射到云量、大气密度和颜色；
`PLANET_FRAG` 里是地表配色与各种阈值（冰线、干旱度、沸腾、熔融）。
