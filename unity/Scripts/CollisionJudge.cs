using UnityEngine;

public enum ContactType { Front, Rear, Side }

public struct ContactInfo
{
    public ContactType type;
    public float side;          // 对方在玩家哪一侧：+1 = +X（Unity 左手坐标系里车头朝 +Z 时是驾驶员右侧），-1 = -X
    public bool playerAtFault;  // 是否算玩家的主动失误（只有失误才扣血）
}

/// <summary>
/// 碰撞判定：“只惩罚主动失误”。
///
/// 规则
///   Rear  （被后车追尾）           → 不扣血，往前推一把
///   Side  + 对方挤过来             → 不扣血，横向推一下
///   Side  + 玩家自己变道撞上去      → 扣血
///   Front （玩家撞上前方的车/路障） → 扣血
///
/// 提供两种实现，任选其一：
///   A. Classify()          ：道路坐标 + 最小穿透轴（和网页版一致）。适合 Trigger 碰撞，没有物理接触点也能用。
///   B. ClassifyByNormal()  ：用物理引擎给的碰撞法线。适合非 Trigger 的刚体碰撞（OnCollisionEnter）。
/// </summary>
public static class CollisionJudge
{
    /// 判定侧撞责任时的速度容差（m/s），避免两车都几乎不动时判定抖动
    const float FaultTolerance = 0.5f;

    /// <summary>
    /// A. 道路坐标判定。
    /// 两个矩形重叠时，“穿透深度更浅的那个轴”就是碰撞法线方向：
    ///   纵向穿透更浅 → 前后碰撞，看对方在前还是在后
    ///   横向穿透更浅 → 侧面碰撞，比较双方“朝对方靠近”的横向速度，快的一方是肇事者
    /// </summary>
    public static ContactInfo Classify(PlayerController player,
        float otherZ, float otherLateral, float otherLateralVelocity, float otherLength, float otherWidth)
    {
        float dz = otherZ - player.RoadZ;               // > 0：对方在玩家前面
        float dl = otherLateral - player.Lateral;       // > 0：对方在玩家 +X 侧
        float side = dl >= 0f ? 1f : -1f;
        float penZ = (player.length + otherLength) * 0.5f - Mathf.Abs(dz);
        float penL = (player.width + otherWidth) * 0.5f - Mathf.Abs(dl);

        if (penZ <= penL)
        {
            return dz > 0f
                ? new ContactInfo { type = ContactType.Front, side = side, playerAtFault = true }
                : new ContactInfo { type = ContactType.Rear, side = side, playerAtFault = false };
        }

        float playerClosing = player.LateralVelocity * side;   // > 0：玩家正往对方那边变道
        float otherClosing = -otherLateralVelocity * side;     // > 0：对方正往玩家这边挤
        return new ContactInfo
        {
            type = ContactType.Side,
            side = side,
            playerAtFault = playerClosing > otherClosing + FaultTolerance,
        };
    }

    /// <summary>
    /// B. 物理法线判定（在玩家身上的 OnCollisionEnter 里调用）。
    /// contact.normal 指向玩家（从对方指向自己）。与玩家朝向做点积：
    ///   normal · forward >  0.6 → 力从后面来 → Rear（被追尾）
    ///   normal · forward < -0.6 → 力从前面来 → Front（撞上前车）
    ///   其他                     → Side，再比较双方横向速度判断责任
    /// </summary>
    public static ContactInfo ClassifyByNormal(Collision collision, Transform playerTf, Rigidbody playerRb)
    {
        ContactPoint cp = collision.GetContact(0);
        Vector3 n = cp.normal;                       // 从对方指向玩家
        float along = Vector3.Dot(n, playerTf.forward);
        float side = Vector3.Dot(-n, playerTf.right) >= 0f ? 1f : -1f; // 对方在玩家右侧（+X）→ +1

        if (along > 0.6f) return new ContactInfo { type = ContactType.Rear, side = side, playerAtFault = false };
        if (along < -0.6f) return new ContactInfo { type = ContactType.Front, side = side, playerAtFault = true };

        Vector3 right = playerTf.right;
        Rigidbody other = collision.rigidbody;
#if UNITY_6000_0_OR_NEWER
        float playerLat = Vector3.Dot(playerRb.linearVelocity, right);
        float otherLat = other ? Vector3.Dot(other.linearVelocity, right) : 0f;
#else
        float playerLat = Vector3.Dot(playerRb.velocity, right);
        float otherLat = other ? Vector3.Dot(other.velocity, right) : 0f;
#endif
        float playerClosing = playerLat * side;  // > 0：玩家往对方那边移动
        float otherClosing = -otherLat * side;   // > 0：对方往玩家这边移动
        return new ContactInfo { type = ContactType.Side, side = side, playerAtFault = playerClosing > otherClosing + FaultTolerance };
    }
}
