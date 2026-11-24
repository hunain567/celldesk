import { formatRupees, parseRupees } from '@nexodesk/shared';
import { describe, expect, it } from 'vitest';

describe('money helpers', () => {
  it('parses typed rupee amounts into integer paisa', () => {
    expect(parseRupees('121,999')).toBe(12199900);
    expect(parseRupees('1250.5')).toBe(125050);
    expect(parseRupees('Rs 0.05')).toBe(5);
    expect(parseRupees('-300')).toBe(-30000);
  });

  it('rejects anything that is not a plain amount', () => {
    for (const bad of ['', 'abc', '1.234', '12..5', '1e5']) {
      expect(() => parseRupees(bad)).toThrow(RangeError);
    }
  });

  it('formats paisa for display', () => {
    expect(formatRupees(12199900)).toBe('Rs 121,999');
    expect(formatRupees(125050)).toBe('Rs 1,250.5');
    expect(formatRupees(-30000)).toBe('-Rs 300');
  });
});
