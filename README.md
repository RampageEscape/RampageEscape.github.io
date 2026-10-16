# Rampage Escape 暴走大逃亡

**▶ 線上遊玩 / Play online：https://rampageescape.github.io/**

作者 / Author：[@jimyauuu06](https://github.com/jimyauuu06)

2.5D 等距视角的街机风警车追逐游戏，低多边形风格。现阶段是网页版原型（Three.js），可以在手机浏览器里玩；以后再移植到 iOS/Android（`unity/Scripts/` 里是对应的 C# 脚本）。

游戏界面支持**繁体中文**（默认）和 **English**，标题和结算画面右上角一键切换，选择会被记住。文案都在 `src/i18n.js`。

## 部署

网站托管在 GitHub Pages（免费、HTTPS、全球 CDN），从 `main` 分支根目录直接发布。推送到 `main` 后一两分钟自动更新，不需要另外操作。Three.js 已经放在 `vendor/` 里，不依赖外部 CDN。车辆 3D 模型来自 [Kenney Car Kit](https://kenney.nl/assets/car-kit)（CC0）。

## 玩法

| 操作 | 手机 | 电脑 |
|---|---|---|
| 变道 | 左右滑 | ← → / A D |
| 加速 / 刹车 | 上下滑 | ↑ ↓ / W S |
| 路口选路 | 开到对应车道（路面有箭头），或直接点选项 | 同左 |
| 冲刺（无敌，撞毁警车） | 双击屏幕或点 DASH | 空格 |
| 开炮（坦克） | 点 FIRE | F |

双人对战：玩家 1 用屏幕**左半边**（键盘 WASD + 空格冲刺 + F 开炮），玩家 2 用**右半边**（方向键 + Enter 冲刺 + L 开炮）。手机建议横过来玩。用冲刺撞对手会让他掉血；落后的一方会获得追赶加速。

- **三种模式**：闯关模式（5 关，按表现拿 1～3 星，过关解锁下一关）、无尽模式、**双人对战**（同一台设备左右分屏，看谁先被撞毁或被捕）
- **速度分级**：开局速度只有正常的约 6 成，分数每突破一个门槛升一级（最多 LV 10），整体速度慢慢加快，警车和车流也一起变快
- **海上追逐**：路口里选“海上追逐”会通往码头，冲下跳台变成快艇（每个进化等级都有对应的船，坦克变炮艇），在海上照样被水警船追；到对岸冲上滑道再变回汽车
- **7 张地图**：郊区城市、雪地森林、沙漠峡谷、海滨公路、工业港口、霓虹夜城、海上追逐。遇到十字路口 / T 字路口 / Y 型分叉时，开到哪条车道就走哪条岔路，每条岔路通往不同地图
- **改装站**：每过一个路口就会经过一个改装站，三选一升级：装甲、维修、护盾、氮气、引擎，或者**车辆进化**：跑车 → 肌肉车 → 装甲车（不冲刺也能撞爆警车）→ **坦克**（可以开炮）
- **擦边 & 暴走模式**：贴着车擦过去加分；撞毁、擦边、吃道具会累积暴走值，满了 6 秒内车身变大、撞什么炸什么
- **任务 / 金币 / 车库**：每局 3 个任务，金币可以在车库买永久升级（开局血量、护盾、冲刺冷却、暴走时间、金币加成）
- **警用直升机 Boss**：3 星以后出现，探照灯锁定你并投弹；撑过 25 秒或者开坦克把它打下来
- **道具和跳台**：路上会出现护盾 / 氮气 / 维修道具；跳台可以让你飞越路障
- 只有自己撞上前车、自己变道撞车才扣血；被警车追尾只会被推一把
- 被 2 辆以上警车包夹太久会被捕；路障最多堵 2 条车道，前方会有预警
- 可以引诱警车撞上民用车或路障

## 运行

ES Module 需要通过本地服务器打开（直接双击 `index.html` 不行）：

```bash
python3 -m http.server 8000
```

然后访问 http://localhost:8000 。手机和电脑在同一个 Wi-Fi 时，手机访问 `http://<电脑IP>:8000` 就能用触屏玩。

控制台里有 `window.game` 可以用来调试，比如 `game.player.hp = 999`。

## 目录

```
src/
  main.js                 游戏主循环、计分、镜头
  config.js               所有可调数值
  data/levels.js          闯关模式的关卡设定
  world/                  路线(Path)、路口(LevelManager)、地图生成、刷怪、改装站/道具/跳台
  player/                 玩家控制器、车辆进化、升级卡、坦克主炮
  ai/                     警车 / 坦克 / 民用车
  fx/                     对象池、爆炸特效、打击感、天气
  systems/Collisions.js   碰撞
  ui/HUD.js
unity/Scripts/            Unity C# 版：PlayerController、PoliceAI、HitStop、CameraShake…
docs/ARCHITECTURE.md      架构设计与打击感设计说明
```

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 安装成手机 App（PWA）

网站本身就是一个可安装的「网页 App」：有图标、全屏启动、第一次玩过之后可以离线玩。

- **iPhone / iPad**：用 Safari 打开网站 → 点「分享」→「加入主画面」。
- **安卓**：用 Chrome 打开网站 → 标题画面点「📲 安装到手机」（或浏览器菜单里的「安装应用」）。
- **电脑**：Chrome / Edge 地址栏右边的安装图标。

相关文件：`manifest.webmanifest`（名称、图标、全屏设置）、`sw.js`（离线缓存，网络优先）、`src/pwa.js`（安装按钮）、`assets/icons/`（图标由游戏里的 3D 跑车渲染生成）。

## 素材来源与授权

| 素材 | 作者 / 来源 | 授权 |
|---|---|---|
| 主角跑车（Car Concept，`assets/hero/`） | Eric Chadwick（Darmstadt Graphics Group GmbH），[Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/CarConcept)；游戏里删掉了看不见的零件、合并了网格、玻璃改为普通半透明材质 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| 警车、民用车、碎片模型（`assets/models/`） | [Kenney Car Kit](https://kenney.nl/assets/car-kit) | CC0 |
| 天空 HDRI、沥青 / 雪地 / 沙地 / 草地 / 海滩 / 水泥地贴图（`assets/env/`、`assets/textures/`） | [Poly Haven](https://polyhaven.com/) | CC0 |
| 建筑立面、地砖、海浪、粒子贴图 | 游戏代码程序化生成 | 随本项目 |
| 音效与背景音乐 | Web Audio 实时合成（`src/audio/AudioEngine.js`） | 随本项目 |

