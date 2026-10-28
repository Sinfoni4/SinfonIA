/**
 * Prompt Guard & Security Boundary.
 * Enforces strict semantic delimitation (<user_input>) and defensive escaping
 * to ensure that untrusted user input is always treated as passive data and never
 * as executable system instructions.
 *
 * Implements pre-execution detection of Prompt Injection, Jailbreak,
 * Command Override, Cross-Tenant Exfiltration, and Impersonation attacks.
 */

export type AttackType =
  'JAILBREAK' | 'COMMAND_OVERRIDE' | 'CROSS_TENANT_EXFILTRATION' | 'IMPERSONATION';

export interface PromptInjectionCheckResult {
  isInjection: boolean;
  attackType?: AttackType;
  reason?: string;
  matchedPattern?: string;
}

// Patterns for common LLM jailbreak, system prompt override and privilege escalation vectors
const JAILBREAK_PATTERNS: Array<{ regex: RegExp; type: AttackType; label: string }> = [
  {
    regex:
      /(?:ignore|disregard|forget|bypass)\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions|rules|directives|prompts)/i,
    type: 'JAILBREAK',
    label: 'Instruction override (ignore previous instructions)',
  },
  {
    regex:
      /(?:you\s+are\s+now|act\s+as|switch\s+to)\s+(?:dan|unfiltered|jailbroken|developer\s+mode|root|god\s+mode)/i,
    type: 'JAILBREAK',
    label: 'Role override / Developer Mode / DAN jailbreak',
  },
  {
    regex: /developer\s+mode\s+(?:enabled|activated|on)/i,
    type: 'JAILBREAK',
    label: 'Developer mode activation',
  },
  {
    regex: /(?:system\s+override|admin\s+override)\s*[:.]?/i,
    type: 'COMMAND_OVERRIDE',
    label: 'System/Admin override directive',
  },
  {
    regex: /(?:drop|truncate|delete\s+from)\s+(?:database|table|practices|users|tenants)/i,
    type: 'COMMAND_OVERRIDE',
    label: 'Destructive SQL/database command injection',
  },
  {
    regex: /(?:exec|execute|run)\s+(?:shell|bash|cmd|powershell|sql|arbitrary)/i,
    type: 'COMMAND_OVERRIDE',
    label: 'Command execution injection',
  },
  {
    regex:
      /(?:reveal|dump|leak|show|extract)\s+(?:all\s+)?(?:tenants|practices\s+for\s+tenant|users\s+for\s+tenant|system\s+prompt|secret)/i,
    type: 'CROSS_TENANT_EXFILTRATION',
    label: 'Cross-tenant data extraction / system prompt leak',
  },
  {
    regex: /(?:disregard|bypass|ignore)\s+tenant(?:\s+isolation|\s+filters)?/i,
    type: 'CROSS_TENANT_EXFILTRATION',
    label: 'Tenant isolation bypass attempt',
  },
  {
    regex: /<\s*\|\s*im_start\s*\|\s*>system|\[\s*INST\s*\]\s*<<SYS>>/i,
    type: 'IMPERSONATION',
    label: 'System token / Chat template impersonation injection',
  },
  {
    regex: /(?:role\s*:\s*(?:system|assistant|admin)|^(?:system|assistant)\s*:)/im,
    type: 'IMPERSONATION',
    label: 'Role-tag impersonation',
  },
];

// Italian attack phrasing. Matched on normalized text (lowercase, no accents, apostrophes as
// spaces, de-obfuscated), so "Ignora le istruzioni", "i g n o r a" and "1gn0ra" all match.
const ITALIAN_PATTERNS: Array<{ regex: RegExp; type: AttackType; label: string }> = [
  {
    regex:
      /\b(?:ignora|ignorate|dimentica|dimenticate|trascura|scavalca|salta|annulla|non\s+considerare|non\s+tenere\s+conto\s+d\w*)\s+(?:tutte\s+|tutti\s+)?(?:le\s+|i\s+|gli\s+|ogni\s+)?(?:tue\s+|precedenti\s+)?(?:istruzion\w*|regol\w*|direttiv\w*|indicazion\w*|prompt|vincol\w*|limitazion\w*)/,
    type: 'JAILBREAK',
    label: 'Instruction override (Italian)',
  },
  {
    regex:
      /\b(?:fingi\s+di\s+essere|comportati\s+(?:da|come)|agisci\s+(?:da|come)|da\s+(?:ora|adesso)\s+(?:in\s+poi\s+)?sei|ora\s+sei|diventa|impersona)\s+(?:un\s+|una\s+|il\s+|l\s+|lo\s+)?(?:amministrator\w*|admin|sviluppator\w*|root|superutente|dan|(?:ia|ai|assistente|modello|bot)\s+(?:senza|libero|sbloccat\w*))/,
    type: 'JAILBREAK',
    label: 'Role override (Italian)',
  },
  {
    regex:
      /\bmodalita\s+(?:sviluppatore|sviluppo|developer|dio|admin|debug|senza\s+(?:limiti|filtri|restrizioni|censure))/,
    type: 'JAILBREAK',
    label: 'Unrestricted mode activation (Italian)',
  },
  {
    regex:
      /\b(?:mostra\w*|rivela\w*|stampa\w*|dimmi|ripeti|elenca\w*|scrivi|copia)\s+(?:\w+\s+){0,3}(?:prompt(?:\s+di\s+sistema)?|istruzioni\s+(?:di\s+sistema|iniziali|nascoste|segrete|interne)|regole\s+(?:di\s+sistema|nascoste|interne|segrete)|chiav\w*\s+(?:api|segret\w*)|password|token|credenziali)/,
    type: 'CROSS_TENANT_EXFILTRATION',
    label: 'System prompt / secret disclosure (Italian)',
  },
  {
    regex:
      /\b(?:pratiche|dati|utenti|documenti|soci|clienti)\s+(?:di|delle|degli|dei)\s+(?:tutte\s+le\s+|tutti\s+gli\s+|tutti\s+i\s+|altre\s+|altri\s+)(?:cooperativ\w*|tenant|aziend\w*|organizzazion\w*|clienti)/,
    type: 'CROSS_TENANT_EXFILTRATION',
    label: 'Cross-tenant data request (Italian)',
  },
  {
    regex:
      /\b(?:ignora|aggira|disattiva|scavalca|salta|rimuovi)\s+(?:l\s+|il\s+|i\s+|gli\s+)?(?:isolamento|filtr\w*|separazion\w*|controll\w*|permess\w*|autorizzazion\w*)/,
    type: 'CROSS_TENANT_EXFILTRATION',
    label: 'Isolation / permission bypass (Italian)',
  },
  {
    regex:
      /\b(?:cancella|elimina|svuota|distruggi|azzera|resetta)\s+(?:tutte\s+le\s+pratiche|tutti\s+i\s+(?:dati|record|utenti|soci)|tutto\s+il\s+database|(?:il\s+)?database|(?:la\s+|le\s+)?tabell\w*|ogni\s+pratica)/,
    type: 'COMMAND_OVERRIDE',
    label: 'Destructive bulk command (Italian)',
  },
  {
    regex:
      /\b(?:esegui|lancia|avvia)\s+(?:questo\s+|il\s+|lo\s+|uno\s+)?(?:comando|script|codice|query)\b/,
    type: 'COMMAND_OVERRIDE',
    label: 'Command execution request (Italian)',
  },
];

const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

/**
 * Text as the patterns expect it: lowercase, without accents, zero-width characters or
 * apostrophes, with leetspeak undone inside words and letter-spaced words joined back
 * ("i g n o r a" -> "ignora").
 */
export function normalizeForInspection(raw: string): string {
  let text = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u200B-\u200D\u2060\uFEFF\u00AD]/g, '')
    .toLowerCase()
    .replace(/[’'`´]/g, ' ');
  // Leetspeak only inside words that also contain letters, so amounts and dates stay intact.
  text = text.replace(/\S+/g, (word) =>
    /[a-z]/.test(word) ? word.replace(/[013457@$]/g, (c) => LEET[c] ?? c) : word,
  );
  // Join runs of single characters separated by spaces, dots, dashes or underscores.
  text = text.replace(/\b(?:[a-z][\s._-]+){3,}[a-z]\b/g, (run) => run.replace(/[\s._-]+/g, ''));
  return text.replace(/\s+/g, ' ').trim();
}

/** Readable text hidden in base64 tokens (an encoded payload must not slip past the guard). */
function decodedPayloads(raw: string): string[] {
  const decoded: string[] = [];
  for (const token of raw.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    try {
      const text = Buffer.from(token, 'base64').toString('utf-8');
      const printable = text.replace(/[^\x20-\x7E\u00C0-\u017F]/g, '');
      if (text.length >= 8 && printable.length / text.length > 0.9) decoded.push(text);
    } catch {
      // Not base64: ignore.
    }
  }
  return decoded;
}

/**
 * Escapes closing tags and special prompt markup characters to prevent breaking out of
 * the semantic data delimiter.
 */
export function escapePromptData(raw: string): string {
  return raw
    .replace(/<\/user_input>/gi, '&lt;/user_input&gt;')
    .replace(/<user_input>/gi, '&lt;user_input&gt;')
    .replace(/<\/system>/gi, '&lt;/system&gt;')
    .replace(/<system>/gi, '&lt;system&gt;')
    .replace(/<\|im_start\|>/gi, '&lt;|im_start|&gt;')
    .replace(/<\|im_end\|>/gi, '&lt;|im_end|&gt;')
    .replace(/<<SYS>>/gi, '&lt;&lt;SYS&gt;&gt;')
    .replace(/<\/SYS>>/gi, '&lt;/SYS&gt;&gt;');
}

/**
 * Wraps user input into a hardened semantic data boundary.
 * The system prompt strictly directs the LLM that anything within <user_input> is passive data.
 */
export function wrapInUserDelimiter(raw: string): string {
  const sanitized = escapePromptData(raw.trim());
  return `<user_input>\n${sanitized}\n</user_input>`;
}

/**
 * Inspects untrusted user input for known prompt injection and jailbreak signatures.
 */
export function checkPromptInjection(raw: string): PromptInjectionCheckResult {
  // The original text, its normalized form, and anything decoded from base64 are all inspected.
  const variants = [raw.trim(), ...decodedPayloads(raw)];
  for (const text of variants) {
    for (const item of JAILBREAK_PATTERNS) {
      if (item.regex.test(text)) return found(item);
    }
    const normalized = normalizeForInspection(text);
    for (const item of [...ITALIAN_PATTERNS, ...JAILBREAK_PATTERNS]) {
      if (item.regex.test(normalized)) return found(item);
    }
  }
  return { isInjection: false };
}

function found(item: {
  regex: RegExp;
  type: AttackType;
  label: string;
}): PromptInjectionCheckResult {
  return {
    isInjection: true,
    attackType: item.type,
    reason: item.label,
    matchedPattern: item.regex.source,
  };
}
