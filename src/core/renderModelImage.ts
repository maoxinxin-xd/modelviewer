import { ViewerEngine } from './ViewerEngine'
import { isSupportedModelFile } from './ModelLoader'
import { resolveModelFileName } from './modelFormat'
import type { PanoramaSource } from './panorama'
import type { PresetView, ProjectionMode, TextureMode } from './utils'

export type ModelInput = File | Blob | string
export type ImageFormat = 'png' | 'jpeg' | 'webp'

export interface RenderModelImageOptions {
  /** 必填：模型来源 File | Blob | URL。其余均可省略，使用默认值出图 */
  model: ModelInput

  /**
   * 源文件名（含扩展名）。
   * Blob / 无扩展名 URL 时用于选择 Loader，例如 `"chair.obj"`、`"pack.zip"`。
   * 不要依赖默认 `.glb`——未指定且无法推断时会报错。
   */
  fileName?: string

  /** 输出 CSS 像素宽 @default 1024 */
  width?: number
  /** @default 与 width 相同 */
  height?: number

  /** @default 'png' */
  format?: ImageFormat
  /** jpeg/webp 有损质量 0–1 @default 0.92 */
  quality?: number

  /**
   * `'transparent'` 或 CSS 颜色。
   * @default png/webp 透明；jpeg `#ffffff`
   */
  background?: 'transparent' | string

  /**
   * 等距圆柱（2:1）全景图作为场景背景与环境光。
   * 注意：全景会铺满整个画面，因此同时传 `background: 'transparent'` 也不会得到透明底。
   */
  panorama?: PanoramaSource

  /** 长边中心裁切为 1:1 @default false */
  square?: boolean

  /** @default 'perspective' */
  projection?: ProjectionMode
  /** 机位；`none` 保持加载后的取景 @default 'front' */
  presetView?: PresetView
  /** 多机位，按顺序出多张图 */
  views?: PresetView[]

  /**
   * @default 自动：模型有贴图则 textured，否则 clay
   */
  textureMode?: TextureMode
  /** 主光角度（度）@default 加载后引擎默认 0 */
  lightAngle?: number
  /** @default 2 */
  lightIntensity?: number
  /** @default 2 */
  ambientIntensity?: number
  /** 参考网格 @default false */
  showGrid?: boolean

  signal?: AbortSignal
}

export interface RenderedImage {
  blob: Blob
  width: number
  height: number
  format: ImageFormat
  mime: string
  /** Set when this item came from `views[i]` */
  view?: PresetView
  /** Resolved source file name used for loading */
  fileName?: string
}

function formatMime(format: ImageFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
}

function defaultBackground(format: ImageFormat): 'transparent' | string {
  return format === 'jpeg' ? '#ffffff' : 'transparent'
}

export interface ResolveModelInputOptions {
  /** Original file name with extension (e.g. "model.obj") */
  fileName?: string
  signal?: AbortSignal
}

/**
 * Resolve File | Blob | URL into a File the loader can accept.
 * Uses `fileName`, then File.name / URL path / MIME / magic bytes —
 * never silently pretends the model is `.glb`.
 */
export async function resolveModelInput(
  source: ModelInput,
  options: ResolveModelInputOptions | AbortSignal = {}
): Promise<File> {
  const opts: ResolveModelInputOptions =
    typeof AbortSignal !== 'undefined' && options instanceof AbortSignal
      ? { signal: options }
      : (options as ResolveModelInputOptions)

  const name = await resolveModelFileName(source, opts.fileName)

  if (source instanceof File) {
    if (source.name === name) {
      if (!isSupportedModelFile(source)) {
        throw new Error(`Unsupported model format: ${source.name}`)
      }
      return source
    }
    // rename when caller provided a better fileName
    const renamed = new File([source], name, {
      type: source.type || undefined
    })
    if (!isSupportedModelFile(renamed)) {
      throw new Error(`Unsupported model format: ${renamed.name}`)
    }
    return renamed
  }

  if (typeof Blob !== 'undefined' && source instanceof Blob) {
    const file = new File([source], name, { type: source.type || undefined })
    if (!isSupportedModelFile(file)) {
      throw new Error(`Unsupported model format: ${file.name}`)
    }
    return file
  }

  if (typeof source !== 'string') {
    throw new Error('model must be File | Blob | URL string')
  }

  const res = await fetch(source, { signal: opts.signal })
  if (!res.ok) {
    throw new Error(`Failed to fetch model (${res.status}): ${source}`)
  }
  const blob = await res.blob()
  const resolved = await resolveModelFileName(
    blob,
    opts.fileName || name
  )
  const file = new File([blob], resolved, {
    type: blob.type || undefined
  })
  if (!isSupportedModelFile(file)) {
    throw new Error(`Unsupported model format: ${file.name} (from ${source})`)
  }
  return file
}

function applyEngineOptions(engine: ViewerEngine, options: RenderModelImageOptions, format: ImageFormat) {
  if (options.projection) {
    engine.toggleProjectionMode(options.projection)
  }
  if (options.lightAngle != null) engine.setLightAngle(options.lightAngle)
  if (options.lightIntensity != null) engine.setLightIntensity(options.lightIntensity)
  if (options.ambientIntensity != null) engine.setAmbientIntensity(options.ambientIntensity)

  // Texture mode: explicit, or auto after load
  if (options.textureMode) {
    engine.applyTextureMode(options.textureMode)
  } else if (engine.state.isWhiteModel) {
    engine.applyTextureMode('clay')
  } else {
    engine.applyTextureMode('textured')
  }

  engine.setGridVisible(Boolean(options.showGrid))

  const background = options.background ?? defaultBackground(format)
  engine.setBackground(background)
}

async function renderOne(
  engine: ViewerEngine,
  options: RenderModelImageOptions,
  file: File,
  view: PresetView | undefined,
  width: number,
  height: number,
  format: ImageFormat
): Promise<RenderedImage> {
  if (view && view !== 'none') {
    engine.setPresetView(view, { animate: false })
  }

  const blob = await engine.renderToBlob({
    format,
    quality: options.quality,
    square: options.square,
    showGrid: options.showGrid
  })

  return {
    blob,
    width: options.square ? Math.max(width, height) : width,
    height: options.square ? Math.max(width, height) : height,
    format,
    mime: formatMime(format),
    view,
    fileName: file.name
  }
}

/**
 * Offscreen render: model + params → image(s).
 *
 * @example
 * ```ts
 * import { renderModelImage } from 'mivo-model-viewer/core'
 *
 * const blob = await renderModelImage({
 *   model: file,              // 或 Blob / URL 字符串
 *   fileName: 'chair.obj',    // Blob/无扩展名 URL 时必填（或可被 MIME/文件头推断）
 *   width: 1200,
 *   height: 800,
 *   format: 'png',
 *   background: 'transparent',
 *   presetView: 'front',
 *   textureMode: 'textured'
 * })
 * ```
 */
export async function renderModelImage(
  options: RenderModelImageOptions
): Promise<Blob> {
  const images = await renderModelImages({
    ...options,
    views: [options.views?.[0] ?? options.presetView ?? 'front']
  })
  return images[0].blob
}

/** Same as {@link renderModelImage} but returns structured metadata. */
export async function renderModelImageDetailed(
  options: RenderModelImageOptions
): Promise<RenderedImage> {
  const images = await renderModelImages({
    ...options,
    views: [options.views?.[0] ?? options.presetView ?? 'front']
  })
  return images[0]
}

/** Render one or more camera poses. `views` drives the output array order. */
export async function renderModelImages(
  options: RenderModelImageOptions
): Promise<RenderedImage[]> {
  const format = options.format ?? 'png'
  const width = options.width ?? 1024
  const height = options.height ?? width
  const views: PresetView[] = options.views?.length
    ? options.views
    : [options.presetView ?? 'front']

  options.signal?.throwIfAborted?.()

  const file = await resolveModelInput(options.model, {
    fileName: options.fileName,
    signal: options.signal
  })
  options.signal?.throwIfAborted?.()

  const host = document.createElement('div')
  host.setAttribute('data-mivo-render', '1')
  host.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${width}px`,
    `height:${height}px`,
    'opacity:0',
    'pointer-events:none',
    'overflow:hidden'
  ].join(';')
  document.body.appendChild(host)

  const needsAlpha = (options.background ?? defaultBackground(format)) === 'transparent'
  const engine = new ViewerEngine(host, {
    width,
    height,
    alpha: needsAlpha || format !== 'jpeg',
    headless: true,
    clearColor: needsAlpha ? null : (options.background ?? '#ffffff'),
    clearAlpha: needsAlpha ? 0 : 1,
    pixelRatio: 1
  })

  try {
    options.signal?.throwIfAborted?.()
    await engine.loadFromFile(file)
    options.signal?.throwIfAborted?.()

    if (options.background !== undefined) {
      engine.setBackground(options.background)
    }

    if (options.panorama) {
      await engine.setPanorama(options.panorama, { hideGrid: !options.showGrid })
    }

    applyEngineOptions(engine, options, format)

    const out: RenderedImage[] = []
    for (const view of views) {
      options.signal?.throwIfAborted?.()
      out.push(await renderOne(engine, options, file, view, width, height, format))
    }
    return out
  } finally {
    engine.dispose()
    host.remove()
  }
}

/** Object URL for a rendered image. Caller should revoke when done. */
export async function renderModelImageObjectURL(
  options: RenderModelImageOptions
): Promise<string> {
  const blob = await renderModelImage(options)
  return URL.createObjectURL(blob)
}

/** data: URL (base64). Convenient for `<img src>` / JSON APIs; large models can be big. */
export async function renderModelImageDataUrl(
  options: RenderModelImageOptions
): Promise<string> {
  const blob = await renderModelImage(options)
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Failed to encode image data URL'))
    reader.readAsDataURL(blob)
  })
}
