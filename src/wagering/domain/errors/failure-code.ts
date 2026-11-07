export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  BalanceLimitExceeded = "BALANCE_LIMIT_EXCEEDED",
  CurrencyMismatch = "CURRENCY_MISMATCH",
  PlayerWalletMismatch = "PLAYER_WALLET_MISMATCH",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  ReferenceInvalidKind = "REFERENCE_INVALID_KIND",
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceAlreadyReversed = "REFERENCE_ALREADY_REVERSED",
  InfrastructureFailure = "INFRASTRUCTURE_FAILURE",
}
