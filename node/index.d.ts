/** Pure Node entry point. No browser or GPU initialization occurs in the host process. */
export type ModelSource = string | { bytes: Uint8Array; fileName: string; resources?: Record<string, Uint8Array> };
/** side is a compatibility alias for right. */
export type PresetView =
  | 'front' | 'back' | 'left' | 'right' | 'side' | 'top' | 'bottom' | 'none';
export interface Warning { code: string; message: string; affectsFidelity: boolean; resource?: string; details?: unknown }
export interface CommonOptions {
  /** Native FBX2glTF by default; three retains the legacy loader. */
  fbxBackend?: 'native' | 'three';
  /** Explicit executable path. Never searched in PATH or replaced with a fallback. */
  fbxBinary?: string;
  timeout?: number;
  resourceDirs?: string[];
  entry?: string;
  entryFormats?: string[];
  entryDepth?: number;
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
  textureCompress?: 'auto' | 'webp' | 'avif' | 'none' | false | 'false';
  compress?: 'meshopt' | 'draco' | 'quantize' | 'none' | false | 'false';
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
  device?: 'auto' | 'software' | 'hardware';
  /** Camera framing padding; defaults to 0.1. */
  padding?: number;
  view?: PresetView;
  views?: PresetView[];
  projection?: 'perspective' | 'orthographic';
  textureMode?: 'textured' | 'white' | 'clay' | 'normal' | 'albedo';
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
  nativeConversionMs?: number | null;
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
  close(): Promise<void>;
}
export function createModelProcessor(options?: { concurrency?: number; maxQueue?: number }): ModelProcessor;
export function inspectModel(source: ModelSource, options?: CommonOptions): Promise<ModelResult>;
export function renderModelImages(source: ModelSource, options?: RenderOptions): Promise<ModelResult>;
export function convertModelToGlb(source: ModelSource, options?: ConvertOptions): Promise<ModelResult>;
export function optimizeModel(source: ModelSource, options?: CommonOptions & OptimizationOptions): Promise<ModelResult>;

/** Binary resolution does not import the vendor wrapper or search PATH. */
export interface FbxBinaryMetadata {
  backend: 'fbx2gltf';
  binaryPath: string;
  binarySource: 'bundled' | 'override';
  packageVersion: string | null;
  platform: string;
  arch: string;
  binaryArch: 'x64' | null;
  requiresRosetta: boolean | null;
  compatibility: 'native' | 'rosetta' | 'unknown';
}
export interface FbxProbeResult extends Partial<FbxBinaryMetadata> {
  backend: 'fbx2gltf';
  ok: boolean;
  version: string | null;
  repairHints: string[];
  error: { code: string; message: string } | null;
}
export function resolveFbxBinary(
  options?: Pick<CommonOptions, 'fbxBinary'>,
  runtime?: { platform?: string; arch?: string },
): Promise<FbxBinaryMetadata>;
export function probeFbxBinary(
  options?: Pick<CommonOptions, 'fbxBinary' | 'signal'> & { isolated?: boolean },
  runtime?: { platform?: string; arch?: string },
): Promise<FbxProbeResult>;
