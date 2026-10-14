using System;
using UnityEngine;
using UnityEngine.Rendering;

/// <summary>
/// 视觉插槽：把“看得见的模型”和“碰撞 / 逻辑”彻底分开，换模型时不动任何玩法代码。
///
/// 预制体结构（逻辑脚本只认根节点和 BoxCollider，永远不碰模型）：
///   PoliceCar (根)              ← Rigidbody + BoxCollider(isTrigger) + PoliceAI      ← 碰撞的唯一真相
///    └─ Visual                  ← 本脚本 VisualSlot
///        └─ __Model (自动生成)  ← 实例化的方块模型 或 高精度模型
///            ├─ Body / Wheel_FL / Wheel_FR ... / Siren_Red / Muzzle / Turret（锚点，按名字查找）
///
/// 换模型时它会自动：
///   1. 修正模型朝向（Blender 导出常见的 -Z / X 朝前）
///   2. 等比缩放，让模型长度 = 碰撞盒长度 × fillRatio（模型永远“套”在碰撞盒上）
///   3. 底部贴地、水平居中到碰撞盒
///   4. 删掉模型自带的碰撞体（高精度 MeshCollider 既慢又会和玩法碰撞盒打架）
///   5. 统一阴影设置；发出 VisualChanged 事件，让坦克炮塔、警灯等重新绑定锚点
///
/// 平滑过渡：每个插槽同时保留 blockyPrefab（方块）和 highPolyPrefab（高精度），
/// 可以逐个车型切换；全局开关 GlobalHighPoly 让低端机直接回退到方块模型。
/// </summary>
[ExecuteAlways]
[DisallowMultipleComponent]
public class VisualSlot : MonoBehaviour
{
    public enum Axis { PositiveZ, NegativeZ, PositiveX, NegativeX }
    public enum FitMode { MatchLength, MatchLargestSide, KeepImportScale }

    /// 全局开关：GraphicsQualityManager 在低端机上设为 false，所有插槽回退到方块模型
    public static bool GlobalHighPoly = true;
    public static event Action GlobalSwitchChanged;

    public static void SetGlobalHighPoly(bool on)
    {
        if (GlobalHighPoly == on) return;
        GlobalHighPoly = on;
        GlobalSwitchChanged?.Invoke();
    }

    [Header("模型")]
    public GameObject blockyPrefab;
    public GameObject highPolyPrefab;
    [Tooltip("这个车型是否已经切换到高精度模型（逐个车型灰度切换用）")]
    public bool useHighPoly = true;

    [Header("对齐")]
    [Tooltip("模型自身的“车头”朝向（Blender 默认导出常见 -Z 或 +X）")]
    public Axis modelForward = Axis.PositiveZ;
    public FitMode fit = FitMode.MatchLength;
    [Tooltip("留空 = 自动取父物体上的 BoxCollider")]
    public BoxCollider referenceCollider;
    [Range(0.5f, 1.3f), Tooltip("模型长度占碰撞盒长度的比例。略小于 1 可以让碰撞判定比视觉稍微宽松")]
    public float fillRatio = 1f;
    public float groundOffset = 0f;

    [Header("渲染")]
    public ShadowCastingMode castShadows = ShadowCastingMode.On;
    public bool receiveShadows = true;
    [Tooltip("删除模型自带的所有 Collider（车辆必须勾选）")]
    public bool stripColliders = true;

    public Transform Model { get; private set; }
    public bool IsHighPoly { get; private set; }
    public float FittedScale { get; private set; } = 1f;
    public event Action<VisualSlot> VisualChanged;

    const string ModelName = "__Model";

    void OnEnable()
    {
        GlobalSwitchChanged += Rebuild;
        Rebuild();
    }

    void OnDisable() => GlobalSwitchChanged -= Rebuild;

#if UNITY_EDITOR
    // 在 Inspector 里改参数时，场景视图立即看到对齐结果（延迟一帧，避免在 OnValidate 里创建物体）
    void OnValidate()
    {
        if (!isActiveAndEnabled) return;
        UnityEditor.EditorApplication.delayCall += () => { if (this) Rebuild(); };
    }
#endif

    [ContextMenu("Rebuild Visual")]
    public void Rebuild()
    {
        bool wantHigh = useHighPoly && GlobalHighPoly && highPolyPrefab != null;
        GameObject prefab = wantHigh ? highPolyPrefab : blockyPrefab;

        // 1) 清掉旧模型
        for (int i = transform.childCount - 1; i >= 0; i--)
        {
            Transform c = transform.GetChild(i);
            if (c.name != ModelName) continue;
            if (Application.isPlaying) Destroy(c.gameObject);
            else DestroyImmediate(c.gameObject);
        }
        Model = null;
        if (prefab == null) return;

        // 2) 实例化到一个中间节点上，所有缩放/旋转/偏移都加在这个节点上，不改模型本身
        var holder = new GameObject(ModelName).transform;
        holder.SetParent(transform, false);
        holder.gameObject.hideFlags = Application.isPlaying ? HideFlags.None : HideFlags.DontSave;
        holder.localRotation = AxisToRotation(modelForward);
        Instantiate(prefab, holder, false).name = prefab.name;

        // 3) 删掉模型自带碰撞体，统一渲染设置
        if (stripColliders)
            foreach (var col in holder.GetComponentsInChildren<Collider>(true))
            {
                if (Application.isPlaying) Destroy(col);
                else DestroyImmediate(col);
            }
        foreach (var r in holder.GetComponentsInChildren<Renderer>(true))
        {
            r.shadowCastingMode = castShadows;
            r.receiveShadows = receiveShadows;
        }

        // 4) 对齐到碰撞盒
        FitToCollider(holder);

        Model = holder;
        IsHighPoly = wantHigh;
        VisualChanged?.Invoke(this);
    }

    void FitToCollider(Transform holder)
    {
        BoxCollider box = referenceCollider != null ? referenceCollider : GetComponentInParent<BoxCollider>();
        if (box == null) { FittedScale = 1f; return; }

        Bounds model = LocalBounds(holder);
        Bounds target = ColliderBoundsInSlotSpace(box);
        if (model.size.sqrMagnitude < 1e-6f) return;

        float scale = 1f;
        switch (fit)
        {
            case FitMode.MatchLength:
                scale = target.size.z * fillRatio / model.size.z;
                break;
            case FitMode.MatchLargestSide:
                float m = Mathf.Max(model.size.x, model.size.z), t = Mathf.Max(target.size.x, target.size.z);
                scale = t * fillRatio / m;
                break;
        }
        holder.localScale = Vector3.one * scale;
        FittedScale = scale;

        // 缩放后重新量一次，再把底部贴地、水平居中
        model = LocalBounds(holder);
        Vector3 offset = new Vector3(target.center.x - model.center.x, target.min.y - model.min.y + groundOffset, target.center.z - model.center.z);
        holder.localPosition += offset;

        if (fit != FitMode.KeepImportScale && (scale < 0.75f || scale > 1.33f))
            Debug.LogWarning($"[VisualSlot] {name}: 模型被缩放了 {scale:0.00} 倍才对齐碰撞盒，导出单位或朝向可能不对（检查 Blender 的 Apply Scale / 单位）。", this);
    }

    /// 所有 Renderer 的网格包围盒，换算到本插槽的局部空间（不用 Renderer.bounds，那是世界 AABB，旋转后会变大）
    Bounds LocalBounds(Transform root)
    {
        Matrix4x4 toSlot = transform.worldToLocalMatrix;
        bool any = false;
        var b = new Bounds();
        foreach (var r in root.GetComponentsInChildren<Renderer>(true))
        {
            Bounds mesh;
            if (r is SkinnedMeshRenderer smr) mesh = smr.localBounds;
            else if (r.TryGetComponent(out MeshFilter mf) && mf.sharedMesh != null) mesh = mf.sharedMesh.bounds;
            else continue;
            Matrix4x4 m = toSlot * r.transform.localToWorldMatrix;
            foreach (Vector3 corner in Corners(mesh))
            {
                Vector3 p = m.MultiplyPoint3x4(corner);
                if (!any) { b = new Bounds(p, Vector3.zero); any = true; }
                else b.Encapsulate(p);
            }
        }
        return b;
    }

    Bounds ColliderBoundsInSlotSpace(BoxCollider box)
    {
        Matrix4x4 m = transform.worldToLocalMatrix * box.transform.localToWorldMatrix;
        var local = new Bounds(box.center, box.size);
        var b = new Bounds(m.MultiplyPoint3x4(box.center), Vector3.zero);
        foreach (Vector3 c in Corners(local)) b.Encapsulate(m.MultiplyPoint3x4(c));
        return b;
    }

    static Vector3[] Corners(Bounds b)
    {
        Vector3 mn = b.min, mx = b.max;
        return new[]
        {
            new Vector3(mn.x, mn.y, mn.z), new Vector3(mx.x, mn.y, mn.z), new Vector3(mn.x, mx.y, mn.z), new Vector3(mn.x, mn.y, mx.z),
            new Vector3(mx.x, mx.y, mn.z), new Vector3(mx.x, mn.y, mx.z), new Vector3(mn.x, mx.y, mx.z), new Vector3(mx.x, mx.y, mx.z),
        };
    }

    static Quaternion AxisToRotation(Axis a)
    {
        switch (a)
        {
            case Axis.NegativeZ: return Quaternion.Euler(0f, 180f, 0f);
            case Axis.PositiveX: return Quaternion.Euler(0f, -90f, 0f);
            case Axis.NegativeX: return Quaternion.Euler(0f, 90f, 0f);
            default: return Quaternion.identity;
        }
    }

    /// <summary>按名字深度查找锚点（Muzzle、Turret、Siren_Red、Wheel_FL……）。新旧模型只要锚点同名，逻辑代码就不用改</summary>
    public Transform FindAnchor(string anchorName)
    {
        if (Model == null) return null;
        foreach (var t in Model.GetComponentsInChildren<Transform>(true))
            if (t.name == anchorName) return t;
        return null;
    }
}
