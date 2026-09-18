import * as THREE from 'three'
import type { AssetPack, VirtualFile } from './AssetPack'
import { SLOT_KEYWORDS, type TextureSlot } from './AssetPack'

export interface MaterialReport {
  texturesFound: number
  texturesMissing: number
  missingSlots: string[]
  notes: string[]
}

const TEXTURE_KEYS: TextureSlot[] = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap'
]

function basename(path: string): string {
  return (path.split('/').pop() || path).toLowerCase()
}

function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

/** 在资源包中按 basename / 关键词查找贴图 */
export function findTextureInPack(
  pack: AssetPack,
  reference: string
): VirtualFile | null {
  if (!reference) return null
  const cleaned = decodeURIComponent(reference)
    .replace(/\\/g, '/')
    .replace(/^file:[^/]*/i, '')
    .replace(/^\/+/g, '')
  const filePart = basename(cleaned)
  const noExt = stripExt(filePart)

  // basename 精确（忽略扩展名差异：只要 lowerBase 前缀相同）
  const entries = [...pack.files.values()].filter(
    (f) => f.ext && (f.lowerBase === filePart || stripExt(f.lowerBase) === noExt)
  )
  if (entries.length === 0) {
    return null
  }

  const modelDir = pack.modelDir
  if (modelDir) {
    const sameDir = entries.find(
      (f) => f.path.startsWith(`${modelDir}/`) || !f.path.includes('/')
    )
    if (sameDir) return sameDir
  }
  const preferredDir = entries.find((f) =>
    /textures?|maps?|fbm|materials?/i.test(f.path)
  )
  return preferredDir || entries[0]
}

export function createTextureFromVirtual(
  _pack: AssetPack,
  vf: VirtualFile
): THREE.Texture | null {
  // 已有 blob URL 时由 TextureLoader 加载；这里统一走 URL
  if (!vf.blobUrl) {
    const blob = new Blob([vf.data as unknown as BlobPart], { type: vf.mimeType })
    vf.blobUrl = URL.createObjectURL(blob)
  }
  const loader = new THREE.TextureLoader()
  try {
    const tex = loader.load(vf.blobUrl)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.needsUpdate = true
    return tex
  } catch {
    return null
  }
}

function hasUsableTexture(mat: THREE.Material, key: string): boolean {
  const anyMat = mat as unknown as Record<string, unknown>
  const v = anyMat[key]
  return Boolean(v && (v as THREE.Texture).isTexture && (v as THREE.Texture).image)
}

function materialRefString(mat: THREE.Material, keys: string[]): string | null {
  const anyMat = mat as unknown as Record<string, unknown>
  for (const key of keys) {
    const v = anyMat[key]
    if (!v) continue
    if (typeof v === 'string' && v) return v
    const tex = v as THREE.Texture & { name?: string; image?: { src?: string } }
    if (tex.name && typeof tex.name === 'string') return tex.name
    const src = tex.image?.src
    if (src && typeof src === 'string' && !src.startsWith('blob:') && !src.startsWith('data:')) {
      return src
    }
  }
  // material.name 常带贴图名
  if (mat.name) return mat.name
  return null
}

/**
 * 对 FBX/OBJ 等场景做材质补全（ZIP 资源包内）
 * 边界：Loader 已解析部分优先；缺失槽用 basename/关键词启发式补；仍缺则默认 PBR + 报告
 */
export function applyMaterialFallback(
  root: THREE.Object3D,
  pack: AssetPack
): MaterialReport {
  const report: MaterialReport = {
    texturesFound: 0,
    texturesMissing: 0,
    missingSlots: [],
    notes: []
  }
  const missingSet = new Set<string>()
  const textureFiles = [...pack.files.values()].filter((f) =>
    ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga', 'tif', 'tiff', 'gif'].includes(f.ext)
  )

  // 全包关键词索引（一次构建）
  const keywordHits: Partial<Record<TextureSlot, VirtualFile>> = {}
  for (const slot of TEXTURE_KEYS) {
    const keys = SLOT_KEYWORDS[slot]
    const hit = textureFiles.find((t) =>
      keys.some((k) => t.lowerBase.includes(k.toLowerCase()))
    )
    if (hit) keywordHits[slot] = hit
  }

  root.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]

    const nextMats = materials.map((mat) => {
      if (!mat) {
        return new THREE.MeshStandardMaterial({
          color: 0xcccccc,
          roughness: 0.7,
          metalness: 0,
          side: THREE.DoubleSide
        })
      }
      const anyMat = mat as unknown as Record<string, unknown>
      const ref =
        materialRefString(mat, ['map', 'emissiveMap', 'name']) ||
        mesh.name ||
        (typeof anyMat.name === 'string' ? anyMat.name : '')

      const applySlot = (slot: TextureSlot, refKeys: string[]) => {
        if (hasUsableTexture(mat, slot)) {
          report.texturesFound += 1
          return
        }
        // 1) 从引用字符串在包内找
        let vf = ref ? findTextureInPack(pack, ref) : null
        // 2) 用引用 basename + 槽位关键词组合找
        if (!vf && ref) {
          const base = stripExt(basename(ref))
          const keys = SLOT_KEYWORDS[slot]
          vf =
            textureFiles.find(
              (t) =>
                stripExt(t.lowerBase).includes(base) &&
                keys.some((k) => t.lowerBase.includes(k.toLowerCase()))
            ) || null
        }
        // 3) 全局关键词
        if (!vf) vf = keywordHits[slot] || null
        // 4) 若仅缺 map，用任意 albedo 类图兜底
        if (!vf && slot === 'map') {
          vf = keywordHits.map || textureFiles[0] || null
        }

        if (vf) {
          const tex = createTextureFromVirtual(pack, vf)
          if (tex) {
            if (slot === 'map' || slot === 'emissiveMap') {
              tex.colorSpace = THREE.SRGBColorSpace
            } else {
              tex.colorSpace = THREE.NoColorSpace
            }
            ;(mat as unknown as Record<string, unknown>)[slot] = tex
            mat.needsUpdate = true
            report.texturesFound += 1
            return
          }
        }

        // 仅对关键缺失计数（map/normal），避免噪声
        if (slot === 'map' || slot === 'normalMap') {
          report.texturesMissing += 1
          missingSet.add(slot)
        }
        void refKeys
      }

      applySlot('map', ['map', 'diffuse', 'name'])
      applySlot('normalMap', ['normalMap', 'normal', 'bump'])
      applySlot('roughnessMap', ['roughnessMap', 'roughness'])
      applySlot('metalnessMap', ['metalnessMap', 'metalness'])
      applySlot('aoMap', ['aoMap', 'ao'])
      applySlot('emissiveMap', ['emissiveMap', 'emissive'])

      // 完全无贴图：给默认 PBR，避免纯黑/不可见
      if (!hasUsableTexture(mat, 'map')) {
        const std = mat as THREE.MeshStandardMaterial
        if (!(std as unknown as { _mimoFallback?: boolean })._mimoFallback) {
          if (!std.color || (std.color.getHex?.() ?? 0) === 0) {
            std.color = new THREE.Color(0xcccccc)
          }
          if (typeof std.roughness === 'number' && std.roughness === 0) std.roughness = 0.7
          if (typeof std.metalness === 'number' && std.metalness === 0) std.metalness = 0.05
          ;(std as unknown as { _mimoFallback?: boolean })._mimoFallback = true
          std.side = THREE.DoubleSide
          std.needsUpdate = true
        }
        if (!missingSet.has('map')) {
          missingSet.add('map')
        }
      }

      return mat
    })

    mesh.material = Array.isArray(mesh.material) ? nextMats : nextMats[0]
  })

  report.missingSlots = [...missingSet]
  report.notes.push(`资源包内贴图 ${textureFiles.length} 个`)
  if (report.texturesMissing > 0) {
    report.notes.push('已对缺失贴图使用默认材质')
  }
  return report
}

/** OBJ：尝试加载同包/同目录 MTL，再材质补全 */
export function tryLoadMtlFromPack(
  pack: AssetPack,
  object: THREE.Object3D
): boolean {
  const mtlFiles = [...pack.files.values()].filter((f) => f.ext === 'mtl')
  if (mtlFiles.length === 0) return false

  // 简易 MTL：只解析 map_Kd / Kd / Ns
  // 完整 MTLLoader 需要路径解析，ZIP 内用关键字补全已足够
  const mtl = mtlFiles[0]
  const text = new TextDecoder().decode(mtl.data)
  const blocks = text.split(/^newmtl\s+/m)
  const matMap = new Map<string, { mapKd?: string; kd?: THREE.Color }>()

  for (const block of blocks) {
    if (!block.trim()) continue
    const lines = block.split(/\r?\n/)
    const name = (lines[0] || '').trim()
    if (!name || name.startsWith('#')) continue
    const info: { mapKd?: string; kd?: THREE.Color } = {}
    for (const line of lines.slice(1)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('map_Kd')) {
        info.mapKd = trimmed.split(/\s+/).pop()
      } else if (trimmed.startsWith('Kd')) {
        const parts = trimmed.split(/\s+/).slice(1).map(Number)
        if (parts.length >= 3) {
          info.kd = new THREE.Color(parts[0], parts[1], parts[2])
        }
      }
    }
    matMap.set(name.toLowerCase(), info)
  }

  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const name = (mesh.name || '').toLowerCase()
    const info = matMap.get(name) || [...matMap.values()][0]
    if (!info) return

    let map: THREE.Texture | null = null
    if (info.mapKd) {
      const vf = findTextureInPack(pack, info.mapKd)
      if (vf) map = createTextureFromVirtual(pack, vf)
    }
    const material = new THREE.MeshStandardMaterial({
      color: info.kd || 0xcccccc,
      map,
      roughness: 0.7,
      metalness: 0.05,
      side: THREE.DoubleSide
    })
    if (map) map.colorSpace = THREE.SRGBColorSpace
    mesh.material = material
  })

  return true
}
