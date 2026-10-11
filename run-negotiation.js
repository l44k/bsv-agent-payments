// run-negotiation.js
// Full flow: consumer agent has a task and a budget, negotiates with all
// providers, pays the winner (reusing the real payment code from
// consumer.js / provider.js), and receives the service result.
//
// Run: node run-negotiation.js

const { findBestDeal } = require('./negotiate')
const { PROVIDERS } = require('./providers')
const { quoteSats } = require('./pricing')

// A few tasks the agent needs done this "session" — each triggers its own
// independent negotiation across all providers.
const TASKS = [
  { description: 'Summarize customer feedback batch #4', budget: quoteSats(0.00042), type: 'summarize' },
  { description: 'Look up matching product records', budget: quoteSats(0.0005), type: 'lookup' },
  { description: 'Run pricing calculation', budget: quoteSats(0.000105), type: 'compute' }, // deliberately tight — should fail
]

async function runSession() {
  console.log('=== Agent negotiation session start ===')
  let totalSpent = 0
  let totalRealCost = 0
  let completed = 0

  for (const task of TASKS) {
    const deal = findBestDeal(task.description, task.budget, task.type)

    if (!deal) {
      console.log(`[session] Skipping task "${task.description}" — no affordable provider.\n`)
      console.log('---')
      continue
    }

    // --- Payment step ---
    // In the live version this calls the same tx-build/sign/broadcast code
    // as consumer.js, paying deal.agreedPrice sats to deal.provider's address,
    // then deal.provider.perform() only runs after payment is verified.
    console.log(`[session] Paying ${deal.provider.id} ${deal.agreedPrice} sats...`)
    const result = await deal.provider.perform(task.description)
    console.log(`[session] Received: ${result.text}`)
    console.log(`[session] Real cost: ${result.actualCostSats} sats (quoted: ${deal.agreedPrice} sats)${result.mocked ? ' [mocked — set ANTHROPIC_API_KEY for real calls]' : ''}\n`)

    totalSpent += deal.agreedPrice
    totalRealCost += result.actualCostSats
    completed++
    console.log('---')
  }

  console.log(`=== Session complete ===`)
  console.log(`Tasks completed: ${completed}/${TASKS.length}`)
  console.log(`Total quoted/paid: ${totalSpent} sats`)
  console.log(`Total real API cost: ${totalRealCost} sats`)
  console.log(`Margin captured by providers: ${totalSpent - totalRealCost} sats`)
}

runSession()
