/**
 * AGX-02: the identifiers of a company (TerreFVG, model A: one organization per farm).
 *
 * - `taxCode`: the codice fiscale, which for a farm is also its CUAA. It is 16 characters for a
 *   sole trader (a person's code, with its check letter) or 11 digits for a company.
 * - `vatNumber`: the Italian partita IVA, 11 digits with a check digit (an "IT" prefix is dropped).
 * - `externalRefs`: the code of the company in other systems (e.g. `{ "odoo": "res.partner/42" }`),
 *   set only from the platform console, for the integrations (AGX-11).
 *
 * The administrator of the organization and the platform console change them; networks never
 * see them (they see name, municipality and sector only, D4). The audit records which ones
 * changed, never their values: a sole trader's codice fiscale is personal data.
 */

export class CompanyIdentifiersError extends Error {
  readonly statusCode = 400;
  readonly code = 'COMPANY_IDENTIFIERS_INVALID';
  constructor(message: string) {
    super(message);
    this.name = 'CompanyIdentifiersError';
  }
}

const PERSON_CODE =
  /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

// Values of the characters in odd positions (1st, 3rd, ...) for the check letter.
const ODD_VALUES = [
  1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23,
];

function characterIndex(c: string): number {
  return c >= '0' && c <= '9' ? c.charCodeAt(0) - 48 : c.charCodeAt(0) - 65;
}

/** The check letter of a 16-character codice fiscale (its first 15 characters). */
export function personCodeCheck(first15: string): string {
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const index = characterIndex(first15[i]);
    sum += i % 2 === 0 ? ODD_VALUES[index] : index;
  }
  return String.fromCharCode(65 + (sum % 26));
}

/** The check digit of an 11-digit number (partita IVA, or a company's codice fiscale). */
export function elevenDigitCheck(first10: string): number {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const digit = first10.charCodeAt(i) - 48;
    if (i % 2 === 0) sum += digit;
    else sum += digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
  }
  return (10 - (sum % 10)) % 10;
}

function validElevenDigits(value: string): boolean {
  return (
    /^\d{11}$/.test(value) &&
    !/^0+$/.test(value) &&
    elevenDigitCheck(value.slice(0, 10)) === Number(value[10])
  );
}

const compact = (value: string) => value.replace(/[\s.-]/g, '').toUpperCase();

/** null removes it; undefined leaves it as it is. */
export function normalizeTaxCode(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const code = compact(value);
  if (code === '') return null;
  if (code.length === 16) {
    if (PERSON_CODE.test(code) && personCodeCheck(code.slice(0, 15)) === code[15]) return code;
    throw new CompanyIdentifiersError(
      'Codice fiscale / CUAA non valido: controlla i 16 caratteri.',
    );
  }
  if (code.length === 11 && validElevenDigits(code)) return code;
  throw new CompanyIdentifiersError(
    'Codice fiscale / CUAA non valido: servono 16 caratteri (ditta individuale) o 11 cifre (società).',
  );
}

export function normalizeVatNumber(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) return value;
  const number = compact(value).replace(/^IT/, '');
  if (number === '') return null;
  if (validElevenDigits(number)) return number;
  throw new CompanyIdentifiersError('Partita IVA non valida: servono 11 cifre corrette.');
}

export type ExternalRefs = Record<string, string>;

const SYSTEM = /^[a-z][a-z0-9_-]{0,31}$/;
const MAX_REFS = 10;

/** {} or null removes them all. */
export function normalizeExternalRefs(
  value: Record<string, string> | null | undefined,
): ExternalRefs | null | undefined {
  if (value === undefined || value === null) return value;
  const entries = Object.entries(value).map(([system, ref]) => [
    system.trim().toLowerCase(),
    ref.trim(),
  ]);
  if (entries.length > MAX_REFS) {
    throw new CompanyIdentifiersError(`Al massimo ${MAX_REFS} riferimenti esterni.`);
  }
  const refs: ExternalRefs = {};
  for (const [system, ref] of entries) {
    if (!SYSTEM.test(system)) {
      throw new CompanyIdentifiersError(
        `Sistema esterno «${system}» non valido: lettere minuscole, cifre, - e _.`,
      );
    }
    if (ref === '' || ref.length > 128) {
      throw new CompanyIdentifiersError(`Riferimento per «${system}»: da 1 a 128 caratteri.`);
    }
    refs[system] = ref;
  }
  return Object.keys(refs).length === 0 ? null : refs;
}

export function sameRefs(a: unknown, b: ExternalRefs | null): boolean {
  const left = a && typeof a === 'object' ? (a as Record<string, unknown>) : {};
  const right = b ?? {};
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((k) => left[k] === right[k]);
}

/** What the audit records of a change: set or removed, never the value. */
export const changeMark = (value: string | null) => (value === null ? 'removed' : 'set');

/** Reads the stored refs (JSONB) back, keeping only string values. */
export function readExternalRefs(value: unknown): ExternalRefs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    ),
  );
}
