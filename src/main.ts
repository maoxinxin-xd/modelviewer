/**
 * Demo entry — thin host around the SDK default UI.
 * This file is NOT part of the published library API.
 */
import { createModelViewer } from './index'

const app = document.getElementById('app')
if (!app) throw new Error('missing #app')

// Full-page demo container
app.style.width = '100%'
app.style.height = '100%'
app.style.overflow = 'hidden'

createModelViewer(app, {
  locale: 'zh-CN',
  theme: {
    primary: '#745ef5'
  }
})
