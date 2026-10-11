// negotiate.js
// The bargaining protocol, shared by full-pipeline.js and run-negotiation.js.
//
// Alternating offers over at most `rounds` rounds. Both sides concede a
// little each round:
//
//   provider: starts at its ask and concedes linearly to its floor by the
//             last round (the floor is private to the provider)
//   consumer: opens at `openFactor` x ask and concedes linearly up to its
//             ceiling = min(budget, ask)
//
// In every round the consumer makes an offer. The provider accepts it if it
// meets the provider's current price, otherwise it counters with that price.
// The consumer takes the counter if it is no more than what it would have
// offered next anyway (so it never pays more than it has to), otherwise the
// next round starts. A deal is therefore always between the provider's floor
// and the consumer's ceiling, and no deal is possible when the budget is
// below the floor.

const { PROVIDERS } = require('./providers')

const ROUNDS = 5
const OPEN_FACTOR = 0.5

// Provider's current price: `ask` in round 0, `floor` in the last round.
function providerPrice(quote, round, rounds) {
  const t = rounds <= 1 ? 1 : round / (rounds - 1)
  return Math.round(quote.ask - (quote.ask - quote.floor) * t)
}

// Consumer's planned offer for a round, rising from the opening offer to the ceiling.
function consumerOffer(quote, ceiling, round, rounds, openFactor) {
  const open = Math.min(Math.round(quote.ask * openFactor), ceiling)
  const t = rounds <= 1 ? 1 : round / (rounds - 1)
  return Math.round(open + (ceiling - open) * t)
}

// Negotiate one request with one provider. `input` is what the provider will
// be asked to do; its quote depends on it. Returns price = null if no deal.
function negotiate(provider, input, budgetSats, { rounds = ROUNDS, openFactor = OPEN_FACTOR } = {}) {
  const quote = provider.quote(input)
  const ceiling = Math.min(budgetSats, quote.ask)
  const transcript = []

  const done = (price, outcome, roundsUsed, extra = {}) => ({ provider, quote, price, outcome, rounds: roundsUsed, transcript, ...extra })

  for (let r = 0; r < rounds; r++) {
    const offer = consumerOffer(quote, ceiling, r, rounds, openFactor)
    const target = providerPrice(quote, r, rounds)

    if (offer >= target) {
      transcript.push(`round ${r + 1}: I offer ${offer} -> accepted`)
      return done(offer, 'offer accepted', r + 1)
    }
    transcript.push(`round ${r + 1}: I offer ${offer} -> counter ${target}`)

    const nextPlanned = r < rounds - 1 ? consumerOffer(quote, ceiling, r + 1, rounds, openFactor) : ceiling
    if (target <= nextPlanned) {
      transcript.push(`round ${r + 1}: counter ${target} is within my next offer (${nextPlanned}) -> I accept`)
      return done(target, 'counter accepted', r + 1)
    }
  }
  const last = providerPrice(quote, rounds - 1, rounds)
  transcript.push(`no deal: provider's last price ${last} is above my ceiling ${ceiling}`)
  return done(null, 'no deal', rounds, { lastPrice: last, ceiling })
}

// Negotiate with every provider of a service type and pick the cheapest deal.
// (Used by the offline demo run-negotiation.js.)
function findBestDeal(input, budgetSats, taskType) {
  const candidates = PROVIDERS.filter(p => p.type === taskType)
  console.log(`\n[consumer] Task: "${input.slice(0, 60)}" (needs: ${taskType}). Budget: ${budgetSats} sats. Querying ${candidates.length} provider(s)...\n`)

  const results = candidates.map(provider => {
    const n = negotiate(provider, input, budgetSats)
    console.log(`[consumer] ${provider.id}: ask ${n.quote.ask} -> ${n.price === null ? 'no deal' : `deal at ${n.price} (${n.outcome}, ${n.rounds} rounds)`}`)
    n.transcript.forEach(line => console.log(`    ${line}`))
    return n
  })

  const viable = results.filter(r => r.price !== null).sort((a, b) => a.price - b.price)
  if (viable.length === 0) {
    console.log(`\n[consumer] No provider agreed within budget. Task not completed.`)
    return null
  }
  const winner = viable[0]
  console.log(`\n[consumer] Best deal: ${winner.provider.id} at ${winner.price} sats (of ${viable.length} viable offers).`)
  return { provider: winner.provider, agreedPrice: winner.price, negotiation: winner }
}

module.exports = { negotiate, findBestDeal, providerPrice, consumerOffer, ROUNDS, OPEN_FACTOR }
