import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  CAMERA_CONFIG,
  calculateOrthographicViewSize,
  countTriangles,
  disposeObject3D,
  extractAlbedoFromMaterial,
  getModelDiagonal,
  hasValidModelDimensions,
  type PresetView,
  type ProjectionMode,
  type TextureMode
} from './utils'
import { ModelLoader, type LoadResult } from './ModelLoader'
import { applyPanorama, type AppliedPanorama, type PanoramaSource } from './panorama'
import { captureView, type CaptureFormat } from './capture'
import { computeFocusPose, type FocusPose } from './camera'

export interface ViewerState {
  progress: number
  ready: boolean
  isLoading: boolean
  hasModel: boolean
  /** 是否已启用全景图场景背景 */
  hasPanorama: boolean
  projectionMode: ProjectionMode
  presetView: PresetView
  textureMode: TextureMode
  triangleCount: number
  isWhiteModel: boolean
  favorited: boolean
  lightAngle: number
  lightIntensity: number
  ambientIntensity: number
  fileName: string
  isDragging: boolean
  materialStatus: string
  entryName: string
}

export type StateListener = (state: ViewerState) => void

export interface ViewerEngineOptions {
  /** Renderer backing store size; falls back to container size @default container */
  width?: number
  height?: number
  /** WebGL alpha (needed for transparent PNG/WebP) @default false */
  alpha?: boolean
  /** Device pixel ratio @default min(dpr, 2) */
  pixelRatio?: number
  /** Clear color; use null with alpha:true for transparent @default 0x000000 / alpha 0 */
  clearColor?: number | string | null
  clearAlpha?: number
  /** Skip window resize binding (offscreen renders) @default false */
  headless?: boolean
  /** 等距圆柱（2:1）全景图，作为场景背景与默认环境光 */
  panorama?: PanoramaSource
  /** 全景图是否同时作为 scene.environment（IBL） @default true */
  panoramaEnvironment?: boolean
}

/** 渲染一帧时传给回调的上下文 */
export interface ViewerFrameInfo {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  /** 当前活动相机（透视 / 正交） */
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera
  controls: OrbitControls
  /** 与上一帧的间隔（秒）；手动渲染时可用 delta 覆盖 */
  delta: number
  /** 累计时间（秒） */
  time: number
  /** 帧序号，从 1 开始 */
  frame: number
}

export type ViewerFrameCallback = (frame: ViewerFrameInfo) => void

/** 自定义渲染回调，例如换成 EffectComposer */
export type ViewerRenderCallback = (frame: ViewerFrameInfo) => void

export interface ViewerCameraOptions {
  /** 相机世界坐标 */
  position?: THREE.Vector3 | [number, number, number]
  /** 视线目标点（同步给控制器） */
  target?: THREE.Vector3 | [number, number, number]
  /** 透视相机垂直 FOV（度） */
  fov?: number
  /** 透视相机裁剪面 */
  near?: number
  far?: number
  /** 相机上方向 */
  up?: THREE.Vector3 | [number, number, number]
}

export interface ViewerCaptureFrameOptions {
  width?: number
  height?: number
  format?: CaptureFormat
  quality?: number
  pixelRatio?: number
  /** 是否按输出尺寸临时调整相机宽高比 @default true */
  adjustAspect?: boolean
}

export interface ViewerFocusOptions {
  /** 画面留白系数 @default 1.15 */
  padding?: number
  /** 是否用缓动过渡 @default true */
  animate?: boolean
}

export class ViewerEngine {
  private container: HTMLElement
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private perspectiveCamera!: THREE.PerspectiveCamera
  private orthographicCamera!: THREE.OrthographicCamera
  private activeCamera!: THREE.PerspectiveCamera | THREE.OrthographicCamera
  private controls!: OrbitControls
  private animationId = 0
  private engineOptions: ViewerEngineOptions
  private clearAlpha = 0

  private modelRoot: THREE.Group | null = null
  private currentBlob: Blob | null = null
  private gridHelper: THREE.GridHelper | null = null
  private panoramaApplied: AppliedPanorama | null = null
  /** 当前全景图的显示地址，供 UI 做缩略预览 */
  private panoramaUrl: string | null = null
  /** 上面地址若由引擎创建的 objectURL，退出时需要释放 */
  private panoramaBlobUrl: string | null = null
  private panoramaToken = 0
  private gridVisibleBeforePanorama: boolean | null = null
  private directionalLight!: THREE.DirectionalLight
  private ambientLight!: THREE.AmbientLight
  private hemiLight!: THREE.HemisphereLight

  private loader = new ModelLoader()
  private loadToken = 0
  private listeners = new Set<StateListener>()

  private modelAnimations: THREE.AnimationClip[] = []
  private extraObjects = new Set<THREE.Object3D>()
  private beforeRenderCallbacks = new Set<ViewerFrameCallback>()
  private afterRenderCallbacks = new Set<ViewerFrameCallback>()
  private renderCallback: ViewerRenderCallback | null = null
  private autoRenderEnabled = true
  private lastFrameTime = 0
  private frameTime = 0
  private frameCount = 0

  state: ViewerState = {
    progress: 0,
    ready: false,
    isLoading: false,
    hasModel: false,
    hasPanorama: false,
    projectionMode: 'perspective',
    presetView: 'front',
    textureMode: 'textured',
    triangleCount: 0,
    isWhiteModel: false,
    favorited: false,
    lightAngle: 0,
    lightIntensity: 2,
    ambientIntensity: 2,
    fileName: '',
    isDragging: false,
    materialStatus: '-',
    entryName: ''
  }

  constructor(container: HTMLElement, options: ViewerEngineOptions = {}) {
    this.container = container
    this.engineOptions = options
    this.initRenderer()
    this.initCameras()
    this.initLights()
    this.initControls()
    if (!options.headless) this.initEvents()
    this.animate()
    if (options.panorama) {
      void this.setPanorama(options.panorama).catch((error) => {
        console.error('[model-viewer] failed to set panorama', error)
      })
    }
  }

  private getRenderSize() {
    const w = this.engineOptions.width || this.container.clientWidth || 1
    const h = this.engineOptions.height || this.container.clientHeight || 1
    return { w, h }
  }

  private initRenderer() {
    const { w, h } = this.getRenderSize()
    const alpha = this.engineOptions.alpha ?? false
    const clearColor =
      this.engineOptions.clearColor === undefined ? 0x000000 : this.engineOptions.clearColor
    this.clearAlpha = this.engineOptions.clearAlpha ?? (alpha ? 0 : 1)

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha,
      preserveDrawingBuffer: true
    })
    this.renderer.setPixelRatio(
      this.engineOptions.pixelRatio ?? Math.min(window.devicePixelRatio || 1, 2)
    )
    this.renderer.setSize(w, h)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    if (clearColor === null) {
      this.renderer.setClearColor(0x000000, 0)
      this.clearAlpha = 0
    } else {
      this.renderer.setClearColor(clearColor as THREE.ColorRepresentation, this.clearAlpha)
    }
    this.container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
  }

  /** Resize drawing buffer (CSS size still 100% of container) */
  setRenderSize(width: number, height: number) {
    this.engineOptions.width = width
    this.engineOptions.height = height
    this.renderer.setSize(width, height)
    this.perspectiveCamera.aspect = width / height
    this.perspectiveCamera.updateProjectionMatrix()
    this.handleResize()
  }

  /**
   * Viewport clear color.
   * `transparent` → alpha clear; hex/string → opaque color.
   */
  setBackground(background: 'transparent' | number | string) {
    if (background === 'transparent') {
      this.renderer.setClearColor(0x000000, 0)
      this.clearAlpha = 0
    } else {
      this.renderer.setClearColor(background as THREE.ColorRepresentation, 1)
      this.clearAlpha = 1
    }
  }

  // ---------------------------------------------------------------------------
  // 扩展点：给导演台 / 自建 3D 应用留的口子。
  // 原则是「暴露原生 three 对象 + 钩子」，SDK 不重复封装 three 自身的能力。
  // ---------------------------------------------------------------------------

  /** 底层 WebGLRenderer（后处理、阴影、renderTarget、导出都用它） */
  getRenderer() {
    return this.renderer
  }

  /** 场景根节点（可自行加灯光、道具、辅助对象） */
  getScene() {
    return this.scene
  }

  /** 当前活动相机（透视 / 正交） */
  getCamera() {
    return this.activeCamera
  }

  /** 轨道控制器（阻尼、角度限制、开关交互） */
  getControls() {
    return this.controls
  }

  /** 画布元素（captureStream 录屏、事件绑定用） */
  getCanvas() {
    return this.renderer.domElement
  }

  /** 当前模型根节点；未加载时为 null */
  getModelRoot() {
    return this.modelRoot
  }

  /**
   * 当前模型自带的动画片段（glTF / FBX 等）。引擎不自动播放：
   * 自行 new THREE.AnimationMixer(getModelRoot())，在 onBeforeRender 里推进 mixer 即可。
   */
  getAnimations() {
    return this.modelAnimations
  }

  /** 往场景里加自定义对象（dispose 时会移除；对象自身的资源由调用方释放） */
  addObject(object: THREE.Object3D) {
    this.extraObjects.add(object)
    this.scene.add(object)
  }

  /** 移除自定义对象；传 dispose: true 会一并释放它的几何体与材质 */
  removeObject(object: THREE.Object3D, options: { dispose?: boolean } = {}) {
    this.extraObjects.delete(object)
    this.scene.remove(object)
    if (options.dispose) disposeObject3D(object)
  }

  /**
   * 开关自动渲染。关掉后渲染循环仍在跑但不画，由调用方用 renderFrame() 决定何时出帧
   * （离线渲染、序列帧导出、只要结果的批处理）。
   */
  setAutoRender(enabled: boolean) {
    if (this.autoRenderEnabled === enabled) return
    this.autoRenderEnabled = enabled
    this.lastFrameTime = performance.now()
  }

  getAutoRender() {
    return this.autoRenderEnabled
  }

  /**
   * 渲染一帧：控制器更新 → 渲染前回调 → 渲染（可被自定义管线接管）→ 渲染后回调。
   * 传 delta 可做确定性渲染（固定时间步导出序列帧）。
   */
  renderFrame(options: { delta?: number; updateControls?: boolean } = {}) {
    const info = this.createFrameInfo(options.delta)
    if (options.updateControls !== false) this.controls.update()
    this.beforeRenderCallbacks.forEach((callback) => {
      try {
        callback(info)
      } catch (error) {
        console.error('[model-viewer] onBeforeRender 回调出错', error)
      }
    })
    if (this.renderCallback) this.renderCallback(info)
    else this.renderer.render(this.scene, this.activeCamera)
    this.afterRenderCallbacks.forEach((callback) => {
      try {
        callback(info)
      } catch (error) {
        console.error('[model-viewer] onAfterRender 回调出错', error)
      }
    })
  }

  /** 每帧渲染前的回调（推进动画 / 时间轴），返回取消函数 */
  onBeforeRender(callback: ViewerFrameCallback) {
    this.beforeRenderCallbacks.add(callback)
    return () => this.beforeRenderCallbacks.delete(callback)
  }

  /** 每帧渲染后的回调（读帧、叠加后期），返回取消函数 */
  onAfterRender(callback: ViewerFrameCallback) {
    this.afterRenderCallbacks.add(callback)
    return () => this.afterRenderCallbacks.delete(callback)
  }

  /** 接管渲染调用（例如 EffectComposer）；传 null 恢复默认的 renderer.render */
  setRenderCallback(callback: ViewerRenderCallback | null) {
    this.renderCallback = callback
  }

  /** 直接摆相机：位置 / 目标点 / 焦距 / 裁剪面 */
  setCamera(options: ViewerCameraOptions) {
    const toVec = (value: THREE.Vector3 | [number, number, number] | undefined) => {
      if (!value) return null
      return Array.isArray(value)
        ? new THREE.Vector3(value[0], value[1], value[2])
        : value.clone()
    }

    const position = toVec(options.position)
    const target = toVec(options.target)
    const up = toVec(options.up)

    if (options.fov != null) this.perspectiveCamera.fov = options.fov
    if (options.near != null) this.perspectiveCamera.near = options.near
    if (options.far != null) this.perspectiveCamera.far = options.far
    if (options.fov != null || options.near != null || options.far != null) {
      this.perspectiveCamera.updateProjectionMatrix()
    }
    if (up) this.activeCamera.up.copy(up)
    if (target) this.controls.target.copy(target)
    if (position) this.activeCamera.position.copy(position)
    if (position || target) {
      this.activeCamera.lookAt(this.controls.target)
      this.controls.update()
    }
  }

  /**
   * 把相机聚焦到某个对象（选中后按 F 那种）。
   * 取景算法在 core/camera.ts 的 computeFocusPose 里，自建场景可直接复用。
   */
  focusObject(object: THREE.Object3D, options: ViewerFocusOptions = {}): FocusPose | null {
    const aspect = this.getAspect()
    const pose = computeFocusPose(this.activeCamera, object, {
      padding: options.padding,
      aspect
    })
    if (!pose) return null

    this.controls.minDistance = Math.min(this.controls.minDistance, pose.distance * 0.05)
    this.controls.maxDistance = Math.max(this.controls.maxDistance, pose.distance * 6)

    if (this.activeCamera === this.orthographicCamera && pose.orthoViewSize > 0) {
      this.orthographicCamera.left = (-pose.orthoViewSize * aspect) / 2
      this.orthographicCamera.right = (pose.orthoViewSize * aspect) / 2
      this.orthographicCamera.top = pose.orthoViewSize / 2
      this.orthographicCamera.bottom = -pose.orthoViewSize / 2
      this.orthographicCamera.updateProjectionMatrix()
    }

    if (options.animate === false) {
      this.activeCamera.position.copy(pose.position)
      this.activeCamera.lookAt(pose.target)
      this.controls.target.copy(pose.target)
      this.controls.update()
    } else {
      this.animateCameraTo(pose.position, pose.target, 0.5)
    }
    this.patch({ presetView: 'none' })
    return pose
  }

  /** 开关鼠标 / 触摸交互（切到关键帧编辑、框选时常用） */
  setControlsEnabled(enabled: boolean) {
    this.controls.enabled = enabled
  }

  /**
   * 出帧：按目标尺寸渲染当前画面并返回 Blob（不改页面布局、不裁切）。
   * 与 captureScreenshot 的区别：不做 1:1 裁切、不开关网格，可指定尺寸 / 像素比，
   * 并且会走当前渲染管线（帧回调与 setRenderCallback 都生效）。多机位批量出图用它。
   */
  async captureFrame(options: ViewerCaptureFrameOptions = {}): Promise<Blob> {
    return captureView(this.renderer, this.scene, this.activeCamera, {
      ...options,
      render: () => this.renderFrame({ updateControls: false }),
      // 恢复显示态：只重绘，不再触发帧回调，避免动画 / 时间轴被多推进一帧
      restoreRender: () => {
        if (this.renderCallback) {
          this.renderCallback({
            renderer: this.renderer,
            scene: this.scene,
            camera: this.activeCamera,
            controls: this.controls,
            delta: 0,
            time: this.frameTime,
            frame: this.frameCount
          })
        } else {
          this.renderer.render(this.scene, this.activeCamera)
        }
      }
    })
  }

  /** 是否已启用全景图背景 */
  get hasPanorama() {
    return this.panoramaApplied !== null
  }

  /**
   * 用等距圆柱（2:1）全景图作为场景背景，例如 720° 全景图。
   * 传 null 恢复原来的纯色 / 透明底色。
   */
  async setPanorama(
    source: PanoramaSource | null,
    options: { environment?: boolean; hideGrid?: boolean } = {}
  ): Promise<void> {
    const token = ++this.panoramaToken
    if (source === null || source === undefined) {
      this.disposePanorama()
      return
    }

    const isBlob = typeof Blob !== 'undefined' && source instanceof Blob

    // 先应用新图：失败时抛错并保留当前全景，不会先黑一下再报错
    const applied = await applyPanorama(this.scene, source, {
      environment: options.environment ?? this.engineOptions.panoramaEnvironment ?? true
    })
    // 期间又被替换 / 清空 / dispose 过，丢弃这次结果
    if (token !== this.panoramaToken) {
      applied.dispose()
      return
    }

    // 预览地址：字符串直接用；Blob 由引擎建 objectURL 并持有；Texture 尽量取 image.src
    let previewUrl: string | null
    let blobUrl: string | null = null
    if (typeof source === 'string') {
      previewUrl = source
    } else if (isBlob) {
      previewUrl = URL.createObjectURL(source)
      blobUrl = previewUrl
    } else {
      previewUrl = ((source as THREE.Texture).image as { src?: string } | undefined)?.src ?? null
    }

    const previousApplied = this.panoramaApplied
    const previousBlobUrl = this.panoramaBlobUrl
    this.panoramaApplied = applied
    this.panoramaUrl = previewUrl
    this.panoramaBlobUrl = blobUrl
    // handle 只会还原仍属于它的 scene 状态，替换时不会误清新图
    if (previousApplied) previousApplied.dispose()
    if (previousBlobUrl) URL.revokeObjectURL(previousBlobUrl)

    if (options.hideGrid ?? true) {
      if (this.gridVisibleBeforePanorama === null) {
        this.gridVisibleBeforePanorama = this.gridHelper?.visible ?? true
      }
      this.setGridVisible(false)
    }
    this.patch({ hasPanorama: true })
  }

  /** 当前全景图的显示地址（URL / 引擎持有的 objectURL / Texture 的 image.src） */
  get panoramaSourceUrl() {
    return this.panoramaUrl
  }

  /** 全景是否接管了网格显隐（开全景且要求隐藏网格） */
  private get panoramaHidesGrid() {
    return this.panoramaApplied !== null && this.gridVisibleBeforePanorama !== null
  }

  /** 关闭全景图背景，恢复底色与网格原显隐状态 */
  clearPanorama() {
    this.panoramaToken += 1
    this.disposePanorama()
  }

  private disposePanorama() {
    const hadPanorama = this.panoramaApplied !== null
    // handle 会把 scene 的背景 / 环境还原成本次应用之前的状态
    this.panoramaApplied?.dispose()
    this.panoramaApplied = null
    if (this.panoramaBlobUrl) URL.revokeObjectURL(this.panoramaBlobUrl)
    this.panoramaBlobUrl = null
    this.panoramaUrl = null
    if (this.gridVisibleBeforePanorama !== null) {
      this.setGridVisible(this.gridVisibleBeforePanorama)
      this.gridVisibleBeforePanorama = null
    }
    if (hadPanorama) this.patch({ hasPanorama: false })
  }

  private initCameras() {
    const aspect = this.getAspect()
    this.perspectiveCamera = new THREE.PerspectiveCamera(
      CAMERA_CONFIG.PERSPECTIVE_FOV,
      aspect,
      CAMERA_CONFIG.NEAR_CLIP,
      CAMERA_CONFIG.FAR_CLIP
    )
    this.perspectiveCamera.position.set(0, 0, 5)

    this.orthographicCamera = new THREE.OrthographicCamera(
      -5 * aspect,
      5 * aspect,
      5,
      -5,
      CAMERA_CONFIG.ORTHO_NEAR,
      CAMERA_CONFIG.ORTHO_FAR
    )
    this.orthographicCamera.position.copy(this.perspectiveCamera.position)
    this.activeCamera = this.perspectiveCamera
  }

  private initLights() {
    this.hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 0.6)
    this.hemiLight.position.set(0, 20, 0)
    this.scene.add(this.hemiLight)

    this.directionalLight = new THREE.DirectionalLight(0xffffff, this.state.lightIntensity)
    this.directionalLight.name = 'customDirectionalLight'
    this.updateLightDirection()
    this.scene.add(this.directionalLight)
    this.scene.add(this.directionalLight.target)

    this.ambientLight = new THREE.AmbientLight(0xffffff, this.state.ambientIntensity)
    this.ambientLight.name = 'customAmbientLight'
    this.scene.add(this.ambientLight)
  }

  private initControls() {
    this.controls = new OrbitControls(this.activeCamera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.screenSpacePanning = true
    this.controls.zoomSpeed = 0.5
    this.controls.rotateSpeed = 0.9
    this.controls.panSpeed = 0.8
    this.controls.addEventListener('start', () => {
      this.patch({ presetView: 'none' })
    })
  }

  private initEvents() {
    window.addEventListener('resize', this.handleResize)
  }

  private handleResize = () => {
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w === 0 || h === 0) return
    this.renderer.setSize(w, h)
    const aspect = w / h
    this.perspectiveCamera.aspect = aspect
    this.perspectiveCamera.updateProjectionMatrix()

    const radius = this.controls.target.distanceTo(this.activeCamera.position)
    const viewSize = calculateOrthographicViewSize(Math.max(radius, 0.001))
    this.orthographicCamera.left = (-viewSize * aspect) / 2
    this.orthographicCamera.right = (viewSize * aspect) / 2
    this.orthographicCamera.top = viewSize / 2
    this.orthographicCamera.bottom = -viewSize / 2
    this.orthographicCamera.updateProjectionMatrix()
  }

  private getAspect() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    return w / h
  }

  private createFrameInfo(deltaOverride?: number): ViewerFrameInfo {
    const now = performance.now()
    const delta =
      deltaOverride ?? (this.lastFrameTime ? Math.min((now - this.lastFrameTime) / 1000, 0.1) : 0)
    this.lastFrameTime = now
    this.frameTime += delta
    this.frameCount += 1
    return {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.activeCamera,
      controls: this.controls,
      delta,
      time: this.frameTime,
      frame: this.frameCount
    }
  }

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate)
    if (!this.autoRenderEnabled) {
      // 暂停渲染时只推进时间基准，恢复后 delta 不会跳变
      this.lastFrameTime = performance.now()
      return
    }
    this.renderFrame()
  }

  subscribe(listener: StateListener) {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private patch(partial: Partial<ViewerState>) {
    this.state = { ...this.state, ...partial }
    this.listeners.forEach((fn) => fn(this.state))
  }

  private clearModel() {
    if (this.modelRoot) {
      this.scene.remove(this.modelRoot)
      disposeObject3D(this.modelRoot)
      this.modelRoot = null
    }
    this.removeGrid()
    this.currentBlob = null
    this.modelAnimations = []
  }

  async loadFromFile(file: File) {
    const token = ++this.loadToken
    // 替换时保留 hasModel，UI 侧栏不闪断；同时进入 loading
    this.patch({
      progress: 0,
      ready: false,
      isLoading: true,
      triangleCount: 0,
      presetView: 'front',
      projectionMode: 'perspective',
      textureMode: 'textured'
    })
    this.clearModel()
    // 替换后先回到默认灯光/相机曝光
    this.applyDefaultLighting()

    try {
      const result: LoadResult = await this.loader.loadFromFile(file, (p) => {
        if (token !== this.loadToken) return
        this.patch({ progress: Math.min(p, 99) })
      })
      if (token !== this.loadToken) {
        disposeObject3D(result.object)
        return
      }
      this.attachModel(result)
    } catch (error) {
      if (token !== this.loadToken) return
      console.error(error)
      this.patch({ progress: 0, ready: false, isLoading: false })
      throw error
    }
  }

  private applyDefaultLighting() {
    this.state.lightAngle = 0
    this.state.lightIntensity = 2
    this.state.ambientIntensity = 2
    this.directionalLight.intensity = 2
    this.ambientLight.intensity = 2
    this.updateLightDirection()
    this.renderer.toneMappingExposure = 1
    this.patch({
      lightAngle: 0,
      lightIntensity: 2,
      ambientIntensity: 2
    })
  }

  private attachModel(result: LoadResult) {
    this.modelRoot = result.object
    this.modelAnimations = result.animations ?? []
    this.currentBlob = result.fileBlob
    this.scene.add(this.modelRoot)

    const diagonal = getModelDiagonal(this.modelRoot) || 1
    const distance = diagonal * 1.5
    this.setCameraDistance(distance)
    this.addGrid(diagonal)

    const triangleCount = countTriangles(this.modelRoot)
    const hasTextures = this.detectHasTextures(this.modelRoot)
    const report = result.materialReport
    const baseStatus =
      report.texturesMissing > 0
        ? `部分缺失（找到 ${report.texturesFound}）`
        : report.texturesFound > 0
          ? `完整（${report.texturesFound}）`
          : hasTextures
            ? 'Loader 内置'
            : '默认材质'
    const materialStatus = result.experimental
      ? `实验性展示 · ${baseStatus}`
      : baseStatus

    this.patch({
      progress: 100,
      ready: true,
      isLoading: false,
      hasModel: true,
      triangleCount,
      fileName: result.fileName,
      entryName: result.entryName,
      materialStatus,
      isWhiteModel: !hasTextures,
      textureMode: hasTextures ? 'textured' : 'clay',
      presetView: 'front',
      projectionMode: 'perspective'
    })

    this.applyDefaultLighting()

    if (hasTextures) {
      this.applyTextureMode('textured')
    } else {
      this.applyTextureMode('clay')
    }
  }

  private detectHasTextures(root: THREE.Object3D): boolean {
    let found = false
    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh || found) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const mat of mats) {
        if (!mat) continue
        const anyMat = mat as unknown as Record<string, unknown>
        if (anyMat.map || anyMat.emissiveMap || anyMat.baseColorMap) {
          found = true
          return
        }
      }
    })
    return found
  }

  private setCameraDistance(distance: number) {
    const position = { x: 0, y: 0, z: distance }
    this.perspectiveCamera.position.set(position.x, position.y, position.z)
    this.perspectiveCamera.lookAt(0, 0, 0)

    const viewSize = calculateOrthographicViewSize(distance)
    const aspect = this.getAspect()
    this.orthographicCamera.left = (-viewSize * aspect) / 2
    this.orthographicCamera.right = (viewSize * aspect) / 2
    this.orthographicCamera.top = viewSize / 2
    this.orthographicCamera.bottom = -viewSize / 2
    this.orthographicCamera.position.copy(this.perspectiveCamera.position)
    this.orthographicCamera.updateProjectionMatrix()

    this.controls.object = this.perspectiveCamera
    this.controls.target.set(0, 0, 0)
    this.controls.minDistance = Math.max(distance * 0.05, 0.01)
    this.controls.maxDistance = distance * 8
    this.controls.update()
  }

  private addGrid(diagonal: number) {
    this.removeGrid()
    if (!this.modelRoot) return
    const box = new THREE.Box3().setFromObject(this.modelRoot)
    const size = new THREE.Vector3()
    box.getSize(size)
    const maxDimension = Math.max(size.x, size.y, size.z)
    this.gridHelper = new THREE.GridHelper(maxDimension * 150, 200, 0x4e4e4e, 0x4e4e4e)
    this.gridHelper.name = 'groundGrid'
    this.gridHelper.position.y = box.min.y
    this.gridHelper.raycast = () => {}
    // 全景场景下网格通常与画面冲突，跟随当前全景状态
    this.gridHelper.visible = !this.panoramaHidesGrid
    this.scene.add(this.gridHelper)
    void diagonal
  }

  private removeGrid() {
    if (!this.gridHelper) return
    this.scene.remove(this.gridHelper)
    this.gridHelper.geometry.dispose()
    ;(this.gridHelper.material as THREE.Material).dispose()
    this.gridHelper = null
  }

  setGridVisible(visible: boolean) {
    if (this.gridHelper) this.gridHelper.visible = visible
  }

  toggleProjectionMode(type: ProjectionMode) {
    if (this.state.projectionMode === type) return
    const currentPosition = this.activeCamera.position.clone()
    const target = this.controls.target.clone()
    const distance = currentPosition.distanceTo(target)

    this.state.projectionMode = type

    if (type === 'orthographic') {
      this.setGridVisible(false)
      this.orthographicCamera.position.copy(currentPosition)
      const viewSize = calculateOrthographicViewSize(distance)
      const aspect = this.getAspect()
      this.orthographicCamera.left = (-viewSize * aspect) / 2
      this.orthographicCamera.right = (viewSize * aspect) / 2
      this.orthographicCamera.top = viewSize / 2
      this.orthographicCamera.bottom = -viewSize / 2
      this.orthographicCamera.lookAt(target)
      this.orthographicCamera.updateProjectionMatrix()
      this.activeCamera = this.orthographicCamera
    } else {
      this.setGridVisible(!this.panoramaHidesGrid)
      this.perspectiveCamera.position.copy(currentPosition)
      this.perspectiveCamera.lookAt(target)
      this.perspectiveCamera.aspect = this.getAspect()
      this.perspectiveCamera.updateProjectionMatrix()
      this.activeCamera = this.perspectiveCamera
    }

    this.controls.object = this.activeCamera
    this.controls.target.copy(target)
    this.controls.update()
    this.patch({ projectionMode: type })
  }

  setPresetView(view: PresetView, options: { animate?: boolean } = {}) {
    if (!this.modelRoot) return
    const animate = options.animate !== false
    const distance = this.activeCamera.position.distanceTo(this.controls.target)
    const target = this.controls.target.clone()
    let position = new THREE.Vector3()

    switch (view) {
      case 'front':
        position.set(0, 0, distance)
        break
      case 'back':
        position.set(0, 0, -distance)
        break
      case 'side':
        position.set(distance, 0, 0)
        break
      case 'top':
        position.set(0, distance, 0.001)
        break
      default:
        return
    }

    position.add(target)
    if (animate) {
      this.animateCameraTo(position, target, 0.55)
    } else {
      this.activeCamera.position.copy(position)
      this.activeCamera.lookAt(target)
      this.controls.target.copy(target)
      this.controls.update()
    }
    this.patch({ presetView: view })
  }

  private cameraTweenId = 0

  private animateCameraTo(
    endPosition: THREE.Vector3,
    endTarget: THREE.Vector3,
    durationSec = 0.5
  ) {
    const tweenId = ++this.cameraTweenId
    const startTarget = this.controls.target.clone()
    const startOffset = this.activeCamera.position.clone().sub(startTarget)
    const endOffset = endPosition.clone().sub(endTarget)

    const startSph = new THREE.Spherical().setFromVector3(startOffset)
    const endSph = new THREE.Spherical().setFromVector3(endOffset)

    // 取最短角路径，避免绕远
    const shortestAngle = (from: number, to: number) => {
      let d = to - from
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      return d
    }
    const dTheta = shortestAngle(startSph.theta, endSph.theta)
    const dPhi = shortestAngle(startSph.phi, endSph.phi)
    const dRadius = endSph.radius - startSph.radius

    const start = performance.now()
    const durationMs = Math.max(durationSec, 0.01) * 1000
    const tmpOffset = new THREE.Vector3()
    const tmpSph = new THREE.Spherical()

    const cancelOnUser = () => {
      this.cameraTweenId += 1
    }
    this.controls.addEventListener('start', cancelOnUser)
    const cleanup = () => {
      this.controls.removeEventListener('start', cancelOnUser)
    }

    const step = () => {
      if (tweenId !== this.cameraTweenId) {
        cleanup()
        return
      }
      const t = Math.min(1, (performance.now() - start) / durationMs)
      const e = 1 - Math.pow(1 - t, 3)

      // 绕目标点球面插值（旋转），而不是直线穿模
      tmpSph.set(
        startSph.radius + dRadius * e,
        THREE.MathUtils.clamp(startSph.phi + dPhi * e, 1e-4, Math.PI - 1e-4),
        startSph.theta + dTheta * e
      )
      tmpOffset.setFromSpherical(tmpSph)

      this.controls.target.lerpVectors(startTarget, endTarget, e)
      this.activeCamera.position.copy(this.controls.target).add(tmpOffset)
      this.activeCamera.lookAt(this.controls.target)
      this.controls.update()

      if (t < 1) {
        requestAnimationFrame(step)
      } else {
        cleanup()
      }
    }

    requestAnimationFrame(step)
  }

  applyTextureMode(mode: TextureMode) {
    if (!this.modelRoot) return
    if (this.state.textureMode === mode && this.state.ready) {
      // allow re-apply when called from init
    }
    this.patch({ textureMode: mode })

    if (mode === 'textured') {
      this.restoreOriginalMaterial()
      this.renderer.toneMappingExposure = 1
    } else if (mode === 'clay') {
      this.showWhiteModel()
      this.renderer.toneMappingExposure = 0.55
    } else if (mode === 'normal') {
      this.switchToNormalMapDisplay()
      this.renderer.toneMappingExposure = 1
    } else if (mode === 'albedo') {
      this.switchToAlbedoMap()
      this.renderer.toneMappingExposure = 0.9
    }
  }

  private saveOriginalMaterials(root: THREE.Object3D) {
    root.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      if (!mesh.userData.originalMaterial) {
        mesh.userData.originalMaterial = mesh.material
      }
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals()
      }
    })
  }

  private restoreOriginalMaterial() {
    if (!this.modelRoot) return
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.isMesh && mesh.userData.originalMaterial) {
        mesh.material = mesh.userData.originalMaterial
      }
    })
  }

  private showWhiteModel() {
    if (!this.modelRoot) return
    this.saveOriginalMaterials(this.modelRoot)
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals()
      }
      const white = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
        flatShading: true
      })
      mesh.material = white
    })
  }

  private switchToNormalMapDisplay() {
    if (!this.modelRoot) return
    this.saveOriginalMaterials(this.modelRoot)
    const normalMaterial = new THREE.MeshNormalMaterial({
      side: THREE.DoubleSide,
      flatShading: true
    })
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      if (mesh.geometry && !mesh.geometry.attributes.normal) {
        mesh.geometry.computeVertexNormals()
      }
      mesh.material = normalMaterial
    })
  }

  private switchToAlbedoMap() {
    if (!this.modelRoot) return
    this.saveOriginalMaterials(this.modelRoot)
    this.modelRoot.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      const original = mesh.userData.originalMaterial
      const materials = Array.isArray(original) ? original : [original]
      const newMaterials = materials.map((mat: THREE.Material) => {
        if (!mat) {
          return new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })
        }
        const anyMat = mat as unknown as Record<string, unknown>
        if (anyMat._albedoMaterial) return anyMat._albedoMaterial as THREE.Material
        const { texture, color } = extractAlbedoFromMaterial(mat)
        const mapTexture = texture as (THREE.Texture & { transparent?: boolean; alphaTest?: number }) | null
        const albedoMaterial = new THREE.MeshBasicMaterial({
          map: texture,
          color,
          side: THREE.DoubleSide,
          transparent: mapTexture ? Boolean(mapTexture.transparent) : false,
          alphaTest: mapTexture?.alphaTest
        })
        anyMat._albedoMaterial = albedoMaterial
        return albedoMaterial
      })
      mesh.material = Array.isArray(original) ? newMaterials : newMaterials[0]
    })
  }

  setLightAngle(angle: number) {
    this.state.lightAngle = ((angle % 360) + 360) % 360
    this.updateLightDirection()
    this.patch({ lightAngle: this.state.lightAngle })
  }

  private updateLightDirection() {
    const angleRad = (this.state.lightAngle - 90) * (Math.PI / 180)
    const x = Math.cos(angleRad)
    const z = Math.sin(angleRad)
    const y = 0.5
    this.directionalLight.position.set(x * 10, y * 10, z * 10)
    this.directionalLight.target.position.set(0, 0, 0)
    this.directionalLight.target.updateMatrixWorld()
  }

  setLightIntensity(value: number) {
    this.state.lightIntensity = value
    this.directionalLight.intensity = value
    this.patch({ lightIntensity: value })
  }

  setAmbientIntensity(value: number) {
    this.state.ambientIntensity = value
    this.ambientLight.intensity = value
    if (this.modelRoot) {
      this.modelRoot.traverse((child) => {
        const mesh = child as THREE.Mesh
        if (!mesh.isMesh) return
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        mats.forEach((mat) => {
          const anyMat = mat as unknown as Record<string, unknown>
          if (anyMat.emissive && (anyMat.emissive as THREE.Color).getHex?.() !== 0x000000) {
            const mapped = 1 + (value / 20) * 19
            anyMat.emissiveIntensity = mapped
            mat.needsUpdate = true
          }
        })
      })
    }
    this.patch({ ambientIntensity: value })
  }

  setDragging(dragging: boolean) {
    this.patch({ isDragging: dragging })
  }

  toggleFavorite() {
    this.patch({ favorited: !this.state.favorited })
  }

  exportCurrentModel(): Blob | null {
    return this.currentBlob
  }

  hasValidModel() {
    return hasValidModelDimensions(this.modelRoot)
  }

  async captureScreenshot(): Promise<Blob> {
    return this.renderToBlob({ square: true, format: 'png' })
  }

  /**
   * Render current scene to an image blob.
   * `square: true` center-crops to 1:1 on the long side (product-shot style).
   */
  async renderToBlob(
    options: {
      format?: 'png' | 'jpeg' | 'webp'
      quality?: number
      square?: boolean
      showGrid?: boolean
    } = {}
  ): Promise<Blob> {
    const format = options.format ?? 'png'
    const quality = options.quality ?? 0.92
    const mime =
      format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png'

    const previousGrid = this.gridHelper?.visible ?? false
    const showGrid = options.showGrid ?? previousGrid
    let restored = false
    const restoreGrid = () => {
      if (restored) return
      restored = true
      this.setGridVisible(previousGrid)
      this.renderFrame({ updateControls: false })
    }

    try {
      this.setGridVisible(showGrid)
      this.renderFrame({ updateControls: false })

      const canvas = this.renderer.domElement
      const originalBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (blob) => {
            if (blob) resolve(blob)
            else reject(new Error('截图失败'))
          },
          mime,
          format === 'png' ? 1 : quality
        )
      })

      if (!options.square) {
        restoreGrid()
        return originalBlob
      }

      restoreGrid()

      // 1:1 square crop, transparent / bg padding
      const img = await createImageBitmap(originalBlob)
      const longSide = Math.max(img.width, img.height)
      const out = document.createElement('canvas')
      out.width = longSide
      out.height = longSide
      const ctx = out.getContext('2d')
      if (!ctx) throw new Error('无法创建 canvas 上下文')
      if (mime === 'image/jpeg') {
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, longSide, longSide)
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      const x = (longSide - img.width) / 2
      const y = (longSide - img.height) / 2
      ctx.drawImage(img, x, y, img.width, img.height)
      img.close()

      return await new Promise<Blob>((resolve, reject) => {
        out.toBlob(
          (blob) => {
            if (blob) resolve(blob)
            else reject(new Error('图片转换失败'))
          },
          mime,
          format === 'png' ? 1 : quality
        )
      })
    } finally {
      restoreGrid()
    }
  }

  dispose() {
    cancelAnimationFrame(this.animationId)
    window.removeEventListener('resize', this.handleResize)
    this.clearModel()
    // 让仍在加载中的全景作废，并释放贴图（外部传入的 Texture 由调用方负责）
    this.panoramaToken += 1
    this.disposePanorama()
    this.controls.dispose()
    this.loader.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement)
    }
    this.beforeRenderCallbacks.clear()
    this.afterRenderCallbacks.clear()
    this.renderCallback = null
    this.extraObjects.forEach((object) => this.scene.remove(object))
    this.extraObjects.clear()
    this.modelAnimations = []
    this.listeners.clear()
  }
}
