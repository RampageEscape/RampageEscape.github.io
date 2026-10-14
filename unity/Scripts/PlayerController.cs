using System;
using UnityEngine;

/// <summary>
/// 玩家车辆控制器（移动端）
///  - 屏幕滑动：左/右 = 变道，上/下 = 加速/刹车；手指移动超过阈值立即触发，一次拖动可连续变道
///  - 双击屏幕 / UI 按钮调用 TryDash() = 冲刺
///  - 冲刺期间：速度 ×1.65、无敌，并把 tag 切换为 "PlayerDash"，警车在 OnTriggerEnter 里据此判定被撞毁
///
/// 场景设置：
///  1. Tags & Layers 里新增 tag "PlayerDash"
///  2. 本物体：Rigidbody(isKinematic) + BoxCollider(isTrigger)，tag = "Player"
///  3. visualRoot 指向车身模型子节点（用来做侧倾，不影响碰撞盒）
/// </summary>
[RequireComponent(typeof(Rigidbody))]
public class PlayerController : MonoBehaviour
{
    public const string TagNormal = "Player";
    public const string TagDash = "PlayerDash";

    [Header("车道")]
    public int startLane = 1;
    public float laneSharpness = 9f;

    [Header("速度")]
    public float baseSpeed = 30f, minSpeed = 14f, maxSpeed = 46f;
    public float accel = 16f, brake = 34f;
    public float swipeUpBias = 10f, swipeDownBias = -14f, maxBias = 16f, biasDecay = 3f;

    [Header("滑动输入")]
    [Tooltip("触发滑动的最小距离（dp，会按屏幕 DPI 换算成像素）")]
    public float swipeThresholdDp = 30f;
    public float doubleTapTime = 0.3f;

    [Header("冲刺 Dash")]
    public float dashDuration = 1.1f, dashCooldown = 3.2f, dashSpeedMul = 1.65f, dashExtendOnKill = 0.3f;
    public GameObject dashAura;
    public TrailRenderer[] dashTrails;

    [Header("生命")]
    public float maxHp = 100f, hitInvuln = 0.7f;

    [Header("被推（非玩家失误的碰撞）")]
    public float rearBoost = 5f;        // 被追尾时往前推的速度
    public float sidePush = 0.6f;       // 被侧挤时的横向推力系数
    public float bumpMaxSpeedMul = 1.15f;

    [Header("表现")]
    public Transform visualRoot;
    public float width = 2f, length = 4.4f;

    public event Action OnDashStart, OnDashEnd;
    public event Action<float> OnHit;
    public event Action OnBump;          // 可以在这里播放轻微的金属摩擦音效 / 小火花
    public event Action OnDeath;

    // ---- 对外只读状态（AI 会读取） ----
    public bool IsDashing { get; private set; }
    public bool IsAlive => hp > 0f;
    public float RoadZ => z;
    public float Lateral => lateral;
    public float LateralVelocity => latVel;
    public float Speed => speed;
    public float Hp => hp;
    public float DashCharge => IsDashing ? 1f : 1f - dashCooldownTimer / dashCooldown;
    public bool DashReady => IsAlive && !IsDashing && dashCooldownTimer <= 0f;

    int lane;
    float z, lateral, latVel, knockVel, speed, speedBias, hp, invuln, dashTimer, dashCooldownTimer;

    // 触摸状态
    Vector2 touchStart, touchAnchor;
    float touchStartTime, lastTapTime = -1f;
    bool swipeFired;
    int touchId = -1;

    void Awake()
    {
        GetComponent<Rigidbody>().isKinematic = true;
        ResetState(0f);
    }

    public void ResetState(float startZ)
    {
        lane = startLane;
        lateral = RoadPath.LaneOffset(lane);
        z = startZ;
        speed = baseSpeed;
        speedBias = latVel = knockVel = invuln = dashTimer = dashCooldownTimer = 0f;
        hp = maxHp;
        SetDashing(false);
        ApplyTransform(0f);
    }

    void Update()
    {
        float dt = Time.deltaTime; // 受 Time.timeScale 影响 → 顿帧/慢动作自动生效
        ReadTouch();
        ReadKeyboard();
        UpdateDash(dt);
        UpdateSpeed(dt);
        UpdateLateral(dt);
        z += speed * dt;
        ApplyTransform(dt);
    }

    // =========================================================== 输入
    float SwipeThresholdPx => swipeThresholdDp * (Screen.dpi > 0f ? Screen.dpi / 160f : 1f);

    void ReadTouch()
    {
        for (int i = 0; i < Input.touchCount; i++)
        {
            Touch t = Input.GetTouch(i);
            if (touchId == -1 && t.phase == TouchPhase.Began)
            {
                touchId = t.fingerId;
                touchStart = touchAnchor = t.position;
                touchStartTime = Time.unscaledTime;
                swipeFired = false;
            }
            if (t.fingerId != touchId) continue;

            if (t.phase == TouchPhase.Moved)
            {
                Vector2 d = t.position - touchAnchor;
                if (d.magnitude >= SwipeThresholdPx)
                {
                    HandleSwipe(d);
                    touchAnchor = t.position; // 以当前位置为新起点，支持连续滑动
                    swipeFired = true;
                }
            }
            else if (t.phase == TouchPhase.Ended || t.phase == TouchPhase.Canceled)
            {
                bool isTap = !swipeFired
                    && (t.position - touchStart).magnitude < SwipeThresholdPx * 0.4f
                    && Time.unscaledTime - touchStartTime < 0.25f;
                if (isTap)
                {
                    if (lastTapTime > 0f && Time.unscaledTime - lastTapTime < doubleTapTime) { TryDash(); lastTapTime = -1f; }
                    else lastTapTime = Time.unscaledTime;
                }
                touchId = -1;
            }
        }
    }

    void ReadKeyboard()
    {
#if UNITY_EDITOR || UNITY_STANDALONE || UNITY_WEBGL
        if (Input.GetKeyDown(KeyCode.LeftArrow) || Input.GetKeyDown(KeyCode.A)) HandleSwipe(Vector2.left);
        if (Input.GetKeyDown(KeyCode.RightArrow) || Input.GetKeyDown(KeyCode.D)) HandleSwipe(Vector2.right);
        if (Input.GetKeyDown(KeyCode.UpArrow) || Input.GetKeyDown(KeyCode.W)) HandleSwipe(Vector2.up);
        if (Input.GetKeyDown(KeyCode.DownArrow) || Input.GetKeyDown(KeyCode.S)) HandleSwipe(Vector2.down);
        if (Input.GetKeyDown(KeyCode.Space)) TryDash();
#endif
    }

    /// 屏幕坐标原点在左下角：d.y > 0 是向上滑
    void HandleSwipe(Vector2 d)
    {
        if (!IsAlive) return;
        if (Mathf.Abs(d.x) > Mathf.Abs(d.y))
        {
            // Unity 是左手坐标系：车头朝 +Z 时 +X 是驾驶员右侧（镜头在车后方，也是屏幕右侧）
            // → 右滑 = 车道编号 +1（往 +X），左滑 = -1
            lane = d.x > 0f ? Mathf.Min(RoadPath.LaneCount - 1, lane + 1) : Mathf.Max(0, lane - 1);
        }
        else
        {
            speedBias = d.y > 0f
                ? Mathf.Min(maxBias, speedBias + swipeUpBias)
                : Mathf.Max(-maxBias, speedBias + swipeDownBias);
        }
    }

    // =========================================================== 冲刺
    public bool TryDash()
    {
        if (!DashReady) return false;
        dashTimer = dashDuration;
        invuln = 0f;
        SetDashing(true);
        OnDashStart?.Invoke();
        return true;
    }

    /// 冲刺中每撞毁一辆警车延长一点冲刺时间，鼓励连撞
    public void ExtendDash()
    {
        if (IsDashing) dashTimer = Mathf.Min(dashTimer + dashExtendOnKill, dashDuration * 1.5f);
    }

    void UpdateDash(float dt)
    {
        if (IsDashing)
        {
            dashTimer -= dt;
            if (dashTimer <= 0f)
            {
                SetDashing(false);
                dashCooldownTimer = dashCooldown;
                OnDashEnd?.Invoke();
            }
        }
        else if (dashCooldownTimer > 0f)
        {
            dashCooldownTimer = Mathf.Max(0f, dashCooldownTimer - dt);
        }
        invuln = Mathf.Max(0f, invuln - dt);
    }

    /// 核心：冲刺状态通过“切换碰撞标签”暴露给其他物体
    void SetDashing(bool on)
    {
        IsDashing = on;
        gameObject.tag = on ? TagDash : TagNormal;
        if (dashAura) dashAura.SetActive(on);
        if (dashTrails != null) foreach (var tr in dashTrails) if (tr) tr.emitting = on;
    }

    // =========================================================== 受伤
    /// 返回 true 表示真的扣了血（冲刺或无敌帧期间免疫）
    public bool Hit(float damage, float pushDir = 0f, float speedMul = 0.6f)
    {
        if (!IsAlive || IsDashing || invuln > 0f) return false;
        hp = Mathf.Max(0f, hp - damage);
        invuln = hitInvuln;
        speed *= speedMul;
        if (pushDir != 0f)
        {
            knockVel = pushDir * 8f;
            lane = RoadPath.NearestLane(lateral + pushDir * RoadPath.LaneWidth * 0.6f);
        }
        OnHit?.Invoke(damage);
        if (hp <= 0f) OnDeath?.Invoke();
        return true;
    }

    /// <summary>
    /// 非玩家失误的碰撞（被追尾、被警车侧挤）：不扣血、不进无敌帧，只推一把。
    ///   speedBoost：加到速度偏移量上，1~2 秒内自然回落 → 像被人从后面推了一把
    ///   pushDir   ：横向推一下，但不改目标车道，车子会自己回正
    /// </summary>
    public void Bump(float pushDir, float speedBoost)
    {
        if (!IsAlive) return;
        if (pushDir != 0f) knockVel = pushDir * 8f * sidePush;
        if (speedBoost > 0f)
        {
            speedBias = Mathf.Min(maxBias, speedBias + speedBoost);
            float cap = maxSpeed * bumpMaxSpeedMul * (IsDashing ? dashSpeedMul : 1f);
            speed = Mathf.Min(speed + speedBoost * 0.6f, cap);
        }
        OnBump?.Invoke();
    }

    /// 撞上不可摧毁的东西（坦克）时被挡住
    public void BlockAt(float maxZ, float speedCap)
    {
        z = Mathf.Min(z, maxZ);
        speed = Mathf.Min(speed, speedCap);
    }

    // =========================================================== 移动
    void UpdateSpeed(float dt)
    {
        float decay = biasDecay * dt;
        speedBias = Mathf.Abs(speedBias) <= decay ? 0f : speedBias - Mathf.Sign(speedBias) * decay;
        float target = Mathf.Clamp(baseSpeed + speedBias, minSpeed, maxSpeed);
        if (IsDashing) target *= dashSpeedMul;
        if (!IsAlive) target = 0f;
        float rate = target > speed ? (IsDashing ? accel * 5f : accel) : brake;
        speed = Mathf.MoveTowards(speed, target, rate * dt);
    }

    void UpdateLateral(float dt)
    {
        float prev = lateral;
        // 帧率无关的指数平滑：lerp 系数 = 1 - e^(-k·dt)
        lateral = Mathf.Lerp(lateral, RoadPath.LaneOffset(lane), 1f - Mathf.Exp(-laneSharpness * dt)) + knockVel * dt;
        knockVel = Mathf.Lerp(knockVel, 0f, 1f - Mathf.Exp(-6f * dt));
        float lim = RoadPath.HalfWidth - width * 0.5f - 0.1f;
        lateral = Mathf.Clamp(lateral, -lim, lim);
        latVel = dt > 0f ? (lateral - prev) / dt : 0f;
    }

    void ApplyTransform(float dt)
    {
        transform.position = RoadPath.ToWorld(z, lateral);
        float yaw = RoadPath.Heading(z) + Mathf.Atan2(latVel, Mathf.Max(speed, 5f)) * 0.9f;
        transform.rotation = Quaternion.Euler(0f, yaw * Mathf.Rad2Deg, 0f);
        if (visualRoot)
        {
            float roll = Mathf.Clamp(-latVel * 0.025f, -0.12f, 0.12f) * Mathf.Rad2Deg;
            float pitch = IsDashing ? -3f : 0f;
            Quaternion target = Quaternion.Euler(pitch, 0f, roll);
            visualRoot.localRotation = Quaternion.Slerp(visualRoot.localRotation, target, 1f - Mathf.Exp(-10f * dt));
        }
    }
}
