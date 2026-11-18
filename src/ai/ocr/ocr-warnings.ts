/**
 * The warnings of a document read (OCR), in Italian: they are shown to the people who check the
 * data. Reads made before this were stored in English: `italianOcrWarning` translates them when
 * they are shown, and leaves any other text as it is.
 */

export const OCR_WARNINGS = {
  totalsMismatch: 'I totali non tornano: imponibile più IVA è diverso dal totale del documento',
  zeroTotal: 'Il totale del documento è zero: controlla se è un documento non fiscale',
  vatCheckDigit: (vat: string) =>
    `La partita IVA ${vat} non supera il controllo della cifra finale`,
  vatUnlabeled: (vat: string) => `Partita IVA ${vat} trovata senza la dicitura «P.IVA»`,
  lowConfidence: (percent: number) => `Lettura poco sicura (${percent}%): controlla i dati`,
} as const;

const LEGACY: Array<[RegExp, (m: RegExpExecArray) => string]> = [
  [/^Totals do not add up\b/, () => OCR_WARNINGS.totalsMismatch],
  [/^Document total is zero\b/, () => OCR_WARNINGS.zeroTotal],
  [/^VAT number (\S+) fails the check digit$/, (m) => OCR_WARNINGS.vatCheckDigit(m[1])],
  [/^VAT number (\S+) found without its label$/, (m) => OCR_WARNINGS.vatUnlabeled(m[1])],
  [/^Low OCR confidence \((\d+)%\)$/, (m) => OCR_WARNINGS.lowConfidence(Number(m[1]))],
];

export function italianOcrWarning(warning: string): string {
  for (const [pattern, text] of LEGACY) {
    const m = pattern.exec(warning);
    if (m) return text(m);
  }
  return warning;
}
