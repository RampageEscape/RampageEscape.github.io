// 车漆 Shader（URP 14 / Unity 2022.3 LTS 及以上）
//
// 在标准 PBR（UniversalFragmentPBR）基础上加三样东西，让高精度车模看起来像“真的烤漆”：
//   1. 清漆层 Clear Coat：URP 自带的第二层高光（_CLEARCOAT），漆面上那层亮亮的反射
//   2. 双色漆 Flip Color：正对视线是底色，掠射角渐变到另一种颜色（变色龙漆、糖果漆）
//   3. 金属闪片 Flakes：物体空间网格哈希，随机让一小部分像素更亮，模拟金属颗粒
//
// 性能：比 URP Lit 多一层高光和一次哈希，移动端只建议给玩家车 LOD0 用；
// 警车、民用车用普通 URP Lit，低画质可以整体换成 Simple Lit。
// 所有 Pass 共用同一个 UnityPerMaterial CBUFFER，兼容 SRP Batcher。
Shader "RampageEscape/CarPaint"
{
    Properties
    {
        [MainColor] _BaseColor("Base Color", Color) = (0.82, 0.1, 0.08, 1)
        _FlipColor("Flip Color (掠射角)", Color) = (0.35, 0.02, 0.12, 1)
        [MainTexture] _BaseMap("Albedo (贴花/脏污)", 2D) = "white" {}
        [Normal] _BumpMap("Normal Map", 2D) = "bump" {}
        _OcclusionMap("Occlusion (烘焙 AO，G 通道)", 2D) = "white" {}
        _Metallic("Metallic", Range(0, 1)) = 0.55
        _Smoothness("Smoothness", Range(0, 1)) = 0.55
        _ClearCoatMask("Clear Coat", Range(0, 1)) = 1
        _ClearCoatSmoothness("Clear Coat Smoothness", Range(0, 1)) = 0.92
        _FlakeDensity("Flake Density", Range(50, 800)) = 320
        _FlakeIntensity("Flake Intensity", Range(0, 1)) = 0.35
    }

    SubShader
    {
        Tags { "RenderType" = "Opaque" "RenderPipeline" = "UniversalPipeline" "Queue" = "Geometry" }
        LOD 300

        HLSLINCLUDE
        #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

        TEXTURE2D(_BaseMap);      SAMPLER(sampler_BaseMap);
        TEXTURE2D(_BumpMap);      SAMPLER(sampler_BumpMap);
        TEXTURE2D(_OcclusionMap); SAMPLER(sampler_OcclusionMap);

        CBUFFER_START(UnityPerMaterial)
            float4 _BaseMap_ST;
            half4 _BaseColor;
            half4 _FlipColor;
            half _Metallic;
            half _Smoothness;
            half _ClearCoatMask;
            half _ClearCoatSmoothness;
            half _FlakeDensity;
            half _FlakeIntensity;
        CBUFFER_END
        ENDHLSL

        // ------------------------------------------------------------------ 主光照
        Pass
        {
            Name "ForwardLit"
            Tags { "LightMode" = "UniversalForward" }

            HLSLPROGRAM
            #pragma target 3.5
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile _ _MAIN_LIGHT_SHADOWS _MAIN_LIGHT_SHADOWS_CASCADE
            #pragma multi_compile _ _ADDITIONAL_LIGHTS_VERTEX _ADDITIONAL_LIGHTS
            #pragma multi_compile _ _FORWARD_PLUS
            #pragma multi_compile_fragment _ _SHADOWS_SOFT
            #pragma multi_compile_fragment _ _SCREEN_SPACE_OCCLUSION
            #pragma multi_compile_fog
            #pragma multi_compile_instancing
            #define _CLEARCOAT 1
            #define _NORMALMAP 1

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                float4 tangentOS  : TANGENT;
                float2 uv         : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv         : TEXCOORD0;
                float3 positionWS : TEXCOORD1;
                half3  normalWS   : TEXCOORD2;
                half4  tangentWS  : TEXCOORD3;
                half   fogFactor  : TEXCOORD4;
                float3 positionOS : TEXCOORD5;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            Varyings vert(Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_TRANSFER_INSTANCE_ID(v, o);
                VertexPositionInputs pos = GetVertexPositionInputs(v.positionOS.xyz);
                VertexNormalInputs nrm = GetVertexNormalInputs(v.normalOS, v.tangentOS);
                o.positionCS = pos.positionCS;
                o.positionWS = pos.positionWS;
                o.normalWS = nrm.normalWS;
                o.tangentWS = half4(nrm.tangentWS, v.tangentOS.w * GetOddNegativeScale());
                o.uv = TRANSFORM_TEX(v.uv, _BaseMap);
                o.fogFactor = ComputeFogFactor(pos.positionCS.z);
                o.positionOS = v.positionOS.xyz;
                return o;
            }

            // 物体空间网格哈希：闪片跟着车走，不会在车身上“滑动”
            float Hash13(float3 p)
            {
                p = frac(p * 0.1031);
                p += dot(p, p.zyx + 31.32);
                return frac((p.x + p.y) * p.z);
            }

            half4 frag(Varyings i) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(i);

                half3 viewDirWS = GetWorldSpaceNormalizeViewDir(i.positionWS);
                half3 normalTS = UnpackNormal(SAMPLE_TEXTURE2D(_BumpMap, sampler_BumpMap, i.uv));
                half3 bitangentWS = i.tangentWS.w * cross(i.normalWS, i.tangentWS.xyz);
                half3 normalWS = NormalizeNormalPerPixel(TransformTangentToWorld(normalTS, half3x3(i.tangentWS.xyz, bitangentWS, i.normalWS)));

                // 双色漆
                half ndv = saturate(dot(normalWS, viewDirWS));
                half3 paint = lerp(_FlipColor.rgb, _BaseColor.rgb, ndv * ndv);
                half3 albedoTex = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, i.uv).rgb;

                // 金属闪片：约 18% 的小格子更光滑、更亮
                half flake = step(0.82, Hash13(floor(i.positionOS * _FlakeDensity))) * _FlakeIntensity;

                SurfaceData s = (SurfaceData)0;
                s.albedo = paint * albedoTex;
                s.metallic = _Metallic;
                s.smoothness = saturate(_Smoothness + flake * 0.35);
                s.normalTS = normalTS;
                s.occlusion = SAMPLE_TEXTURE2D(_OcclusionMap, sampler_OcclusionMap, i.uv).g;
                s.alpha = 1;
                s.clearCoatMask = _ClearCoatMask;
                s.clearCoatSmoothness = _ClearCoatSmoothness;

                InputData d = (InputData)0;
                d.positionWS = i.positionWS;
                d.normalWS = normalWS;
                d.viewDirectionWS = viewDirWS;
                d.shadowCoord = TransformWorldToShadowCoord(i.positionWS);
                d.fogCoord = i.fogFactor;
                d.bakedGI = SampleSH(normalWS);
                d.normalizedScreenSpaceUV = GetNormalizedScreenSpaceUV(i.positionCS);
                d.shadowMask = half4(1, 1, 1, 1);

                half4 color = UniversalFragmentPBR(d, s);
                // 闪片在主光下额外闪一点（便宜的“亮片”效果）
                Light mainLight = GetMainLight(d.shadowCoord);
                color.rgb += flake * mainLight.color * mainLight.shadowAttenuation * 0.25;
                color.rgb = MixFog(color.rgb, d.fogCoord);
                return color;
            }
            ENDHLSL
        }

        // ------------------------------------------------------------------ 投射阴影
        Pass
        {
            Name "ShadowCaster"
            Tags { "LightMode" = "ShadowCaster" }
            ZWrite On ZTest LEqual ColorMask 0 Cull Back

            HLSLPROGRAM
            #pragma vertex ShadowVert
            #pragma fragment ShadowFrag
            #pragma multi_compile_instancing
            #pragma multi_compile_vertex _ _CASTING_PUNCTUAL_LIGHT_SHADOW
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Shadows.hlsl"

            float3 _LightDirection;
            float3 _LightPosition;

            struct ShadowAttributes
            {
                float4 positionOS : POSITION;
                float3 normalOS   : NORMAL;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            float4 ShadowVert(ShadowAttributes v) : SV_POSITION
            {
                UNITY_SETUP_INSTANCE_ID(v);
                float3 positionWS = TransformObjectToWorld(v.positionOS.xyz);
                float3 normalWS = TransformObjectToWorldNormal(v.normalOS);
            #if _CASTING_PUNCTUAL_LIGHT_SHADOW
                float3 lightDir = normalize(_LightPosition - positionWS);
            #else
                float3 lightDir = _LightDirection;
            #endif
                float4 positionCS = TransformWorldToHClip(ApplyShadowBias(positionWS, normalWS, lightDir));
            #if UNITY_REVERSED_Z
                positionCS.z = min(positionCS.z, UNITY_NEAR_CLIP_VALUE);
            #else
                positionCS.z = max(positionCS.z, UNITY_NEAR_CLIP_VALUE);
            #endif
                return positionCS;
            }

            half4 ShadowFrag() : SV_Target { return 0; }
            ENDHLSL
        }

        // ------------------------------------------------------------------ 深度（深度纹理 / 软粒子）
        Pass
        {
            Name "DepthOnly"
            Tags { "LightMode" = "DepthOnly" }
            ZWrite On ColorMask R Cull Back

            HLSLPROGRAM
            #pragma vertex DepthVert
            #pragma fragment DepthFrag
            #pragma multi_compile_instancing

            struct DepthAttributes { float4 positionOS : POSITION; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct DepthVaryings { float4 positionCS : SV_POSITION; };

            DepthVaryings DepthVert(DepthAttributes v)
            {
                UNITY_SETUP_INSTANCE_ID(v);
                DepthVaryings o;
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                return o;
            }

            half DepthFrag(DepthVaryings i) : SV_Target { return i.positionCS.z; }
            ENDHLSL
        }

        // ------------------------------------------------------------------ 深度 + 法线（SSAO 需要）
        Pass
        {
            Name "DepthNormals"
            Tags { "LightMode" = "DepthNormals" }
            ZWrite On Cull Back

            HLSLPROGRAM
            #pragma vertex DNVert
            #pragma fragment DNFrag
            #pragma multi_compile_instancing

            struct DNAttributes { float4 positionOS : POSITION; float3 normalOS : NORMAL; UNITY_VERTEX_INPUT_INSTANCE_ID };
            struct DNVaryings { float4 positionCS : SV_POSITION; half3 normalWS : TEXCOORD0; };

            DNVaryings DNVert(DNAttributes v)
            {
                UNITY_SETUP_INSTANCE_ID(v);
                DNVaryings o;
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                o.normalWS = TransformObjectToWorldNormal(v.normalOS);
                return o;
            }

            half4 DNFrag(DNVaryings i) : SV_Target { return half4(NormalizeNormalPerPixel(i.normalWS), 0); }
            ENDHLSL
        }
    }

    FallBack "Universal Render Pipeline/Lit"
}
