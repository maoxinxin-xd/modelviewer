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

export interface ViewerState {
  progress: number
  ready: boolean
  isLoading: boolean
  hasModel: boolean
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
}

type StateListener = (state: ViewerState) => void

export class ViewerEngine {
  private container: HTMLElement
  private renderer!: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private perspectiveCamera!: THREE.PerspectiveCamera
  private orthographicCamera!: THREE.OrthographicCamera
  private activeCamera!: THREE.PerspectiveCamera | THREE.OrthographicCamera
  private controls!: OrbitControls
  private animationId = 0

  private modelRoot: THREE.Group | null = null
  private currentBlob: Blob | null = null
  private gridHelper: THREE.GridHelper | null = null
  private directionalLight!: THREE.DirectionalLight
  private ambientLight!: THREE.AmbientLight
  private hemiLight!: THREE.HemisphereLight

  private loader = new ModelLoader()
  private loadToken = 0
  private listeners = new Set<StateListener>()

  state: ViewerState = {
    progress: 0,
    ready: false,
    isLoading: false,
    hasModel: false,
    projectionMode: 'perspective',
    presetView: 'front',
    textureMode: '贴图',
    triangleCount: 0,
    isWhiteModel: false,
    favorited: false,
    lightAngle: 0,
    lightIntensity: 2,
    ambientIntensity: 2,
    fileName: '',
    isDragging: false
  }

  constructor(container: HTMLElement) {
    this.container = container
    this.initRenderer()
    this.initCameras()
    this.initLights()
    this.initControls()
    this.initEvents()
    this.animate()
  }

  private initRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1
    this.renderer.setClearColor(0x000000, 0)
    this.container.appendChild(this.renderer.domElement)
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
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

  private animate = () => {
    this.animationId = requestAnimationFrame(this.animate)
    this.controls.update()
    this.renderer.render(this.scene, this.activeCamera)
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
      textureMode: '贴图'
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
    this.currentBlob = result.fileBlob
    this.scene.add(this.modelRoot)

    const diagonal = getModelDiagonal(this.modelRoot) || 1
    const distance = diagonal * 1.5
    this.setCameraDistance(distance)
    this.addGrid(diagonal)

    const triangleCount = countTriangles(this.modelRoot)
    const hasTextures = this.detectHasTextures(this.modelRoot)
    this.patch({
      progress: 100,
      ready: true,
      isLoading: false,
      hasModel: true,
      triangleCount,
      fileName: result.fileName,
      isWhiteModel: !hasTextures,
      textureMode: hasTextures ? '贴图' : '白膜',
      presetView: 'front',
      projectionMode: 'perspective'
    })

    this.applyDefaultLighting()

    if (hasTextures) {
      this.applyTextureMode('贴图')
    } else {
      this.applyTextureMode('白膜')
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
      this.setGridVisible(true)
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

  setPresetView(view: PresetView) {
    if (!this.modelRoot) return
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
    this.animateCameraTo(position, target, 0.55)
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

    if (mode === '贴图') {
      this.restoreOriginalMaterial()
      this.renderer.toneMappingExposure = 1
    } else if (mode === '白膜') {
      this.showWhiteModel()
      this.renderer.toneMappingExposure = 0.55
    } else if (mode === '法线') {
      this.switchToNormalMapDisplay()
      this.renderer.toneMappingExposure = 1
    } else if (mode === '反照') {
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
    const previousGrid = this.gridHelper?.visible ?? false
    this.setGridVisible(false)
    this.renderer.render(this.scene, this.activeCamera)

    const canvas = this.renderer.domElement
    const originalBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('截图失败'))
      }, 'image/png', 1)
    })

    this.setGridVisible(previousGrid)
    this.renderer.render(this.scene, this.activeCamera)

    // 1:1 square crop, transparent padding
    const img = await createImageBitmap(originalBlob)
    const longSide = Math.max(img.width, img.height)
    const out = document.createElement('canvas')
    out.width = longSide
    out.height = longSide
    const ctx = out.getContext('2d')
    if (!ctx) throw new Error('无法创建 canvas 上下文')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    const x = (longSide - img.width) / 2
    const y = (longSide - img.height) / 2
    ctx.drawImage(img, x, y, img.width, img.height)
    img.close()

    return await new Promise<Blob>((resolve, reject) => {
      out.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('图片转换失败'))
      }, 'image/png', 1)
    })
  }

  dispose() {
    cancelAnimationFrame(this.animationId)
    window.removeEventListener('resize', this.handleResize)
    this.clearModel()
    this.controls.dispose()
    this.loader.dispose()
    this.renderer.dispose()
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement)
    }
    this.listeners.clear()
  }
}
