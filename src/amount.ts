const DEFAULT_TOKEN_DECIMALS = 7;

export function toDisplayAmount(
  amount: string,
  decimals: number = DEFAULT_TOKEN_DECIMALS,
): string {
  const normalizedDecimals =
    Number.isInteger(decimals) && decimals >= 0 ? decimals : DEFAULT_TOKEN_DECIMALS;
  const scale = 10n ** BigInt(normalizedDecimals);
  const raw = BigInt(amount);
  const abs = raw < 0n ? -raw : raw;
  const integer = abs / scale;
  const remainder = abs % scale;
  const sign = raw < 0n ? "-" : "";

  if (normalizedDecimals === 0) return `${sign}${integer}`;

  return `${sign}${integer}.${String(remainder).padStart(normalizedDecimals, "0")}`;
}
