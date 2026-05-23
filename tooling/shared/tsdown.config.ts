import { defineConfig } from 'tsdown'

export default defineConfig({
  platform: 'node',
  exports: true,
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
})
