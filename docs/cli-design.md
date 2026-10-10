# 纯 Node 模型处理：CLI 与后端 API

实现基线：2026-10-09。Node ≥22.12、Three ≥0.170、glTF Transform 固定 4.5.1。

## 定位

模型生成后的服务端工作流工具。没有 Chromium、Playwright、HTTP runner、Python 或 Blender。

- `info`：读取解析后模型信息。
- `render`：Node Dawn + Three WebGPU 离屏渲染。
- `convert`：支持格式 → 尽量保真的自包含 GLB。
- `optimize`：GLB → glTF Transform 优化，包括减面、贴图缩尺寸与几何压缩。
- `convert --optimize`：一次完成格式转换和优化，只返回最终产物。

普通转换不会默认减面；优化则沿用固定上游版本的完整优化行为，不承诺层级/编辑语义不变。

## 命令

```bash
node node/cli.mjs info ./model.fbx --json
node node/cli.mjs render ./model.glb -o ./preview.png
node node/cli.mjs render ./model.glb --views front,back,side,top --output-dir ./previews
node node/cli.mjs convert ./model.obj -o ./model.glb
node node/cli.mjs optimize ./model.glb -o ./model-small.glb
node node/cli.mjs convert ./model.fbx -o ./model-small.glb --optimize
node node/cli.mjs convert ./model.fbx -o ./model-small.glb --optimize \
  --simplify-ratio 0.5 --simplify-error 0.001 --texture-size 2048 --compress meshopt
```

npm 包安装后使用 `mivo-model-viewer`，无需构建 CLI。根入口与 `./core` 仍为浏览器 SDK；新增 `./node` 为独立后端入口。

### 公共参数与输出

- `--json`：stdout 仅一个 JSON 对象，日志/进度走 stderr。
- `--timeout`：默认 120 秒，包括排队、解析、优化和渲染；硬超时终止任务进程。
- `--resource-dir`：可重复，明确增加关联资源搜索根目录。
- `--entry`：ZIP 内精确入口；ZIP 多候选时可显式指定。
- `--strict`：非预期保真警告使任务失败，不提交文件。主动减面/缩图等记录为 transformations。
- `--overwrite`：默认不覆盖，包括原地处理；开启后仍先完成验证再替换。
- `--allow-network`：默认禁用网络，只可显式读取模型的公共 HTTP(S) 关联资源。
- `--help` / `--version`。

退出码：0 成功，1 运行失败，2 参数错误，130 中断。

JSON 外壳为 `{schemaVersion:1,ok,command,input,entry,outputs,data,warnings,error}`。CLI 的 outputs 返回绝对路径与 byteLength，不输出模型二进制；Node API 的 outputs.bytes 返回 Uint8Array。

### render

默认 1024×1024、PNG、front、透视、textured、透明底、无网格；JPEG 默认白底。灯光/环境光强度默认 2，角度默认 0。单张格式按输出扩展名推断，多张 `--format` 默认 png。

单张 `-o` 与多张 `--views ... --output-dir` 互斥。尺寸 DPR 固定 1；单边上限 8192、总像素上限 16,777,216，并检查实际 GPU 限制。显式 JPEG 透明背景和 PNG quality 参数报错。

支持 `--view`、`--width`、`--height`、`--size`、`--projection`、`--mode` / `--texture-mode`、`--background`、`--quality`、`--grid`、灯光参数。多视角只加载一次。同一包默认场景出图，不包含其他场景；取景保持模型坐标不改源数据。

### convert / optimize

输出仅 GLB。普通 convert 保留坐标、比例、层级、已解析动画与隐藏节点，不主动合并、缩图或减面；`--center`、`--only-visible`、`--no-animations` 显式改变行为。
原生 FBX 不支持 `--only-visible`，此选项需显式指定 `--fbx-backend three`。

优化顺序：dedup → instance → palette → flatten → join → weld → simplify → resample → prune → sparse → textureCompress → meshopt/draco/quantize。

默认：ratio 0（误差约束内尽量减面）、error 0.0001、textureSize 2048、textureCompress auto、compress meshopt。对应参数为 `--simplify-ratio`（别名 --ratio）、`--simplify-error`（--error）、`--texture-size`（--textures）、`--texture-compress`、`--compress`。`--no-instance` 等关闭对应阶段。未开启 convert --optimize 时拒绝优化参数。

POINTS 禁止默认 ratio=0 简化，需指定正比例或 --no-simplify。无外部 KTX2 编码器，首版不提供 KTX2 编码；已有 KTX2 数据尽量保留，但 Node 出图不保证解码此类贴图。

每个 GLB 写入前回读验证。报告优化前后几何、节点、纹理统计和文件大小，不能把压缩体积下降描述为减面效果。未达到目标比例如实报告；输出变为空模型则失败。

## 后端 API 与隔离

```js
import { createModelProcessor } from 'mivo-model-viewer/node';
const processor = createModelProcessor({ concurrency: 1, maxQueue: 32 });
try {
  const result = await processor.convertModelToGlb('/data/model.fbx', {
    optimize: true,
    simplifyRatio: 0.5,
    timeout: 120,
    signal: abortController.signal,
  });
  // result.outputs[0].bytes 是最终 GLB，不要求先写输出文件。
} finally {
  await processor.close();
}
```

也导出 inspectModel、renderModelImages、convertModelToGlb、optimizeModel 独立函数。

输入为路径或 `{bytes:Uint8Array,fileName:string,resources?:Record<string,Uint8Array>}`。默认并发 1、最大等待 32，每任务独立 Node 进程。兼容 DOM/Canvas/FileReader/GPU 只在该进程安装；不污染业务主进程。任务完成/取消释放原生资源并退出，避免长期累计 GPU/图片缓存。

## 资源与保真边界

搜索：嵌入 → 原始相对路径 → resource-dir → 大小写/分隔符容错 → 常见贴图目录 → 唯一 basename。歧义不随机选。已找到的贴图优先，不凭关键词覆盖有效数据。必要材质补全要产生明确诊断。

所有图片解码完成后再消费。PLY 顶点色与有效法线尽量保留；OBJ MTL、FBX 关联资源单独解析。STEP/VRML 为实验性，STEP 输出三角网格，不保留完整 CAD B-Rep/PMI。未知扩展或源格式复杂语义不能宣称无损。

本地读取仅限授权根目录，检查 symlink 越界。ZIP 流式限制 10,000 项、单项 256MiB、总解压 1GiB，拒绝越界路径。网络默认关闭，开启时也拒绝私网目标、非 HTTP(S) 与不受控重定向。

## 部署与验证

Dockerfile.node 面向 Linux x86_64/glibc、Node 22，无 GPU：安装 libvulkan1 与 mesa-vulkan-drivers，选择 Lavapipe ICD。没有 Xvfb、显示服务器或浏览器。macOS 本机开发使用 Metal。

```bash
# 以下 Docker 镜像构建/执行由用户按需运行。
docker build -f Dockerfile.node -t mivo-model-tool .
docker run --rm -v "$PWD/models:/data:ro" -v "$PWD/output:/output" \
  mivo-model-tool render /data/model.glb -o /output/model.png
```

行为测试：`npm run test:node`。真实模型验证从 `/Users/maoxinxin/Downloads/模型` 只读加载，输出到独立临时目录。实现时不执行 SDK 构建或类型检查。

Linux 软件渲染需要实际容器验收，不以 macOS GPU 出图代替此项验收；性能和像素结果不保证与网页 WebGL 查看器一致。

生产部署建议设置容器 CPU/内存限制；任务子进程隔离和模型预算不能替代操作系统 cgroup 限额。

## 处理耗时

CLI JSON 与 Node API 成功结果的 `data.timings` 自动记录毫秒耗时，使用单调时钟，不受系统时间调整影响：

| 字段 | 口径 |
| --- | --- |
| `loadMs` | 读取关联资源、解码并转换为内部文档 |
| `exportMs` | GLB 编码、回读验证及输出统计，含最终几何压缩编码 |
| `conversionMs` | convert 的 loadMs + exportMs，排除优化阶段；不是独立纯转换基准 |
| `optimizationMs` | 完整优化阶段，包括减面、贴图处理等，不含最终 GLB 编码 |
| `simplifyMs` | simplify 算法阶段；明确关闭简化时为 0 |
| `convertAndOptimizeMs` | 一步 convert --optimize 的 worker 实测时间，包含加载、优化、导出与检查，不含 worker 启动/IPC/清理 |
| `renderMs` | 渲染模块加载、GPU 初始化、场景准备、全部视角渲染和图片编码；不含源模型加载 |
| `workerMs` | worker 接收任务至资源清理完成，不含 worker 模块初始化 |
| `queueMs` | 等待任务槽位的时间 |
| `executionMs` | 启动 worker 至任务返回，包括模块初始化、IPC、执行、清理与退出 |
| `totalMs` | API 总时间，包括排队 |
| `outputWriteMs` | CLI 输出文件写入时间，仅 CLI 提供 |
| `cliTotalMs` | CLI 命令处理至文件写入完成，不含程序启动和 stdout 序列化，仅 CLI 提供 |

未执行/未完成的阶段为 null，不伪造 0。worker 失败也尽量在 `error.details.timings` 返回已测时间。取消/崩溃时仅能获取主进程计时。`data.optimization.stageTimingsMs` 提供每个实际启用的 transform 的耗时。

这些是嵌套/重叠口径，**不能把 totalMs、optimizationMs、simplifyMs 等直接相加**。要比较“先转换再优化”和“一步转换优化”，需分别实际执行，不能用一步命令的子阶段估算独立命令耗时。

真实模型批量耗时报告对独立转换、独立优化、一步转换优化、预览分别执行测量：报告中的 conversionMs 是独立转换 API 总耗时，optimizationStandaloneMs 是独立优化 API 总耗时，simplifyMs 是一步优化中纯减面算法时间。totalProcessingMs 为一步转换优化接着预览的完整流程墙钟时间，不包含前两个独立基准调用或输出模型/图片落盘时间。旧产物不覆盖，重新测得的报告标明 measuredAt。使用并发 1，避免模型任务之间的 CPU/GPU 争用；原生渲染平台及硬件须随报告注明。
