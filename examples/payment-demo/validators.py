"""Input validation. Contains the seeded bug."""

SUPPORTED_CURRENCIES = {"USD", "EUR", "GBP"}


def validate_amount(amount: float) -> None:
    # BUG: should be `amount <= 0` - negative amounts pass validation and
    # reach the payment gateway.
    if amount == 0:
        raise ValueError("Amount must be positive")


def validate_currency(currency: str) -> None:
    if currency not in SUPPORTED_CURRENCIES:
        raise ValueError(f"Unsupported currency: {currency}")
