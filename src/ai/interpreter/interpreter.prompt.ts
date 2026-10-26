/**
 * Hardened prompt for the interpreter: few-shot, explicit schema, strict JSON.
 * Reduces hallucination and keeps output parseable.
 */

import type { InterpreterContext } from './interpreter.types.js';

const STRICT_JSON_RULE =
  'Return ONLY a single JSON object. No markdown, no code fences, no explanation, no trailing text.';

const SCHEMA = `You MUST output JSON with EXACTLY this structure (no extra keys):
{
  "action": "transition_practice" | "create_practice",
  "filters": {
    "practiceId": string | null,
    "status": string | null,
    "name": string | null
  },
  "artistName": string | null,
  "nextState": string
}

HARD RULES:
- ALWAYS include action, filters, artistName, nextState
- NEVER omit fields (even if unknown)
- If a field is unknown: set it to null
- nextState is NEVER null (must be a string)
- NEVER return an empty object

CREATE PRACTICE RULES:
- If the user asks to create a practice ("crea pratica per ...", "crea una pratica per ..."):
  - action = "create_practice"
  - artistName = extracted person name (string)
  - nextState = "CREATED"
  - filters.practiceId/status/name = null

STATUS INFERENCE (User intent -> filters.status):
- "valida" -> "CREATED"
- "completa" -> "VALIDATED"
- "invia" -> "COMPLETED"
- "validate" -> "CREATED"
- "complete" -> "VALIDATED"
- "submit" -> "CREATED"

NEXT STATE INFERENCE (User intent -> nextState):
- "valida" -> "VALIDATED"
- "completa" -> "COMPLETED"
- "validate" -> "VALIDATED"
- "complete" -> "COMPLETED"
- "submit" -> "SUBMITTED"

PRIORITY RULES (to avoid ambiguity):
- If the user explicitly specifies a TARGET state (e.g. "to VALIDATED", "a COMPLETED", "to failed", "to submitted"),
  then nextState MUST be that explicit target (normalized to uppercase).
- If filters.practiceId is NOT null, then filters.status MUST be null
  (unless the user explicitly mentions the CURRENT/source status like "from VALIDATED").

NAME EXTRACTION:
- Extract the person's name if explicitly present (e.g. "di Mario Rossi")
- If absent: null
- DO NOT invent names

UUID EXTRACTION:
- If the user explicitly provides a UUID, set filters.practiceId to that UUID string
- Otherwise null

Allowed status/nextState values (uppercase only):
- "CREATED" | "VALIDATED" | "SUBMITTED" | "FAILED" | "COMPLETED"

FORBIDDEN:
- No ambiguous/error markers
- No natural language output`;

const FEW_SHOT = `
Few-shot examples (CRITICAL). Output ONLY the JSON object:

Input:
"crea pratica per Mario Rossi"
Output:
{"action":"create_practice","filters":{"practiceId":null,"status":null,"name":null},"artistName":"Mario Rossi","nextState":"CREATED"}

Input:
"valida la pratica"
Output:
{"action":"transition_practice","filters":{"practiceId":null,"status":"CREATED","name":null},"artistName":null,"nextState":"VALIDATED"}

Input:
"valida la pratica di Mario Rossi"
Output:
{"action":"transition_practice","filters":{"practiceId":null,"status":"CREATED","name":"Mario Rossi"},"artistName":null,"nextState":"VALIDATED"}

Input:
"Valida la pratica 550e8400-e29b-41d4-a716-446655440000"
Output:
{"action":"transition_practice","filters":{"practiceId":"550e8400-e29b-41d4-a716-446655440000","status":"CREATED","name":null},"artistName":null,"nextState":"VALIDATED"}

Input:
"Set practice 550e8400-e29b-41d4-a716-446655440000 to VALIDATED"
Output:
{"action":"transition_practice","filters":{"practiceId":"550e8400-e29b-41d4-a716-446655440000","status":null,"name":null},"artistName":null,"nextState":"VALIDATED"}

Input:
"Set practice 550e8400-e29b-41d4-a716-446655440000 to COMPLETED"
Output:
{"action":"transition_practice","filters":{"practiceId":"550e8400-e29b-41d4-a716-446655440000","status":null,"name":null},"artistName":null,"nextState":"COMPLETED"}

Input:
"Porta la pratica a submitted"
Output:
{"action":"transition_practice","filters":{"practiceId":null,"status":null,"name":null},"artistName":null,"nextState":"SUBMITTED"}

Input:
"Manda avanti la pratica 6ba7b810-9dad-11d1-80b4-00c04fd430c8 a COMPLETED"
Output:
{"action":"transition_practice","filters":{"practiceId":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","status":null,"name":null},"artistName":null,"nextState":"COMPLETED"}

Input:
"Complete practice 6ba7b810-9dad-11d1-80b4-00c04fd430c8"
Output:
{"action":"transition_practice","filters":{"practiceId":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","status":null,"name":null},"artistName":null,"nextState":"COMPLETED"}

Input:
"submit practice 6ba7b810-9dad-11d1-80b4-00c04fd430c8"
Output:
{"action":"transition_practice","filters":{"practiceId":"6ba7b810-9dad-11d1-80b4-00c04fd430c8","status":"CREATED","name":null},"artistName":null,"nextState":"SUBMITTED"}
`;

function buildAvailablePracticesSection(context?: InterpreterContext): string {
  const practices = context?.practices ?? [];
  if (practices.length === 0) {
    return ['AVAILABLE PRACTICES:', '- none'].join('\n');
  }

  const lines = practices.map(
    (p) =>
      `- ID: ${p.id} | STATUS: ${p.status} | NAME: ${p.name ?? '-'} | TYPE: ${p.type} | SUMMARY: ${p.summary}`,
  );
  return ['AVAILABLE PRACTICES:', ...lines].join('\n');
}

export function buildInterpreterPrompt(userInput: string, context?: InterpreterContext): string {
  return [
    'You are SinfonIA Input Interpreter.',
    'Extract intent and filters only. Do not resolve final practice selection.',
    STRICT_JSON_RULE,
    '',
    buildAvailablePracticesSection(context),
    '',
    'Rules on context usage:',
    '- Use context as hints to extract best filters.',
    '- Do not decide the final candidate; deterministic engine resolves candidates later.',
    '- Use NAME, TYPE, and SUMMARY to match user intent to the correct practice.',
    '',
    SCHEMA,
    '',
    FEW_SHOT,
    'User:',
    userInput.trim(),
    'Output (JSON only):',
  ]
    .filter(Boolean)
    .join('\n');
}
