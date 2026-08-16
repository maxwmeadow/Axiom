"""Axiom runtime-layer demo target.

A tiny payment service with a seeded validation bug: negative amounts slip
through validate_amount and blow up (or silently corrupt state) downstream.
Run it under Axiom (launch_target MCP tool or `python -m axiom_adapter run
app.py`), watch process_payment / validate_amount, and follow the calls on
the canvas.
"""

import random
import time

from payment import process_payment


def main() -> None:
    print("payment-demo: processing a payment every 2 seconds (Ctrl+C to stop)")
    currencies = ["USD", "EUR", "GBP"]
    while True:
        # Most payments are fine; occasionally a refund path produces a
        # negative amount that the validator should reject - but doesn't.
        amount = round(random.uniform(5.0, 500.0), 2)
        if random.random() < 0.2:
            amount = -amount
        currency = random.choice(currencies)
        try:
            result = process_payment(amount, currency)
            print(f"processed: {result}")
        except Exception as exc:
            print(f"payment failed: {type(exc).__name__}: {exc}")
        time.sleep(2)


if __name__ == "__main__":
    main()
