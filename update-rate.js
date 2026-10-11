// update-rate.js
// Free, direct refresh of the BSV/USD rate: no agents, no payment, no
// negotiation. Writes rate.json, which pricing.js reads on every conversion.
//
//   node update-rate.js              one refresh, then exit
//   node update-rate.js --watch      keep refreshing every 60 s (Ctrl+C to stop)
//   node update-rate.js --watch 30   ...every 30 s (minimum 5)
//
// Run --watch in a second terminal and the rate stays live while you run
// full-pipeline.js as often as you like. A failed refresh keeps the last
// good rate and retries on the next tick.

const { fetchRateFromChain, saveRate, describeRate } = require('./rate')

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const stamp = () => new Date().toLocaleTimeString('fi-FI')

async function refreshOnce() {
  const { bsvUsd, sourceTime } = await fetchRateFromChain()
  // Direct fetch from the source itself is trusted, so the 2x sanity guard
  // is skipped (it exists for rates bought from other agents).
  const saved = saveRate(bsvUsd, { source: 'direct:whatsonchain', sourceTime }, { guard: false })
  if (!saved.ok) throw new Error(saved.reason)
  return { bsvUsd, sourceTime, previous: saved.record.previous }
}

async function main() {
  const args = process.argv.slice(2)
  const watchAt = args.indexOf('--watch')
  console.log(`Current rate: ${describeRate()}`)

  if (watchAt === -1) {
    const r = await refreshOnce()
    console.log(`Updated: 1 BSV = $${r.bsvUsd}${r.sourceTime ? ` (source time ${r.sourceTime})` : ''}`)
    return
  }

  const seconds = Math.max(5, Number(args[watchAt + 1]) || 60)
  console.log(`Watching: refreshing every ${seconds} s. Ctrl+C to stop.\n`)
  for (;;) {
    try {
      const r = await refreshOnce()
      const changed = r.previous && r.previous !== r.bsvUsd ? ` (was $${r.previous})` : ''
      console.log(`[${stamp()}] 1 BSV = $${r.bsvUsd}${changed}`)
    } catch (err) {
      console.error(`[${stamp()}] refresh failed: ${err.message} — keeping ${describeRate()}`)
    }
    await sleep(seconds * 1000)
  }
}

main().catch(err => {
  console.error(`Rate update failed: ${err.message} — rate.json left unchanged.`)
  process.exit(1)
})
