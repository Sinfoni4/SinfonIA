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
    regex: /^(?:system|assistant)\s*:\s*(?:you\s+are|override|new\s+instructions)/im,
    type: 'IMPERSONATION',
    label: 'Role-tag impersonation',
  },
];

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
  const text = raw.trim();

  for (const item of JAILBREAK_PATTERNS) {
    if (item.regex.test(text)) {
      return {
        isInjection: true,
        attackType: item.type,
        reason: item.label,
        matchedPattern: item.regex.source,
      };
    }
  }

  return { isInjection: false };
}
