'use strict'
// Drives the payment pipeline every 2s; ~20% of payments are negative (refund
// path) and hit the seeded validator bug.
const { processPayment } = require('./payment')

function main() {
  console.log('node-demo: processing a payment every 2 seconds (Ctrl+C to stop)')
  const currencies = ['USD', 'EUR', 'GBP']
  setInterval(() => {
    let amount = Math.round((Math.random() * 495 + 5) * 100) / 100
    if (Math.random() < 0.2) amount = -amount
    const currency = currencies[Math.floor(Math.random() * currencies.length)]
    try {
      const result = processPayment(amount, currency)
      console.log('processed:', JSON.stringify(result))
    } catch (err) {
      console.log('payment failed:', err.constructor.name + ':', err.message)
    }
  }, 2000)
}

main()
