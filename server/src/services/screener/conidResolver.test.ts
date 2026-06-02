// Vitest fixtures for the conid-resolver picker (Batch S1.5).
//
// Tests the pure pickUsStockMatch function against the live secdef
// response shapes observed via bin/upside-ib on 2026-06-02 (MNTS:
// MOMENTUS INC NASDAQ + SCHIEHALLION FUND LSE; REPL: Replimune NASDAQ
// + RUDRABHISHEK NSE; etc.).

import { describe, it, expect } from 'vitest';
import { pickUsStockMatch } from './conidPicker.js';
import type { RawIbSecdefResult } from '../../types/index.js';

const mntsLikeResponse: RawIbSecdefResult[] = [
  {
    conid: '839174082',
    companyHeader: 'MOMENTUS INC - NASDAQ',
    companyName: 'MOMENTUS INC',
    symbol: 'MNTS',
    description: 'NASDAQ',
    sections: [
      { secType: 'STK' },
      { secType: 'WAR', months: 'AUG26', exchange: 'SMART;ARCA' },
    ],
  },
  {
    conid: '837866605',
    companyHeader: 'SCHIEHALLION FUND LTD/THE - LSE',
    companyName: 'SCHIEHALLION FUND LTD/THE',
    symbol: 'MNTS',
    description: 'LSE',
    sections: [{ secType: 'STK' }],
  },
];

describe('pickUsStockMatch', () => {
  it('picks the US match when both US + foreign exist', () => {
    expect(pickUsStockMatch(mntsLikeResponse)).toEqual({
      conid: 839174082,
      exchange: 'NASDAQ',
    });
  });

  it('returns null when only foreign listings match', () => {
    const foreignOnly = [
      {
        conid: '12345',
        companyHeader: 'Foreign Co',
        companyName: 'Foreign Co',
        symbol: 'XYZ',
        description: 'LSE',
        sections: [{ secType: 'STK' }],
      },
    ];
    expect(pickUsStockMatch(foreignOnly)).toBeNull();
  });

  it('accepts NYSE listings', () => {
    const nyseOnly = [
      {
        conid: '265598',
        companyHeader: 'Apple - NYSE',
        companyName: 'Apple Inc',
        symbol: 'AAPL',
        description: 'NYSE',
        sections: [{ secType: 'STK' }],
      },
    ];
    expect(pickUsStockMatch(nyseOnly)?.conid).toBe(265598);
    expect(pickUsStockMatch(nyseOnly)?.exchange).toBe('NYSE');
  });

  it('accepts AMEX (NYSE American) listings', () => {
    const amexOnly = [
      {
        conid: '11111',
        companyHeader: 'Small Co - AMEX',
        companyName: 'Small Co',
        symbol: 'SCO',
        description: 'AMEX',
        sections: [{ secType: 'STK' }],
      },
    ];
    expect(pickUsStockMatch(amexOnly)?.exchange).toBe('AMEX');
  });

  it('first-listed US match wins when multiple US matches exist', () => {
    const dual = [
      {
        conid: '111',
        companyHeader: 'Primary - NASDAQ',
        companyName: 'X',
        symbol: 'X',
        description: 'NASDAQ',
        sections: [{ secType: 'STK' }],
      },
      {
        conid: '222',
        companyHeader: 'Secondary - NYSE',
        companyName: 'X',
        symbol: 'X',
        description: 'NYSE',
        sections: [{ secType: 'STK' }],
      },
    ];
    expect(pickUsStockMatch(dual)?.conid).toBe(111);
  });

  it('skips a US-description result without a STK section', () => {
    const optOnly = [
      {
        conid: '999',
        companyHeader: 'X - NASDAQ',
        companyName: 'X',
        symbol: 'X',
        description: 'NASDAQ',
        sections: [
          { secType: 'OPT' },
          { secType: 'WAR' },
        ],
      },
    ];
    expect(pickUsStockMatch(optOnly)).toBeNull();
  });

  it('skips a result with non-numeric or zero conid', () => {
    const broken = [
      {
        conid: 'not-a-number',
        companyHeader: 'X',
        companyName: 'X',
        symbol: 'X',
        description: 'NASDAQ',
        sections: [{ secType: 'STK' }],
      },
      {
        conid: '0',
        companyHeader: 'X',
        companyName: 'X',
        symbol: 'X',
        description: 'NASDAQ',
        sections: [{ secType: 'STK' }],
      },
    ];
    expect(pickUsStockMatch(broken)).toBeNull();
  });

  it('returns null on an empty response', () => {
    expect(pickUsStockMatch([])).toBeNull();
  });

  it('tolerates missing/garbage sections array', () => {
    const garbage = [
      {
        conid: '111',
        companyHeader: 'X',
        companyName: 'X',
        symbol: 'X',
        description: 'NASDAQ',
        sections: null as unknown as RawIbSecdefResult['sections'],
      },
    ];
    expect(pickUsStockMatch(garbage)).toBeNull();
  });
});
