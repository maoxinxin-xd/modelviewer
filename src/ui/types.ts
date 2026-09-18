import type {
  PresetView,
  ProjectionMode,
  TextureMode,
  ViewerState
} from '../core'
import type { Locale } from './i18n'

export type ModelSource = File | Blob | string

export interface LoadModelOptions {
  /**
   * Source file name **with extension** (e.g. `"chair.obj"`, `"pack.zip"`).
   * Required when the source is a Blob or a URL without an extension,
   * unless MIME / magic bytes can identify the format.
   * The SDK does **not** default to `.glb`.
   */
  fileName?: string
}

export interface ModelViewerUIOptions {
  /** Left model-info panel @default true */
  infoPanel?: boolean
  /** Right display + lighting panel @default true */
  settingsPanel?: boolean
  /** Bottom toolbar @default true */
  toolbar?: boolean
  /** Import / replace control @default true */
  import?: boolean
  /** Export source-file control @default true */
  export?: boolean
  /** Screenshot control @default true */
  screenshot?: boolean
  /** Texture-mode switch group @default true */
  textureModes?: boolean
  /** Built-in toast notifications @default true */
  toasts?: boolean
  /** Empty-state hint over canvas @default true */
  emptyHint?: boolean
  /** Loading overlay @default true */
  loadingOverlay?: boolean
}

export interface ModelViewerTheme {
  /** Accent / primary @default #745ef5 */
  primary?: string
  /** Root text color @default #ffffff */
  text?: string
  /** Panel surface @default rgba(26,26,26,0.92) */
  panelBg?: string
  /** Viewport background CSS @default linear-gradient(...) */
  background?: string
}

export interface ModelViewerOptions {
  /** Optional model to load on mount (File | Blob | URL) */
  src?: ModelSource
  /** File name for `src` when it is a Blob / URL without extension */
  srcFileName?: string
  /**
   * Default UI configuration.
   * - `true` / omitted: show full default chrome
   * - object: start from defaults, toggle individual panels
   * - `false`: headless canvas only — drive via `instance.engine`
   */
  ui?: boolean | ModelViewerUIOptions
  theme?: ModelViewerTheme
  locale?: Locale
  defaults?: {
    lightIntensity?: number
    ambientIntensity?: number
  }
  onStateChange?: (state: ViewerState) => void
  onReady?: (state: ViewerState) => void
  onLoadError?: (error: Error) => void
  onFileRejected?: (file: File) => void
}

export interface ModelViewerInstance {
  /** Escape hatch: underlying Three.js engine */
  readonly engine: import('../core').ViewerEngine
  /** Root DOM node created by the component */
  readonly root: HTMLElement
  readonly state: ViewerState
  load(source: ModelSource, options?: LoadModelOptions): Promise<void>
  subscribe(listener: (state: ViewerState) => void): () => void
  setProjection(mode: ProjectionMode): void
  setPresetView(view: PresetView): void
  setTextureMode(mode: TextureMode): void
  setLightIntensity(value: number): void
  setAmbientIntensity(value: number): void
  setLightAngle(angle: number): void
  captureScreenshot(): Promise<Blob>
  exportModel(): Blob | null
  dispose(): void
}
