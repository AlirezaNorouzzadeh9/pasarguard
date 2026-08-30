import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'
import path from 'path'

export default defineConfig({
  base: process.env.BASE_URL,
  clearScreen: false,
  server: {
    host: true,
  },
  build: {
    outDir: 'build',
    assetsDir: 'statics',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replace(/\\/g, '/')

          if (
            normalizedId.includes('/node_modules/react/') ||
            normalizedId.includes('/node_modules/react-dom/') ||
            normalizedId.includes('/node_modules/scheduler/') ||
            normalizedId.includes('react-dom/index.js?commonjs-es-import')
          ) {
            return 'react'
          }

          if (normalizedId.includes('/node_modules/react-router/') || normalizedId.includes('/node_modules/react-router-dom/')) {
            return 'react-router'
          }

          if (normalizedId.includes('/node_modules/@tanstack/react-query/') || normalizedId.includes('/node_modules/@tanstack/query-core/')) {
            return 'react-query'
          }

          if (normalizedId.includes('/node_modules/recharts/')) {
            return 'recharts'
          }

          if (normalizedId.includes('/node_modules/@radix-ui/react-slot/')) {
            return 'radix-slot'
          }

          if (
            normalizedId.includes('/node_modules/@radix-ui/react-dialog/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-alert-dialog/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-toast/')
          ) {
            return 'radix-dialog'
          }

          if (
            normalizedId.includes('/node_modules/@radix-ui/react-popover/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-dropdown-menu/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-hover-card/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-tooltip/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-select/')
          ) {
            return 'radix-popover'
          }

          if (
            normalizedId.includes('/node_modules/@radix-ui/react-tabs/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-accordion/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-collapsible/')
          ) {
            return 'radix-navigation'
          }

          if (
            normalizedId.includes('/node_modules/@radix-ui/react-checkbox/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-radio-group/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-switch/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-label/')
          ) {
            return 'radix-forms'
          }

          if (
            normalizedId.includes('/node_modules/@radix-ui/react-scroll-area/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-separator/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-progress/') ||
            normalizedId.includes('/node_modules/@radix-ui/react-avatar/')
          ) {
            return 'radix-layout'
          }

          if (normalizedId.includes('/node_modules/@radix-ui/react-toggle/') || normalizedId.includes('/node_modules/@radix-ui/react-toggle-group/')) {
            return 'radix-toggle'
          }

          if (
            normalizedId.includes('/node_modules/i18next/') ||
            normalizedId.includes('/node_modules/react-i18next/') ||
            normalizedId.includes('/node_modules/i18next-browser-languagedetector/') ||
            normalizedId.includes('/node_modules/i18next-http-backend/')
          ) {
            return 'i18n'
          }

          if (normalizedId.includes('/node_modules/lodash.debounce/')) {
            return 'lodash'
          }

          if (normalizedId.includes('/node_modules/dayjs/')) {
            return 'dayjs'
          }

          if (
            normalizedId.includes('/node_modules/clsx/') ||
            normalizedId.includes('/node_modules/uuid/') ||
            normalizedId.includes('/node_modules/date-fns/') ||
            normalizedId.includes('/node_modules/date-fns-jalali/')
          ) {
            return 'utils'
          }
        },
      },
    },
  },
  resolve: {
    tsconfigPaths: true,
    alias: [
      {
        find: '@',
        replacement: path.resolve(__dirname, 'src'),
      },
    ],
  },
  // No service worker: the dashboard is served from base "/" but mounted under
  // "/dashboard/", so a Workbox SW registered at "/sw.js" (root) 404s and gets
  // stuck, serving a stale app shell ("Cannot read properties of undefined
  // (reading 'default')") that no refresh can fix. An admin panel gains nothing
  // from offline/installability, so we drop the PWA entirely and always serve
  // fresh from the network. A self-destroying "/sw.js" (see dashboard/__init__.py)
  // cleans up any service worker left over from earlier builds.
  plugins: [
    tailwindcss(),
    react(),
    svgr(),
  ],
})
