using UnityEngine;

/// <summary>
/// 顿帧（Hit Stop）+ 慢动作。挂在场景中任意常驻物体上。
///
/// 原理：撞毁瞬间把 Time.timeScale 压到接近 0（0.02~0.05，而不是 0：爆炸仍在极慢地推进，画面更有张力），
/// 持续 50~120ms 真实时间后，用 0.12 秒从 0.25 倍速缓动回 1 倍速，避免“卡了一下”的生硬感。
///
/// 注意：
///  - 计时一律用 unscaledDeltaTime，否则 timeScale≈0 时计时器自己也停了
///  - 同步缩放 fixedDeltaTime，慢动作期间物理（被炸飞的残骸）依然顺滑
///  - 镜头震动、UI 动画用 unscaled 时间，顿帧期间照样震
/// </summary>
public class HitStop : MonoBehaviour
{
    public static HitStop Instance { get; private set; }

    public float recoverTime = 0.12f;
    public float recoverFrom = 0.25f;

    float baseFixedDelta;
    float freezeTimer, freezeScale = 0.03f, recoverTimer;
    float slowTimer, slowScale = 1f;

    void Awake()
    {
        Instance = this;
        baseFixedDelta = Time.fixedDeltaTime;
    }

    void OnDestroy()
    {
        if (Instance != this) return;
        Instance = null;
        Time.timeScale = 1f;
        Time.fixedDeltaTime = baseFixedDelta;
    }

    /// 顿帧：多次触发取最长，不叠加（叠加会让连撞时卡太久）
    public void Stop(float duration, float scale = 0.03f)
    {
        freezeTimer = Mathf.Max(freezeTimer, duration);
        freezeScale = scale;
        recoverTimer = recoverTime;
    }

    public void SlowMo(float scale, float duration)
    {
        slowScale = Mathf.Min(slowScale, scale);
        slowTimer = Mathf.Max(slowTimer, duration);
    }

    void Update()
    {
        float dt = Time.unscaledDeltaTime;
        float ts;
        if (freezeTimer > 0f)
        {
            freezeTimer -= dt;
            ts = freezeScale;
        }
        else if (recoverTimer > 0f)
        {
            recoverTimer -= dt;
            float k = 1f - Mathf.Max(0f, recoverTimer) / recoverTime;
            ts = Mathf.Lerp(recoverFrom, 1f, k * k);
        }
        else ts = 1f;

        if (slowTimer > 0f) { slowTimer -= dt; ts = Mathf.Min(ts, slowScale); }
        else slowScale = 1f;

        Time.timeScale = ts;
        Time.fixedDeltaTime = baseFixedDelta * Mathf.Max(ts, 0.05f);
    }
}
