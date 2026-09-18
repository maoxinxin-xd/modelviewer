/** Inline SVG icons for the default UI — no external asset loading. */

const svg = (paths: string, size = 18, fill = 'currentColor') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${paths.split('currentColor').join(fill)}</svg>`

export const icons = {
  perspective: svg(
    `<path d="M8.25 1.65c1.07-.64 2.41-.55 3.4.22l3.72 2.95c.72.57 1.14 1.43 1.14 2.35v3.49c0 .9-.4 1.74-1.09 2.31l-3.72 3.07c-1 .82-2.4.91-3.5.23L2.92 13.02A3.2 3.2 0 0 1 1.5 10.47V7.36c0-1.06.56-2.04 1.47-2.58L8.25 1.65Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9 2.95v12.07" stroke="currentColor" stroke-width="1.4"/>`,
    18,
    '#745EF5'
  ),
  orthographic: svg(
    `<rect x="2" y="2" width="14" height="14" rx="2.5" stroke="currentColor" stroke-width="1.4"/><path d="M2 9h14M9 2v14" stroke="currentColor" stroke-width="1.4" opacity=".55"/>`,
    18,
    '#745EF5'
  ),
  front: svg(
    `<rect x="4" y="3" width="10" height="14" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M7 7h4M7 10h4M7 13h2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
    28
  ),
  back: svg(
    `<rect x="4" y="3" width="10" height="14" rx="1.5" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="2.2" stroke="currentColor" stroke-width="1.4"/>`,
    28
  ),
  side: svg(
    `<path d="M5 4h8v12H5z" stroke="currentColor" stroke-width="1.5"/><path d="M13 7l3 2v4l-3 2V7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>`,
    28
  ),
  top: svg(
    `<rect x="3" y="5" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M3 8h12M7 5v10" stroke="currentColor" stroke-width="1.3" opacity=".7"/>`,
    28
  ),
  textured: svg(
    `<circle cx="9" cy="9" r="6.5" fill="#5b8def"/><circle cx="9" cy="9" r="6.5" fill="url(#g)" opacity=".35"/><defs><linearGradient id="g" x1="3" y1="3" x2="15" y2="15"><stop stop-color="#fff"/><stop offset="1" stop-color="#2a4a8a"/></linearGradient></defs>`,
    18
  ),
  clay: svg(
    `<circle cx="9" cy="9" r="6.5" fill="#d8d8d8"/><circle cx="7" cy="7" r="2" fill="#fff" opacity=".55"/>`,
    18
  ),
  normal: svg(
    `<circle cx="9" cy="9" r="6.5" fill="#8b7cf6"/><path d="M5 10c1.5-3 3-4 4-4s2.5 1 4 4" stroke="#f0abfc" stroke-width="1.4" stroke-linecap="round"/>`,
    18
  ),
  albedo: svg(
    `<circle cx="9" cy="9" r="6.5" fill="#f0f0f0"/><circle cx="9" cy="9" r="3" fill="#c8c8c8"/>`,
    18
  ),
  screenshot: svg(
    `<rect x="2.5" y="4" width="13" height="10.5" rx="1.5" stroke="currentColor" stroke-width="1.4"/><circle cx="9" cy="9.25" r="2.4" stroke="currentColor" stroke-width="1.4"/><circle cx="13.2" cy="6.3" r=".7" fill="currentColor"/>`,
    18
  )
} as const
