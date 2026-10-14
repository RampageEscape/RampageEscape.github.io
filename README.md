# Heat Rush 警車狂飆

**▶ 線上遊玩 / Play online：https://jim20060512-ops.github.io/my-game/**

2.5D 等距视角的街机风警车追逐游戏，低多边形风格。现阶段是网页版原型（Three.js），可以在手机浏览器里玩；以后再移植到 iOS/Android（`unity/Scripts/` 里是对应的 C# 脚本）。

游戏界面支持**繁体中文**（默认）和 **English**，标题和结算画面右上角一键切换，选择会被记住。文案都在 `src/i18n.js`。

## 部署

网站托管在 GitHub Pages（免费、HTTPS、全球 CDN），从 `main` 分支根目录直接发布。推送到 `main` 后一两分钟自动更新，不需要另外操作。Three.js 已经放在 `vendor/` 里，不依赖外部 CDN。

## 玩法

| 操作 | 手机 | 电脑 |
|---|---|---|
| 变道 | 左右滑 | ← → / A D |
| 加速 / 刹车 | 上下滑 | ↑ ↓ / W S |
| 冲刺（无敌，撞毁警车） | 双击屏幕或点 DASH | 空格 |

- 冲刺时撞警车 → 警车爆炸，连撞有连击加分，冲刺时间还会延长
- 没冲刺时被撞会扣血；被 2 辆以上警车包夹太久会被捕
- 可以引诱警车撞上民用车或路障
- 路障会越来越密，高星级时可能封死全路，只能冲刺撞过去
- 3 星以后城市里会出现坦克，注意地上的红色预警圈
- 地图在“郊区城市”和“雪地森林”之间轮换

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
  world/                  道路、无尽地图生成、生成器
  player/                 玩家控制器
  ai/                     警车 / 坦克 / 民用车
  fx/                     对象池、爆炸特效、打击感、天气
  systems/Collisions.js   碰撞
  ui/HUD.js
unity/Scripts/            Unity C# 版：PlayerController、PoliceAI、HitStop、CameraShake…
docs/ARCHITECTURE.md      架构设计与打击感设计说明
```

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
