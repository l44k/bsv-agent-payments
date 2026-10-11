// add-agents.js
// Adds any provider wallets required by providers.js that are missing from
// .env, without touching existing lines (CONSUMER_WIF and anything already
// funded stay exactly as they are). Safe to rerun any time you add a new
// provider to providers.js.

const fs = require('fs')
const { PrivateKey } = require('@bsv/sdk')
const { PROVIDERS } = require('./providers')

const ENV_PATH = '.env'

if (!fs.existsSync(ENV_PATH)) {
  console.error('.env not found — run `node setup-env.js` first.')
  process.exit(1)
}

let content = fs.readFileSync(ENV_PATH, 'utf8')
const existingVars = new Set(
  content
    .split('\n')
    .map(line => line.split('=')[0].trim())
    .filter(Boolean)
)

let added = []
for (const provider of PROVIDERS) {
  if (existingVars.has(provider.envVar)) continue
  const wif = PrivateKey.fromRandom().toWif()
  content += `${provider.envVar}=${wif}\n`
  added.push(provider.envVar)
}

if (added.length === 0) {
  console.log('Nothing to add — all provider wallets already in .env.')
} else {
  fs.writeFileSync(ENV_PATH, content, { mode: 0o600 })
  console.log(`Added ${added.length} new provider wallet(s) to .env:`)
  added.forEach(v => console.log(`  ${v}`))
  console.log('\nNo funding needed for these — providers only receive payments.')
}
