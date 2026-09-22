import * as THREE from 'three'

/**
 * 等距圆柱（equirectangular，2:1）全景图来源：URL、Blob 或已建好的 Texture。
 * 这类图可直接作为 360°/720° 场景背景，也可当环境光照（IBL）使用。
 *
 * URL / Blob 由引擎内部创建贴图并负责释放；传入 Texture 时所有权归调用方，
 * 引擎只使用不销毁（清空全景只会把 scene.background 置空）。
 */
export type PanoramaSource = string | Blob | THREE.Texture

function isTexture(value: unknown): value is THREE.Texture {
  return Boolean(value && (value as THREE.Texture).isTexture)
}

/**
 * 载入全景图并标记为等距圆柱映射。
 * three.js 会把该贴图渲染成天空盒背景；同一张贴图赋给 scene.environment
 * 时会自动转成 PMREM 环境贴图，让模型获得来自全景图的光照。
 */
export async function loadPanoramaTexture(source: PanoramaSource): Promise<THREE.Texture> {
  if (isTexture(source)) {
    source.mapping = THREE.EquirectangularReflectionMapping
    source.colorSpace = THREE.SRGBColorSpace
    source.needsUpdate = true
    return source
  }

  // Blob 需要临时 objectURL，加载完成后即可释放（像素已解码进贴图）
  const label = typeof source === 'string' ? source : 'panorama blob'
  const objectUrl = typeof source === 'string' ? null : URL.createObjectURL(source)
  try {
    const texture = await new THREE.TextureLoader().loadAsync(objectUrl ?? (source as string))
    texture.mapping = THREE.EquirectangularReflectionMapping
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    return texture
  } catch (cause) {
    // three 的 ImageLoader 会用 Event 作为 reject 值，这里统一成可读的 Error
    const error = new Error('Failed to load panorama: ' + label) as Error & { cause?: unknown }
    error.cause = cause
    throw error
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
  }
}

/** 已被 handle 释放过的贴图：还原场景时不能把背景指回它们 */
const disposedTextures = new WeakSet<THREE.Texture>()

function withoutDisposed<T>(value: T): T {
  if (value && disposedTextures.has(value as unknown as THREE.Texture)) return null as T
  return value
}

export interface PanoramaApplyOptions {
  /** 是否同时作为环境光（IBL） @default true */
  environment?: boolean
  /** 环境光强度（three r163+ 的 scene.environmentIntensity） */
  environmentIntensity?: number
  /** 背景亮度（scene.backgroundIntensity） */
  backgroundIntensity?: number
  /** 背景模糊 0-1（scene.backgroundBlurriness），让主体更突出 */
  backgroundBlurriness?: number
}

export interface AppliedPanorama {
  /** 已加载的全景贴图（equirectangular 映射） */
  texture: THREE.Texture
  /** 贴图是否由本次调用创建（URL / Blob）；外部传入的 Texture 归调用方所有 */
  owned: boolean
  /** 还原 scene 此前的背景 / 环境设置，并释放自有贴图 */
  dispose: () => void
}

/**
 * 把等距圆柱全景图应用到任意 three.js 场景：背景 + 可选的环境光（IBL）。
 *
 * 这是与 ViewerEngine 无关的纯函数，自建场景（多模型编排 / 导演台）可直接使用。
 * 返回的 handle 记录了应用前的 scene 状态，dispose() 会原样还原。
 */
export async function applyPanorama(
  scene: THREE.Scene,
  source: PanoramaSource,
  options: PanoramaApplyOptions = {}
): Promise<AppliedPanorama> {
  const owned = typeof source === 'string' || source instanceof Blob
  const texture = await loadPanoramaTexture(source)

  const previous = {
    background: scene.background,
    environment: scene.environment,
    environmentIntensity: scene.environmentIntensity,
    backgroundIntensity: scene.backgroundIntensity,
    backgroundBlurriness: scene.backgroundBlurriness
  }

  const appliedEnvironmentIntensity = options.environmentIntensity ?? null
  const appliedBackgroundIntensity = options.backgroundIntensity ?? null
  const appliedBackgroundBlurriness = options.backgroundBlurriness ?? null

  scene.background = texture
  scene.environment = (options.environment ?? true) ? texture : null
  if (appliedEnvironmentIntensity != null) scene.environmentIntensity = appliedEnvironmentIntensity
  if (appliedBackgroundIntensity != null) scene.backgroundIntensity = appliedBackgroundIntensity
  if (appliedBackgroundBlurriness != null) scene.backgroundBlurriness = appliedBackgroundBlurriness

  let disposed = false
  return {
    texture,
    owned,
    dispose() {
      if (disposed) return
      disposed = true
      // 只还原仍然属于本 handle 的状态，避免覆盖之后设置的全景
      if (scene.background === texture) scene.background = withoutDisposed(previous.background)
      if (scene.environment === texture) {
        scene.environment = withoutDisposed(previous.environment)
      }
      if (
        appliedEnvironmentIntensity != null &&
        scene.environmentIntensity === appliedEnvironmentIntensity
      ) {
        scene.environmentIntensity = previous.environmentIntensity
      }
      if (appliedBackgroundIntensity != null && scene.backgroundIntensity === appliedBackgroundIntensity) {
        scene.backgroundIntensity = previous.backgroundIntensity
      }
      if (
        appliedBackgroundBlurriness != null &&
        scene.backgroundBlurriness === appliedBackgroundBlurriness
      ) {
        scene.backgroundBlurriness = previous.backgroundBlurriness
      }
      if (owned) {
        disposedTextures.add(texture)
        texture.dispose()
      }
    }
  }
}
