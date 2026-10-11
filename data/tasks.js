// data/tasks.js
// Concrete, varied content for the negotiation to actually be about — real
// text of different lengths/complexity per task type, instead of one fixed
// string every run. Real Haiku cost varies with input/output length, so
// varied content here is what produces meaningfully different negotiation
// and cost outcomes across runs (useful data for an evaluation chapter).

const SUMMARIZE_SAMPLES = [
  `The app crashed three times but the crash screen has genuinely beautiful typography, 10/10. Support replied in 4 minutes then vanished for 3 days. My cat somehow ordered the premium plan by walking on my keyboard and honestly the onboarding for that flow was smoother than mine. Please add dark mode or I riot.`,
  `Been using this for six months now. Onboarding was confusing at first — took me three tries to find the export button, it's hidden under a menu that looks like a settings icon but isn't. Once I figured it out though, the actual core workflow is solid. Sync between devices is instant, which I didn't expect. Customer support ticket took 2 days to get a real answer but the answer was actually useful and fixed my problem. Would recommend to a colleague but with the caveat that the first week is rough.`,
  `Cancelled after one week. Pricing page said one thing, checkout charged another, and the difference was never explained even after two support emails. The product itself seems fine from what little I used it, but a billing mismatch on day one is a hard no for me.`
]

const LOOKUP_SAMPLES = [
  `Q3 report: revenue up 12% YoY, driven mainly by the EU region (+22%) while APAC declined 4% due to a currency headwind. Churn dropped from 5.1% to 4.3% after the new onboarding flow shipped in July. Headcount grew by 8 people, all in engineering.`,
  `Meeting notes: decided to delay the v2 launch by three weeks to fix the payment-webhook race condition found in staging. Marketing needs the new date by Friday. Design is unaffected and can proceed independently. Legal review of the new ToS is still pending, blocking on that separately.`
]

const TRANSLATE_SAMPLES = [
  `Thank you for your purchase. Your order will arrive within 5 to 7 business days. If you have any questions, please contact our support team.`,
  `The meeting has been rescheduled to next Tuesday at 3pm. Please confirm your availability by replying to this message.`
]

const COMPUTE_SAMPLES = [
  `If a task costs 1800 sats and runs 40 times a day, how many sats is that per week?`,
  `A provider's floor price is 900 sats and its ask is 1500 sats. If a consumer opens at 70% of ask, what's the opening offer?`
]

// Budgets are in USD and converted to sats at the current cached BSV/USD
// rate when each task runs, so they stay consistent with provider quotes
// when the rate moves. Provider prices follow their estimated cost, so a
// budget has to be above roughly 1.1-1.2x the cost of the request for any
// deal to be possible.
function buildTasks() {
  return [
    { description: `Summarize: "${SUMMARIZE_SAMPLES[0]}"`, budgetUsd: 0.00042, type: 'summarize' },
    // tight: only the cheaper summarizer can serve this one within budget
    { description: `Summarize: "${SUMMARIZE_SAMPLES[1]}"`, budgetUsd: 0.00036, type: 'summarize' },
    { description: `Extract key info: "${LOOKUP_SAMPLES[0]}"`, budgetUsd: 0.0005, type: 'lookup' },
    { description: `Translate: "${TRANSLATE_SAMPLES[0]}"`, budgetUsd: 0.00045, type: 'translate' },
    // deliberately below the cost of the request: the agent should walk away and pay nothing
    { description: COMPUTE_SAMPLES[0], budgetUsd: 0.00024, type: 'compute' }
  ]
}

// Bought from a rate agent at session start when the cached rate is stale.
const RATE_TASK = {
  description: 'Fetch the current BSV/USD exchange rate',
  budgetUsd: 0.000075,
  type: 'rate'
}

module.exports = { SUMMARIZE_SAMPLES, LOOKUP_SAMPLES, TRANSLATE_SAMPLES, COMPUTE_SAMPLES, buildTasks, RATE_TASK }
