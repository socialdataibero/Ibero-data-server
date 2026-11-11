import { UnprocessableEntityException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FULL_READ_MAX_ROWS,
  assertFullReadAllowed,
  fullReadMaxRows,
} from './full-read-guard.js';

describe('fullReadMaxRows', () => {
  it('defaults to 400,000', () => {
    expect(DEFAULT_FULL_READ_MAX_ROWS).toBe(400_000);
    expect(fullReadMaxRows({})).toBe(400_000);
  });

  it('reads HARMONIZER_FULL_READ_MAX_ROWS', () => {
    expect(fullReadMaxRows({ HARMONIZER_FULL_READ_MAX_ROWS: '250000' })).toBe(
      250_000,
    );
    expect(fullReadMaxRows({ HARMONIZER_FULL_READ_MAX_ROWS: ' 10 ' })).toBe(10);
  });

  it('ignores values that are not a positive integer', () => {
    for (const value of [
      '',
      '0',
      '-5',
      '1.5',
      'abc',
      '4e5',
      '99999999999999999999',
    ]) {
      expect(fullReadMaxRows({ HARMONIZER_FULL_READ_MAX_ROWS: value })).toBe(
        400_000,
      );
    }
  });
});

describe('assertFullReadAllowed', () => {
  it('allows up to the limit, inclusive', () => {
    expect(() =>
      assertFullReadAllowed('original', { edition: 'E' }, 100, 100),
    ).not.toThrow();
    expect(() =>
      assertFullReadAllowed('original', { edition: 'E' }, 0, 100),
    ).not.toThrow();
  });

  it('refuses above the limit with harmonizer_too_many_rows and params', () => {
    let error: unknown;
    try {
      assertFullReadAllowed('original', { edition: 'Censo' }, 101, 100);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    const response = (error as UnprocessableEntityException).getResponse();
    expect(response).toEqual({
      code: 'harmonizer_too_many_rows',
      message:
        'Downloading the original file of edition "Censo" is temporarily disabled: it has 101 rows and the limit is 100. The paged views still work.',
      params: {
        operation: 'original',
        edition: 'Censo',
        rowCount: 101,
        maxRows: 100,
      },
    });
  });

  it('names the edition for edition operations', () => {
    expect(() =>
      assertFullReadAllowed(
        'original',
        { edition: 'Personas 2020' },
        900_000,
        400_000,
      ),
    ).toThrow(
      'Downloading the original file of edition "Personas 2020" is temporarily disabled',
    );
  });
});
