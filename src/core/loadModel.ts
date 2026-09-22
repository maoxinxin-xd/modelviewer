import { ModelLoader, type LoadResult, type ProgressCallback } from './ModelLoader'
import { resolveModelInput, type ModelInput } from './renderModelImage'
import { disposeObject3D } from './utils'

export interface LoadModelObjectOptions {
  /** 源文件名（含扩展名）；Blob / 无扩展名 URL 时用于选择 Loader */
  fileName?: string
  onProgress?: ProgressCallback
  signal?: AbortSignal
  /** 是否把模型包围盒中心移到原点 @default true；多模型编排建议 false，保留原始坐标 */
  center?: boolean
  /** 是否自动开启 castShadow / receiveShadow @default true */
  shadows?: boolean
}

/**
 * 一步加载模型：File | Blob | URL → LoadResult（object / animations / materialReport）。
 * 与 ViewerEngine 无关，可直接用于自建场景（多模型编排、导演台、批处理出图）。
 *
 * 每次调用创建独立的 ModelLoader，加载完成后立即释放其内部资源（贴图已进入显存／内存，
 * 不受影响），因此不会留下 Draco worker 之类的常驻资源。
 */
export async function loadModelObject(
  source: ModelInput,
  options: LoadModelObjectOptions = {}
): Promise<LoadResult> {
  const file = await resolveModelInput(source, {
    fileName: options.fileName,
    signal: options.signal
  })

  const loader = new ModelLoader()
  try {
    const result = await loader.loadFromFile(file, options.onProgress, {
      center: options.center,
      shadows: options.shadows
    })
    // 底层 Loader 不支持中途取消，至少在这里尊重一次 abort，避免调用方拿到不该要的结果
    if (options.signal?.aborted) {
      disposeObject3D(result.object)
      throw new DOMException('Aborted', 'AbortError')
    }
    return result
  } finally {
    loader.dispose()
  }
}
