import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { createAssetPackFromZip, type AssetPack } from './AssetPack'
import {
  applyMaterialFallback,
  tryLoadMtlFromPack,
  type MaterialReport
} from './MaterialResolver'
import {
  loadVrmlFromBuffer,
  loadStepFromBuffer,
  VRML_EXTENSIONS,
  VRML_ACCEPT,
  STEP_EXTENSIONS,
  STEP_ACCEPT
} from './experimental'

export type ProgressCallback = (percent: number) => void

export interface LoadResult {
  object: THREE.Group
  animations: THREE.AnimationClip[]
  fileName: string
  fileBlob: Blob | null
  materialReport: MaterialReport
  /** 实际加载的入口（ZIP 时为包内文件） */
  entryName: string
  /** true = experimental format (VRML / STEP), simple preview only */
  experimental?: boolean
}

const MODEL_EXTENSIONS = [
  'glb',
  'gltf',
  'obj',
  'fbx',
  'stl',
  'ply',
  'dae',
  '3mf',
  '3ds',
  'zip',
  ...VRML_EXTENSIONS,
  ...STEP_EXTENSIONS
]

export const SUPPORTED_ACCEPT = [
  '.glb,.gltf,.obj,.fbx,.stl,.ply,.dae,.3mf,.3ds,.zip',
  VRML_ACCEPT,
  STEP_ACCEPT
].join(',')

export function isSupportedModelFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  return MODEL_EXTENSIONS.includes(ext)
}

export function isExperimentalModelFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase() || ''
  return (
    (VRML_EXTENSIONS as readonly string[]).includes(ext) ||
    (STEP_EXTENSIONS as readonly string[]).includes(ext)
  )
}

function ensureGroup(object: THREE.Object3D): THREE.Group {
  if (object instanceof THREE.Group) return object
  const group = new THREE.Group()
  group.add(object)
  return group
}

function normalizeObject(root: THREE.Object3D) {
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

function emptyReport(note = ''): MaterialReport {
  return {
    texturesFound: 0,
    texturesMissing: 0,
    missingSlots: [],
    notes: note ? [note] : []
  }
}

function defaultPbrMaterial(color = 0xb0b0b0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.7,
    metalness: 0.05,
    side: THREE.DoubleSide
  })
}

export class ModelLoader {
  private draco: DRACOLoader | null = null
  private manager = new THREE.LoadingManager()
  private activePack: AssetPack | null = null

  constructor() {
    this.draco = new DRACOLoader()
    this.draco.setDecoderPath(
      'https://www.gstatic.com/draco/versioned/decoders/1.5.7/'
    )
  }

  private releasePack() {
    if (this.activePack) {
      this.activePack.dispose()
      this.activePack = null
    }
  }

  async loadFromFile(file: File, onProgress?: ProgressCallback): Promise<LoadResult> {
    const ext = file.name.split('.').pop()?.toLowerCase() || ''
    this.releasePack()

    if (ext === 'zip') {
      return this.loadFromZip(file, onProgress)
    }

    if ((VRML_EXTENSIONS as readonly string[]).includes(ext)) {
      return this.loadExperimentalFile(file, ext, onProgress)
    }

    if ((STEP_EXTENSIONS as readonly string[]).includes(ext)) {
      return this.loadExperimentalFile(file, ext, onProgress)
    }

    const url = URL.createObjectURL(file)
    try {
      const result = await this.loadFromUrl(url, ext, onProgress, file.name)
      result.fileBlob = file
      result.fileName = file.name
      return result
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  /** Experimental VRML / STEP — simple mesh preview, not production CAD fidelity */
  private async loadExperimentalFile(
    file: File,
    ext: string,
    onProgress?: ProgressCallback
  ): Promise<LoadResult> {
    onProgress?.(5)
    const buffer = await file.arrayBuffer()
    onProgress?.(30)

    let object: THREE.Group
    let materialReport: MaterialReport

    if ((VRML_EXTENSIONS as readonly string[]).includes(ext)) {
      const loaded = await loadVrmlFromBuffer(buffer, file.name)
      object = loaded.object
      materialReport = loaded.materialReport
    } else if ((STEP_EXTENSIONS as readonly string[]).includes(ext)) {
      const loaded = await loadStepFromBuffer(buffer, file.name)
      object = loaded.object
      materialReport = loaded.materialReport
    } else {
      throw new Error(`不支持的实验性格式: .${ext}`)
    }

    onProgress?.(80)
    normalizeObject(object)
    onProgress?.(100)

    return {
      object,
      animations: [],
      fileName: file.name,
      fileBlob: file,
      materialReport,
      entryName: file.name,
      experimental: true
    }
  }

  private async loadFromZip(file: File, onProgress?: ProgressCallback): Promise<LoadResult> {
    onProgress?.(5)
    const pack = await createAssetPackFromZip(file)
    this.activePack = pack

    const entry = pack.files.get(pack.entryPath)
    if (!entry) {
      pack.dispose()
      throw new Error('ZIP 入口模型读取失败')
    }
    if (!entry.blobUrl) {
      entry.blobUrl = URL.createObjectURL(
        new Blob([entry.data as unknown as BlobPart], { type: entry.mimeType })
      )
      // AssetPack.dispose() owns all generated blob URLs, including the entry model.
      pack.blobUrls.push(entry.blobUrl)
    }

    onProgress?.(15)
    const manager = pack.manager
    manager.onProgress = (_url, loaded, total) => {
      if (total > 0) onProgress?.(20 + (loaded / total) * 70)
    }

    try {
      const object = await this.loadSceneFromUrl(
        entry.blobUrl,
        pack.entryExt,
        manager,
        pack.entryPath
      )

      // OBJ：尝试包内 MTL
      if (pack.entryExt === 'obj') {
        tryLoadMtlFromPack(pack, object)
      }

      // FBX/OBJ/3DS/DAE：材质启发式补全
      let materialReport = emptyReport('独立文件，无外挂资源包')
      if (['fbx', 'obj', '3ds', 'dae'].includes(pack.entryExt)) {
        materialReport = applyMaterialFallback(object, pack)
      } else if (pack.entryExt === 'gltf' || pack.entryExt === 'glb') {
        materialReport = emptyReport('GLTF/GLB 自带材质')
      }

      normalizeObject(object)
      onProgress?.(100)
      return {
        object,
        animations: (object.animations as THREE.AnimationClip[]) || [],
        fileName: file.name,
        fileBlob: file,
        materialReport,
        entryName: pack.entryPath
      }
    } catch (error) {
      pack.dispose()
      this.activePack = null
      throw error
    }
  }

  private async loadSceneFromUrl(
    url: string,
    ext: string,
    manager: THREE.LoadingManager,
    name: string
  ): Promise<THREE.Group> {
    switch (ext) {
      case 'glb':
      case 'gltf': {
        const loader = new GLTFLoader(manager)
        if (this.draco) loader.setDRACOLoader(this.draco)
        loader.setMeshoptDecoder(MeshoptDecoder)
        const gltf = await loader.loadAsync(url)
        return ensureGroup(gltf.scene)
      }
      case 'obj': {
        const loader = new OBJLoader(manager)
        return ensureGroup(await loader.loadAsync(url))
      }
      case 'fbx': {
        const loader = new FBXLoader(manager)
        return ensureGroup(await loader.loadAsync(url))
      }
      case '3ds': {
        const loader = new TDSLoader(manager)
        const group = await loader.loadAsync(url)
        return ensureGroup(group)
      }
      case 'dae': {
        const loader = new ColladaLoader(manager)
        const collada = await loader.loadAsync(url)
        return ensureGroup(collada.scene)
      }
      case '3mf': {
        const loader = new ThreeMFLoader(manager)
        return ensureGroup(await loader.loadAsync(url))
      }
      case 'ply': {
        const loader = new PLYLoader(manager)
        const geometry = await loader.loadAsync(url)
        geometry.computeVertexNormals()
        const mesh = new THREE.Mesh(geometry, defaultPbrMaterial())
        return ensureGroup(mesh)
      }
      case 'stl': {
        const loader = new STLLoader(manager)
        const geometry = await loader.loadAsync(url)
        geometry.computeVertexNormals()
        const mesh = new THREE.Mesh(geometry, defaultPbrMaterial())
        return ensureGroup(mesh)
      }
      case 'wrl':
      case 'vrml':
      case 'step':
      case 'stp':
        throw new Error(
          `实验性格式 .${ext} 请通过 loadFromFile / createModelViewer 的 File 入口加载（当前 URL 管线未接）`
        )
      default:
        throw new Error(`不支持的模型格式: .${ext} (${name})`)
    }
  }

  async loadFromUrl(
    url: string,
    ext: string,
    onProgress?: ProgressCallback,
    displayName?: string
  ): Promise<LoadResult> {
    const manager = this.manager
    manager.onProgress = (_url, loaded, total) => {
      if (total > 0) onProgress?.((loaded / total) * 100)
    }

    const object = await this.loadSceneFromUrl(
      url,
      ext,
      manager,
      displayName || url
    )

    let materialReport = emptyReport()
    if (ext === 'obj') {
      object.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (mesh.isMesh && !mesh.material) {
          mesh.material = defaultPbrMaterial(0xcccccc)
        } else if (mesh.isMesh) {
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          mats.forEach((m) => {
            const anyM = m as unknown as Record<string, unknown>
            if (m && !anyM.map) {
              anyM.roughness = 0.7
              anyM.metalness = 0.05
              m.needsUpdate = true
            }
          })
        }
      })
      materialReport = emptyReport('OBJ 未提供外挂 MTL/贴图时使用默认材质')
    }

    normalizeObject(object)
    return {
      object,
      animations: (object.animations as THREE.AnimationClip[]) || [],
      fileName: displayName || url.split('/').pop() || `model.${ext}`,
      fileBlob: null,
      materialReport,
      entryName: displayName || url
    }
  }

  dispose() {
    this.releasePack()
    this.draco?.dispose()
  }
}
