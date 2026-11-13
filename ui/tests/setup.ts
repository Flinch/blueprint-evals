import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => {
  cleanup()
  window.location.hash = ''
  try {
    window.localStorage.clear()
  } catch {
    // ignore
  }
})

// jsdom has no layout, so scrolling is a no-op.
Element.prototype.scrollIntoView = () => {}
