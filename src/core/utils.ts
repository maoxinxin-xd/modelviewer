import * as THREE from 'three'

export type ProjectionMode = 'perspective' | 'orthographic'
export type PresetView = 'front' | 'back' | 'side' | 'top' | 'none'
export type TextureMode = '贴图' | '白膜' | '法线' | '反照'

export const CAMERA_CONFIG = {
  PERSPECTIVE_FOV: 45,
  NEAR_CLIP: 0.01,
  FAR_CLIP: 10000,
  ORTHO_NEAR: -10000,
  ORTHO_FAR: 10000
} as const

export function sphericalToCartesian(theta: number, phi: number, radius: number) {
  return {
    x: radius * Math.sin(phi) * Math.sin(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.cos(theta)
  }
}

export function calculateOrthographicViewSize(radius: number): number {
  const fovRad = (CAMERA_CONFIG.PERSPECTIVE_FOV * Math.PI) / 180
  return 2 * radius * Math.tan(fovRad / 2)
}

export function countTriangles(object: THREE.Object3D): number {
  let total = 0
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      const geometry = (child as THREE.Mesh).geometry
      if (!geometry) return
      if (geometry.index) {
        total += geometry.index.count / 3
      } else if (geometry.attributes.position) {
        total += geometry.attributes.position.count / 3
      }
    }
  })
  return Math.floor(total)
}

export function disposeMaterial(material: THREE.Material) {
  const anyMat = material as unknown as Record<string, unknown>
  const mapKeys = [
    'map',
    'normalMap',
    'emissiveMap',
    'roughnessMap',
    'metalnessMap',
    'aoMap',
    'lightMap',
    'bumpMap',
    'displacementMap',
    'specularMap',
    'envMap',
    'alphaMap'
  ]
  for (const key of mapKeys) {
    const texture = anyMat[key]
    if (texture && (texture as THREE.Texture).isTexture) {
      ;(texture as THREE.Texture).dispose()
    }
  }
  material.dispose()
}

export function disposeObject3D(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose()
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach(disposeMaterial)
      } else if (mesh.material) {
        disposeMaterial(mesh.material)
      }
    }
  })
}

export function hasValidModelDimensions(object: THREE.Object3D | null): boolean {
  if (!object) return false
  const box = new THREE.Box3().setFromObject(object)
  if (box.isEmpty()) return false
  const size = new THREE.Vector3()
  box.getSize(size)
  return (
    Number.isFinite(size.x) &&
    Number.isFinite(size.y) &&
    Number.isFinite(size.z) &&
    (size.x > 0 || size.y > 0 || size.z > 0)
  )
}

export function getModelDiagonal(object: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(object)
  const size = new THREE.Vector3()
  box.getSize(size)
  return Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2)
}

export function extractAlbedoFromMaterial(material: THREE.Material) {
  const anyMat = material as unknown as Record<string, unknown>
  let map: THREE.Texture | null = null
  const candidates = ['map', 'baseColorMap', 'diffuseMap', 'baseColorTexture', 'emissiveMap']
  for (const key of candidates) {
    const value = anyMat[key]
    if (value && (value as THREE.Texture).isTexture) {
      map = value as THREE.Texture
      break
    }
  }

  let color = new THREE.Color(0xffffff)
  const colorSource = anyMat.color ?? anyMat.baseColor ?? anyMat.diffuse
  if (colorSource instanceof THREE.Color) {
    color = colorSource.clone()
  } else if (typeof colorSource === 'number') {
    color = colorSource === 0 ? new THREE.Color(0xffffff) : new THREE.Color(colorSource)
  }

  if (map) {
    const hex = color.getHex()
    if (hex === 0x000000 || (hex < 0x333333 && hex > 0)) {
      color = new THREE.Color(0xffffff)
    }
  } else if (color.getHex() === 0x000000) {
    color = new THREE.Color(0xffffff)
  }

  return { texture: map, color }
}
