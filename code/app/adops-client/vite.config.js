import process from 'node:process'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

function localBasicAuthHeader(env) {
  const username = env.ADOPS_LOCAL_BASIC_AUTH_USER || 'alice'
  const password = env.ADOPS_LOCAL_BASIC_AUTH_PASSWORD || ''
  const token = Buffer.from(`${username}:${password}`).toString('base64')

  return `Basic ${token}`
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // AdoptOps CAP dev servers own port 4104 (ChronoPilot owns 4004).
  const capServer = env.VITE_ADOPS_CAP_SERVER || 'http://localhost:4104'
  const localAuthHeader = localBasicAuthHeader(env)

  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [react()],
    build: {
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'ui5-icons',
                test: /node_modules[\\/]@ui5[\\/]webcomponents-icons/,
                priority: 30,
              },
              {
                name: 'ui5-base',
                test: /node_modules[\\/]@ui5[\\/]webcomponents-base/,
                priority: 20,
              },
              {
                name: 'ui5-shell-components',
                test: /node_modules[\\/]@ui5[\\/]webcomponents[\\/]dist[\\/](?:Avatar|Dialog|Icon|Input|Popover|ShellBar|ShellBarItem|Text|Toast|Title)\.js$/,
                priority: 18,
              },
              {
                name: 'react-runtime',
                test: /node_modules[\\/](?:react|react-dom|react-router|react-router-dom|scheduler)/,
                priority: 15,
              },
            ],
          },
        },
      },
    },
    server: {
      port: Number(process.env.PORT) || 5273,
      proxy: {
        // PublicService: the business front door. Deployed, the approuter
        // routes /fiori the same way.
        '/fiori': {
          target: capServer,
          changeOrigin: true,
          headers: {
            Authorization: localAuthHeader,
          },
        },
        // CoreService: role-less endpoints (userInfo, access requests,
        // telemetry). Deployed, the approuter routes /core the same way.
        '/core': {
          target: capServer,
          changeOrigin: true,
          headers: {
            Authorization: localAuthHeader,
          },
        },
        // AdminService (Settings, Product Insights). The deployed approuter
        // already routes /catalog to the CAP service; this mirrors that locally.
        '/catalog': {
          target: capServer,
          changeOrigin: true,
          headers: {
            Authorization: localAuthHeader,
          },
        },
      },
    },
  }
})
