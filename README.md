# 3D 模型查看器

原生 TypeScript + HTML + CSS + Three.js 实现的独立 3D 模型查看器。

## 支持格式（明确边界）

| 类型 | 格式 | 说明 |
|------|------|------|
| 模型 | GLB / GLTF / OBJ / FBX / STL / PLY / DAE / 3MF / **3DS** | 浏览器内直接解析 |
| 包 | **ZIP** | 内含模型 + 贴图时自动映射路径 |
| 暂不支持 | VRML、STEP 等 CAD | 建议先转为 GLB/OBJ 再导入 |

## ZIP + 材质策略（能做到什么）

1. 解压 ZIP → 自动选入口模型（浅路径优先，glb/gltf > fbx > obj > 3ds…）
2. LoadingManager 把相对路径映射到包内资源（`textures/`、`fbm/`、同目录）
3. FBX/OBJ/3DS/DAE：Loader 缺贴图时按 **basename + 关键词**（diffuse/normal/rough/metal…）补全
4. OBJ 尝试解析包内简易 MTL（Kd / map_Kd）
5. 仍缺失：默认 PBR，并在左侧「材质」显示状态

**不会承诺**：任意 FBX 100% 还原、原生 VRML、服务端 CAD 转换。

## 启动

```bash
cd modelViewer
npm install
npm run dev
```

默认地址 `http://localhost:5174`。

## 功能清单

- 左侧：模型信息（文件 / 拓扑 / 面数 / 材质状态）
- 右侧：透视·正交、预设角度（球面旋转动画）、灯光
- 底部：贴图模式、截屏下载、导入 / 替换、导出源文件
- 无模型时底栏仅「导入」；替换时保持 UI 并重置灯光默认值
