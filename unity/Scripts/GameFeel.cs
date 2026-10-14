using UnityEngine;

/// <summary>
/// 打击感“配方”：把事件映射成 顿帧 + 慢动作 + 镜头震动 + 镜头推拉 + 手机震动。
/// 所有手感数值集中在这里，方便策划调。数值与网页版 src/fx/GameFeel.js 相同。
/// </summary>
public static class GameFeel
{
    public static float ComboWindow = 2.5f;
    public static int Combo { get; private set; }
    static float lastKillTime = -99f;

    /// 撞毁警车：power 1 = 普通警车，1.5 = SWAT，2.2 = 坦克
    public static void EnemyDestroyed(float power)
    {
        Combo = Time.unscaledTime - lastKillTime < ComboWindow ? Combo + 1 : 1;
        lastKillTime = Time.unscaledTime;

        // 顿帧时长：基础 45ms，越重越久，连击再加一点（封顶，避免越打越卡）
        HitStop.Instance?.Stop(0.045f + 0.025f * power + 0.01f * Mathf.Min(Combo, 5));
        if (Combo >= 3) HitStop.Instance?.SlowMo(0.35f, 0.35f); // 三连以上给一段慢动作
        CameraShake.Instance?.AddTrauma(0.35f + 0.15f * power);
        CameraShake.Instance?.ZoomKick(0.06f * power);
        SpeedPostFX.Instance?.Pulse(power); // Bloom + 曝光闪一下，和顿帧同时发生
        Haptics(power >= 1.5f);
    }

    public static void PlayerHit(float damage)
    {
        HitStop.Instance?.Stop(0.035f, 0.1f); // 被撞的顿帧更短更轻，不打断操作
        CameraShake.Instance?.AddTrauma(0.25f + damage / 60f);
        CameraShake.Instance?.ZoomKick(-0.03f);
        Haptics(true);
    }

    public static void DashStart()
    {
        CameraShake.Instance?.AddTrauma(0.12f);
        CameraShake.Instance?.ZoomKick(-0.08f); // 拉远 → 速度感
    }

    static void Haptics(bool strong)
    {
#if UNITY_IOS || UNITY_ANDROID
        // Handheld.Vibrate 只有一种长震；想要细腻的轻/重震动可接 Nice Vibrations 等插件
        if (strong) Handheld.Vibrate();
#endif
    }
}
