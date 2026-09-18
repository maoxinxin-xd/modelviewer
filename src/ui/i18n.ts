export type Locale = 'zh-CN' | 'en-US'

export interface ViewerCopy {
  title: string
  emptyDesc: string
  modelInfo: string
  fieldFile: string
  fieldTopology: string
  fieldFaces: string
  fieldMaterial: string
  display: string
  projection: string
  perspective: string
  orthographic: string
  presetViews: string
  front: string
  back: string
  side: string
  top: string
  lighting: string
  angle: string
  keyIntensity: string
  ambientIntensity: string
  import: string
  replace: string
  export: string
  screenshot: string
  texture: string
  clay: string
  normal: string
  albedo: string
  loading: string
  toastNeedModel: string
  toastShotDone: string
  toastShotFail: string
  toastUnsupported: string
  toastLoadOk: string
  toastLoadFail: string
  toastExportEmpty: string
  toastExportOk: string
  materialMissing: string
}

const zhCN: ViewerCopy = {
  title: '3D 模型查看器',
  emptyDesc: '支持 GLB/GLTF/OBJ/FBX/STL/PLY/DAE/3MF/3DS，以及含模型+贴图的 ZIP',
  modelInfo: '模型信息',
  fieldFile: '文件',
  fieldTopology: '拓扑',
  fieldFaces: '面数',
  fieldMaterial: '材质',
  display: '显示设置',
  projection: '透视关系',
  perspective: '透视',
  orthographic: '正交',
  presetViews: '预设角度',
  front: '正视',
  back: '背视',
  side: '侧视',
  top: '俯视',
  lighting: '灯光设置',
  angle: '角度',
  keyIntensity: '射灯强度',
  ambientIntensity: '平面光强度',
  import: '导入',
  replace: '替换',
  export: '导出',
  screenshot: '截屏',
  texture: '贴图',
  clay: '白膜',
  normal: '法线',
  albedo: '反照',
  loading: '模型加载中',
  toastNeedModel: '请先导入模型',
  toastShotDone: '截图已下载',
  toastShotFail: '截图失败，请重试',
  toastUnsupported: '不支持的格式。支持：GLB/GLTF/OBJ/FBX/STL/PLY/DAE/3MF/3DS/ZIP',
  toastLoadOk: '模型加载成功',
  toastLoadFail: '模型加载失败，请重试',
  toastExportEmpty: '暂无可导出的模型文件，请先导入',
  toastExportOk: '导出成功',
  materialMissing: '缺失'
}

const enUS: ViewerCopy = {
  title: '3D Model Viewer',
  emptyDesc:
    'GLB/GLTF/OBJ/FBX/STL/PLY/DAE/3MF/3DS, plus ZIP packs with model + textures',
  modelInfo: 'Model Info',
  fieldFile: 'File',
  fieldTopology: 'Topology',
  fieldFaces: 'Faces',
  fieldMaterial: 'Materials',
  display: 'Display',
  projection: 'Projection',
  perspective: 'Perspective',
  orthographic: 'Orthographic',
  presetViews: 'Preset Views',
  front: 'Front',
  back: 'Back',
  side: 'Side',
  top: 'Top',
  lighting: 'Lighting',
  angle: 'Angle',
  keyIntensity: 'Key Light',
  ambientIntensity: 'Ambient',
  import: 'Import',
  replace: 'Replace',
  export: 'Export',
  screenshot: 'Screenshot',
  texture: 'Textured',
  clay: 'Clay',
  normal: 'Normal',
  albedo: 'Albedo',
  loading: 'Loading model',
  toastNeedModel: 'Import a model first',
  toastShotDone: 'Screenshot saved',
  toastShotFail: 'Screenshot failed, try again',
  toastUnsupported:
    'Unsupported format. Use GLB/GLTF/OBJ/FBX/STL/PLY/DAE/3MF/3DS/ZIP',
  toastLoadOk: 'Model loaded',
  toastLoadFail: 'Failed to load model',
  toastExportEmpty: 'No model to export yet',
  toastExportOk: 'Exported',
  materialMissing: 'missing'
}

export const locales: Record<Locale, ViewerCopy> = {
  'zh-CN': zhCN,
  'en-US': enUS
}

export function resolveCopy(locale: Locale = 'zh-CN'): ViewerCopy {
  return locales[locale] ?? zhCN
}
