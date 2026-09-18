/// <reference types="vite/client" />

declare module '*.css?inline' {
  const css: string
  export default css
}

declare module 'occt-import-js' {
  type LocateFile = (path: string) => string
  type OcctFactory = (config?: { locateFile?: LocateFile }) => Promise<unknown>
  const factory: OcctFactory
  export default factory
}
