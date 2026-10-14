using UnityEngine;

/// <summary>
/// 基于“创伤值 trauma”的镜头震动（GDC 2016 Squirrel Eiserloh 的做法）。
///
/// 层级：CameraRig（跟随玩家）→ ShakePivot（挂本脚本）→ Camera（正交，等距角度）
/// 这样震动只改 ShakePivot 的局部偏移，不会和跟随逻辑互相打架。
///
///  - 冲击时 AddTrauma(x)，trauma ∈ [0,1]，线性衰减
///  - 实际震幅 = trauma²：小撞几乎无感，大爆炸很猛，多次叠加也自然
///  - 用 Perlin 噪声而不是 Random：镜头是“晃”不是“抖”，不会晕
///  - 用 unscaled 时间：顿帧期间画面冻住但镜头仍在震 → 冲击感最强
///  - 正交相机额外做 zoom kick（orthographicSize 瞬间缩小再弹回）
/// </summary>
public class CameraShake : MonoBehaviour
{
    public static CameraShake Instance { get; private set; }

    public float maxOffset = 1.4f;
    public float maxRollDeg = 3f;
    public float frequency = 24f;
    public float decay = 1.6f;
    public Camera cam;

    float trauma, seed, zoomKick, baseOrthoSize;

    void Awake()
    {
        Instance = this;
        seed = Random.value * 100f;
        if (cam == null) cam = GetComponentInChildren<Camera>();
        if (cam) baseOrthoSize = cam.orthographicSize;
    }

    void OnDestroy() { if (Instance == this) Instance = null; }

    public void AddTrauma(float amount) => trauma = Mathf.Clamp01(trauma + amount);

    /// 正值 = 往里推（撞毁瞬间），负值 = 拉远（冲刺开始时的速度感）
    public void ZoomKick(float amount) => zoomKick += amount;

    void LateUpdate()
    {
        float dt = Time.unscaledDeltaTime, t = Time.unscaledTime * frequency;
        trauma = Mathf.Max(0f, trauma - decay * dt);
        float s = trauma * trauma;

        float nx = Mathf.PerlinNoise(seed, t) * 2f - 1f;
        float ny = Mathf.PerlinNoise(seed + 1f, t) * 2f - 1f;
        float nz = Mathf.PerlinNoise(seed + 2f, t) * 2f - 1f;
        float nr = Mathf.PerlinNoise(seed + 3f, t) * 2f - 1f;
        transform.localPosition = new Vector3(nx, ny * 0.5f, nz) * (maxOffset * s);
        transform.localRotation = Quaternion.Euler(0f, 0f, nr * maxRollDeg * s);

        zoomKick = Mathf.Lerp(zoomKick, 0f, 1f - Mathf.Exp(-7f * dt));
        if (cam && cam.orthographic) cam.orthographicSize = baseOrthoSize / (1f + zoomKick);
    }
}
