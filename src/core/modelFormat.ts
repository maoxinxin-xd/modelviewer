import { isSupportedModelFile } from './ModelLoader'

const EXT_MIME: Record<string, string> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  fbx: 'application/octet-stream',
  stl: 'model/stl',
  ply: 'application/octet-stream',
  dae: 'model/vnd.collada+xml',
  '3mf': 'model/3mf',
  '3ds': 'application/octet-stream',
  zip: 'application/zip',
  wrl: 'model/vrml',
  vrml: 'model/vrml',
  step: 'model/step',
  stp: 'model/step'
}

const MIME_EXT: Record<string, string> = {
  'model/gltf-binary': 'glb',
  'model/gltf+json': 'gltf',
  'model/gltf': 'gltf',
  'model/obj': 'obj',
  'text/plain': '', // ambiguous
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'model/stl': 'stl',
  'model/vnd.collada+xml': 'dae',
  'model/3mf': '3mf',
  'model/vrml': 'wrl',
  'x-world/x-vrml': 'wrl',
  'model/step': 'step',
  'application/step': 'step',
  'application/STEP': 'step'
}

export function extensionOf(name: string): string {
  let base = name.split(/[\\/]/).pop() || ''
  base = base.split(/[?#]/)[0] || ''
  const i = base.lastIndexOf('.')
  if (i <= 0 || i === base.length - 1) return ''
  return base.slice(i + 1).toLowerCase()
}

export function hasModelExtension(name: string): boolean {
  return Boolean(extensionOf(name))
}

export function ensureModelExtension(name: string, ext: string): string {
  if (hasModelExtension(name)) return name
  return `${name}.${ext}`
}

export function extFromMime(mime: string): string | null {
  if (!mime) return null
  const key = mime.split(';')[0].trim().toLowerCase()
  const ext = MIME_EXT[key]
  return ext || null
}

function startsWithBytes(buf: Uint8Array, bytes: number[]): boolean {
  if (buf.length < bytes.length) return false
  for (let i = 0; i < bytes.length; i++) {
    if (buf[i] !== bytes[i]) return false
  }
  return true
}

function ascii(buf: Uint8Array, start = 0, end = Math.min(buf.length, start + 64)): string {
  let s = ''
  for (let i = start; i < end && i < buf.length; i++) s += String.fromCharCode(buf[i])
  return s
}

/** Sniff format from file magic / leading text. Returns extension without dot. */
export function extFromMagic(buf: Uint8Array): string | null {
  if (buf.length < 4) return null

  // glTF binary: "glTF"
  if (startsWithBytes(buf, [0x67, 0x6c, 0x54, 0x46])) return 'glb'
  // ZIP
  if (startsWithBytes(buf, [0x50, 0x4b])) return 'zip'
  // FBX binary
  if (ascii(buf, 0, 20).startsWith('Kaydara FBX Binary')) return 'fbx'
  // 3DS primary chunk 0x4D4D
  if (buf[0] === 0x4d && buf[1] === 0x4d) return '3ds'

  const head = ascii(buf, 0, Math.min(buf.length, 256)).replace(/^﻿/, '')
  const trimmed = head.trimStart()

  if (/^#VRML/i.test(trimmed)) return 'wrl'
  if (/^ISO-10303/i.test(trimmed)) return 'step'
  if (/^solid\b/i.test(trimmed) && /\bfacet\b|\bendsolid\b/i.test(ascii(buf, 0, 1024))) {
    return 'stl'
  }
  if (/^\{/.test(trimmed) && /"asset"\s*:/.test(ascii(buf, 0, 2048))) return 'gltf'
  // OBJ: vertices / faces / comments early
  if (/^#?\s*(v|vn|vt|f|o|g|mtllib|usemtl)\s/m.test(ascii(buf, 0, 512))) {
    if (/^#VRML/i.test(trimmed)) return 'wrl'
    return 'obj'
  }
  if (/^ply\b/i.test(trimmed)) return 'ply'
  if (/^<?xml\b/i.test(trimmed) && /collada/i.test(ascii(buf, 0, 1024))) return 'dae'

  return null
}

export async function sniffBlobExtension(blob: Blob): Promise<string | null> {
  const fromMime = extFromMime(blob.type)
  if (fromMime) return fromMime
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer())
  return extFromMagic(head)
}

/**
 * Pick a loader-facing filename for File/Blob/URL inputs.
 * Never silently assumes `.glb` when format is unknown.
 */
export async function resolveModelFileName(
  source: File | Blob | string,
  hintName?: string
): Promise<string> {
  if (typeof source === 'string') {
    const fromUrl = extensionOf(source)
    if (hintName && hasModelExtension(hintName)) return hintName
    if (fromUrl) {
      const base = source.split(/[\\/]/).pop()!.split(/[?#]/)[0]
      return base || `model.${fromUrl}`
    }
    if (hintName) {
      return hintName
    }
    throw new Error(
      `无法从 URL 推断模型扩展名：${source}。请传入 fileName，例如 fileName: "model.obj"`
    )
  }

  if (source instanceof File && source.name && hasModelExtension(source.name)) {
    return source.name
  }

  if (hintName && hasModelExtension(hintName)) {
    return hintName
  }

  const sniffed = await sniffBlobExtension(source as Blob)
  if (sniffed) {
    return ensureModelExtension(hintName || 'model', sniffed)
  }

  if (hintName) {
    throw new Error(
      `无法从 Blob.type / 文件头推断格式，请为 fileName 补上扩展名，例如 "${hintName}.obj"`
    )
  }

  throw new Error(
    'Blob 未带文件名，且无法从 MIME/文件头推断格式。请传入 fileName（如 "chair.obj" / "pack.zip"）'
  )
}

export { isSupportedModelFile, EXT_MIME }
