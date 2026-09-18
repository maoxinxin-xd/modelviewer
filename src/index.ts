/**
 * mivo-model-viewer
 *
 * Default-UI model viewer + headless engine escape hatch.
 */

// Component API
export { createModelViewer, ModelViewer } from './ui/ModelViewer'
export type {
  ModelViewerOptions,
  ModelViewerUIOptions,
  ModelViewerTheme,
  ModelViewerInstance,
  ModelSource
} from './ui/types'
export { locales, resolveCopy } from './ui/i18n'
export type { Locale, ViewerCopy } from './ui/i18n'

// Core / headless
export {
  ViewerEngine,
  ModelLoader,
  isSupportedModelFile,
  SUPPORTED_ACCEPT,
  CAMERA_CONFIG,
  countTriangles,
  disposeObject3D,
  getModelDiagonal,
  hasValidModelDimensions,
  calculateOrthographicViewSize,
  sphericalToCartesian,
  extractAlbedoFromMaterial,
  renderModelImage,
  renderModelImageDetailed,
  renderModelImages,
  renderModelImageObjectURL,
  renderModelImageDataUrl,
  resolveModelInput
} from './core'
export type {
  ViewerState,
  ViewerEngineOptions,
  LoadResult,
  ProgressCallback,
  AssetPack,
  VirtualFile,
  MaterialReport,
  ProjectionMode,
  PresetView,
  TextureMode,
  ModelInput,
  ImageFormat,
  RenderModelImageOptions,
  RenderedImage
} from './core'
