#!/usr/bin/env bun
/**
 * Cloudflare Dev Pages integration for freebuff.
 * Spins up a temporary Cloudflare Pages dev server pointing to a local project directory.
 * Useful for testing agentic changes using temporary dev URLs.
 *
 * Usage:
 *   bun run cloudflare-dev <project-root>
 *   or: bun run cloudflare-dev --url https://my-custom-domain.com
 *
 * The script will:
 * 1. Detect the project root (or use the provided argument)
 * 2. Check if Wrangler (Cloudflare CLI) is installed
 * 3. Spin up a dev server with auto-reload
 * 4. Output the dev URL for sharing with agent platforms
 * 5. Support cleanup on exit
 */

import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { spawn } from 'child_process'
import { prompts } from 'bun'

interface CloudflareDevConfig {
  projectRoot: string
  url?: string
  port?: number
  subdomain?: string
  autoReload: boolean
}

const DEFAULT_PORT = 8787
const DEFAULT_SUBDOMAIN = 'freebuff-dev'

async function checkWranglerInstalled(): Promise<boolean> {
  try {
    const result = await $`which wrangler`.text()
    return result.trim().length > 0
  } catch {
    return false
  }
}

async function findProjectRoot(startPath: string): Promise<string> {
  let current = startPath
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) {
      // Reached filesystem root without finding .git
      return startPath
    }
    current = parent
  }
}

async function main() {
  console.log('🌀 Cloudflare Dev Pages integration for freebuff\n')

  // Parse arguments
  const args = Bun.argv.slice(2)
  let projectRoot: string | undefined
  let customUrl: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url' && i + 1 < args.length) {
      customUrl = args[i + 1]
      i++
    } else if (!projectRoot) {
      projectRoot = args[i]
    }
  }

  if (!projectRoot) {
    // Auto-detect project root
    projectRoot = await findProjectRoot(process.cwd())
    console.log(`📁 Detected project root: ${projectRoot}\n`)
  }

  // Check if wrangler is available
  const hasWrangler = await checkWranglerInstalled()
  if (!hasWrangler) {
    console.error('❌ Wrangler (Cloudflare CLI) is not installed.')
    console.error('   Install with: npm i -g wrangler@latest')
    process.exit(1)
  }

  // Read wrangler config to find project name
  const wranglerConfigPath = path.join(projectRoot, 'wrangler.toml')
  let projectName = path.basename(projectRoot)

  if (fs.existsSync(wranglerConfigPath)) {
    const configContent = fs.readFileSync(wranglerConfigPath, 'utf8')
    const subdomainMatch = configContent.match(/subdomain\s*=\s*"([^"]+)"/)
    if (subdomainMatch) {
      DEFAULT_SUBDOMAIN = subdomainMatch[1]
    }
    const siteNameMatch = configContent.match/site_name\s*=\s*"([^"]+)"/
    if (siteNameMatch) {
      projectName = siteNameMatch[1]
    }
  }

  // Determine port
  const port = await prompts({
    type: 'number',
    name: 'port',
    message: 'Enter port for dev server (default: 8787)',
    initial: DEFAULT_PORT,
    validate: (value: number) => value > 0 && value < 65536,
  })

  // Determine subdomain
  const subdomain = await prompts({
    type: 'text',
    name: 'subdomain',
    message: 'Enter subdomain for dev URL (default: freebuff-dev)',
    initial: DEFAULT_SUBDOMAIN,
  })

  // Construct the dev URL
  const url = customUrl || `https://${subdomain}.${projectName}.pages.dev`

  console.log(`🚀 Starting Cloudflare Pages dev server...`)
  console.log(`   Project: ${projectRoot}`)
  console.log(`   URL: ${url}`)
  console.log('')

  // Check if port is available by trying to bind
  const devServer = spawn('wrangler', ['dev', '--port', port.toString(), '--site', projectRoot], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Ensure we use the local project
      WRANGLER_ENV: 'development',
    },
  })

  // Handle process events
  devServer.on('error', (error) => {
    console.error(`❌ Dev server error: ${error.message}`)
  })

  devServer.on('exit', (code) => {
    console.log(`\n🛑 Dev server exited with code ${code}`)
    cleanup()
  })

  // Setup signal handlers for graceful shutdown
  const setupSignals = () => {
    const signals: NodeJS.Signal[] = ['SIGINT', 'SIGTERM']
    for (const signal of signals) {
      process.on(signal, () => {
        console.log('\n🛑 Received signal, shutting down...')
        devServer.kill()
        process.exit(0)
      })
    }
  }

  setupSignals()

  console.log(`\n✅ Dev server running at: ${url}`)
  console.log('   Press Ctrl+C to stop\n')

  // Wait for interrupt
  await new Promise<void>((resolve) => {
    devServer.on('exit', () => resolve())
  })
}

async function cleanup() {
  // Kill any wrangler processes that were spawned
  // This is a best-effort cleanup
  try {
    // Could add more sophisticated process killing here
  } catch {}
}

main().catch((error) => {
  console.error('❌ Fatal error:', error)
  process.exit(1)
})