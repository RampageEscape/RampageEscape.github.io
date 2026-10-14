using System.Collections;
using System.Collections.Generic;
using UnityEngine;

/// 记录每个实例来自哪个预制体，回收时放回对应的池（运行时自动添加，不需要手动挂）
public class PooledTag : MonoBehaviour
{
    public GameObject prefab;
}

/// <summary>
/// 通用对象池：爆炸特效、警车、民用车、碎片都走这里，避免 Instantiate/Destroy 造成 GC 卡顿。
/// 用法：PoolManager.Spawn(prefab, pos, rot) / PoolManager.Despawn(go, delay)
/// 场景中不需要手动放置，第一次调用时自动创建。
/// </summary>
public class PoolManager : MonoBehaviour
{
    static PoolManager instance;
    readonly Dictionary<GameObject, Stack<GameObject>> pools = new Dictionary<GameObject, Stack<GameObject>>();

    static PoolManager Instance
    {
        get
        {
            if (instance == null) instance = new GameObject("[PoolManager]").AddComponent<PoolManager>();
            return instance;
        }
    }

    /// 预热：加载关卡时先生成一批，战斗中就不会再分配内存
    public static void Prewarm(GameObject prefab, int count)
    {
        var list = new List<GameObject>();
        for (int i = 0; i < count; i++) list.Add(Spawn(prefab, Vector3.zero, Quaternion.identity));
        foreach (var go in list) Despawn(go);
    }

    public static GameObject Spawn(GameObject prefab, Vector3 pos, Quaternion rot)
    {
        var self = Instance;
        if (!self.pools.TryGetValue(prefab, out var stack)) self.pools[prefab] = stack = new Stack<GameObject>();
        GameObject go;
        if (stack.Count > 0)
        {
            go = stack.Pop();
            go.transform.SetPositionAndRotation(pos, rot);
        }
        else
        {
            go = Instantiate(prefab, pos, rot);
            go.AddComponent<PooledTag>().prefab = prefab;
        }
        go.SetActive(true);
        return go;
    }

    public static void Despawn(GameObject go, float delay = 0f)
    {
        if (go == null) return;
        if (delay > 0f) { Instance.StartCoroutine(Instance.DespawnLater(go, delay)); return; }
        var tag = go.GetComponent<PooledTag>();
        if (tag == null) { Destroy(go); return; } // 不是从池里出来的，直接销毁
        go.SetActive(false);
        go.transform.SetParent(Instance.transform, false);
        Instance.pools[tag.prefab].Push(go);
    }

    IEnumerator DespawnLater(GameObject go, float delay)
    {
        yield return new WaitForSeconds(delay);
        if (go != null && go.activeSelf) Despawn(go);
    }
}
