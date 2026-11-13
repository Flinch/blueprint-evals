import { defineConfig } from 'vitest/config'

// Two projects: the library, server and CLI tests run in node; the front end's
// component tests (ui/) need a DOM.
export default defineConfig({
  test: {
    projects: [{ test: { name: 'node', include: ['tests/**/*.test.ts'] } }, './ui/vitest.config.ts'],
  },
})
