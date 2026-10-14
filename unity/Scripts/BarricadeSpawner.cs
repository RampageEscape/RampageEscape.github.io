using System;
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// 路障生成器（与网页版 src/world/Spawner.js 的 spawnBarricade 一致）
///
/// 硬性规则：四车道里每个路障最多堵 maxBlocked（2）条车道，永远保留至少 2 条安全通道。
/// 安全通道可以相邻（例如 0、1 号车道），也可以分开（例如 0、2 号车道）。
///
/// 流程：
///   1. 玩家前方 spawnAhead 米处到达下一个路障位置时生成
///   2. PickBlockedLanes() 按星级决定堵 1 条还是 2 条，洗牌随机选车道
///   3. 被堵车道放横停警车 / 栏杆，前面放雪糕筒
///   4. 清掉安全通道附近的民用车，避免通道被慢车堵死
///   5. 被堵车道前方地面放红色感叹号；进入 warnDistance 后通过事件通知 UI 显示车道示意图
/// </summary>
public class BarricadeSpawner : MonoBehaviour
{
    [Header("引用")]
    public PlayerController player;
    [Tooltip("当前通缉星级，由 GameManager 每帧写入")]
    public int stars = 1;

    [Header("规则")]
    public int maxBlocked = 2;
    public float spawnAhead = 170f;
    public float minGap = 230f, maxGap = 380f;
    public float firstBarricadeZ = 320f;

    [Header("预警")]
    public float warnDistance = 120f;
    public float[] signOffsets = { 16f, 30f };   // 地面感叹号距离路障多远
    public GameObject warningSignPrefab;          // 平放在地面的“红色三角 + !”贴片

    [Header("路障组成")]
    public GameObject parkedPolicePrefab;   // 挂 PoliceAI
    public GameObject parkedSwatPrefab;     // 挂 PoliceAI（参数更重）
    public GameObject barrierPrefab;
    public GameObject conePrefab;
    [Range(0f, 1f)] public float policeChance = 0.65f;

    [Header("清理安全通道")]
    public LayerMask trafficMask;           // 民用车所在的层
    public Vector2 clearRange = new Vector2(-40f, 15f); // 相对路障 z 的范围

    /// UI 订阅：参数是被堵车道编号；null 表示前方没有路障，隐藏提示
    public event Action<int[]> RoadblockWarning;

    class Barricade
    {
        public float z;
        public int[] blocked;
        public readonly List<GameObject> objects = new List<GameObject>();
    }

    readonly List<Barricade> active = new List<Barricade>();
    float nextZ;
    Barricade warned;

    void Start() => nextZ = firstBarricadeZ;

    void Update()
    {
        if (player == null) return;
        float pz = player.RoadZ;

        if (pz + spawnAhead > nextZ)
        {
            Spawn(nextZ);
            // 星级越高路障越密，但间隔有下限
            nextZ += UnityEngine.Random.Range(minGap, maxGap) * Mathf.Max(0.6f, 1.1f - stars * 0.08f);
        }

        // UI 预警：玩家前方 warnDistance 米内最近的路障
        Barricade upcoming = null;
        foreach (var b in active)
            if (b.z > pz && b.z - pz < warnDistance && (upcoming == null || b.z < upcoming.z)) upcoming = b;
        if (upcoming != warned)
        {
            warned = upcoming;
            RoadblockWarning?.Invoke(upcoming?.blocked);
        }

        // 回收已经开过去的路障（包括地面标志）
        for (int i = active.Count - 1; i >= 0; i--)
        {
            if (active[i].z >= pz - 30f) continue;
            foreach (var go in active[i].objects)
            {
                if (go == null || !go.activeSelf) continue;
                // 被撞飞的警车由 PoliceAI 自己回收，而且可能已经从对象池里被复用成追捕警车，不能误回收
                if (go.TryGetComponent(out PoliceAI ai) && ai.Mode != PoliceMode.Parked) continue;
                PoolManager.Despawn(go);
            }
            active.RemoveAt(i);
        }
    }

    /// <summary>
    /// 核心算法：选出要堵的车道。保证 被堵数量 ≤ maxBlocked 且 空车道 ≥ 2。
    /// 写成静态纯函数，方便单元测试（跑 1000 次断言 free >= 2）。
    /// </summary>
    public static int[] PickBlockedLanes(int laneCount, int maxBlocked, int stars, System.Random rng)
    {
        // 1) 硬性上限：既不能超过 maxBlocked，也必须留出 2 条安全通道
        int limit = Mathf.Min(maxBlocked, laneCount - 2);
        if (limit <= 0) return Array.Empty<int>();

        // 2) 按星级决定数量：1 星只堵 1 条；之后堵 2 条的概率随星级上升
        int want = stars <= 1 ? 1 : (rng.NextDouble() < 0.35 + stars * 0.1 ? 2 : 1);
        int count = Mathf.Min(want, limit);

        // 3) Fisher–Yates 洗牌，取前 count 个 → 剩下的就是安全通道（相邻或分开都可能）
        int[] lanes = new int[laneCount];
        for (int i = 0; i < laneCount; i++) lanes[i] = i;
        for (int i = laneCount - 1; i > 0; i--)
        {
            int j = rng.Next(i + 1);
            (lanes[i], lanes[j]) = (lanes[j], lanes[i]);
        }
        int[] blocked = new int[count];
        Array.Copy(lanes, blocked, count);
        Array.Sort(blocked);

        // 4) 防御性校验（规则写错时在编辑器里立刻报出来）
        Debug.Assert(laneCount - blocked.Length >= 2, "路障必须保留至少 2 条安全通道");
        return blocked;
    }

    static readonly System.Random sharedRng = new System.Random();

    void Spawn(float z)
    {
        var b = new Barricade { z = z, blocked = PickBlockedLanes(RoadPath.LaneCount, maxBlocked, stars, sharedRng) };

        foreach (int lane in b.blocked)
        {
            float lat = RoadPath.LaneOffset(lane);

            // 被堵车道：横停警车（高星级可能是 SWAT）或栏杆
            if (UnityEngine.Random.value < policeChance)
            {
                bool swat = stars >= 2 && parkedSwatPrefab && UnityEngine.Random.value < 0.3f;
                var go = PoolManager.Spawn(swat ? parkedSwatPrefab : parkedPolicePrefab, RoadPath.ToWorld(z, lat), Quaternion.identity);
                float yaw = (lane % 2 == 0 ? -1f : 1f) * UnityEngine.Random.Range(63f, 80f);
                go.GetComponent<PoliceAI>().InitParked(z + UnityEngine.Random.Range(-1f, 1f), lat, yaw);
                b.objects.Add(go);
            }
            else
            {
                b.objects.Add(SpawnOnRoad(barrierPrefab, z, lat));
            }
            if (conePrefab) b.objects.Add(SpawnOnRoad(conePrefab, z - 5f, lat)); // “此路不通”提示

            // 地面红色感叹号（只放在被堵的车道上）
            if (warningSignPrefab)
                foreach (float d in signOffsets) b.objects.Add(SpawnOnRoad(warningSignPrefab, z - d, lat, 0.07f));
        }

        ClearTrafficNear(z);
        active.Add(b);
    }

    GameObject SpawnOnRoad(GameObject prefab, float z, float lat, float y = 0f)
    {
        var rot = Quaternion.Euler(0f, RoadPath.Heading(z) * Mathf.Rad2Deg, 0f);
        return PoolManager.Spawn(prefab, RoadPath.ToWorld(z, lat, y), rot);
    }

    /// 清掉路障附近、还在屏幕外的民用车，保证安全通道真的畅通
    void ClearTrafficNear(float z)
    {
        float z0 = z + clearRange.x, z1 = z + clearRange.y;
        Vector3 center = RoadPath.ToWorld((z0 + z1) * 0.5f, 0f, 1f);
        Vector3 half = new Vector3(RoadPath.HalfWidth + 1f, 2f, (z1 - z0) * 0.5f);
        foreach (var col in Physics.OverlapBox(center, half, Quaternion.identity, trafficMask, QueryTriggerInteraction.Collide))
        {
            if (col.transform.position.z > player.RoadZ + 60f) PoolManager.Despawn(col.attachedRigidbody ? col.attachedRigidbody.gameObject : col.gameObject);
        }
    }

    /// 民用车生成器在刷车前调用：路障附近不刷车
    public bool InBarricadeZone(float z)
    {
        foreach (var b in active)
            if (z > b.z + clearRange.x && z < b.z + clearRange.y) return true;
        return false;
    }
}
