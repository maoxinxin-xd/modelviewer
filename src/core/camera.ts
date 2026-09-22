import * as THREE from 'three'

export interface FocusPoseOptions {
  /** 画面留白系数，1 = 正好贴合包围球 @default 1.15 */
  padding?: number
  /** 画面宽高比，默认取相机自身的 aspect */
  aspect?: number
}

export interface FocusPose {
  /** 相机应处的世界坐标 */
  position: THREE.Vector3
  /** 视线目标点（包围球中心） */
  target: THREE.Vector3
  /** 相机到目标点的距离 */
  distance: number
  /** 对象包围球半径 */
  radius: number
  /** 正交相机需要设置的视野高度；透视相机为 0 */
  orthoViewSize: number
}

/** 支持 target 与距离约束的控制器（OrbitControls 以及自定义控制器都满足） */
export interface FocusableControls {
  target: THREE.Vector3
  minDistance?: number
  maxDistance?: number
  update?: () => void
}

type AnyCamera = THREE.PerspectiveCamera | THREE.OrthographicCamera

function isOrtho(camera: AnyCamera): camera is THREE.OrthographicCamera {
  return Boolean((camera as THREE.OrthographicCamera).isOrthographicCamera)
}

function resolveAspect(camera: AnyCamera, aspect?: number): number {
  if (aspect != null && Number.isFinite(aspect) && aspect > 0) return aspect
  const value = (camera as THREE.PerspectiveCamera).aspect
  return Number.isFinite(value) && value > 0 ? value : 1
}

/**
 * 计算「把对象完整框进画面」的相机位姿（纯计算，不修改任何对象）。
 * 透视相机按垂直 / 水平视野取较远者；正交相机给出需要的视野尺寸。
 * 观察方向沿用相机当前相对目标点的方向，退化时用正面方向。
 */
export function computeFocusPose(
  camera: AnyCamera,
  object: THREE.Object3D,
  options: FocusPoseOptions = {}
): FocusPose | null {
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return null

  const sphere = box.getBoundingSphere(new THREE.Sphere())
  const radius = Math.max(sphere.radius, 1e-4)
  const target = sphere.center.clone()
  const padding = options.padding ?? 1.15
  const aspect = resolveAspect(camera, options.aspect)

  let distance: number
  let orthoViewSize = 0

  if (isOrtho(camera)) {
    const needHeight = radius * 2 * padding
    const needWidth = (radius * 2 * padding) / Math.max(aspect, 1e-4)
    orthoViewSize = Math.max(needHeight, needWidth)
    distance = camera.position.distanceTo(target)
    if (!Number.isFinite(distance) || distance < 1e-4) distance = radius * 4
  } else {
    const fov = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(camera.fov, 1, 179))
    const fitHeight = radius / Math.sin(fov / 2)
    const fitWidth = radius / Math.sin(Math.atan(Math.tan(fov / 2) * aspect))
    distance = Math.max(fitHeight, fitWidth) * padding
  }

  const direction = camera.position.clone().sub(target)
  if (direction.lengthSq() < 1e-8) direction.set(0, 0, 1)
  direction.normalize()

  return {
    position: target.clone().add(direction.multiplyScalar(distance)),
    target,
    distance,
    radius,
    orthoViewSize
  }
}

/**
 * 立即把相机对准对象：设置位置 / 视线目标，并放宽控制器的距离约束，
 * 保证聚焦之后仍能自由绕行。需要缓动请自行插值，本函数不做动画。
 * 传 null 的 controls 表示没有轨道控制器（只动相机）。
 */
export function focusCameraOn(
  camera: AnyCamera,
  controls: FocusableControls | null | undefined,
  object: THREE.Object3D,
  options: FocusPoseOptions & {
    /** 聚焦后允许的最近距离系数 @default 0.05 */
    minDistanceFactor?: number
    /** 聚焦后允许的最远距离系数 @default 6 */
    maxDistanceFactor?: number
  } = {}
): FocusPose | null {
  const pose = computeFocusPose(camera, object, options)
  if (!pose) return null

  camera.position.copy(pose.position)
  if (controls) {
    controls.target.copy(pose.target)
    const minFactor = options.minDistanceFactor ?? 0.05
    const maxFactor = options.maxDistanceFactor ?? 6
    if (typeof controls.minDistance === 'number') {
      controls.minDistance = Math.min(controls.minDistance, pose.distance * minFactor)
    }
    if (typeof controls.maxDistance === 'number') {
      controls.maxDistance = Math.max(controls.maxDistance, pose.distance * maxFactor)
    }
  }
  camera.lookAt(pose.target)
  camera.updateMatrixWorld()

  if (pose.orthoViewSize > 0 && isOrtho(camera)) {
    const aspect = resolveAspect(camera, options.aspect)
    camera.left = (-pose.orthoViewSize * aspect) / 2
    camera.right = (pose.orthoViewSize * aspect) / 2
    camera.top = pose.orthoViewSize / 2
    camera.bottom = -pose.orthoViewSize / 2
    camera.updateProjectionMatrix()
  }

  controls?.update?.()
  return pose
}
