using System.Text;
using UnityEditor;
using UnityEngine;

/// <summary>
/// 高精度模型的导入规范：放进 Assets/Art/ 下的模型和贴图会被自动设置成统一、对移动端友好的参数，
/// 不用每个文件手动点 Inspector。
///
/// 目录约定：
///   Assets/Art/Vehicles/     车辆（动态物体，不生成光照贴图 UV）
///   Assets/Art/Environment/  建筑、树、岩石（静态物体，生成光照贴图 UV 方便烘焙）
///
/// 命名约定（在 Blender 里起名）：
///   UCX_xxx 或 xxx_col  → 只当碰撞网格用：自动加 MeshCollider、去掉渲染（只用于静态环境，车辆一律用 BoxCollider）
///   Wheel_FL / Muzzle / Turret / Siren_Red … → 锚点，VisualSlot.FindAnchor 按名字找
/// </summary>
public class ModelImportRules : AssetPostprocessor
{
    const string ArtRoot = "Assets/Art/";
    const string EnvDir = "Assets/Art/Environment/";
    const string VehicleDir = "Assets/Art/Vehicles/";

    // 三角面预算（移动端，LOD0）
    const int VehicleTriBudget = 25000;
    const int PropTriBudget = 6000;

    void OnPreprocessModel()
    {
        if (!assetPath.StartsWith(ArtRoot)) return;
        var mi = (ModelImporter)assetImporter;
        mi.globalScale = 1f;
        mi.useFileScale = true;
        mi.bakeAxisConversion = true;          // 把 Blender 的 Z-up 直接烘焙进网格，根节点不会带 -90° 旋转
        mi.isReadable = false;                 // 不需要 CPU 读网格，省一半内存
        mi.meshCompression = ModelImporterMeshCompression.Medium;
        mi.meshOptimizationFlags = MeshOptimizationFlags.Everything;
        mi.importBlendShapes = false;
        mi.importCameras = false;
        mi.importLights = false;
        mi.importAnimation = false;
        mi.animationType = ModelImporterAnimationType.None;
        mi.addCollider = false;                // 碰撞由预制体根节点的 BoxCollider 负责
        mi.importNormals = ModelImporterNormals.Import;
        mi.importTangents = ModelImporterTangents.CalculateMikk; // 法线贴图需要切线
        mi.generateSecondaryUV = assetPath.StartsWith(EnvDir);   // 静态环境烘焙光照/AO 用
        mi.materialImportMode = ModelImporterMaterialImportMode.ImportViaMaterialDescription;
    }

    void OnPostprocessModel(GameObject root)
    {
        if (!assetPath.StartsWith(ArtRoot)) return;
        int tris = 0;
        foreach (var mf in root.GetComponentsInChildren<MeshFilter>(true))
        {
            Mesh mesh = mf.sharedMesh;
            if (mesh == null) continue;
            string n = mf.name;
            if (n.StartsWith("UCX_") || n.EndsWith("_col"))
            {
                // 简化碰撞网格：只给静态环境用
                mf.gameObject.AddComponent<MeshCollider>().sharedMesh = mesh;
                var mr = mf.GetComponent<MeshRenderer>();
                if (mr != null) Object.DestroyImmediate(mr);
                continue;
            }
            for (int s = 0; s < mesh.subMeshCount; s++) tris += (int)mesh.GetIndexCount(s) / 3;
        }
        int budget = assetPath.StartsWith(VehicleDir) ? VehicleTriBudget : PropTriBudget;
        if (tris > budget)
            Debug.LogWarning($"[ModelImportRules] {assetPath}: {tris} 个三角面，超过预算 {budget}。请做 LOD 或减面。");
    }

    void OnPreprocessTexture()
    {
        if (!assetPath.StartsWith(ArtRoot)) return;
        var ti = (TextureImporter)assetImporter;
        string lower = assetPath.ToLowerInvariant();
        bool isNormal = lower.Contains("_normal") || lower.EndsWith("_n.png") || lower.EndsWith("_n.tga");
        bool isMask = lower.Contains("_mask") || lower.Contains("_metallic") || lower.Contains("_ao");
        if (isNormal) ti.textureType = TextureImporterType.NormalMap;
        ti.sRGBTexture = !(isNormal || isMask); // 金属度/AO 等数据贴图必须是线性空间
        ti.mipmapEnabled = true;
        ti.maxTextureSize = 2048;
        int mobileSize = assetPath.StartsWith(VehicleDir) ? 1024 : 512;
        foreach (string platform in new[] { "Android", "iPhone" })
        {
            var ps = ti.GetPlatformTextureSettings(platform);
            ps.overridden = true;
            ps.maxTextureSize = mobileSize;
            ps.format = isNormal ? TextureImporterFormat.ASTC_5x5 : TextureImporterFormat.ASTC_6x6;
            ti.SetPlatformTextureSettings(ps);
        }
    }
}

/// <summary>菜单：Tools/Rampage Escape/Audit Visuals —— 检查选中（或全部）预制体的模型是否“合规”</summary>
public static class VisualAudit
{
    [MenuItem("Tools/Rampage Escape/Audit Visuals")]
    static void Audit()
    {
        var sb = new StringBuilder("[VisualAudit]\n");
        string[] guids = Selection.assetGUIDs.Length > 0 ? Selection.assetGUIDs : AssetDatabase.FindAssets("t:Prefab");
        int issues = 0;
        foreach (string guid in guids)
        {
            string path = AssetDatabase.GUIDToAssetPath(guid);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) continue;
            foreach (var slot in prefab.GetComponentsInChildren<VisualSlot>(true))
            {
                var box = slot.referenceCollider != null ? slot.referenceCollider : slot.GetComponentInParent<BoxCollider>();
                foreach (var model in new[] { slot.blockyPrefab, slot.highPolyPrefab })
                {
                    if (model == null) continue;
                    int tris = 0, mats = 0, cols = model.GetComponentsInChildren<Collider>(true).Length;
                    foreach (var mf in model.GetComponentsInChildren<MeshFilter>(true))
                        if (mf.sharedMesh != null) for (int s = 0; s < mf.sharedMesh.subMeshCount; s++) tris += (int)mf.sharedMesh.GetIndexCount(s) / 3;
                    foreach (var r in model.GetComponentsInChildren<Renderer>(true)) mats += r.sharedMaterials.Length;
                    bool lod = model.GetComponentInChildren<LODGroup>(true) != null;
                    string warn = "";
                    if (box == null) warn += " 没有 BoxCollider!";
                    if (mats > 4) warn += $" 材质过多({mats})，会增加 draw call;";
                    if (tris > 25000 && !lod) warn += " 面数高但没有 LODGroup;";
                    if (cols > 0) warn += $" 自带 {cols} 个碰撞体(运行时会被删除);";
                    if (warn.Length > 0) issues++;
                    sb.AppendLine($"{path} → {model.name}: {tris} tris, {mats} materials, LOD={lod}.{warn}");
                }
            }
        }
        sb.AppendLine($"共 {issues} 个模型需要注意。");
        Debug.Log(sb.ToString());
    }
}
