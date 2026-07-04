'use strict'
// Axiom Node.js runtime-layer demo target (CommonJS).
// Same seeded validator bug as the Python demo: negative amounts slip through
// validateAmount and blow up downstream in charge().

function validateAmount(amount) {
  // BUG: should be `amount <= 0` — negatives pass validation.
  if (amount === 0) {
    throw new Error('Amount must be positive')
  }
}

function validateCurrency(currency) {
  const supported = ['USD', 'EUR', 'GBP']
  if (!supported.includes(currency)) {
    throw new Error('Unsupported currency: ' + currency)
  }
}

function charge(amount, currency) {
  if (amount < 0) {
    throw new Error('gateway refused negative charge: ' + amount + ' ' + currency)
  }
  return 'tx_' + Math.random().toString(16).slice(2, 10)
}

function processPayment(amount, currency) {
  validateAmount(amount)
  validateCurrency(currency)
  const txId = charge(amount, currency)
  return { success: true, id: txId, amount, currency }
}

module.exports = { processPayment, validateAmount, validateCurrency, charge }
