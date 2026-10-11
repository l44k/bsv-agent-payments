// provider.js
// The "seller" agent. Advertises a price for one unit of a service.
// In this demo the "service" is just a random fact, but swap fetchService()
// for anything: an API call, a compute job, a data lookup, etc.

const { PrivateKey } = require('@bsv/sdk')

// --- CONFIG: paste your PROVIDER wallet from `node wallet.js` here ---
const PROVIDER_WIF = 'PASTE_PROVIDER_WIF_HERE'
const PRICE_SATS = 100 // price per service call, in satoshis (a few thousandths of a cent)

const priv = PrivateKey.fromWif(PROVIDER_WIF)
const address = priv.toPublicKey().toAddress('testnet').toString()

const facts = [
  'A day on Venus is longer than a year on Venus.',
  'Honey never spoils.',
  'Octopuses have three hearts.',
  'Bananas are berries, but strawberries are not.'
]

function fetchService() {
  return facts[Math.floor(Math.random() * facts.length)]
}

// In a real deployment this runs as an HTTP/agent-to-agent endpoint.
// Here we simulate the check synchronously so the flow is easy to read.
async function handleRequest(paymentTxHex) {
  console.log(`[provider] Received payment tx, checking amount and destination...`)

  // A real implementation verifies the tx on-chain via a broadcaster/indexer
  // (e.g. WhatsOnChain API) before releasing the result. See README.
  const verified = await verifyPayment(paymentTxHex, address, PRICE_SATS)

  if (!verified) {
    console.log('[provider] Payment not valid or insufficient. Refusing service.')
    return null
  }

  const result = fetchService()
  console.log(`[provider] Payment verified. Releasing result: "${result}"`)
  return result
}

// Placeholder verification hook — wire this to WhatsOnChain / your own node
// to check the tx actually pays >= PRICE_SATS to `address` and has confirmed
// (or is accepted 0-conf, which BSV supports for instant micropayments).
async function verifyPayment(paymentTxHex, expectedAddress, minSats) {
  console.log(`[provider] (stub) would verify tx pays >= ${minSats} sats to ${expectedAddress}`)
  return true // demo stub — see README for real verification
}

console.log(`[provider] Ready. Selling facts for ${PRICE_SATS} sats each.`)
console.log(`[provider] Pay to: ${address}`)

module.exports = { handleRequest, address, PRICE_SATS }
