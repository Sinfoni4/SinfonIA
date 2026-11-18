/** The warnings of a document read are shown in Italian, also those stored in English before. */
import { describe, expect, it } from 'vitest';

import { italianWarning, readFields } from './practices';

describe('warnings of a document read', () => {
  it('translates the warnings stored in English and keeps the others', () => {
    expect(
      italianWarning('Totals do not add up: taxable amount + VAT differs from document total'),
    ).toBe('I totali non tornano: imponibile più IVA è diverso dal totale del documento');
    expect(italianWarning('VAT number 01234567890 found without its label')).toBe(
      'Partita IVA 01234567890 trovata senza la dicitura «P.IVA»',
    );
    expect(italianWarning('Low OCR confidence (55%)')).toBe(
      'Lettura poco sicura (55%): controlla i dati',
    );
    expect(italianWarning('Data non leggibile')).toBe('Data non leggibile');
  });

  it('applies to the data read shown in the practice', () => {
    expect(
      readFields({ documentType: 'INVOICE', warnings: ['Document total is zero: check it'] })
        .warnings,
    ).toEqual(['Il totale del documento è zero: controlla se è un documento non fiscale']);
  });
});
