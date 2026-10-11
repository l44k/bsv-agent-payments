// chain.js
// Talks to BSV testnet via WhatsOnChain's public API. No API key needed for
// basic reads/broadcasts, but be aware of their rate limits under heavy use.

const BASE = 'https://api.whatsonchain.com/v1/bsv/test'

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Testnet indexing can lag a few seconds behind broadcast/mempool state —
// retry a few times before giving up, instead of failing on the first miss.
async function withRetry(fn, { attempts = 4, delayMs = 2000 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts - 1) await sleep(delayMs)
    }
  }
  throw lastErr
}

// Confirmed AND unconfirmed UTXOs for an address, minus the ones a mempool
// transaction has already spent. The older /unspent endpoint has no such
// flag, so right after a payment it kept listing the coins we had just spent
// and the next payment was rejected as `txn-mempool-conflict` (a double
// spend). /unspent/all marks each output with `isSpentInMempoolTx`.
// (Confirmed results are paginated above 1000 outputs; a demo wallet never
// gets near that, so the next-page token is ignored.)
async function getUnspent(address, network = 'test') {
  if (network !== 'test' && network !== 'main') throw new Error(`unknown network: ${network}`)
  const base = network === 'test' ? BASE : 'https://api.whatsonchain.com/v1/bsv/main'
  const res = await fetch(`${base}/address/${address}/unspent/all`)
  if (!res.ok) throw new Error(`getUnspent failed: ${res.status}`)
  const data = await res.json()
  if (data && data.error) throw new Error(`getUnspent error: ${data.error}`)
  const items = Array.isArray(data) ? data : (data.result || [])
  return items
    .filter(u => !u.isSpentInMempoolTx)
    .map(u => ({ tx_hash: u.tx_hash, tx_pos: u.tx_pos, value: u.value, height: u.height }))
}

async function getTxDetails(txid) {
  const res = await fetch(`${BASE}/tx/hash/${txid}`)
  if (!res.ok) throw new Error(`getTxDetails failed: ${res.status}`)
  return res.json()
}

async function broadcastTx(txHex) {
  const res = await fetch(`${BASE}/tx/raw`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txhex: txHex })
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`broadcast failed: ${res.status} ${text}`)
  // WhatsOnChain answers with the txid as a JSON string followed by a newline.
  let txid = text.trim()
  try {
    const parsed = JSON.parse(txid)
    if (typeof parsed === 'string') txid = parsed
  } catch {
    txid = txid.replace(/"/g, '')
  }
  txid = txid.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(txid)) throw new Error(`broadcast returned an unexpected txid: ${JSON.stringify(text.slice(0, 100))}`)
  return txid
}

async function getRawTxHex(txid) {
  return withRetry(async () => {
    const res = await fetch(`${BASE}/tx/${txid}/hex`)
    if (!res.ok) throw new Error(`getRawTxHex failed: ${res.status}`)
    return res.text()
  })
}

module.exports = { getUnspent, getTxDetails, broadcastTx, getRawTxHex }
