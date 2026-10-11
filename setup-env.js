// setup-env.js
// Generates 4 testnet keypairs and writes them to .env (never overwrites).
// Prints only the CONSUMER address — that's the one to fund from the faucet.
const fs = require('fs')
const { PrivateKey } = require('@bsv/sdk')

if (fs.existsSync('.env')) {
  console.error('.env already exists — not overwriting. Delete it first if you want fresh keys.')
  process.exit(1)
}

const names = ['CONSUMER', 'PROVIDER_SUMMARIZER', 'PROVIDER_ANALYSIS', 'PROVIDER_COMPUTE']
let out = '# Testnet keys. Never commit or share this file.\n'
let consumerAddress = ''

for (const n of names) {
  const key = PrivateKey.fromRandom()
  out += `${n}_WIF=${key.toWif()}\n`
  if (n === 'CONSUMER') consumerAddress = key.toPublicKey().toAddress('testnet').toString()
}
out += '\n# Paste your Claude API key here (leave empty = mock AI mode)\nANTHROPIC_API_KEY=\n'

fs.writeFileSync('.env', out, { mode: 0o600 })
console.log('.env created.')
console.log('Fund this CONSUMER address from a testnet faucet:')
console.log(consumerAddress)
