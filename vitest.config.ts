import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Pure-function suites are DOM-free; the caret-mirror utility is excluded (needs jsdom).
    environment: 'node',
    include: ['frontend/**/*.test.ts'],
    watch: false,
  },
})
