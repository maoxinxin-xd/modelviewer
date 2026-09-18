import { ViewerEngine } from '../core/ViewerEngine'
import {
  isSupportedModelFile,
  resolveModelInput,
  SUPPORTED_ACCEPT,
  type PresetView,
  type ProjectionMode,
  type TextureMode,
  type ViewerState
} from '../core'
import { icons } from './icons'
import { resolveCopy, type Locale, type ViewerCopy } from './i18n'
import type {
  LoadModelOptions,
  ModelSource,
  ModelViewerInstance,
  ModelViewerOptions,
  ModelViewerTheme,
  ModelViewerUIOptions
} from './types'
import styles from './styles.css?inline'

const STYLE_ID = 'mivo-model-viewer-styles'

function ensureStyles() {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = styles
  document.head.appendChild(el)
}

function resolveContainer(target: HTMLElement | string): HTMLElement {
  if (typeof target === 'string') {
    const el = document.querySelector<HTMLElement>(target)
    if (!el) throw new Error(`[model-viewer] container not found: ${target}`)
    return el
  }
  if (!target) throw new Error('[model-viewer] container is required')
  return target
}

function normalizeUi(ui: ModelViewerOptions['ui']): Required<ModelViewerUIOptions> {
  const base: Required<ModelViewerUIOptions> = {
    infoPanel: true,
    settingsPanel: true,
    toolbar: true,
    import: true,
    export: true,
    screenshot: true,
    textureModes: true,
    toasts: true,
    emptyHint: true,
    loadingOverlay: true
  }
  if (ui === false) {
    return {
      infoPanel: false,
      settingsPanel: false,
      toolbar: false,
      import: false,
      export: false,
      screenshot: false,
      textureModes: false,
      toasts: false,
      emptyHint: false,
      loadingOverlay: false
    }
  }
  if (ui === true || ui == null) return base
  return { ...base, ...ui }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

function updateSliderFill(slider: HTMLInputElement) {
  const min = Number(slider.min)
  const max = Number(slider.max)
  const value = Number(slider.value)
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0
  slider.style.setProperty('--fill', `${pct}%`)
}

function buildTemplate(copy: ViewerCopy, ui: Required<ModelViewerUIOptions>) {
  const showLeft = ui.infoPanel
  const showRight = ui.settingsPanel
  const showToolbar = ui.toolbar || ui.import || ui.export || ui.screenshot || ui.textureModes

  return `
    <div class="mv-viewport" data-mv="viewport"></div>

    ${
      ui.loadingOverlay
        ? `<div class="mv-loading hidden" data-mv="loading">
            <div class="mv-spinner"></div>
            <div class="mv-loading-text">${copy.loading}<span class="mv-progress" data-mv="progress">0%</span></div>
          </div>`
        : ''
    }

    ${
      ui.emptyHint
        ? `<div class="mv-empty" data-mv="empty">
            <div class="mv-empty-title">${copy.title}</div>
            <div class="mv-empty-desc">${copy.emptyDesc}</div>
          </div>`
        : ''
    }

    ${
      showLeft
        ? `<aside class="mv-sidebar mv-sidebar-left" data-mv="leftPanel">
            <div class="mv-sidebar-shell">
              <section class="mv-section">
                <header class="mv-section-title">${copy.modelInfo}</header>
                <div class="mv-info-list">
                  <div class="mv-info-row">
                    <span class="mv-info-label">${copy.fieldFile}</span>
                    <span class="mv-info-value mv-file-name" data-mv="fileName">-</span>
                  </div>
                  <div class="mv-info-row">
                    <span class="mv-info-label">${copy.fieldTopology}</span>
                    <span class="mv-info-value" data-mv="topology">${copy.fieldFaces === 'Faces' ? 'Triangles' : '三角面'}</span>
                  </div>
                  <div class="mv-info-row">
                    <span class="mv-info-label">${copy.fieldFaces}</span>
                    <span class="mv-info-value" data-mv="faceCount">0</span>
                  </div>
                  <div class="mv-info-row">
                    <span class="mv-info-label">${copy.fieldMaterial}</span>
                    <span class="mv-info-value" data-mv="materialStatus">-</span>
                  </div>
                </div>
              </section>
            </div>
          </aside>`
        : ''
    }

    ${
      showRight
        ? `<aside class="mv-sidebar mv-sidebar-right" data-mv="rightPanel">
            <div class="mv-sidebar-shell">
              <section class="mv-section">
                <header class="mv-section-title">${copy.display}</header>
                <div class="mv-field">
                  <div class="mv-field-label">${copy.projection}</div>
                  <div class="mv-segment-row">
                    <button type="button" class="mv-segment-btn is-active" data-mv="btnPerspective">
                      <span class="mv-segment-icon"><img src="${icons.perspective}" alt="" /></span>
                      <span>${copy.perspective}</span>
                    </button>
                    <button type="button" class="mv-segment-btn" data-mv="btnOrthographic">
                      <span class="mv-segment-icon"><img src="${icons.orthographic}" alt="" /></span>
                      <span>${copy.orthographic}</span>
                    </button>
                  </div>
                </div>
                <div class="mv-field">
                  <div class="mv-field-label">${copy.presetViews}</div>
                  <div class="mv-preset-grid">
                    <button type="button" class="mv-preset-btn is-active" data-view="front" data-mv="btnFront" title="${copy.front}"><img src="${icons.front}" alt="${copy.front}" /></button>
                    <button type="button" class="mv-preset-btn" data-view="back" data-mv="btnBack" title="${copy.back}"><img src="${icons.back}" alt="${copy.back}" /></button>
                    <button type="button" class="mv-preset-btn" data-view="side" data-mv="btnSide" title="${copy.side}"><img src="${icons.side}" alt="${copy.side}" /></button>
                    <button type="button" class="mv-preset-btn" data-view="top" data-mv="btnTop" title="${copy.top}"><img src="${icons.top}" alt="${copy.top}" /></button>
                  </div>
                </div>
              </section>
              <div class="mv-divider"></div>
              <section class="mv-section">
                <header class="mv-section-title">${copy.lighting}</header>
                <div class="mv-field">
                  <div class="mv-field-label">${copy.angle}</div>
                  <div class="mv-light-dial">
                    <div class="mv-dial-outer">
                      <div class="mv-dial-sphere" data-mv="dialSphere">
                        <div class="mv-dial-tint" data-mv="dialTint"></div>
                      </div>
                    </div>
                    <div class="mv-shader-round" data-mv="shaderRound"></div>
                  </div>
                </div>
                <div class="mv-field">
                  <div class="mv-field-label">${copy.keyIntensity}</div>
                  <div class="mv-slider-row">
                    <input class="mv-native-slider" data-mv="lightSlider" type="range" min="0" max="20" step="1" value="2" />
                    <input class="mv-input-number" data-mv="lightNumber" type="number" min="0" max="20" step="1" value="2" />
                  </div>
                </div>
                <div class="mv-field">
                  <div class="mv-field-label">${copy.ambientIntensity}</div>
                  <div class="mv-slider-row">
                    <input class="mv-native-slider" data-mv="ambientSlider" type="range" min="0" max="20" step="1" value="2" />
                    <input class="mv-input-number" data-mv="ambientNumber" type="number" min="0" max="20" step="1" value="2" />
                  </div>
                </div>
              </section>
            </div>
          </aside>`
        : ''
    }

    ${
      showToolbar
        ? `<div class="mv-bottom-panel" data-mv="bottomPanel">
            <div class="mv-bottom-actions">
              ${
                ui.textureModes
                  ? `<div class="mv-texture-group hidden" data-mv="textureGroup">
                      <div class="mv-tooltip" data-tip="${copy.texture}">
                        <button type="button" class="mv-texture-btn is-active" data-mode="textured" data-mv="btnTextured"><img class="mv-texture-icon" src="${icons.textured}" alt="${copy.texture}" /></button>
                      </div>
                      <div class="mv-tooltip" data-tip="${copy.clay}">
                        <button type="button" class="mv-texture-btn" data-mode="clay" data-mv="btnClay"><img class="mv-texture-icon" src="${icons.clay}" alt="${copy.clay}" /></button>
                      </div>
                      <div class="mv-tooltip" data-tip="${copy.normal}">
                        <button type="button" class="mv-texture-btn" data-mode="normal" data-mv="btnNormal"><img class="mv-texture-icon" src="${icons.normal}" alt="${copy.normal}" /></button>
                      </div>
                      <div class="mv-tooltip" data-tip="${copy.albedo}">
                        <button type="button" class="mv-texture-btn" data-mode="albedo" data-mv="btnAlbedo"><img class="mv-texture-icon" src="${icons.albedo}" alt="${copy.albedo}" /></button>
                      </div>
                    </div>`
                  : ''
              }

              ${
                ui.screenshot
                  ? `<div class="mv-tooltip hidden" data-mv="screenshotWrap" data-tip="${copy.screenshot}">
                      <button type="button" class="mv-action-btn" data-mv="btnScreenshot">
                        <img src="${icons.screenshot}" alt="" width="18" height="18" />
                        ${copy.screenshot}
                      </button>
                    </div>`
                  : ''
              }

              ${
                ui.import
                  ? `<button type="button" class="mv-action-btn mv-import-btn" data-mv="btnImport">${copy.import}</button>`
                  : ''
              }

              ${
                ui.export
                  ? `<button type="button" class="mv-action-btn mv-export-btn hidden" data-mv="btnExport">${copy.export}</button>`
                  : ''
              }
            </div>
          </div>
          <input class="mv-file-input" data-mv="fileInput" type="file" accept="${SUPPORTED_ACCEPT}" />`
        : ''
    }

    ${ui.toasts ? `<div class="mv-toast-container" data-mv="toasts"></div>` : ''}
  `
}

class ModelViewer implements ModelViewerInstance {
  readonly engine: ViewerEngine
  readonly root: HTMLElement

  private ui: Required<ModelViewerUIOptions>
  private copy: ViewerCopy
  private options: ModelViewerOptions
  private cleanups: Array<() => void> = []
  private disposed = false
  private screenshotting = false
  private dragging = false

  private refs: {
    loading: HTMLElement | null
    progress: HTMLElement | null
    empty: HTMLElement | null
    leftPanel: HTMLElement | null
    rightPanel: HTMLElement | null
    textureGroup: HTMLElement | null
    screenshotWrap: HTMLElement | null
    fileName: HTMLElement | null
    faceCount: HTMLElement | null
    materialStatus: HTMLElement | null
    topology: HTMLElement | null
    btnPerspective: HTMLElement | null
    btnOrthographic: HTMLElement | null
    btnFront: HTMLElement | null
    btnBack: HTMLElement | null
    btnSide: HTMLElement | null
    btnTop: HTMLElement | null
    btnTextured: HTMLElement | null
    btnClay: HTMLElement | null
    btnNormal: HTMLElement | null
    btnAlbedo: HTMLElement | null
    btnScreenshot: HTMLButtonElement | null
    btnImport: HTMLButtonElement | null
    btnExport: HTMLButtonElement | null
    fileInput: HTMLInputElement | null
    dialSphere: HTMLElement | null
    dialTint: HTMLElement | null
    shaderRound: HTMLElement | null
    lightSlider: HTMLInputElement | null
    lightNumber: HTMLInputElement | null
    ambientSlider: HTMLInputElement | null
    ambientNumber: HTMLInputElement | null
    toasts: HTMLElement | null
  }

  constructor(host: HTMLElement, options: ModelViewerOptions = {}) {
    this.options = options
    this.ui = normalizeUi(options.ui)
    this.copy = resolveCopy(options.locale ?? 'zh-CN')

    ensureStyles()

    this.root = document.createElement('div')
    this.root.className = 'mv-root'
    this.applyTheme(options.theme)
    this.root.innerHTML = buildTemplate(this.copy, this.ui)
    host.appendChild(this.root)

    const viewport = this.q('viewport')
    if (!viewport) throw new Error('[model-viewer] viewport missing')

    this.engine = new ViewerEngine(viewport)

    if (options.defaults?.lightIntensity != null) {
      this.engine.setLightIntensity(options.defaults.lightIntensity)
    }
    if (options.defaults?.ambientIntensity != null) {
      this.engine.setAmbientIntensity(options.defaults.ambientIntensity)
    }

    this.refs = this.bindRefs()
    this.bindEngine()
    this.bindUi()

    if (options.src) {
      void this.load(options.src, { fileName: options.srcFileName }).catch((error) => {
        const err = error instanceof Error ? error : new Error(String(error))
        options.onLoadError?.(err)
      })
    }

    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }

  get state(): ViewerState {
    return this.engine.state
  }

  private q(name: string): HTMLElement | null {
    return this.root.querySelector(`[data-mv="${name}"]`)
  }

  private qi<T extends HTMLElement>(name: string): T | null {
    return this.root.querySelector(`[data-mv="${name}"]`)
  }

  private applyTheme(theme: ModelViewerOptions['theme']) {
    if (!theme) return
    const s = this.root.style
    if (theme.primary) s.setProperty('--mv-primary', theme.primary)
    if (theme.text) s.setProperty('--mv-text', theme.text)
    if (theme.panelBg) s.setProperty('--mv-panel-bg', theme.panelBg)
    if (theme.background) s.setProperty('--mv-bg', theme.background)
  }

  private bindRefs() {
    return {
      loading: this.q('loading'),
      progress: this.q('progress'),
      empty: this.q('empty'),
      leftPanel: this.q('leftPanel'),
      rightPanel: this.q('rightPanel'),
      textureGroup: this.q('textureGroup'),
      screenshotWrap: this.q('screenshotWrap'),
      fileName: this.q('fileName'),
      faceCount: this.q('faceCount'),
      materialStatus: this.q('materialStatus'),
      topology: this.q('topology'),
      btnPerspective: this.q('btnPerspective'),
      btnOrthographic: this.q('btnOrthographic'),
      btnFront: this.q('btnFront'),
      btnBack: this.q('btnBack'),
      btnSide: this.q('btnSide'),
      btnTop: this.q('btnTop'),
      btnTextured: this.q('btnTextured'),
      btnClay: this.q('btnClay'),
      btnNormal: this.q('btnNormal'),
      btnAlbedo: this.q('btnAlbedo'),
      btnScreenshot: this.qi<HTMLButtonElement>('btnScreenshot'),
      btnImport: this.qi<HTMLButtonElement>('btnImport'),
      btnExport: this.qi<HTMLButtonElement>('btnExport'),
      fileInput: this.qi<HTMLInputElement>('fileInput'),
      dialSphere: this.q('dialSphere'),
      dialTint: this.q('dialTint'),
      shaderRound: this.q('shaderRound'),
      lightSlider: this.qi<HTMLInputElement>('lightSlider'),
      lightNumber: this.qi<HTMLInputElement>('lightNumber'),
      ambientSlider: this.qi<HTMLInputElement>('ambientSlider'),
      ambientNumber: this.qi<HTMLInputElement>('ambientNumber'),
      toasts: this.q('toasts')
    }
  }

  private toast(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info', duration = 2400) {
    if (!this.ui.toasts || !this.refs.toasts) return
    const el = document.createElement('div')
    el.className = `mv-toast ${type === 'info' ? '' : type}`
    el.textContent = message
    this.refs.toasts.appendChild(el)
    window.setTimeout(() => {
      el.style.opacity = '0'
      el.style.transition = 'opacity 0.2s ease'
      window.setTimeout(() => el.remove(), 200)
    }, duration)
  }

  private bindEngine() {
    const unsub = this.engine.subscribe((state) => {
      this.options.onStateChange?.(state)
      if (state.ready) this.options.onReady?.(state)
      this.render(state)
    })
    this.cleanups.push(unsub)
  }

  private render(state: ViewerState) {
    const ready = state.ready
    const loading =
      state.isLoading || (!ready && state.progress > 0 && state.progress < 100)
    const hasModel = state.hasModel || ready

    if (this.refs.loading) {
      this.refs.loading.classList.toggle('hidden', !loading)
    }
    if (this.refs.progress) {
      this.refs.progress.textContent = `${Math.max(state.progress, 0).toFixed(0)}%`
    }
    if (this.refs.empty) {
      this.refs.empty.classList.toggle('hidden', hasModel || loading)
    }

    this.refs.leftPanel?.classList.toggle('is-visible', hasModel)
    this.refs.rightPanel?.classList.toggle('is-visible', hasModel)

    this.refs.textureGroup?.classList.toggle('hidden', !ready)
    this.refs.screenshotWrap?.classList.toggle('hidden', !ready)
    this.refs.btnExport?.classList.toggle('hidden', !ready)
    if (this.refs.btnImport) {
      this.refs.btnImport.textContent = hasModel ? this.copy.replace : this.copy.import
    }

    if (state.fileName && this.refs.fileName) {
      this.refs.fileName.textContent = state.fileName
    }
    if (this.refs.faceCount) {
      this.refs.faceCount.textContent = String(state.triangleCount)
    }
    if (this.refs.materialStatus) {
      this.refs.materialStatus.textContent = state.materialStatus || '-'
    }

    this.refs.btnPerspective?.classList.toggle('is-active', state.projectionMode === 'perspective')
    this.refs.btnOrthographic?.classList.toggle('is-active', state.projectionMode === 'orthographic')

    const presetMap: Record<string, HTMLElement | null> = {
      front: this.refs.btnFront,
      back: this.refs.btnBack,
      side: this.refs.btnSide,
      top: this.refs.btnTop
    }
    for (const [key, node] of Object.entries(presetMap)) {
      node?.classList.toggle('is-active', state.presetView === key)
    }

    const textureBtns: Record<TextureMode, HTMLElement | null> = {
      textured: this.refs.btnTextured,
      clay: this.refs.btnClay,
      normal: this.refs.btnNormal,
      albedo: this.refs.btnAlbedo
    }
    const whiteOnly = state.isWhiteModel
    this.refs.btnTextured?.classList.toggle('hidden', whiteOnly)
    this.refs.btnAlbedo?.classList.toggle('hidden', whiteOnly)
    for (const [mode, node] of Object.entries(textureBtns) as [TextureMode, HTMLElement | null][]) {
      node?.classList.toggle('is-active', state.textureMode === mode)
    }

    if (this.refs.dialSphere) {
      this.refs.dialSphere.style.transform = `rotate(${state.lightAngle - 90}deg)`
    }
    if (this.refs.dialTint) {
      this.refs.dialTint.style.width = '22px'
    }
    if (this.refs.shaderRound) {
      this.refs.shaderRound.style.transform = `rotate(${state.lightAngle}deg)`
      this.refs.shaderRound.style.cursor = state.isDragging ? 'grabbing' : 'grab'
    }

    const lightSlider = this.refs.lightSlider
    const lightNumber = this.refs.lightNumber
    const ambientSlider = this.refs.ambientSlider
    const ambientNumber = this.refs.ambientNumber

    if (
      lightSlider &&
      lightNumber &&
      document.activeElement !== lightNumber &&
      Number(lightSlider.value) !== state.lightIntensity
    ) {
      lightSlider.value = String(state.lightIntensity)
      lightNumber.value = String(state.lightIntensity)
      updateSliderFill(lightSlider)
    }
    if (
      ambientSlider &&
      ambientNumber &&
      document.activeElement !== ambientNumber &&
      Number(ambientSlider.value) !== state.ambientIntensity
    ) {
      ambientSlider.value = String(state.ambientIntensity)
      ambientNumber.value = String(state.ambientIntensity)
      updateSliderFill(ambientSlider)
    }
  }

  private bindUi() {
    const on = <E extends Event>(
      el: HTMLElement | null,
      type: string,
      handler: (event: E) => void
    ) => {
      if (!el) return
      const listener = handler as EventListener
      el.addEventListener(type, listener)
      this.cleanups.push(() => el.removeEventListener(type, listener))
    }

    on(this.refs.btnPerspective, 'click', () => this.engine.toggleProjectionMode('perspective'))
    on(this.refs.btnOrthographic, 'click', () => this.engine.toggleProjectionMode('orthographic'))

    const presets: Array<[Exclude<PresetView, 'none'>, HTMLElement | null]> = [
      ['front', this.refs.btnFront],
      ['back', this.refs.btnBack],
      ['side', this.refs.btnSide],
      ['top', this.refs.btnTop]
    ]
    for (const [view, node] of presets) {
      on(node, 'click', () => this.engine.setPresetView(view))
    }

    const textures: Array<[TextureMode, HTMLElement | null]> = [
      ['textured', this.refs.btnTextured],
      ['clay', this.refs.btnClay],
      ['normal', this.refs.btnNormal],
      ['albedo', this.refs.btnAlbedo]
    ]
    for (const [mode, node] of textures) {
      on(node, 'click', () => this.engine.applyTextureMode(mode))
    }

    // Light dial drag
    const shaderRound = this.refs.shaderRound
    if (shaderRound) {
      const calculateAngle = (event: MouseEvent | TouchEvent, element: HTMLElement) => {
        const rect = element.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2
        const centerY = rect.top + rect.height / 2
        const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX
        const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY
        const deltaX = clientX - centerX
        const deltaY = clientY - centerY
        return (Math.atan2(deltaY, deltaX) * (180 / Math.PI) + 90 + 360) % 360
      }

      const onPointerDown = (event: MouseEvent | TouchEvent) => {
        this.dragging = true
        this.engine.setDragging(true)
        event.preventDefault()
        this.engine.setLightAngle(calculateAngle(event, shaderRound))
      }
      const onPointerMove = (event: MouseEvent | TouchEvent) => {
        if (!this.dragging) return
        event.preventDefault()
        this.engine.setLightAngle(calculateAngle(event, shaderRound))
      }
      const onPointerUp = () => {
        if (!this.dragging) return
        this.dragging = false
        this.engine.setDragging(false)
      }

      shaderRound.addEventListener('mousedown', onPointerDown)
      shaderRound.addEventListener('touchstart', onPointerDown, { passive: false })
      document.addEventListener('mousemove', onPointerMove)
      document.addEventListener('mouseup', onPointerUp)
      document.addEventListener('touchmove', onPointerMove, { passive: false })
      document.addEventListener('touchend', onPointerUp)
      this.cleanups.push(() => {
        shaderRound.removeEventListener('mousedown', onPointerDown)
        shaderRound.removeEventListener('touchstart', onPointerDown)
        document.removeEventListener('mousemove', onPointerMove)
        document.removeEventListener('mouseup', onPointerUp)
        document.removeEventListener('touchmove', onPointerMove)
        document.removeEventListener('touchend', onPointerUp)
      })
    }

    const bindSlider = (
      slider: HTMLInputElement | null,
      number: HTMLInputElement | null,
      apply: (value: number) => void
    ) => {
      if (!slider || !number) return
      updateSliderFill(slider)
      const sync = (raw: string | number) => {
        let value = Number(raw)
        if (Number.isNaN(value)) value = 0
        value = Math.min(20, Math.max(0, Math.round(value * 100) / 100))
        slider.value = String(value)
        number.value = String(value)
        updateSliderFill(slider)
        apply(value)
      }
      const onSlider = () => sync(slider.value)
      const onNumberChange = () => sync(number.value)
      const onNumberBlur = () => sync(number.value)
      slider.addEventListener('input', onSlider)
      number.addEventListener('change', onNumberChange)
      number.addEventListener('blur', onNumberBlur)
      this.cleanups.push(() => {
        slider.removeEventListener('input', onSlider)
        number.removeEventListener('change', onNumberChange)
        number.removeEventListener('blur', onNumberBlur)
      })
    }

    bindSlider(this.refs.lightSlider, this.refs.lightNumber, (v) =>
      this.engine.setLightIntensity(v)
    )
    bindSlider(this.refs.ambientSlider, this.refs.ambientNumber, (v) =>
      this.engine.setAmbientIntensity(v)
    )

    on(this.refs.btnScreenshot, 'click', async () => {
      if (this.screenshotting) return
      if (!this.engine.state.ready) {
        this.toast(this.copy.toastNeedModel, 'warn')
        return
      }
      this.screenshotting = true
      this.refs.btnScreenshot?.classList.add('is-disabled')
      try {
        const blob = await this.engine.captureScreenshot()
        downloadBlob(blob, `screenshot_${Date.now()}.png`)
        this.toast(this.copy.toastShotDone, 'success')
      } catch (error) {
        console.error(error)
        this.toast(this.copy.toastShotFail, 'error')
      } finally {
        this.screenshotting = false
        this.refs.btnScreenshot?.classList.remove('is-disabled')
      }
    })

    on(this.refs.btnImport, 'click', () => this.refs.fileInput?.click())

    on(this.refs.fileInput, 'change', async () => {
      const input = this.refs.fileInput as HTMLInputElement | null
      const file = input?.files?.[0]
      if (input) input.value = ''
      if (!file) return
      if (!isSupportedModelFile(file)) {
        this.options.onFileRejected?.(file)
        this.toast(this.copy.toastUnsupported, 'error')
        return
      }
      try {
        await this.engine.loadFromFile(file)
        const entry = this.engine.state.entryName
        const base = this.engine.state.fileName
        const msg =
          entry && entry !== base
            ? `${this.copy.toastLoadOk}：${base} → ${entry}`
            : `${this.copy.toastLoadOk}：${base}`
        this.toast(msg, 'success')
        const status = this.engine.state.materialStatus
        if (status.includes(this.copy.materialMissing) || status === '默认材质') {
          this.toast(status, 'warn')
        }
      } catch (error) {
        console.error(error)
        const reason =
          error instanceof Error ? error.message : this.copy.toastLoadFail
        this.toast(reason, 'error')
        this.options.onLoadError?.(
          error instanceof Error ? error : new Error(String(error))
        )
      }
    })

    on(this.refs.btnExport, 'click', () => {
      const blob = this.engine.exportCurrentModel()
      if (!blob) {
        this.toast(this.copy.toastExportEmpty, 'warn')
        return
      }
      const name = this.engine.state.fileName || `model_${Date.now()}`
      downloadBlob(blob, name)
      this.toast(this.copy.toastExportOk, 'success')
    })

    if (this.refs.lightSlider) updateSliderFill(this.refs.lightSlider)
    if (this.refs.ambientSlider) updateSliderFill(this.refs.ambientSlider)
  }

  async load(source: ModelSource, options: { fileName?: string } = {}) {
    if (this.disposed) throw new Error('[model-viewer] instance disposed')
    const file = await resolveModelInput(source, { fileName: options.fileName })
    if (!isSupportedModelFile(file)) {
      this.options.onFileRejected?.(file)
      this.toast(this.copy.toastUnsupported, 'error')
      throw new Error(this.copy.toastUnsupported)
    }
    try {
      await this.engine.loadFromFile(file)
    } catch (error) {
      this.options.onLoadError?.(
        error instanceof Error ? error : new Error(String(error))
      )
      throw error
    }
  }

  subscribe(listener: (state: ViewerState) => void) {
    return this.engine.subscribe(listener)
  }

  setProjection(mode: ProjectionMode) {
    this.engine.toggleProjectionMode(mode)
  }

  setPresetView(view: PresetView) {
    this.engine.setPresetView(view)
  }

  setTextureMode(mode: TextureMode) {
    this.engine.applyTextureMode(mode)
  }

  setLightIntensity(value: number) {
    this.engine.setLightIntensity(value)
  }

  setAmbientIntensity(value: number) {
    this.engine.setAmbientIntensity(value)
  }

  setLightAngle(angle: number) {
    this.engine.setLightAngle(angle)
  }

  captureScreenshot() {
    return this.engine.captureScreenshot()
  }

  exportModel() {
    return this.engine.exportCurrentModel()
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cleanups.forEach((fn) => fn())
    this.cleanups = []
    this.engine.dispose()
    this.root.remove()
  }
}

/**
 * Create a model viewer with default UI (customizable) or headless canvas.
 *
 * @example
 * ```ts
 * import { createModelViewer } from 'mivo-model-viewer'
 *
 * const viewer = createModelViewer('#app', {
 *   locale: 'zh-CN',
 *   ui: { export: false }, // hide export button
 *   theme: { primary: '#3b82f6' },
 *   onReady: (s) => console.log('ready', s.fileName)
 * })
 * await viewer.load(file)
 * ```
 */
export function createModelViewer(
  container: HTMLElement | string,
  options?: ModelViewerOptions
): ModelViewerInstance {
  return new ModelViewer(resolveContainer(container), options)
}

export { ModelViewer }
export type {
  Locale,
  ModelViewerOptions,
  ModelViewerUIOptions,
  ModelViewerTheme,
  ModelViewerInstance,
  ModelSource,
  LoadModelOptions
}
