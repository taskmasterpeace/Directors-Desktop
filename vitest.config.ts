import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@openreel/core': path.resolve(__dirname, './vendor/openreel-core/src'),
    },
  },
  test: {
    // Pure-function suites are DOM-free; the caret-mirror utility is excluded (needs jsdom).
    // The vendored OpenReel core's own tests are NOT run here — only our smoke suite,
    // which proves the alias + deps + engines work inside DD's harness.
    environment: 'node',
    // electron/ is included so the main-process export path (ffmpeg filter
    // building) is covered too — it had no tests, which is how burned-in
    // captions silently dropped bold/italic for five of six presets.
    include: [
      'frontend/**/*.test.ts',
      'electron/**/*.test.ts',
      'vendor/openreel-core/smoke/**/*.test.ts',
    ],
    watch: false,
  },
})
