import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

export type ProgressCallback = (percent: number) => void

export interface LoadResult {
  object: THREE.Group
  animations: THREE.AnimationClip[]
  fileName: string
  fileBlob: Blob | null
}

const MODEL_EXTENSIONS = [
  'glb',
  'gltf',
  'obj',
  'fbx',
  'stl',
  'ply',
  'dae',
  '3mf'
]

export function isSupportedModelFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  return MODEL_EXTENSIONS.includes(ext)
}

function ensureGroup(object: THREE.Object3D): THREE.Group {
  if (object instanceof THREE.Group) return object
  const group = new THREE.Group()
  group.add(object)
  return group
}

function normalizeObject(root: THREE.Object3D) {
  // Center model at origin and keep original scale
  const box = new THREE.Box3().setFromObject(root)
  if (box.isEmpty()) return
  const center = new THREE.Vector3()
  box.getCenter(center)
  root.position.sub(center)

  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (mesh.isMesh) {
      mesh.castShadow = true
      mesh.receiveShadow = true
      if (!mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals()
      }
    }
  })
}

export class ModelLoader {
  private draco: DRACOLoader | null = null
  private manager = new THREE.LoadingManager()

  constructor() {
    this.draco = new DRACOLoader()
    this.draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
  }

  async loadFromFile(file: File, onProgress?: ProgressCallback): Promise<LoadResult> {
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    const url = URL.createObjectURL(file)
    try {
      const result = await this.loadFromUrl(url, ext, onProgress)
      result.fileName = file.name
      result.fileBlob = file
      return result
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  async loadFromUrl(
    url: string,
    ext: string,
    onProgress?: ProgressCallback
  ): Promise<LoadResult> {
    const manager = this.manager
    manager.onProgress = (_url, loaded, total) => {
      if (total > 0) onProgress?.((loaded / total) * 100)
    }

    switch (ext) {
      case 'glb':
      case 'gltf': {
        const loader = new GLTFLoader(manager)
        if (this.draco) loader.setDRACOLoader(this.draco)
        loader.setMeshoptDecoder(MeshoptDecoder)
        const gltf = await loader.loadAsync(url)
        const object = ensureGroup(gltf.scene)
        normalizeObject(object)
        return {
          object,
          animations: gltf.animations || [],
          fileName: url.split('/').pop() || 'model.glb',
          fileBlob: null
        }
      }
      case 'obj': {
        const loader = new OBJLoader(manager)
        const object = ensureGroup(await loader.loadAsync(url))
        object.traverse((child) => {
          const mesh = child as THREE.Mesh
          if (mesh.isMesh) {
            mesh.material = new THREE.MeshStandardMaterial({
              color: 0xcccccc,
              roughness: 0.7,
              metalness: 0.1,
              side: THREE.DoubleSide
            })
          }
        })
        normalizeObject(object)
        return { object, animations: [], fileName: url.split('/').pop() || 'model.obj', fileBlob: null }
      }
      case 'fbx': {
        const loader = new FBXLoader(manager)
        const object = ensureGroup(await loader.loadAsync(url))
        normalizeObject(object)
        return { object, animations: (object.animations as THREE.AnimationClip[]) || [], fileName: url.split('/').pop() || 'model.fbx', fileBlob: null }
      }
      case 'stl': {
        const loader = new STLLoader(manager)
        const geometry = await loader.loadAsync(url)
        geometry.computeVertexNormals()
        const material = new THREE.MeshStandardMaterial({
          color: 0xb0b0b0,
          roughness: 0.65,
          metalness: 0.05,
          side: THREE.DoubleSide
        })
        const mesh = new THREE.Mesh(geometry, material)
        const object = ensureGroup(mesh)
        normalizeObject(object)
        return { object, animations: [], fileName: url.split('/').pop() || 'model.stl', fileBlob: null }
      }
      case 'ply': {
        const loader = new PLYLoader(manager)
        const geometry = await loader.loadAsync(url)
        geometry.computeVertexNormals()
        const material = new THREE.MeshStandardMaterial({
          color: 0xb0b0b0,
          roughness: 0.65,
          metalness: 0.05,
          side: THREE.DoubleSide,
          flatShading: !geometry.attributes.normal
        })
        const mesh = new THREE.Mesh(geometry, material)
        const object = ensureGroup(mesh)
        normalizeObject(object)
        return { object, animations: [], fileName: url.split('/').pop() || 'model.ply', fileBlob: null }
      }
      case 'dae': {
        const loader = new ColladaLoader(manager)
        const collada = await loader.loadAsync(url)
        const object = ensureGroup(collada.scene)
        normalizeObject(object)
        return {
          object,
          animations: (collada as unknown as { animations?: THREE.AnimationClip[] }).animations || [],
          fileName: url.split('/').pop() || 'model.dae',
          fileBlob: null
        }
      }
      case '3mf': {
        const loader = new ThreeMFLoader(manager)
        const object = ensureGroup(await loader.loadAsync(url))
        normalizeObject(object)
        return { object, animations: [], fileName: url.split('/').pop() || 'model.3mf', fileBlob: null }
      }
      default:
        throw new Error(`不支持的模型格式: .${ext}`)
    }
  }

  dispose() {
    this.draco?.dispose()
  }
}
