# Rampage Escape 暴走大逃亡

**▶ 線上遊玩 / Play online：https://rampageescape.github.io/**

作者 / Author：[@jimyauuu06](https://github.com/jimyauuu06)

2.5D 等距视角的街机风警车追逐游戏，低多边形风格。现阶段是网页版原型（Three.js），可以在手机浏览器里玩；以后再移植到 iOS/Android（`unity/Scripts/` 里是对应的 C# 脚本）。

游戏界面支持**繁体中文**（默认）和 **English**，标题和结算画面右上角一键切换，选择会被记住。文案都在 `src/i18n.js`。

## 部署

网站托管在 GitHub Pages（免费、HTTPS、全球 CDN），从 `main` 分支根目录直接发布。推送到 `main` 后一两分钟自动更新，不需要另外操作。Three.js 已经放在 `vendor/` 里，不依赖外部 CDN。

## 玩法

| 操作 | 手机 | 电脑 |
|---|---|---|
| 变道 | 左右滑 | ← → / A D |
| 加速 / 刹车 | 上下滑 | ↑ ↓ / W S |
| 路口选路 | 路口前左滑 / 上滑 / 右滑，或直接点选项 | ← ↑ → |
| 冲刺（无敌，撞毁警车） | 双击屏幕或点 DASH | 空格 |
| 开炮（坦克） | 点 FIRE | F |

- **两种模式**：闯关模式（5 关，按表现拿 1～3 星，过关解锁下一关）和无尽模式
- **5 张地图**：郊区城市、雪地森林、沙漠峡谷、海滨公路、工业港口。遇到十字路口 / T 字路口 / Y 型分叉时，自己选走哪条路，每条岔路通往不同地图
- **改装站**：每过一个路口就会经过一个改装站，三选一升级：装甲、维修、护盾、氮气、引擎，或者**车辆进化**：跑车 → 肌肉车 → 装甲车（不冲刺也能撞爆警车）→ **坦克**（可以开炮）
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
