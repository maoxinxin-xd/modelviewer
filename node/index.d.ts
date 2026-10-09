/** Pure Node entry point. No browser or GPU initialization occurs in the host process. */
export type ModelSource = string | { bytes: Uint8Array; fileName: string; resources?: Record<string, Uint8Array> };
export type PresetView = 'front' | 'back' | 'side' | 'top' | 'none';
export interface Warning { code: string; message: string; affectsFidelity: boolean; resource?: string; details?: unknown }
export interface CommonOptions {
  timeout?: number;
  resourceDirs?: string[];
  entry?: string;
  strict?: boolean;
  allowNetwork?: boolean;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}
export interface OptimizationOptions {
  simplifyRatio?: number;
  simplifyError?: number;
  simplifyLockBorder?: boolean;
  simplify?: boolean;
  instance?: boolean;
  palette?: boolean;
  flatten?: boolean;
  join?: boolean;
  weld?: boolean;
  textureSize?: number;
  textureCompress?: 'auto' | 'webp' | 'avif' | false | 'false';
  compress?: 'meshopt' | 'draco' | false | 'false';
}
export interface ConvertOptions extends CommonOptions, OptimizationOptions {
  optimize?: boolean;
  center?: boolean;
  onlyVisible?: boolean;
  animations?: boolean;
}
export interface RenderOptions extends CommonOptions {
  width?: number;
  height?: number;
  format?: 'png' | 'jpeg' | 'webp';
  quality?: number;
  view?: PresetView;
  views?: PresetView[];
  projection?: 'perspective' | 'orthographic';
  textureMode?: 'textured' | 'clay' | 'normal' | 'albedo';
  background?: string;
  showGrid?: boolean;
  lightIntensity?: number;
  ambientIntensity?: number;
  lightAngle?: number;
}
export interface Artifact {
  name: string;
  format: string;
  bytes: Uint8Array;
  view?: PresetView;
  width?: number;
  height?: number;
}
/** Wall-clock milliseconds. Overlapping summary metrics must not be added together. */
export interface ModelTimings {
  unit: 'ms';
  loadMs: number | null;
  exportMs: number | null;
  optimizationMs: number | null;
  simplifyMs: number | null;
  renderMs: number | null;
  /** Loading/conversion plus export/validation, excluding optimization. Not a separate benchmark. */
  conversionMs: number | null;
  convertAndOptimizeMs: number | null;
  workerMs: number | null;
  queueMs: number;
  executionMs: number;
  totalMs: number;
  outputWriteMs?: number;
  cliTotalMs?: number;
}
export interface ModelResult {
  schemaVersion: 1;
  ok: true;
  command: 'info' | 'render' | 'convert' | 'optimize';
  input: string;
  entry: string;
  outputs: Artifact[];
  data: Record<string, unknown> & { timings: ModelTimings };
  warnings: Warning[];
  error: null;
}
export interface ModelProcessor {
  inspectModel(source: ModelSource, options?: CommonOptions): Promise<ModelResult>;
  renderModelImages(source: ModelSource, options?: RenderOptions): Promise<ModelResult>;
  convertModelToGlb(source: ModelSource, options?: ConvertOptions): Promise<ModelResult>;
  optimizeModel(source: ModelSource, options?: CommonOptions & OptimizationOptions): Promise<ModelResult>;
  /** Reject queued tasks and terminate running child processes. */
  close(): void;
}
export function createModelProcessor(options?: { concurrency?: number; maxQueue?: number }): ModelProcessor;
export function inspectModel(source: ModelSource, options?: CommonOptions): Promise<ModelResult>;
export function renderModelImages(source: ModelSource, options?: RenderOptions): Promise<ModelResult>;
export function convertModelToGlb(source: ModelSource, options?: ConvertOptions): Promise<ModelResult>;
export function optimizeModel(source: ModelSource, options?: CommonOptions & OptimizationOptions): Promise<ModelResult>;
