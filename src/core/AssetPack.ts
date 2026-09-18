import { unzipSync, strFromU8 } from 'fflate'
import * as THREE from 'three'

/** ZIP 内支持的模型入口扩展名（优先级从高到低） */
const ENTRY_PRIORITY = [
  'gltf',
  'glb',
  'fbx',
  'obj',
  '3ds',
  'dae',
  '3mf',
  'ply',
  'stl'
]

const TEXTURE_EXTS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'gif',
  'tga',
  'tif',
  'tiff',
  'psd',
  'ktx',
  'ktx2',
  'dds',
  'exr',
  'hdr'
])

export interface VirtualFile {
  path: string
  basename: string
  ext: string
  lowerBase: string
  data: Uint8Array
  blobUrl: string | null
  mimeType: string
}

export interface AssetPack {
  files: Map<string, VirtualFile>
  byLowerBase: Map<string, VirtualFile[]>
  entryPath: string
  entryExt: string
  modelDir: string
  manager: THREE.LoadingManager
  blobUrls: string[]
  dispose: () => void
}

function extOf(path: string): string {
  const name = path.split('/').pop() || path
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

function mimeOf(ext: string): string {
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'webp':
      return 'image/webp'
    case 'bmp':
      return 'image/bmp'
    case 'gif':
      return 'image/gif'
    case 'tga':
      return 'image/x-tga'
    case 'tif':
    case 'tiff':
      return 'image/tiff'
    case 'glb':
      return 'model/gltf-binary'
    case 'gltf':
      return 'model/gltf+json'
    case 'obj':
      return 'text/plain'
    case 'fbx':
      return 'application/octet-stream'
    case 'mtl':
      return 'text/plain'
    default:
      return 'application/octet-stream'
  }
}

function pickEntry(paths: string[]): string | null {
  const modelPaths = paths.filter((p) => ENTRY_PRIORITY.includes(extOf(p)))
  if (modelPaths.length === 0) return null
  // 优先：浅路径 + 高优先级扩展名
  modelPaths.sort((a, b) => {
    const depthA = a.split('/').length
    const depthB = b.split('/').length
    if (depthA !== depthB) return depthA - depthB
    return ENTRY_PRIORITY.indexOf(extOf(a)) - ENTRY_PRIORITY.indexOf(extOf(b))
  })
  return modelPaths[0]
}

/**
 * 从 ZIP 构建虚拟资源表 + LoadingManager 路径映射
 * 边界：只做「解压 → 找入口 → 路径/文件名映射」，不做服务端转换
 */
export async function createAssetPackFromZip(file: File): Promise<AssetPack> {
  const buf = new Uint8Array(await file.arrayBuffer())
  const unzipped = unzipSync(buf)

  const files = new Map<string, VirtualFile>()
  const byLowerBase = new Map<string, VirtualFile[]>()
  const blobUrls: string[] = []

  for (const [rawPath, data] of Object.entries(unzipped)) {
    if (rawPath.endsWith('/')) continue
    // normalize zip path
    const path = rawPath.replace(/\\/g, '/').replace(/^\/+/, '')
    const basename = path.split('/').pop() || path
    const ext = extOf(path)
    const lowerBase = basename.toLowerCase()
    const mimeType = mimeOf(ext)
    const vf: VirtualFile = {
      path,
      basename,
      ext,
      lowerBase,
      data,
      blobUrl: null,
      mimeType
    }
    files.set(path, vf)
    const list = byLowerBase.get(lowerBase) || []
    list.push(vf)
    byLowerBase.set(lowerBase, list)
  }

  const entryPath = pickEntry([...files.keys()])
  if (!entryPath) {
    throw new Error('ZIP 内未找到可识别的模型文件（支持 glb/gltf/fbx/obj/3ds/dae/3mf/ply/stl）')
  }

  const entry = files.get(entryPath)!
  const entryExt = entry.ext
  const modelDir = entryPath.includes('/')
    ? entryPath.slice(0, entryPath.lastIndexOf('/'))
    : ''

  const manager = new THREE.LoadingManager()

  const ensureBlobUrl = (vf: VirtualFile) => {
    if (!vf.blobUrl) {
      const blob = new Blob([vf.data as unknown as BlobPart], { type: vf.mimeType })
      vf.blobUrl = URL.createObjectURL(blob)
      blobUrls.push(vf.blobUrl)
    }
    return vf.blobUrl
  }

  // 请求 URL → 虚拟资源
  const resolveVirtual = (url: string): VirtualFile | null => {
    const clean = decodeURIComponent(url.split('?')[0].split('#')[0]).replace(/\\/g, '/')
    const filePart = clean.split('/').pop() || clean

    // 1) 完整/相对路径命中
    const candidates = [
      clean.replace(/^\.\//, ''),
      modelDir ? `${modelDir}/${filePart}` : filePart,
      modelDir
        ? `${modelDir}/${clean.replace(/^\.\//, '')}`
        : clean.replace(/^\.\//, ''),
      filePart
    ]
    for (const c of candidates) {
      const hit = files.get(c) || files.get(c.replace(/^\/+/, ''))
      if (hit) return hit
    }

    // 2) basename 不区分大小写
    const byBase = byLowerBase.get(filePart.toLowerCase())
    if (byBase && byBase.length > 0) {
      // 优先同目录
      if (modelDir) {
        const same = byBase.find((f) => f.path.startsWith(`${modelDir}/`) || !f.path.includes('/'))
        if (same) return same
      }
      // 纹理优先放 textures/maps/fbm
      const preferred = byBase.find((f) =>
        /textures?|maps?|fbm|materials?/i.test(f.path)
      )
      return preferred || byBase[0]
    }
    return null
  }

  manager.setURLModifier((url) => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url
    // 仅映射包内相对资源；入口模型本身也用 blob
    const vf = resolveVirtual(url)
    if (vf) return ensureBlobUrl(vf)
    // 入口绝对/相对名
    if (url.endsWith(entryPath) || url.includes(entryPath)) {
      return ensureBlobUrl(entry)
    }
    return url
  })

  // 预创建常用纹理的 blob（加速 Loader 内部 Image 加载）
  for (const vf of files.values()) {
    if (TEXTURE_EXTS.has(vf.ext) || vf.ext === 'mtl' || vf.ext === 'obj' || vf.ext === 'fbx') {
      ensureBlobUrl(vf)
    }
  }

  const dispose = () => {
    for (const u of blobUrls) URL.revokeObjectURL(u)
    blobUrls.length = 0
    for (const vf of files.values()) vf.blobUrl = null
  }

  return {
    files,
    byLowerBase,
    entryPath,
    entryExt,
    modelDir,
    manager,
    blobUrls,
    dispose
  }
}

export function readTextFromVirtual(vf: VirtualFile): string {
  return strFromU8(vf.data)
}

export function listTextureFiles(pack: AssetPack): VirtualFile[] {
  return [...pack.files.values()].filter((f) => TEXTURE_EXTS.has(f.ext))
}

/** 关键词语义（与讨论中的边界一致：启发式，不追求 100%） */
export const SLOT_KEYWORDS: Record<string, string[]> = {
  map: ['diffuse', 'albedo', 'basecolor', 'base_color', 'base-color', 'color', 'col', 'diff', '_d', 'albedo'],
  normalMap: ['normal', 'nrm', '_n', 'norm', 'bump'],
  roughnessMap: ['rough', 'roughness', '_r'],
  metalnessMap: ['metal', 'metallic', 'metalness', '_m'],
  aoMap: ['ao', 'occlusion', 'ambientocclusion', 'ambient_occlusion'],
  emissiveMap: ['emissive', 'emit', '_e']
}

export type TextureSlot = keyof typeof SLOT_KEYWORDS

export function matchTextureByKeywords(
  pack: AssetPack,
  slots: TextureSlot[]
): Partial<Record<TextureSlot, VirtualFile>> {
  const textures = listTextureFiles(pack)
  const result: Partial<Record<TextureSlot, VirtualFile>> = {}
  const used = new Set<string>()

  for (const slot of slots) {
    const keys = SLOT_KEYWORDS[slot]
    const hit = textures.find((t) => {
      if (used.has(t.path)) return false
      return keys.some((k) => t.lowerBase.includes(k.toLowerCase()))
    })
    if (hit) {
      result[slot] = hit
      used.add(hit.path)
    }
  }
  return result
}

export function formatMissingSummary(missing: string[]): string {
  if (missing.length === 0) return '材质完整'
  if (missing.length <= 2) return `缺少${missing.join('/')}`
  return `缺少 ${missing.length} 项贴图`
}
