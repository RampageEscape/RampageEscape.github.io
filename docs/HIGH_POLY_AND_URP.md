# 高精度模型替换 & URP 画质升级指南

适用：Unity 2022.3 LTS（URP 14）及以上，包括 Unity 6（URP 17）。相关脚本都在 `unity/` 目录：

| 文件 | 作用 |
|---|---|
| `Scripts/Visuals/VisualSlot.cs` | 视觉插槽：模型和碰撞分离，新模型自动对齐到碰撞盒，可随时回退到方块模型 |
| `Scripts/Visuals/WheelSpinner.cs` | 按名字找车轮，自动转动/转向；换模型后自动重新绑定 |
| `Editor/ModelImportRules.cs` | 导入规范（缩放、轴向、压缩、贴图格式）+ 菜单 `Tools/Rampage Escape/Audit Visuals` 体检 |
| `Scripts/Rendering/GraphicsQualityManager.cs` | 低/中/高三档画质 + 自适应分辨率 |
| `Scripts/Rendering/SpeedPostFX.cs` | 后处理跟着速度、冲刺、爆炸变化 |
| `Shaders/CarPaint.shader` | 车漆：清漆层 + 双色漆 + 金属闪片 |

---

## 一、核心原则：模型只是“皮”，碰撞盒才是“骨”

所有玩法代码（`PlayerController`、`PoliceAI`、`CollisionJudge`、`BarricadeSpawner`）只读两样东西：**根节点的 Transform** 和 **根节点的 BoxCollider 尺寸**。它们从来不碰模型。所以只要保证下面的预制体结构，换模型就不会动到任何玩法：

```
PoliceCar（根节点）        Rigidbody(isKinematic) + BoxCollider(isTrigger) + PoliceAI
 └─ Visual                 VisualSlot + WheelSpinner
     └─ __Model（运行时生成） 方块模型 或 高精度模型，自带的碰撞体会被删掉
         ├─ Wheel_FL / Wheel_FR / Wheel_RL / Wheel_RR
         ├─ Siren_Red / Siren_Blue
         └─ Turret / Muzzle（坦克）
```

**碰撞体规则**
- 车辆一律用 **BoxCollider**，并且把它当作唯一真相。玩法里的碰撞判定（追尾/正面/侧撞）就是用这个盒子算的。
- **绝对不要**给会动的车用高精度 MeshCollider：物理开销会翻几十倍，而且凹凸的车身会让“被追尾/正面撞”的判定变得不稳定。
- 静态环境（建筑、岩石）如果需要精确碰撞，在 Blender 里做一个低面数的碰撞网格，命名 `UCX_xxx` 或 `xxx_col`。导入时会自动转成 MeshCollider，并且不参与渲染。
- 想让碰撞比视觉稍微“宽容”一点，把 `VisualSlot.fillRatio` 调到 1.05～1.1：模型会比碰撞盒略大，擦边时不算撞。

---

## 二、平滑过渡：四步换模型

### 第 1 步：重构预制体（一次性）
把现有方块预制体改成上面的结构：根节点保留 Rigidbody、BoxCollider 和逻辑脚本；新建子物体 `Visual`，挂 `VisualSlot`，`blockyPrefab` 拖入原来的方块模型。进 Play 跑一遍，确认行为完全没变。**这一步不换任何模型，只是验证结构。**

### 第 2 步：按规范导出和导入
Blender 导出 FBX 时：
- **Apply Transform**（应用缩放和旋转）。单位用米，1 Blender 单位 = 1 米。
- 所有车的车头朝向保持一致（比如全部朝 Blender 的 -Y）。导入后如果车头不朝 Unity 的 +Z，在 `VisualSlot.modelForward` 里选对应的朝向即可，不用回去改模型。
- **Pivot 在车底中心**。车轮的 Pivot 在轮毂中心，否则会偏心转。
- 锚点用约定的名字：`Wheel_FL`、`Muzzle`、`Turret`、`Siren_Red`……

把模型放进 `Assets/Art/Vehicles/` 或 `Assets/Art/Environment/`，`ModelImportRules` 会自动设置好缩放、轴向（`bakeAxisConversion`）、网格压缩、关闭读写、手机贴图用 ASTC，超过面数预算会在 Console 警告。

### 第 3 步：在插槽里挂上新模型并校验
`VisualSlot.highPolyPrefab` 拖入新模型。插槽是 `[ExecuteAlways]` 的，在**场景视图里马上就能看到**模型被转正、缩放到碰撞盒长度、贴地居中。然后：
- 打开碰撞盒 Gizmo，看模型是不是正好套在绿色盒子上。
- 如果 Console 提示“缩放了 X 倍才对齐”，说明导出单位或朝向不对，回 Blender 修，不要硬调。
- 运行菜单 `Tools/Rampage Escape/Audit Visuals`，检查面数、材质数、LOD、多余碰撞体。

### 第 4 步：灰度切换
- 每个插槽有 `useHighPoly` 开关：**一次只切一个车型**（先玩家车，再警车，再环境），每切一个就跑一遍完整游戏。
- `VisualSlot.GlobalHighPoly` 是全局开关：低端机由 `GraphicsQualityManager` 自动关掉，所有插槽**回退到方块模型**。方块模型因此不要删，它就是低画质档。
- 有问题随时把 `useHighPoly` 关掉，立刻回到方块模型，不用回滚代码。

### 资源预算（移动端，LOD0）

| 类型 | 三角面 | 材质数 | 贴图 |
|---|---|---|---|
| 玩家车 | ≤ 25k | ≤ 3 | 1024，ASTC 6x6 |
| 警车 / 民用车 | 8k～12k | ≤ 2 | 1024（共用图集） |
| 建筑 | 1k～5k | 1（图集） | 512～1024 |
| 树 / 岩石 / 小道具 | 300～2k | 1（图集） | 512 |
| 同屏总量 | ≤ 500k 三角面，≤ 150 draw call | | |

- 车辆做 2～3 级 **LOD Group**。正交相机下 Unity 按屏幕占比切 LOD，同样有效。
- 同类道具（树、路灯、集装箱）共用材质并勾选 **GPU Instancing**；整个项目开启 **SRP Batcher**。

---

## 三、URP 画质：三档设置

在 Project Settings → Quality 建三个等级，每个等级指定自己的 URP Asset（`GraphicsQualityManager` 会切换它们）：

| 设置 | Low | Medium | High |
|---|---|---|---|
| 模型 | 方块 | 高精度 | 高精度 |
| Render Scale | 0.8（自适应 0.7～1） | 0.9（自适应） | 1.0（自适应） |
| HDR | 关 | 开 | 开 |
| MSAA / 抗锯齿 | 关 + FXAA | 关 + FXAA | 2x 或 SMAA |
| 主光阴影 | 1 级联，1024，距离 50 | 1 级联，2048，距离 60 | 2 级联，2048，软阴影，距离 70 |
| 附加光 | 关（警灯用自发光 + Bloom） | 逐顶点 | 逐像素，最多 2 盏 |
| 后处理 | 关 | Bloom + 色调映射 + 暗角 | + SSAO + 动态模糊 + 色差 |

**光照**
- 一盏实时方向光负责阴影。环境光用烘焙的 **Light Probes**，加每张地图一个烘焙的 **Reflection Probe**，车漆的反射全靠它。不要用实时反射探针。
- 警灯、路灯**不要用实时点光源**：用 HDR 自发光材质（强度 > 1），交给 Bloom 让它发光，几乎零开销。
- 正交俯视角的阴影距离按“屏幕能看到的范围”设，50～70 米就够。级联越少越省。

**材质**
- 玩家车：`CarPaint.shader`（清漆 + 双色 + 闪片）。
- 警车、民用车：URP Lit，金属度/光滑度/AO 打包进一张贴图（R=金属度、G=AO、A=光滑度）。
- 低画质：Simple Lit 或 Baked Lit。
- **AO 尽量烘焙进贴图**（Substance / Blender 烘焙），实时 SSAO 只在高画质开。

---

## 四、后处理：逼真又不掉帧

| 效果 | 推荐参数 | 移动端注意 |
|---|---|---|
| Tonemapping | ACES（写实）或 Neutral（保色） | 需要 HDR，几乎免费 |
| Bloom | Threshold 1.0，Intensity 0.6，Scatter 0.6，**High Quality Filtering 关**，Downscale 半分辨率 | 只让 HDR 值 > 1 的东西发光：爆炸火焰、警灯、车灯 |
| SSAO | 只开高画质；Downsample 开，Sample Count Low，Radius 0.3，After Opaque 关 | 最贵的效果之一，中低画质用烘焙 AO 代替 |
| Motion Blur | 只开高画质；Quality Low，Intensity 跟速度联动（0～0.35） | URP 的动态模糊以相机运动为主；中低画质用速度线粒子 + 暗角代替 |
| Chromatic Aberration | 平时 0，冲刺时 0.3 | 很便宜，冲刺的“隧道感”主要靠它 |
| Vignette | 0.18，冲刺 0.34 | 便宜 |
| Color Adjustments | 每张地图一个色调（雪地偏冷、沙漠偏暖） | 可以用 Volume 混合在地图切换时过渡 |

**和玩法联动（`SpeedPostFX`）**
- 速度越快，动态模糊和暗角越强；冲刺时加色差。
- 撞毁警车时 Bloom 和曝光冲高一下，`GameFeel.EnemyDestroyed` 里已经调用了 `SpeedPostFX.Pulse`，和顿帧、震屏同一时刻发生。全部用 unscaled 时间，顿帧期间照样闪。
- 换地图时：每张地图一个局部 Volume（Weight 渐变），切换色调和雾。

**不掉帧的关键**
1. **自适应分辨率**（`GraphicsQualityManager`）：平均帧时间超出预算就降 0.1 渲染比例，持续宽裕再慢慢升回去。正交俯视角下 0.8 几乎看不出差别，能省约 35% 像素开销。
2. 按机型分档：内存 < 3.5GB 或核心数 < 6 的手机默认 Low，玩家可以在设置里手动改。
3. 透明粒子是移动端的头号杀手（overdraw）：爆炸用少量大粒子 + 序列帧贴图，关闭软粒子。
4. 用 Frame Debugger 看 draw call，用 Profiler 的 GPU 模块看每个后处理的耗时，在**真机**上测，编辑器的帧率没有参考价值。
5. 长时间游玩会发热降频：可以接 Unity 的 Adaptive Performance 包，温度高时主动降一档。

---

## 五、注意事项

- 这些 C# 和 Shader 是按 URP 14 的 API 写的，**还没有在 Unity 里编译测试过**，导入后可能需要修小问题。
- `CarPaint.shader` 不支持 Unity 6 的 GPU Resident Drawer（DOTS Instancing）。它只用在玩家车上，影响不大；如果要大量使用，可以照同样的思路用 Shader Graph 做一个版本。
- 网页版（Three.js）也是同样的思路：`src/models/Models.js` 是唯一生成模型的地方，碰撞用的是道路坐标里的长宽，和模型无关。要换成 glTF 模型的话，只需要改这一个文件。
