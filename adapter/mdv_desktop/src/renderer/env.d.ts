import type { MdvDesktopApi } from '../shared/ipc.js'

declare global {
  interface Window {
    readonly mdvDesktop: MdvDesktopApi
  }
}

export {}
