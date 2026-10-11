// ai-service.js
// Wraps a real call to the Claude API. If no ANTHROPIC_API_KEY is set, falls
// back to a mock response so the rest of the demo still runs — but the whole
// point of this file is to use it for real once you have a key.

const { usdCostOfCall, usdToSats } = require('./pricing')

async function callClaude(systemPrompt, userPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY

  if (!apiKey) {
    console.log('  [ai-service] No ANTHROPIC_API_KEY set — using mock response.')
    return {
      text: `[mock output for: "${userPrompt.slice(0, 40)}..."]`,
      inputTokens: Math.round(userPrompt.length / 4), // rough char->token estimate
      outputTokens: 40,
      mocked: true
    }
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`Claude API error ${response.status}: ${errText}`)
  }

  const data = await response.json()
  const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('')

  return {
    text,
    inputTokens: data.usage.input_tokens,
    outputTokens: data.usage.output_tokens,
    mocked: false
  }
}

// Runs the call and returns both the result text and its real cost in sats,
// so a provider can log what the task actually cost vs. what it charged.
async function runPricedTask(systemPrompt, userPrompt) {
  const { text, inputTokens, outputTokens, mocked } = await callClaude(systemPrompt, userPrompt)
  const usd = usdCostOfCall(inputTokens, outputTokens)
  const sats = usdToSats(usd)
  return { text, inputTokens, outputTokens, actualCostSats: sats, mocked }
}

module.exports = { runPricedTask }
