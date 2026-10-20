import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// KaTeX's stylesheet lists every font three times (woff2, woff, ttf). Every
// browser this app supports reads woff2, so the other two are dropped before
// bundling; otherwise they add ~3 MB of never-fetched files to every build,
// Docker image and desktop package.
function katexWoff2Only(): Plugin {
  return {
    name: 'katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/katex(\.min)?\.css(\?|$)/.test(id)) return null
      return code
        .replace(/,url\([^)]*\.woff\)\s*format\(["']woff["']\)/g, '')
        .replace(/,url\([^)]*\.ttf\)\s*format\(["']truetype["']\)/g, '')
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const serverPort = env.PORT ?? process.env.PORT ?? 3001

  return {
    plugins: [katexWoff2Only(), react(), tailwindcss()],
    build: {
      // Never inline fonts as data: URIs: the server's CSP is font-src 'self',
      // which blocks them (KaTeX's smallest fonts fell under the default
      // 4 kB inline limit and silently failed to load). undefined keeps
      // Vite's default for everything else.
      assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
    },
    base: process.env.VITE_BASE ?? '/',
    envDir: path.resolve(__dirname, '..'),
    define: {
      __SERVER_PORT__: JSON.stringify(String(serverPort)),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        // Force IPv4 — on Windows + Node 17+, `localhost` resolves to ::1 first,
        // which can collide with wslrelay / Docker Desktop listeners on the same port.
        '/api': `http://127.0.0.1:${serverPort}`,
        '/v1': `http://127.0.0.1:${serverPort}`,
      },
    },
  }
})
