import * as THREE from 'three'

export type CaptureFormat = 'png' | 'jpeg' | 'webp'

export interface CaptureViewOptions {
  /** 输出宽（CSS 像素）@default 当前画布宽 */
  width?: number
  /** 输出高（CSS 像素）@default 当前画布高 */
  height?: number
  /** @default 'png' */
  format?: CaptureFormat
  /** jpeg / webp 质量 0-1 @default 0.92 */
  quality?: number
  /** 临时像素比，出高清图用（例如 2 / 3） */
  pixelRatio?: number
  /** 是否按输出尺寸临时调整相机宽高比 @default true */
  adjustAspect?: boolean
  /** 自定义渲染（例如 EffectComposer.render）；默认 renderer.render(scene, camera) */
  render?: () => void
  /** 渲染前的回调（例如推进动画、更新矩阵） */
  beforeRender?: () => void
  /**
   * 恢复显示态时的重绘。默认直接 renderer.render，
   * 不走 render 回调，避免恢复那次把动画 / 时间轴又推进一遍。
   */
  restoreRender?: () => void
}

export function captureFormatMime(format: CaptureFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'
}

/**
 * 按指定尺寸出帧，不改动页面布局：临时调整渲染尺寸 / 像素比 → 渲染 → 导出 Blob → 还原。
 * 多机位批量出图、序列帧导出都基于它。默认渲染当前画面，也可以传入 composer 之类的自定义渲染。
 */
export async function captureView(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  options: CaptureViewOptions = {}
): Promise<Blob> {
  const format = options.format ?? 'png'
  const quality = options.quality ?? 0.92
  const mime = captureFormatMime(format)

  const size = renderer.getSize(new THREE.Vector2())
  const currentRatio = renderer.getPixelRatio()
  const width = Math.max(1, Math.round(options.width ?? size.width))
  const height = Math.max(1, Math.round(options.height ?? size.height))
  const ratio = options.pixelRatio ?? currentRatio
  const resize = width !== size.width || height !== size.height || ratio !== currentRatio

  const aspectCamera = camera as THREE.PerspectiveCamera
  const previousAspect = aspectCamera.aspect
  const canAdjustAspect =
    (options.adjustAspect ?? true) && Number.isFinite(previousAspect) && previousAspect > 0
  const draw = options.render ?? (() => renderer.render(scene, camera))
  const redraw = options.restoreRender ?? (() => renderer.render(scene, camera))

  try {
    if (resize) {
      renderer.setPixelRatio(ratio)
      renderer.setSize(width, height, false)
      if (canAdjustAspect) {
        aspectCamera.aspect = width / height
        camera.updateProjectionMatrix()
      }
    }
    options.beforeRender?.()
    draw()

    return await new Promise<Blob>((resolve, reject) => {
      renderer.domElement.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('captureView: toBlob 失败'))),
        mime,
        format === 'png' ? 1 : quality
      )
    })
  } finally {
    if (resize) {
      renderer.setPixelRatio(currentRatio)
      renderer.setSize(size.width, size.height, false)
      if (canAdjustAspect) {
        aspectCamera.aspect = previousAspect
        camera.updateProjectionMatrix()
      }
      // 恢复显示态，避免画布停在导出尺寸上；这里失败不能盖掉原始异常
      try {
        redraw()
      } catch (error) {
        console.error('[model-viewer] captureView: 恢复重绘失败', error)
      }
    }
  }
}
