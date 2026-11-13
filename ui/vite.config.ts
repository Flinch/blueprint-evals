import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// The front end builds into <package>/dist/ui, where the server serves it from.
// `tsc` also writes the compiled api-types there, so the directory is never
// emptied (emptyOutDir: false). Only the files this build owns are cleared, so
// old hashed assets do not pile up.

const outDir = resolve(import.meta.dirname, '..', 'dist', 'ui')

function cleanOwnOutput(): Plugin {
  let dir = outDir
  return {
    name: 'clean-own-output',
    apply: 'build',
    configResolved(config) {
      dir = resolve(config.root, config.build.outDir)
    },
    buildStart() {
      rmSync(resolve(dir, 'assets'), { recursive: true, force: true })
      rmSync(resolve(dir, 'index.html'), { force: true })
    },
  }
}

// `npm run dev:ui` proxies /api to a running `evals ui`. Give it the URL that
// `evals ui` printed (it ends in ?token=...):
//
//   EVALS_UI_URL='http://127.0.0.1:4747/?token=...' npm run dev:ui
//
// The proxy sends the token in a header and presents the target's own Origin, so
// the server's checks pass. The token stays in this process and never reaches
// the browser.
function proxyTarget(): { target: string; token: string | null } {
  const raw = process.env.EVALS_UI_URL ?? 'http://127.0.0.1:4747'
  try {
    const url = new URL(raw)
    return { target: url.origin, token: url.searchParams.get('token') }
  } catch {
    return { target: 'http://127.0.0.1:4747', token: null }
  }
}

const { target, token } = proxyTarget()

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), cleanOwnOutput()],
  base: '/',
  build: {
    outDir,
    emptyOutDir: false,
    assetsInlineLimit: 0, // the server's CSP allows same-origin files, not data: fonts
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', req => {
            req.setHeader('origin', target)
            req.removeHeader('sec-fetch-site')
            if (token) req.setHeader('x-evals-token', token)
          })
        },
      },
    },
  },
})
