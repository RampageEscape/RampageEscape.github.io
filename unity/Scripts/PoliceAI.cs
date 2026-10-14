using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;

public enum PoliceRole { FlankLeft, FlankRight, Blocker, Rammer }
public enum PoliceMode { Chase, Parked, Wreck }

/// <summary>
/// 警车 AI（普通警车 / SWAT 用同一脚本，调参数区分）
///
/// 寻路：无尽跑酷的路是运行时生成的，不适合烘焙 NavMesh。
/// 这里在“道路坐标系”里做转向行为：预测玩家位置 → 按角色算目标点 → P 控制速度 + 平滑转向 → 前方避障。
/// （如果以后做大地图自由漫游模式，可以把 Pursue() 换成 NavMeshAgent.SetDestination，碰撞部分不用改。）
///
/// 角色分工（Spawner 生成时轮流分配）：
///   FlankLeft / FlankRight : 开到玩家两侧并排，冷却好了横向撞击 → 形成包夹
///   Blocker                : 从旁边超车，到玩家正前方后刹车逼停
///   Rammer                 : 跟在后面找机会追尾
///
/// 预制体设置：Rigidbody(isKinematic) + BoxCollider(isTrigger)，obstacleMask 勾选民用车/路障所在层。
/// </summary>
[RequireComponent(typeof(Rigidbody))]
public class PoliceAI : MonoBehaviour
{
    public static readonly List<PoliceAI> Active = new List<PoliceAI>();
    /// 参数：被摧毁的警车、是否被玩家冲刺撞毁（false = 被引诱撞车/被炮弹炸）
    public static event Action<PoliceAI, bool> Destroyed;

    [Header("追捕")]
    public float catchUp = 14f;
    public float steerGain = 3.2f;
    public float maxLatSpeed = 9f;
    public float lookAhead = 0.35f;
    public float ramCooldown = 1.6f;
    public float ramImpulse = 7f;
    public float damage = 10f;
    public float width = 2f, length = 4.4f;
    public LayerMask obstacleMask;

    [Header("爆炸")]
    public GameObject explosionPrefab;   // 带 ParticleSystem 的爆炸特效预制体（火球、火焰柱、烟、碎片、火花）
    public float explosionPower = 1f;    // SWAT 可以设 1.5
    public float fxLifetime = 3f;
    public float wreckLifetime = 2.6f;
    public int score = 300;

    public PoliceMode Mode { get; private set; }
    public PoliceRole Role { get; private set; }
    public float RoadZ => z;
    public float Lateral => lateral;

    PlayerController player;
    Rigidbody rb;
    Collider col;
    float z, lateral, latVel, speed, yawOffset, ramTimer, skill;

    void Awake()
    {
        rb = GetComponent<Rigidbody>();
        col = GetComponent<Collider>();
    }

    void OnEnable() => Active.Add(this);
    void OnDisable() => Active.Remove(this);

    // =========================================================== 生成（由 Spawner 从对象池取出后调用）
    public void InitChase(PlayerController target, float startZ, float startLateral, float startSpeed, PoliceRole role)
    {
        ResetBody();
        player = target;
        z = startZ;
        lateral = startLateral;
        speed = startSpeed;
        Role = role;
        Mode = PoliceMode.Chase;
        ramTimer = UnityEngine.Random.Range(0.8f, 2f);
        skill = UnityEngine.Random.Range(0.55f, 1f); // 避障能力，越低越容易被玩家引诱撞车
        ApplyTransform();
    }

    public void InitParked(float atZ, float atLateral, float yawDeg)
    {
        ResetBody();
        z = atZ;
        lateral = atLateral;
        speed = 0f;
        yawOffset = yawDeg * Mathf.Deg2Rad;
        Mode = PoliceMode.Parked;
        ApplyTransform();
    }

    void ResetBody()
    {
        StopAllCoroutines();
        rb.isKinematic = true;
        col.enabled = true;
        latVel = yawOffset = 0f;
    }

    // =========================================================== 追捕寻路
    void Update()
    {
        if (Mode != PoliceMode.Chase || player == null) return;
        Pursue(Time.deltaTime);
        ApplyTransform();
    }

    void Pursue(float dt)
    {
        float lim = RoadPath.HalfWidth - width * 0.5f - 0.1f;
        float rel = z - player.RoadZ; // > 0：警车在玩家前面

        // 1) 预测玩家横向位置（提前量追踪，而不是追着玩家当前位置跑）
        float predLat = Mathf.Clamp(player.Lateral + player.LateralVelocity * lookAhead, -lim, lim);
        float side = Role == PoliceRole.FlankLeft ? 1f : Role == PoliceRole.FlankRight ? -1f : Mathf.Sign(lateral - player.Lateral);
        if (side == 0f) side = 1f;
        float beside = (width + player.width) * 0.5f + 0.5f;
        float flankLat = predLat + side * beside;
        if (Mathf.Abs(flankLat) > lim) flankLat = predLat - side * beside; // 这侧没空间就去另一侧

        // 2) 按角色确定目标点（desiredGap = 相对玩家的纵向目标距离）
        float desiredLat, desiredGap;
        switch (Role)
        {
            case PoliceRole.Blocker:
                desiredGap = 10f;
                bool ahead = rel > (length + player.length) * 0.5f + 1.5f;
                desiredLat = ahead ? predLat : flankLat; // 先从侧面超车，超过去再并线
                break;
            case PoliceRole.Rammer:
                desiredGap = ramTimer <= 0f ? 0f : -7f;
                desiredLat = predLat;
                break;
            default:
                desiredGap = 0f;
                desiredLat = flankLat;
                break;
        }

        // 3) 纵向：P 控制追到目标距离；速度上限保证玩家冲刺时能甩开
        float desiredSpeed = player.Speed + Mathf.Clamp((player.RoadZ + desiredGap - z) * 1.4f, -14f, catchUp);
        if (Role == PoliceRole.Blocker && rel > 3f && Mathf.Abs(lateral - player.Lateral) < 2.5f)
            desiredSpeed = Mathf.Min(desiredSpeed, player.Speed - 5f); // 挡在前面刹车
        desiredSpeed = Mathf.Min(desiredSpeed, player.baseSpeed + catchUp + 6f);

        // 4) 避障：向前做 BoxCast，撞到障碍就选一侧绕开，两侧都没空间就减速
        float look = (12f + Mathf.Max(0f, speed - 10f) * 0.5f) * skill;
        Vector3 halfExt = new Vector3(width * 0.5f, 0.6f, 0.5f);
        if (Physics.BoxCast(transform.position + Vector3.up * 0.8f, halfExt, transform.forward, out RaycastHit hit,
                transform.rotation, look, obstacleMask, QueryTriggerInteraction.Collide))
        {
            float obLat = hit.collider.transform.position.x - RoadPath.CenterX(hit.collider.transform.position.z);
            float clear = (hit.collider.bounds.size.x + width) * 0.5f + 0.8f;
            float s = Mathf.Sign(lateral - obLat);
            if (s == 0f) s = 1f;
            float alt = obLat + s * clear;
            if (Mathf.Abs(alt) > lim) alt = obLat - s * clear;
            if (Mathf.Abs(alt) > lim) desiredSpeed = Mathf.Min(desiredSpeed, player.Speed * 0.5f);
            else desiredLat = alt;
        }

        // 5) 横向转向 + 侧撞
        ramTimer -= dt;
        float wantLatVel = Mathf.Clamp((desiredLat - lateral) * steerGain, -maxLatSpeed, maxLatSpeed);
        latVel = Mathf.Lerp(latVel, wantLatVel, 1f - Mathf.Exp(-4f * dt));
        if (Role != PoliceRole.Rammer && ramTimer <= 0f && Mathf.Abs(rel) < 2.6f && Mathf.Abs(player.Lateral - lateral) < 4.6f)
        {
            latVel = Mathf.Sign(player.Lateral - lateral) * ramImpulse;
            ramTimer = ramCooldown * UnityEngine.Random.Range(0.8f, 1.4f);
        }
        lateral = Mathf.Clamp(lateral + latVel * dt, -lim, lim);

        float accel = desiredSpeed > speed ? 22f : 30f;
        speed = Mathf.MoveTowards(speed, desiredSpeed, accel * dt);
        z += speed * dt;
        yawOffset = Mathf.Atan2(latVel, Mathf.Max(speed, 5f)) * 0.8f;
    }

    void ApplyTransform()
    {
        transform.position = RoadPath.ToWorld(z, lateral);
        transform.rotation = Quaternion.Euler(0f, (RoadPath.Heading(z) + yawOffset) * Mathf.Rad2Deg, 0f);
    }

    // =========================================================== 碰撞
    void OnTriggerEnter(Collider other)
    {
        if (Mode == PoliceMode.Wreck) return;

        // 关键：玩家处于冲刺状态（tag = PlayerDash）→ 警车瞬间被摧毁
        if (other.CompareTag(PlayerController.TagDash))
        {
            var p = other.GetComponentInParent<PlayerController>();
            p?.ExtendDash();
            Explode(other.transform.position, p ? p.Speed : speed, true);
            return;
        }

        if (other.CompareTag(PlayerController.TagNormal))
        {
            HandlePlayerContact(other.GetComponentInParent<PlayerController>());
            return;
        }

        // 追捕中撞上路障 / 民用车 / 坦克 → 自己炸（玩家可以引诱警车撞车）
        if (Mode == PoliceMode.Chase && ((1 << other.gameObject.layer) & obstacleMask) != 0)
        {
            Explode(other.transform.position, speed, false);
        }
    }

    void HandlePlayerContact(PlayerController p)
    {
        if (p == null) return;
        if (Mode == PoliceMode.Parked)
        {
            p.Hit(damage * 2.8f, 0f, 0.45f); // 硬闯路障
            return;
        }
        float dz = p.RoadZ - z;
        bool sideHit = Mathf.Abs(dz) < (length + p.length) * 0.35f;
        if (sideHit)
        {
            float dir = Mathf.Sign(p.Lateral - lateral);
            p.Hit(damage, dir * 0.8f, 0.85f);
            latVel = -dir * 5f;
        }
        else if (dz > 0f)
        {
            p.Hit(damage, 0f, 1f); // 从后面追尾
            speed = p.Speed - 10f;
        }
        else
        {
            p.Hit(damage * 1.3f, 0f, 0.55f); // 玩家撞上前方拦截者
            speed = p.Speed + 6f;
        }
        ramTimer = ramCooldown;
    }

    // =========================================================== 爆炸 & 回收
    /// <param name="sourcePos">撞击来源的位置，决定被炸飞的方向</param>
    /// <param name="sourceSpeed">撞击来源的速度，残骸继承一部分</param>
    public void Explode(Vector3 sourcePos, float sourceSpeed, bool byDash)
    {
        if (Mode == PoliceMode.Wreck) return;
        Mode = PoliceMode.Wreck;
        col.enabled = false;

        // 1) 从对象池“实例化”爆炸粒子特效，播放完自动回收
        if (explosionPrefab)
        {
            GameObject fx = PoolManager.Spawn(explosionPrefab, transform.position + Vector3.up * 0.8f, Quaternion.identity);
            fx.transform.localScale = Vector3.one * explosionPower;
            foreach (var ps in fx.GetComponentsInChildren<ParticleSystem>())
            {
                ps.Clear(true);
                ps.Play(true);
            }
            PoolManager.Despawn(fx, fxLifetime);
        }

        // 2) 车身被炸飞：切换为非运动学刚体，交给物理引擎
        float dir = Mathf.Sign(transform.position.x - sourcePos.x);
        if (dir == 0f) dir = UnityEngine.Random.value < 0.5f ? -1f : 1f;
        Vector3 fwd = transform.forward;
        Vector3 right = transform.right;
        rb.isKinematic = false;
        rb.useGravity = true;
        Vector3 launch = right * dir * UnityEngine.Random.Range(6f, 11f)
                       + Vector3.up * UnityEngine.Random.Range(13f, 19f) / Mathf.Sqrt(explosionPower)
                       + fwd * sourceSpeed * 0.55f;
#if UNITY_6000_0_OR_NEWER
        rb.linearVelocity = launch;
#else
        rb.velocity = launch;
#endif
        rb.angularVelocity = new Vector3(UnityEngine.Random.Range(-6f, 6f), UnityEngine.Random.Range(-5f, 5f), dir * UnityEngine.Random.Range(4f, 9f));

        // 3) 打击感（顿帧 + 镜头震动 + 震动反馈），连击数由 GameFeel 统计
        GameFeel.EnemyDestroyed(explosionPower);
        Destroyed?.Invoke(this, byDash);

        // 4) 残骸飞一会儿后回收进对象池
        StartCoroutine(RecycleAfter(wreckLifetime));
    }

    IEnumerator RecycleAfter(float t)
    {
        yield return new WaitForSeconds(t); // 受 timeScale 影响，慢动作时残骸停留更久
        rb.isKinematic = true;
        PoolManager.Despawn(gameObject);
    }
}
