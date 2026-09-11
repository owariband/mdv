import { fileURLToPath } from 'node:url'
import { defineConfig } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

const fromRoot = (path: string) => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: {
          index: fromRoot('./src/main/index.ts'),
          'mdv-session': fromRoot('./src/main/mdv-session.ts'),
          'markdown-session': fromRoot('./src/main/markdown-session.ts'),
          'folder-workspace': fromRoot('./src/main/folder-workspace.ts'),
        },
        external: ['electron'],
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: 'chunks/[name]-[hash].js',
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: fromRoot('./src/preload/index.ts'),
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    plugins: [vue()],
  },
})
