# Rampage Escape 架构设计

2.5D 等距视角街机追逐游戏。网页版（Three.js）是可玩原型，`unity/Scripts/` 是移植到 iOS/Android 时的对应 C# 实现，两边的模块划分和数值一致。

## 1. 核心系统模块

```
            ┌──────────────┐  滑动/按键   ┌────────────────────┐
            │ SwipeInput   │ ───────────▶ │ PlayerController   │──┐ collisionTag
            └──────────────┘              │ 变道/加减速/冲刺/受伤│  │ 'Player' / 'PlayerDash'
                                          └────────────────────┘  │
┌────────────┐  道路坐标 (z, lateral)  ┌──────────────┐           ▼
│ Road       │◀──────────────────────│ 所有实体      │   ┌──────────────┐
│ 中心线/车道 │                        │ Vehicle 基类  │◀──│ Collisions   │
└────────────┘                        ├──────────────┤   └──────┬───────┘
      ▲                               │ PoliceAI     │          │ 事件
      │                               │ Civilian     │          ▼
┌────────────────┐   生成/回收         │ Obstacle     │   ┌──────────────┐   ┌──────────────┐
│ WorldGenerator │   ┌─────────┐      │ TankAI+Shells│   │ Game (main)  │──▶│ GameFeel     │
│ 无尽地图区块     │   │ Spawner │─────▶└──────────────┘   │ 计分/连击/星级 │   │ 顿帧/震屏/缩放 │
└────────────────┘   └─────────┘  ObjectPool              └──────┬───────┘   └──────────────┘
                                                                 ▼
                                               ┌──────────────┐  ┌──────────────┐
                                               │ Effects 对象池 │  │ HUD          │
                                               └──────────────┘  └──────────────┘
```

| 模块 | 网页版 | Unity | 职责 |
|---|---|---|---|
| 道路系统 | `src/world/Road.js` | `RoadPath.cs` | 中心线函数（城市直路 / 森林正弦弯道）、车道偏移。所有车辆用“道路坐标” `(z, lateral)`，弯道上 AI 和碰撞逻辑不用改 |
| 输入 | `src/input/SwipeInput.js` | `PlayerController.ReadTouch()` | 滑动超过阈值立即触发（不等抬手），可连续滑；双击冲刺；键盘调试 |
| 玩家控制 | `src/player/PlayerController.js` | `PlayerController.cs` | 车道平滑插值、速度偏移回落、冲刺状态机、受伤与无敌帧 |
| AI 导航 | `src/ai/PoliceAI.js` | `PoliceAI.cs` | 道路坐标系里的转向行为：预测 → 角色目标点 → P 控制速度 → 避障 |
| 重型单位 | `src/ai/TankAI.js` | （待移植） | 坦克炮塔追踪、预判落点开炮、地面预警圈 |
| 民用车 / 路障 | `src/ai/Traffic.js` | （待移植） | 慢速车流、堵车换道；可被撞飞的栏杆和雪糕筒 |
| 生成器 | `src/world/Spawner.js` | （待移植） | 按通缉星级刷追捕警车（轮流分配角色）、路障（高星级封死全路）、SWAT、坦克；视野外回收 |
| 地图生成 | `src/world/WorldGenerator.js` | （用预制体区块） | 40m 一块，前 7 块后 2 块。城市：十字路口、红砖楼、路灯、电线杆；森林：松树、巨石、红头桩。InstancedMesh 合批 |
| 碰撞 | `src/systems/Collisions.js` | Trigger + Tag | 道路坐标下的矩形重叠；结果由各实体的 `onPlayerCollision` 决定 |
| 特效对象池 | `src/fx/ObjectPool.js` + `Effects.js` | `PoolManager.cs` + ParticleSystem 预制体 | 运行中零分配：火焰、烟、火花、碎片、冲击波、火焰喷射柱 |
| 打击感 | `src/fx/GameFeel.js` | `HitStop.cs` `CameraShake.cs` `GameFeel.cs` | 见第 4 节 |

### 冲刺 → 摧毁警车的数据流

1. 玩家双击 / 按 DASH → `PlayerController.tryDash()`，`isDashing = true`，**碰撞标签变为 `PlayerDash`**（Unity 里是 `gameObject.tag`）。
2. 碰撞系统检测到重叠 → 调用 `PoliceAI.onPlayerCollision(player)`（Unity：`OnTriggerEnter`）。
3. 警车读 `player.collisionTag === 'PlayerDash'` → `explode()`：
   - 从对象池取爆炸粒子（Unity：`PoolManager.Spawn(explosionPrefab)` + `ParticleSystem.Play()`）
   - 自身变成残骸，带速度和角速度飞出去（Unity：切换为非运动学刚体）
   - 通知 `Game.onEnemyDestroyed` → 计分、连击、延长冲刺、触发 GameFeel
4. 残骸飞 2.6 秒后由 Spawner 回收进对象池（Unity：协程 `RecycleAfter` → `PoolManager.Despawn`）。

### 警车包夹策略

| 角色 | 目标位置 | 行为 |
|---|---|---|
| 侧翼 ±1 | 玩家左/右并排 | 冷却好后横向猛撞；这一侧没路就换边 |
| 拦截 0 | 玩家前方 10m | 先从侧面超车，再并入玩家车道并减速逼停 |
| 追尾 2 | 玩家后方 | 冷却好后顶上来 |

- 被 2 辆以上警车贴身包夹时，**被捕条**上涨，满了就 BUSTED。冲刺或撞毁警车可以缓解。
- 警车避障能力 `skill` 随机，差的会撞上民用车或路障自爆，所以玩家可以**引诱警车撞车**（同样计分）。
- 警车最高速度有上限，玩家冲刺时可以甩开。

## 2–3. 代码位置

- 玩家控制器：网页版 [`src/player/PlayerController.js`](../src/player/PlayerController.js)，Unity 版 [`unity/Scripts/PlayerController.cs`](../unity/Scripts/PlayerController.cs)
- 警车 AI：网页版 [`src/ai/PoliceAI.js`](../src/ai/PoliceAI.js)，Unity 版 [`unity/Scripts/PoliceAI.cs`](../unity/Scripts/PoliceAI.cs)

Unity 场景设置：
1. Tags 里加 `PlayerDash`。
2. 玩家和警车都用 `Rigidbody(isKinematic)` + `BoxCollider(isTrigger)`。
3. 警车的 `obstacleMask` 勾选民用车和路障所在的 Layer。
4. 场景里放一个物体挂 `HitStop`；相机层级为 `CameraRig → ShakePivot(CameraShake) → Camera(正交)`。

## 4. 打击感：镜头震动 + 顿帧

撞毁一辆警车时，时间线（真实时间）：

```
0ms     碰撞 ─ timeScale → 0.03（顿帧），白色闪屏 0.25，镜头推近 6%，trauma +0.5，手机震 25ms
~70ms   顿帧结束 ─ 0.12 秒内 timeScale 从 0.25 缓动回 1
        火焰柱向外喷射，残骸飞起；镜头仍在晃（震动用真实时间）
~400ms  trauma 衰减到很小，镜头回正
```

### 顿帧（Hit Stop）要点
- **不要完全停在 0**，用 0.02–0.05：爆炸以极慢速度继续，画面像“定格的瞬间”，比纯暂停更有张力。
- **时长按重量递增**：普通警车约 70ms，SWAT 约 85ms，坦克约 100ms；连击每次 +10ms，最多加 5 次。超过 150ms 会让人觉得“卡顿”。
- **取最大值，不叠加**：一次冲刺连撞 3 辆时，如果顿帧时间累加，玩家会感觉游戏卡住了。
- **缓出恢复**：从 0.25 倍速二次缓动回 1 倍速，比瞬间恢复顺滑。
- **计时用真实时间**（`unscaledDeltaTime`），否则 timeScale≈0 时计时器自己也停了。
- 三连以上额外给 0.35 秒的 0.35 倍速慢动作，作为奖励时刻。
- 玩家被撞的顿帧更短（35ms、0.1 倍速），因为这时候玩家需要马上反应，不能打断操作。

### 镜头震动（Camera Shake）要点
- **trauma 模型**：每次冲击加 trauma（上限 1），线性衰减；**实际震幅 = trauma²**。小碰撞几乎察觉不到，大爆炸很猛，多次冲击叠加也自然。
- **用平滑噪声**（Perlin / 多个正弦叠加）而不是 `Random`：镜头是“晃”，不是“抖”，手机上看不会晕。
- 位移 + 绕视线轴的**轻微旋转**（±3°），旋转比位移更有冲击感。
- **用真实时间更新**：顿帧时画面冻结，但镜头还在震，这是冲击感最强的组合。
- 震动加在独立的 ShakePivot 节点上，不和跟随逻辑互相干扰。
- 正交相机的 **zoom kick**：撞毁时 orthographicSize 瞬间缩小 6% 再弹回（推近），冲刺开始时放大 8%（拉远，速度感）。
- 设置里提供“减弱震动”开关（无障碍）。

### 其他加分项
- **闪屏**：白色半透明覆盖层，0.35 秒淡出；玩家受伤用红色。
- **手机震动**：网页 `navigator.vibrate`，Unity `Handheld.Vibrate`，更细腻的可以接 Nice Vibrations。
- **飘字**：分数从撞击点弹出，连击时字体放大。
- **爆炸物理继承速度**：火焰和碎片继承警车的前进速度，爆炸“跟着车飞”，不会原地炸开被甩在身后。
- **音效**（待做）：撞击瞬间先播低频“砰”，顿帧结束后再播爆炸长尾；顿帧期间可以压低背景音乐。

## 性能注意（移动端）
- 地图道具用 InstancedMesh 合批，每个区块只有十几个 draw call。
- 所有粒子、车辆都走对象池，游戏中不 new。
- 下一步优化：把发光粒子改成单个 InstancedMesh（现在每个粒子一个 Mesh，爆炸多时 draw call 偏高）；阴影贴图在低端机降到 1024。
