using UnityEngine;

/// <summary>
/// 道路中心线（与网页版 src/world/Road.js 一致）。
/// 所有车辆用“道路坐标” (z, lateral) 描述位置：z 沿前进方向，lateral 是相对中心线的横向偏移。
/// 正式项目可以换成 Unity Splines 采样，只要保留 CenterX / Heading 这两个接口即可。
/// </summary>
public static class RoadPath
{
    public static int LaneCount = 4;
    public static float LaneWidth = 3.6f;
    public static float BiomeLength = 800f;
    public static float Transition = 120f;

    public static float HalfWidth => LaneCount * LaneWidth * 0.5f;

    public static float LaneOffset(int lane) => (lane - (LaneCount - 1) * 0.5f) * LaneWidth;

    public static int NearestLane(float lateral) =>
        Mathf.Clamp(Mathf.RoundToInt(lateral / LaneWidth + (LaneCount - 1) * 0.5f), 0, LaneCount - 1);

    public static bool IsForest(float z) => Mathf.FloorToInt(Mathf.Max(z, 0f) / BiomeLength) % 2 == 1;

    static float Smooth(float e0, float e1, float x)
    {
        float t = Mathf.Clamp01((x - e0) / (e1 - e0));
        return t * t * (3f - 2f * t);
    }

    /// 0 = 直路（城市），1 = 完全弯曲（森林）
    public static float CurveWeight(float z)
    {
        float L = BiomeLength, T = Transition, t = Mathf.Repeat(z, 2f * L);
        return Smooth(L, L + T, t) * (1f - Smooth(2f * L - T, 2f * L, t));
    }

    public static float CenterX(float z)
    {
        float w = CurveWeight(z);
        if (w <= 0f) return 0f;
        return w * (16f * Mathf.Sin(z * 0.011f) + 7f * Mathf.Sin(z * 0.027f + 1.3f));
    }

    /// 道路切线方向（弧度，绕 Y 轴，0 = +Z）
    public static float Heading(float z) => Mathf.Atan2(CenterX(z + 1f) - CenterX(z - 1f), 2f);

    public static Vector3 ToWorld(float z, float lateral, float y = 0f) => new Vector3(CenterX(z) + lateral, y, z);
}
