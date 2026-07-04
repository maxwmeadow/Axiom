"""Payment processing pipeline."""

import uuid

from validators import validate_amount, validate_currency


def process_payment(amount: float, currency: str) -> dict:
    validate_amount(amount)
    validate_currency(currency)
    tx_id = charge(amount, currency)
    return {"success": True, "id": tx_id, "amount": amount, "currency": currency}


def charge(amount: float, currency: str) -> str:
    if amount < 0:
        # The gateway rejects what the validator should have caught.
        raise ValueError(f"gateway refused negative charge: {amount} {currency}")
    return f"tx_{uuid.uuid4().hex[:8]}"
