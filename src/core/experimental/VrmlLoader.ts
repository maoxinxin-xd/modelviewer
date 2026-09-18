import * as THREE from 'three'
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js'
import type { MaterialReport } from '../MaterialResolver'

export const VRML_EXTENSIONS = ['wrl', 'vrml'] as const
export const VRML_ACCEPT = '.wrl,.vrml'

/**
 * Experimental VRML simple preview via three.js VRMLLoader.
 * Best-effort only — complex nodes/textures may be missing.
 */
export async function loadVrmlFromBuffer(
  buffer: ArrayBuffer,
  fileName: string
): Promise<{ object: THREE.Group; materialReport: MaterialReport }> {
  const loader = new VRMLLoader()
  const text = new TextDecoder().decode(buffer)
  let scene: THREE.Group
  try {
    // path arg used for relative texture URLs inside VRML
    scene = loader.parse(text, '') as unknown as THREE.Group
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`VRML 解析失败（实验性）：${reason}`)
  }

  const object = scene instanceof THREE.Group ? scene : wrapObject3D(scene)
  ensureMaterials(object)

  return {
    object,
    materialReport: {
      texturesFound: 0,
      texturesMissing: 0,
      missingSlots: [],
      notes: [
        `实验性 VRML 简单展示（${fileName}）`,
        '仅保证基础几何/简单材质；复杂 VRML 节点可能丢失',
        '生产管线建议转为 GLB/OBJ 后再导入'
      ]
    }
  }
}

function wrapObject3D(obj: THREE.Object3D): THREE.Group {
  const group = new THREE.Group()
  group.add(obj)
  return group
}

function ensureMaterials(root: THREE.Object3D) {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    if (!mesh.geometry.attributes.normal) {
      mesh.geometry.computeVertexNormals()
    }
    if (!mesh.material) {
      mesh.material = new THREE.MeshStandardMaterial({
        color: 0xb0b0b0,
        roughness: 0.75,
        metalness: 0.05,
        side: THREE.DoubleSide
      })
      return
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    mats.forEach((mat) => {
      const any = mat as unknown as Record<string, unknown>
      // VRML materials often use non-PBR; nudge toward visible Standard shading
      if (mat.type === 'MeshPhongMaterial' || mat.type === 'MeshLambertMaterial') {
        // keep loader materials — they usually render
        return
      }
      if (any.roughness == null && mat.type === 'MeshBasicMaterial') {
        // leave basic materials
      }
    })
  })
}
