// verify.js
// Provider-side payment verification: confirms a broadcast tx actually pays
// >= the agreed amount to the provider's own address before releasing the
// service. This is the gate that makes "pay then deliver" real.
//
// A tx we just broadcast ourselves can briefly 404 on lookup before the
// indexer catches up, so this retries a few times before giving up rather
// than failing on the very first check.

const { getTxDetails } = require('./chain')

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function verifyPayment(txid, expectedAddress, minSats, { attempts = 4, delayMs = 2000 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const details = await getTxDetails(txid)
      const outputs = details.vout || []

      const matching = outputs.find(out => {
        const addrs = (out.scriptPubKey && out.scriptPubKey.addresses) || []
        const sats = Math.round(out.value * 1e8) // WhatsOnChain reports value in BSV
        return addrs.includes(expectedAddress) && sats >= minSats
      })

      if (matching) return true
      // tx found but no matching output yet — unlikely to change on retry,
      // but harmless to try once more in case of a partial/stale response
    } catch (err) {
      lastErr = err
    }
    if (i < attempts - 1) await sleep(delayMs)
  }
  if (lastErr) console.log(`[verify] Still failing after retries: ${lastErr.message}`)
  return false
}

module.exports = { verifyPayment }
