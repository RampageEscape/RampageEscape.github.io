using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// 画质分级 + 自适应分辨率，目标是“高精度模型 + 后处理”依然稳定 60 帧。
///
/// 准备工作（一次性）：
///   1. Project Settings → Quality 建 3 个等级 Low / Medium / High，每个等级指定自己的 URP Asset
///      （阴影距离、级联、MSAA、HDR 等差异都写在各自的 URP Asset 里，比运行时改参数稳定）
///   2. 3 个 URP Asset 共用同一个 Universal Renderer，SSAO 作为 Renderer Feature 加在上面
///   3. 场景里放一个物体挂本脚本，拖入主相机和 Renderer Data
///
/// 分级策略（具体数值见 docs/HIGH_POLY_AND_URP.md）：
///   Low    : 方块模型、无后处理、FXAA、1 级阴影
///   Medium : 高精度模型、Bloom + 色调映射、FXAA
///   High   : 高精度模型、Bloom + SSAO + 动态模糊、SMAA、软阴影
/// </summary>
public class GraphicsQualityManager : MonoBehaviour
{
    public enum Tier { Low, Medium, High }

    public static GraphicsQualityManager Instance { get; private set; }
    public static Tier Current { get; private set; } = Tier.High;

    [Header("Quality Settings 里三个等级的下标")]
    public int lowQualityIndex = 0, mediumQualityIndex = 1, highQualityIndex = 2;

    [Header("引用")]
    public Camera mainCamera;
    [Tooltip("用来开关 SSAO 等 Renderer Feature")]
    public UniversalRendererData rendererData;

    [Header("自适应分辨率")]
    public int targetFps = 60;
    [Range(0.5f, 1f)] public float minRenderScale = 0.7f;
    [Range(0.5f, 1f)] public float maxRenderScale = 1f;
    [Tooltip("多少秒评估一次（太频繁会因为重新分配 RenderTexture 反而卡顿）")]
    public float evaluateInterval = 2f;

    const string PrefKey = "rampage.graphicsTier";
    float avgFrameMs, timer, originalRenderScale = -1f;

    void Awake()
    {
        Instance = this;
        Application.targetFrameRate = targetFps;
        QualitySettings.vSyncCount = 0;
    }

    void Start()
    {
        // 玩家在设置里手动选过就用玩家的，否则自动判断
        Apply(PlayerPrefs.HasKey(PrefKey) ? (Tier)PlayerPrefs.GetInt(PrefKey) : DetectTier());
    }

    /// 粗略的机型分级：内存和核心数是最靠谱的两个指标；之后的自适应分辨率会继续兜底
    public static Tier DetectTier()
    {
        if (!Application.isMobilePlatform) return Tier.High;
        int memMB = SystemInfo.systemMemorySize, cores = SystemInfo.processorCount;
        if (memMB < 3500 || cores < 6) return Tier.Low;
        if (memMB < 6000) return Tier.Medium;
        return Tier.High;
    }

    public void SetTierByPlayer(Tier t)
    {
        PlayerPrefs.SetInt(PrefKey, (int)t);
        Apply(t);
    }

    public void Apply(Tier t)
    {
        RestoreRenderScale(); // 切换等级会换 URP Asset，先把上一个 Asset 的渲染比例还原
        Current = t;
        int index = t == Tier.Low ? lowQualityIndex : t == Tier.Medium ? mediumQualityIndex : highQualityIndex;
        QualitySettings.SetQualityLevel(index, true);

        // 低端机回退到方块模型（VisualSlot 会自动全部重建）
        VisualSlot.SetGlobalHighPoly(t != Tier.Low);

        if (mainCamera != null)
        {
            var cam = mainCamera.GetUniversalAdditionalCameraData();
            cam.renderPostProcessing = t != Tier.Low;
            cam.antialiasing = t == Tier.High ? AntialiasingMode.SubpixelMorphologicalAntiAliasing : AntialiasingMode.FastApproximateAntialiasing;
            cam.antialiasingQuality = AntialiasingQuality.Medium;
        }

        // SSAO 只在高画质开（移动端最贵的后处理之一；中低画质靠烘焙进贴图的 AO）
        SetRendererFeature("AmbientOcclusion", t == Tier.High);

        SpeedPostFX.Instance?.SetTier(t);
        SetRenderScale(maxRenderScale);
    }

    void SetRendererFeature(string nameContains, bool on)
    {
        if (rendererData == null) return;
        foreach (var f in rendererData.rendererFeatures)
            if (f != null && f.name.Contains(nameContains)) f.SetActive(on);
    }

    static UniversalRenderPipelineAsset UrpAsset => GraphicsSettings.currentRenderPipeline as UniversalRenderPipelineAsset;

    void SetRenderScale(float s)
    {
        var asset = UrpAsset;
        if (asset == null) return;
        if (originalRenderScale < 0f) originalRenderScale = asset.renderScale;
        asset.renderScale = Mathf.Clamp(s, minRenderScale, maxRenderScale);
    }

    /// <summary>
    /// 自适应分辨率：平均帧时间超出预算就降 0.1 渲染比例，持续很宽裕再慢慢升回去（降快升慢，避免来回抖）。
    /// 正交等距视角下 0.8 的渲染比例几乎看不出差别，却能省下 ~35% 的像素着色开销。
    /// </summary>
    void Update()
    {
        float ms = Time.unscaledDeltaTime * 1000f;
        avgFrameMs = avgFrameMs <= 0f ? ms : Mathf.Lerp(avgFrameMs, ms, 0.05f);
        if ((timer += Time.unscaledDeltaTime) < evaluateInterval) return;
        timer = 0f;

        var asset = UrpAsset;
        if (asset == null) return;
        float budget = 1000f / targetFps;
        if (avgFrameMs > budget * 1.12f && asset.renderScale > minRenderScale + 0.01f) SetRenderScale(asset.renderScale - 0.1f);
        else if (avgFrameMs < budget * 0.8f && asset.renderScale < maxRenderScale - 0.01f) SetRenderScale(asset.renderScale + 0.05f);
    }

    // 编辑器里运行时改的是 URP Asset 本身，退出时要还原，免得把降过的分辨率存进项目
    void RestoreRenderScale()
    {
        if (originalRenderScale > 0f && UrpAsset != null) UrpAsset.renderScale = originalRenderScale;
        originalRenderScale = -1f;
    }

    void OnDestroy()
    {
        RestoreRenderScale();
        if (Instance == this) Instance = null;
    }
}
