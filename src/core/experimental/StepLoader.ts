import * as THREE from 'three'
import type { MaterialReport } from '../MaterialResolver'

export const STEP_EXTENSIONS = ['step', 'stp'] as const
export const STEP_ACCEPT = '.step,.stp'

/** WASM asset URL for occt-import-js; override when self-hosting. */
let stepWasmUrl: string | null = null

export function setStepWasmUrl(url: string | null) {
  stepWasmUrl = url
}

export function getStepWasmUrl(): string | null {
  return stepWasmUrl
}

const DEFAULT_WASM_CDN =
  'https://unpkg.com/occt-import-js@0.0.23/dist/occt-import-js.wasm'

type OcctMesh = {
  name?: string
  color?: number[] | null
  attributes: {
    position: { array: number[] | Float32Array }
    normal?: { array: number[] | Float32Array }
  }
  index: { array: number[] | Uint32Array }
}

type OcctResult = {
  success: boolean
  meshes?: OcctMesh[]
}

type OcctModule = {
  ReadStepFile: (data: Uint8Array, params: unknown) => OcctResult
}

type OcctFactory = (config?: {
  locateFile?: (path: string) => string
}) => Promise<OcctModule>

let occtPromise: Promise<OcctFactory> | null = null

async function loadOcctFactory(): Promise<OcctFactory> {
  if (!occtPromise) {
    occtPromise = import('occt-import-js').then((mod) => {
      const factory =
        (mod as { default?: OcctFactory }).default ||
        (mod as unknown as OcctFactory)
      if (typeof factory !== 'function') {
        throw new Error('occt-import-js 模块导出异常')
      }
      return factory
    })
  }
  return occtPromise
}

/**
 * Experimental STEP/STP simple mesh preview via occt-import-js (OpenCascade WASM).
 * Tessellated mesh only — not full CAD B-Rep / PMI fidelity.
 */
export async function loadStepFromBuffer(
  buffer: ArrayBuffer,
  fileName: string
): Promise<{ object: THREE.Group; materialReport: MaterialReport }> {
  let factory: OcctFactory
  try {
    factory = await loadOcctFactory()
  } catch {
    throw new Error(
      'STEP 实验性展示需要安装依赖：npm install occt-import-js（并确保可访问 WASM）'
    )
  }

  const wasm = stepWasmUrl || DEFAULT_WASM_CDN
  let occt: OcctModule
  try {
    occt = await factory({
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasm : path)
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`STEP 引擎初始化失败：${reason}。可用 setStepWasmUrl() 指定本地 WASM`)
  }

  let result: OcctResult
  try {
    result = occt.ReadStepFile(new Uint8Array(buffer), null)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`STEP 解析失败（实验性）：${reason}`)
  }

  if (!result || result.success === false || !result.meshes?.length) {
    throw new Error('STEP 解析结果为空或失败（实验性简单展示）')
  }

  const object = new THREE.Group()
  for (const meshData of result.meshes) {
    object.add(buildMesh(meshData))
  }

  return {
    object,
    materialReport: {
      texturesFound: 0,
      texturesMissing: 0,
      missingSlots: [],
      notes: [
        `实验性 STEP 简单展示：${fileName}`,
        `三角网格块 ${result.meshes.length} 个（WASM 细分，非完整 CAD）`,
        '不保证装配约束/PMI/精确 B-Rep；生产建议转 GLB'
      ]
    }
  }
}

function buildMesh(data: OcctMesh): THREE.Mesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute(toFloatArray(data.attributes.position.array), 3)
  )
  if (data.attributes.normal) {
    geometry.setAttribute(
      'normal',
      new THREE.Float32BufferAttribute(toFloatArray(data.attributes.normal.array), 3)
    )
  } else {
    geometry.computeVertexNormals()
  }
  geometry.setIndex(new THREE.BufferAttribute(toIndexArray(data.index.array), 1))
  if (data.name) geometry.name = data.name

  const color = data.color
    ? new THREE.Color(data.color[0], data.color[1], data.color[2])
    : new THREE.Color(0xb8b8b8)

  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.65,
    metalness: 0.15,
    side: THREE.DoubleSide
  })

  return new THREE.Mesh(geometry, material)
}

function toFloatArray(input: number[] | Float32Array): Float32Array {
  return input instanceof Float32Array ? input : new Float32Array(input)
}

function toIndexArray(input: number[] | Uint32Array): Uint32Array {
  return input instanceof Uint32Array ? input : new Uint32Array(input)
}
