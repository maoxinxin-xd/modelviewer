import './styles.css'
import { ViewerEngine } from './core/ViewerEngine'
import { isSupportedModelFile, SUPPORTED_ACCEPT } from './core/ModelLoader'
import type { PresetView, TextureMode } from './core/utils'

import perspectiveIcon from './icons/perspective.svg'
import orthographicIcon from './icons/orthographic.svg'
import screenshotIcon from './icons/截屏.svg'
import frontViewIcon from './icons/正视图.svg'
import backViewIcon from './icons/背视图.svg'
import sideViewIcon from './icons/侧视图.svg'
import topViewIcon from './icons/俯视图.svg'
import normalMapIcon from './icons/法线.svg'
import albedoMapIcon from './icons/反照.svg'
import whiteModelIcon from './icons/白模.svg'
import textureIcon from './icons/贴图.svg'

// ---------- Toast ----------
const toastRoot = document.createElement('div')
toastRoot.className = 'toast-container'
document.body.appendChild(toastRoot)

type ToastType = 'info' | 'success' | 'error' | 'warn'

function toast(message: string, type: ToastType = 'info', duration = 2400) {
  const el = document.createElement('div')
  el.className = `toast ${type === 'info' ? '' : type}`
  el.textContent = message
  toastRoot.appendChild(el)
  window.setTimeout(() => {
    el.style.opacity = '0'
    el.style.transition = 'opacity 0.2s ease'
    window.setTimeout(() => el.remove(), 200)
  }, duration)
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
  const pct = ((value - min) / (max - min)) * 100
  slider.style.setProperty('--fill', `${pct}%`)
}

// ---------- App UI ----------
const app = document.getElementById('app')!
if (!app) throw new Error('missing #app')

app.innerHTML = `
  <div class="model-viewer-overlay" id="overlay">
    <div id="viewport"></div>

    <div class="model-loading-progress hidden" id="loading">
      <div class="spinner"></div>
      <div class="loading-text">模型加载中<span class="process-text" id="progressText">0%</span></div>
    </div>

    <div class="empty-hint" id="emptyHint">
      <div class="empty-hint-title">3D 模型查看器</div>
      <div class="empty-hint-desc">支持 GLB/GLTF/OBJ/FBX/STL/PLY/DAE/3MF/3DS，以及含模型+贴图的 ZIP</div>
    </div>

    <!-- 左侧：模型信息 -->
    <aside class="sidebar sidebar-left" id="leftPanel">
      <div class="sidebar-shell">
        <section class="sidebar-section">
          <header class="sidebar-section-title">模型信息</header>
          <div class="info-list">
            <div class="info-row">
              <span class="info-label">文件</span>
              <span class="info-value file-name" id="fileNameValue">-</span>
            </div>
            <div class="info-row">
              <span class="info-label">拓扑</span>
              <span class="info-value" id="topologyValue">三角面</span>
            </div>
            <div class="info-row">
              <span class="info-label">面数</span>
              <span class="info-value" id="faceCountValue">0</span>
            </div>
            <div class="info-row">
              <span class="info-label">材质</span>
              <span class="info-value" id="materialStatusValue">-</span>
            </div>
          </div>
        </section>
      </div>
    </aside>

    <!-- 右侧：显示设置 + 灯光设置 -->
    <aside class="sidebar sidebar-right" id="rightPanel">
      <div class="sidebar-shell">
        <section class="sidebar-section">
          <header class="sidebar-section-title">显示设置</header>
          <div class="field-block">
            <div class="field-label">透视关系</div>
            <div class="segment-row">
              <button type="button" class="segment-btn is-active" id="btnPerspective">
                <img class="segment-icon" src="${perspectiveIcon}" alt="" />
                <span>透视</span>
              </button>
              <button type="button" class="segment-btn" id="btnOrthographic">
                <img class="segment-icon" src="${orthographicIcon}" alt="" />
                <span>正交</span>
              </button>
            </div>
          </div>
          <div class="field-block">
            <div class="field-label">预设角度</div>
            <div class="preset-grid">
              <button type="button" class="preset-btn is-active" data-view="front" id="btnFront" title="正视">
                <img src="${frontViewIcon}" alt="正视" />
              </button>
              <button type="button" class="preset-btn" data-view="back" id="btnBack" title="背视">
                <img src="${backViewIcon}" alt="背视" />
              </button>
              <button type="button" class="preset-btn" data-view="side" id="btnSide" title="侧视">
                <img src="${sideViewIcon}" alt="侧视" />
              </button>
              <button type="button" class="preset-btn" data-view="top" id="btnTop" title="俯视">
                <img src="${topViewIcon}" alt="俯视" />
              </button>
            </div>
          </div>
        </section>

        <div class="sidebar-divider"></div>

        <section class="sidebar-section">
          <header class="sidebar-section-title">灯光设置</header>
          <div class="field-block">
            <div class="field-label">角度</div>
            <div class="light-dial">
              <div class="dial-outer">
                <div class="dial-sphere" id="dialSphere">
                  <div class="dial-tint" id="dialTint"></div>
                </div>
              </div>
              <div class="shader-round" id="shaderRound"></div>
            </div>
          </div>
          <div class="field-block">
            <div class="field-label">射灯强度</div>
            <div class="slider-row">
              <input class="native-slider" id="lightSlider" type="range" min="0" max="20" step="1" value="2" />
              <input class="input-number" id="lightNumber" type="number" min="0" max="20" step="1" value="2" />
            </div>
          </div>
          <div class="field-block">
            <div class="field-label">平面光强度</div>
            <div class="slider-row">
              <input class="native-slider" id="ambientSlider" type="range" min="0" max="20" step="1" value="2" />
              <input class="input-number" id="ambientNumber" type="number" min="0" max="20" step="1" value="2" />
            </div>
          </div>
        </section>
      </div>
    </aside>

    <!-- 底部面板 -->
    <div class="bottom-panel" id="bottomPanel">
      <div class="bottom-actions">
        <div class="texture-group hidden" id="textureGroup">
          <div class="tooltip-host" data-tip="贴图">
            <div class="texture-icon-container is-active" id="btnTexture">
              <img class="texture-icon" src="${textureIcon}" alt="贴图" />
            </div>
          </div>
          <div class="tooltip-host" data-tip="白膜">
            <div class="texture-icon-container" id="btnWhite">
              <img class="texture-icon" src="${whiteModelIcon}" alt="白膜" />
            </div>
          </div>
          <div class="tooltip-host" data-tip="法线">
            <div class="texture-icon-container" id="btnNormal">
              <img class="texture-icon" src="${normalMapIcon}" alt="法线" />
            </div>
          </div>
          <div class="tooltip-host" data-tip="反射">
            <div class="texture-icon-container" id="btnAlbedo">
              <img class="texture-icon" src="${albedoMapIcon}" alt="反照" />
            </div>
          </div>
        </div>

        <div class="tooltip-host hidden" id="screenshotWrap" data-tip="截屏">
          <button class="screenshot-button" id="btnScreenshot" type="button">
            <img src="${screenshotIcon}" alt="截屏" width="18" height="18" />
            截屏
          </button>
        </div>

        <button class="import-button" id="btnImport" type="button">导入</button>

        <button class="export-button hidden" id="btnExport" type="button">导出</button>
      </div>
    </div>

    <input
      class="hidden-input"
      id="fileInput"
      type="file"
      accept="${SUPPORTED_ACCEPT}"
    />
  </div>
`

// ---------- Element refs ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const viewport = $('viewport')
const loadingEl = $('loading')
const progressText = $('progressText')
const emptyHint = $('emptyHint')
const leftPanel = $('leftPanel')
const rightPanel = $('rightPanel')
const textureGroup = $('textureGroup')
const screenshotWrap = $('screenshotWrap')
const fileNameValue = $('fileNameValue')
const faceCountValue = $('faceCountValue')
const topologyValue = $('topologyValue')
const materialStatusValue = $('materialStatusValue')

const btnPerspective = $('btnPerspective')
const btnOrthographic = $('btnOrthographic')
const presetButtons = {
  front: $('btnFront'),
  back: $('btnBack'),
  side: $('btnSide'),
  top: $('btnTop')
} as const

const shaderRound = $('shaderRound')
const dialSphere = $('dialSphere')
const dialTint = $('dialTint')

const lightSlider = $<HTMLInputElement>('lightSlider')
const lightNumber = $<HTMLInputElement>('lightNumber')
const ambientSlider = $<HTMLInputElement>('ambientSlider')
const ambientNumber = $<HTMLInputElement>('ambientNumber')

const btnTexture = $('btnTexture')
const btnWhite = $('btnWhite')
const btnNormal = $('btnNormal')
const btnAlbedo = $('btnAlbedo')
const btnScreenshot = $<HTMLButtonElement>('btnScreenshot')
const btnImport = $<HTMLButtonElement>('btnImport')
const btnExport = $<HTMLButtonElement>('btnExport')
const fileInput = $<HTMLInputElement>('fileInput')

// ---------- Engine ----------
const engine = new ViewerEngine(viewport)

engine.subscribe((state) => {
  const ready = state.ready
  const loading = state.isLoading || (!ready && state.progress > 0 && state.progress < 100)
  const hasModel = state.hasModel || ready

  // loading
  if (loading) {
    loadingEl.classList.remove('hidden')
    progressText.textContent = `${Math.max(state.progress, 0).toFixed(0)}%`
  } else {
    loadingEl.classList.add('hidden')
  }

  // empty / side panels：替换时保持侧栏
  emptyHint.classList.toggle('hidden', hasModel || loading)
  leftPanel.classList.toggle('is-visible', hasModel)
  rightPanel.classList.toggle('is-visible', hasModel)

  // 底栏
  textureGroup.classList.toggle('hidden', !ready)
  screenshotWrap.classList.toggle('hidden', !ready)
  btnExport.classList.toggle('hidden', !ready)
  btnImport.textContent = hasModel ? '替换' : '导入'
  btnImport.classList.remove('is-disabled')

  // info
  if (state.fileName) fileNameValue.textContent = state.fileName
  faceCountValue.textContent = String(state.triangleCount)
  topologyValue.textContent = '三角面'
  materialStatusValue.textContent = state.materialStatus || '-'

  // projection
  btnPerspective.classList.toggle('is-active', state.projectionMode === 'perspective')
  btnOrthographic.classList.toggle('is-active', state.projectionMode === 'orthographic')

  // presets
  ;(Object.keys(presetButtons) as PresetView[]).forEach((key) => {
    if (key === 'none') return
    presetButtons[key].classList.toggle('is-active', state.presetView === key)
  })

  // texture buttons
  const isWhiteOnly = state.isWhiteModel
  btnTexture.classList.toggle('hidden', isWhiteOnly)
  btnAlbedo.classList.toggle('hidden', isWhiteOnly)
  btnTexture.classList.toggle('is-active', state.textureMode === '贴图')
  btnWhite.classList.toggle('is-active', state.textureMode === '白膜')
  btnNormal.classList.toggle('is-active', state.textureMode === '法线')
  btnAlbedo.classList.toggle('is-active', state.textureMode === '反照')

  // light dial
  dialSphere.style.transform = `rotate(${state.lightAngle - 90}deg)`
  dialTint.style.width = '24px'
  shaderRound.style.transform = `rotate(${state.lightAngle}deg)`
  shaderRound.style.cursor = state.isDragging ? 'grabbing' : 'grab'

  // sliders
  if (document.activeElement !== lightNumber && Number(lightSlider.value) !== state.lightIntensity) {
    lightSlider.value = String(state.lightIntensity)
    lightNumber.value = String(state.lightIntensity)
    updateSliderFill(lightSlider)
  }
  if (document.activeElement !== ambientNumber && Number(ambientSlider.value) !== state.ambientIntensity) {
    ambientSlider.value = String(state.ambientIntensity)
    ambientNumber.value = String(state.ambientIntensity)
    updateSliderFill(ambientSlider)
  }
})

updateSliderFill(lightSlider)
updateSliderFill(ambientSlider)

// ---------- Events: projection / presets ----------
btnPerspective.addEventListener('click', () => engine.toggleProjectionMode('perspective'))
btnOrthographic.addEventListener('click', () => engine.toggleProjectionMode('orthographic'))
;(
  Object.entries(presetButtons) as [Exclude<PresetView, 'none'>, HTMLElement][]
).forEach(([view, node]) => {
  node.addEventListener('click', () => engine.setPresetView(view))
})

// ---------- Events: texture ----------
btnTexture.addEventListener('click', () => engine.applyTextureMode('贴图' as TextureMode))
btnWhite.addEventListener('click', () => engine.applyTextureMode('白膜' as TextureMode))
btnNormal.addEventListener('click', () => engine.applyTextureMode('法线' as TextureMode))
btnAlbedo.addEventListener('click', () => engine.applyTextureMode('反照' as TextureMode))

// ---------- Events: light angle drag ----------
function calculateAngle(event: MouseEvent | TouchEvent, element: HTMLElement): number {
  const rect = element.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height / 2
  const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX
  const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY
  const deltaX = clientX - centerX
  const deltaY = clientY - centerY
  let calculatedAngle = Math.atan2(deltaY, deltaX) * (180 / Math.PI)
  calculatedAngle = (calculatedAngle + 90 + 360) % 360
  return calculatedAngle
}

let dragging = false

function onPointerDown(event: MouseEvent | TouchEvent) {
  dragging = true
  engine.setDragging(true)
  event.preventDefault()
  engine.setLightAngle(calculateAngle(event, shaderRound))
}

function onPointerMove(event: MouseEvent | TouchEvent) {
  if (!dragging) return
  event.preventDefault()
  engine.setLightAngle(calculateAngle(event, shaderRound))
}

function onPointerUp() {
  if (!dragging) return
  dragging = false
  engine.setDragging(false)
}

shaderRound.addEventListener('mousedown', onPointerDown)
shaderRound.addEventListener('touchstart', onPointerDown, { passive: false })
document.addEventListener('mousemove', onPointerMove)
document.addEventListener('mouseup', onPointerUp)
document.addEventListener('touchmove', onPointerMove, { passive: false })
document.addEventListener('touchend', onPointerUp)

// ---------- Events: sliders ----------
function bindSlider(
  slider: HTMLInputElement,
  number: HTMLInputElement,
  apply: (value: number) => void
) {
  const sync = (raw: string | number) => {
    let value = Number(raw)
    if (Number.isNaN(value)) value = 0
    value = Math.min(20, Math.max(0, Math.round(value * 100) / 100))
    slider.value = String(value)
    number.value = String(value)
    updateSliderFill(slider)
    apply(value)
  }
  slider.addEventListener('input', () => sync(slider.value))
  number.addEventListener('change', () => sync(number.value))
  number.addEventListener('blur', () => sync(number.value))
}

bindSlider(lightSlider, lightNumber, (v) => engine.setLightIntensity(v))
bindSlider(ambientSlider, ambientNumber, (v) => engine.setAmbientIntensity(v))

// ---------- Events: screenshot / import / export ----------
let screenshotting = false
btnScreenshot.addEventListener('click', async () => {
  if (screenshotting) return
  if (!engine.state.ready) {
    toast('请先导入模型', 'warn')
    return
  }
  screenshotting = true
  btnScreenshot.classList.add('is-disabled')
  try {
    const blob = await engine.captureScreenshot()
    const timestamp = Date.now()
    downloadBlob(blob, `screenshot_${timestamp}.png`)
    toast('截图已下载', 'success')
  } catch (error) {
    console.error(error)
    toast('截图失败，请重试', 'error')
  } finally {
    screenshotting = false
    btnScreenshot.classList.remove('is-disabled')
  }
})

btnImport.addEventListener('click', () => fileInput.click())

fileInput.addEventListener('change', async () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (!file) return
  if (!isSupportedModelFile(file)) {
    toast('不支持的格式。支持：GLB/GLTF/OBJ/FBX/STL/PLY/DAE/3MF/3DS/ZIP', 'error')
    return
  }
  try {
    await engine.loadFromFile(file)
    const entry = engine.state.entryName
    const base = engine.state.fileName
    const msg =
      entry && entry !== base
        ? `已加载 ${base} → ${entry}`
        : `模型加载成功：${base}`
    toast(msg, 'success')
    if (engine.state.materialStatus.includes('缺失') || engine.state.materialStatus === '默认材质') {
      toast(`材质：${engine.state.materialStatus}`, 'warn')
    }
  } catch (error) {
    console.error(error)
    const reason = error instanceof Error ? error.message : '模型加载失败，请重试'
    toast(reason, 'error')
  }
})

btnExport.addEventListener('click', () => {
  const blob = engine.exportCurrentModel()
  if (!blob) {
    toast('暂无可导出的模型文件，请先导入', 'warn')
    return
  }
  const name = engine.state.fileName || `model_${Date.now()}`
  downloadBlob(blob, name)
  toast('导出成功', 'success')
})

// Initial render once container has size
requestAnimationFrame(() => {
  window.dispatchEvent(new Event('resize'))
})
