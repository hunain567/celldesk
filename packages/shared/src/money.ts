/**
 * Money is stored and calculated as integer paisa (1 PKR = 100 paisa).
 * Floating point is never used for amounts.
 */

export type Paisa = number;

export function assertPaisa(value: number): asserts value is Paisa {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Amount must be a whole number of paisa, received ${value}`);
  }
}

/** Parses a user-typed rupee amount such as "1,250.50" into paisa. */
export function parseRupees(input: string): Paisa {
  const cleaned = input.replace(/[,\s]/g, '').replace(/^rs\.?/i, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new RangeError(`"${input}" is not a valid amount`);
  }
  const negative = cleaned.startsWith('-');
  const [whole = '0', fraction = ''] = cleaned.replace('-', '').split('.');
  const paisa = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  assertPaisa(paisa);
  return negative ? -paisa : paisa;
}

const formatter = new Intl.NumberFormat('en-PK', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** Formats paisa as "Rs 1,250.5" style text for display. */
export function formatRupees(paisa: Paisa): string {
  assertPaisa(paisa);
  const sign = paisa < 0 ? '-' : '';
  return `${sign}Rs ${formatter.format(Math.abs(paisa) / 100)}`;
}
