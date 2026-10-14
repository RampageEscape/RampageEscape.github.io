using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

/// <summary>
/// 让后处理“跟着玩法动”，而不是一套固定参数：
///   速度越快 → 动态模糊、暗角越强（只在高画质开动态模糊）
///   冲刺中   → 色差（Chromatic Aberration）+ 更重的暗角，制造冲刺的“隧道感”
///   爆炸瞬间 → Bloom 和曝光短暂冲高，配合顿帧（GameFeel 调用 Pulse）
///
/// 用法：场景里的 Global Volume 上挂本脚本，Profile 里先添加 Bloom / Motion Blur / Chromatic Aberration / Vignette / Color Adjustments / Tonemapping 这几个 Override。
/// 全部用 unscaled 时间：顿帧（timeScale≈0）期间 Bloom 照样闪。
/// </summary>
[RequireComponent(typeof(Volume))]
public class SpeedPostFX : MonoBehaviour
{
    public static SpeedPostFX Instance { get; private set; }

    public PlayerController player;

    [Header("速度感")]
    [Range(0f, 1f)] public float motionBlurAtMaxSpeed = 0.35f;
    [Range(0f, 1f)] public float vignetteBase = 0.18f, vignetteDash = 0.34f;
    [Range(0f, 1f)] public float chromaticDash = 0.3f;

    [Header("爆炸冲击")]
    public float bloomBase = 0.6f;
    public float bloomPulse = 2.2f;
    public float exposurePulse = 0.35f;
    public float pulseDecay = 3f;

    Bloom bloom;
    MotionBlur motionBlur;
    ChromaticAberration chromatic;
    Vignette vignette;
    ColorAdjustments colorAdjust;
    float pulse, dash01;
    bool motionBlurAllowed = true;

    void Awake()
    {
        Instance = this;
        // 用 profile（运行时副本）而不是 sharedProfile，避免把运行时数值写回资源文件
        VolumeProfile p = GetComponent<Volume>().profile;
        p.TryGet(out bloom);
        p.TryGet(out motionBlur);
        p.TryGet(out chromatic);
        p.TryGet(out vignette);
        p.TryGet(out colorAdjust);
    }

    void OnDestroy() { if (Instance == this) Instance = null; }

    /// 爆炸 / 撞毁时调用，power 1 = 普通警车，2.2 = 坦克
    public void Pulse(float power) => pulse = Mathf.Max(pulse, power);

    public void SetTier(GraphicsQualityManager.Tier t)
    {
        // 动态模糊在移动端很贵，而且 URP 的动态模糊主要是相机运动模糊，只在高画质开
        motionBlurAllowed = t == GraphicsQualityManager.Tier.High;
        if (motionBlur != null) motionBlur.active = motionBlurAllowed;
        if (chromatic != null) chromatic.active = t != GraphicsQualityManager.Tier.Low;
    }

    void LateUpdate()
    {
        float dt = Time.unscaledDeltaTime;
        pulse = Mathf.MoveTowards(pulse, 0f, dt * pulseDecay);

        float speed01 = 0f;
        bool dashing = false;
        if (player != null)
        {
            speed01 = Mathf.InverseLerp(player.baseSpeed, player.maxSpeed * player.dashSpeedMul, player.Speed);
            dashing = player.IsDashing;
        }
        dash01 = Mathf.MoveTowards(dash01, dashing ? 1f : 0f, dt * 4f);

        if (bloom != null) bloom.intensity.Override(bloomBase + pulse * bloomPulse);
        if (colorAdjust != null) colorAdjust.postExposure.Override(pulse * exposurePulse);
        if (vignette != null) vignette.intensity.Override(Mathf.Lerp(vignetteBase, vignetteDash, Mathf.Max(dash01, speed01 * 0.4f)));
        if (chromatic != null) chromatic.intensity.Override(dash01 * chromaticDash);
        if (motionBlur != null && motionBlurAllowed) motionBlur.intensity.Override(speed01 * motionBlurAtMaxSpeed);
    }
}
