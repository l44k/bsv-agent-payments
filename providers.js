// providers.js
// Each provider is an agent selling one service. Instead of a fixed price
// list, a provider QUOTES a price for the specific request it is asked to
// serve, derived from its own estimate of what serving it will cost:
//
//   estimated cost = tokens in (prompt length) + tokens out (typical answer)
//   floor (lowest price it will accept) = cost x (1 + floorMargin)
//   ask   (its opening list price)      = cost x (1 + askMargin)
//
// so a longer input costs more, and no provider will knowingly sell below
// its own estimated cost. The estimate can still be wrong (the answer may
// come out longer than usual), which is where negative margins can remain.
// Quotes are in sats at the current cached BSV/USD rate (see rate.js).
//
// `rate-bot` sells the exchange rate itself. Its underlying API is free, so
// it has no cost to derive a price from and uses a fixed market price.

const { runPricedTask } = require('./ai-service')
const { quoteSats, usdCostOfCall, estimateTokens } = require('./pricing')
const { fetchRateFromChain } = require('./rate')

// Tokens the API adds around our prompt (message framing etc.), estimated
// from measured costs of real runs.
const INPUT_OVERHEAD_TOKENS = 15

function llmAgent(def) {
  const buildPrompt = input => `${def.promptPrefix}${input}`

  const estimateCostUsd = input => {
    const tokensIn = estimateTokens(def.system) + estimateTokens(buildPrompt(input)) + INPUT_OVERHEAD_TOKENS
    const tokensOut = def.expectedOutputTokens(estimateTokens(input))
    return usdCostOfCall(tokensIn, tokensOut)
  }

  return {
    id: def.id,
    envVar: def.envVar,
    type: def.type,
    service: def.service,
    quote: input => {
      const estUsd = estimateCostUsd(input)
      const floor = quoteSats(estUsd * (1 + def.floorMargin))
      const ask = Math.max(floor, quoteSats(estUsd * (1 + def.askMargin)))
      return { estCostSats: quoteSats(estUsd), ask, floor }
    },
    perform: input => runPricedTask(def.system, buildPrompt(input))
  }
}

const PROVIDERS = [
  llmAgent({
    id: 'summarizer-bot',
    envVar: 'PROVIDER_SUMMARIZER_WIF',
    type: 'summarize',
    service: 'text summarization via Claude Haiku',
    system: 'You summarize text in one short sentence. Be concise.',
    promptPrefix: 'Summarize this: ',
    expectedOutputTokens: () => 28,
    askMargin: 0.9,
    floorMargin: 0.2
  }),
  llmAgent({
    id: 'summarizer-bot-2',
    envVar: 'PROVIDER_SUMMARIZER2_WIF',
    type: 'summarize',
    service: 'text summarization via Claude Haiku (budget competitor)',
    system: 'You summarize text in one short, punchy sentence.',
    promptPrefix: 'Summarize this: ',
    expectedOutputTokens: () => 26,
    askMargin: 0.6,  // thinner margins: undercuts summarizer-bot
    floorMargin: 0.1
  }),
  llmAgent({
    id: 'analysis-bot',
    envVar: 'PROVIDER_ANALYSIS_WIF',
    type: 'lookup',
    service: 'structured info extraction via Claude Haiku',
    system: 'You extract 2-3 key facts or entities from text as a short bullet list.',
    promptPrefix: 'Extract key info from: ',
    expectedOutputTokens: () => 50,
    askMargin: 0.9,
    floorMargin: 0.2
  }),
  llmAgent({
    id: 'analysis-bot-2',
    envVar: 'PROVIDER_ANALYSIS2_WIF',
    type: 'lookup',
    service: 'structured info extraction via Claude Haiku (budget competitor)',
    system: 'You extract the single most important fact from text, one line.',
    promptPrefix: 'Extract key info from: ',
    expectedOutputTokens: () => 46, // measured: adds a header and a long sentence despite "one line"
    askMargin: 0.6,
    floorMargin: 0.1
  }),
  llmAgent({
    id: 'compute-bot',
    envVar: 'PROVIDER_COMPUTE_WIF',
    type: 'compute',
    service: 'simple reasoning/calculation via Claude Haiku',
    system: 'You solve simple calculations or logic questions in one line.',
    promptPrefix: '',
    expectedOutputTokens: () => 35,
    askMargin: 0.8,
    floorMargin: 0.15
  }),
  llmAgent({
    id: 'translator-bot',
    envVar: 'PROVIDER_TRANSLATE_WIF',
    type: 'translate',
    service: 'text translation via Claude Haiku',
    system: 'You translate text to Portuguese. Return only the translation.',
    promptPrefix: '',
    // Portuguese takes roughly 30 % more tokens than the English source.
    expectedOutputTokens: tokensInText => Math.ceil(tokensInText * 1.3),
    askMargin: 0.8,
    floorMargin: 0.15
  }),
  {
    id: 'rate-bot',
    envVar: 'PROVIDER_RATE_WIF',
    type: 'rate',
    service: 'current BSV/USD exchange rate (WhatsOnChain)',
    // Free upstream API, so no cost to derive a price from: a fixed market price.
    quote: () => ({ estCostSats: 0, ask: quoteSats(0.00006), floor: quoteSats(0.00002) }),
    perform: async () => {
      const { bsvUsd, sourceTime } = await fetchRateFromChain()
      return {
        text: `1 BSV = $${bsvUsd} USD${sourceTime ? ` (as of ${sourceTime})` : ''}`,
        data: { bsvUsd, sourceTime },
        actualCostSats: 0,
        mocked: false
      }
    }
  }
]

module.exports = { PROVIDERS }
