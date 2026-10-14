using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// 车轮转动 + 前轮转向。挂在和 VisualSlot 同一个物体上。
/// 每次 VisualSlot 换模型都会重新按名字找车轮（Wheel_FL / Wheel_FR / Wheel_RL / Wheel_RR，或任何以 "Wheel" 开头的节点），
/// 所以方块模型和高精度模型可以共用这一个脚本，玩法代码完全不知道模型换了。
/// 车轮的轴心要在轮毂中心（建模时设置好 Pivot，否则会“偏心”转）。
/// </summary>
[RequireComponent(typeof(VisualSlot))]
public class WheelSpinner : MonoBehaviour
{
    public float wheelRadius = 0.42f;
    public float maxSteerDeg = 25f;
    [Tooltip("速度来源：留空则用父物体的位移估算")]
    public PlayerController player;

    VisualSlot slot;
    readonly List<Transform> wheels = new List<Transform>();
    readonly List<Transform> frontWheels = new List<Transform>();
    readonly List<Quaternion> baseRot = new List<Quaternion>();
    Vector3 lastPos;
    float spin;

    void Awake() => slot = GetComponent<VisualSlot>();
    void OnEnable() { slot.VisualChanged += Bind; Bind(slot); }
    void OnDisable() => slot.VisualChanged -= Bind;

    void Bind(VisualSlot s)
    {
        wheels.Clear();
        frontWheels.Clear();
        baseRot.Clear();
        if (s.Model == null) return;
        foreach (var t in s.Model.GetComponentsInChildren<Transform>(true))
        {
            if (!t.name.StartsWith("Wheel")) continue;
            wheels.Add(t);
            baseRot.Add(t.localRotation);
            if (t.name.EndsWith("FL") || t.name.EndsWith("FR")) frontWheels.Add(t);
        }
        lastPos = transform.position;
    }

    void LateUpdate()
    {
        if (wheels.Count == 0 || Time.deltaTime <= 0f) return;
        float speed = player != null ? player.Speed : Vector3.Distance(transform.position, lastPos) / Time.deltaTime;
        lastPos = transform.position;
        spin += speed * Time.deltaTime / wheelRadius * Mathf.Rad2Deg;
        float steer = player != null ? Mathf.Clamp(player.LateralVelocity * 4f, -maxSteerDeg, maxSteerDeg) : 0f;
        for (int i = 0; i < wheels.Count; i++)
        {
            float yaw = frontWheels.Contains(wheels[i]) ? steer : 0f;
            wheels[i].localRotation = baseRot[i] * Quaternion.Euler(spin, yaw, 0f);
        }
    }
}
