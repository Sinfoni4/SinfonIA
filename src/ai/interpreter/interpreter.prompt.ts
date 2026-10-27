/**
 * Hardened prompt for the interpreter: few-shot, explicit schema, strict JSON.
 * Reduces hallucination and keeps output parseable.
 */

import type { InterpreterContext } from './interpreter.types.js';

const STRICT_JSON_RULE =
  'Return ONLY a single JSON object. No markdown, no code fences, no explanation, no trailing text.';

const SCHEMA = `You MUST output JSON with EXACTLY this structure (no extra keys):
{
  "schemaVersion": 1,
  "action": "transition_practice" | "create_practice" | "clarification_required",
  "confidence": number between 0.0 and 1.0,
  "filters": {
    "practiceId": string | null,
    "status": string | null,
    "name": string | null
  },
  "artistName": string | null,
  "nextState": string | null,
  "clarification": {
    "question": string,
    "reason": string,
    "options": string[]
  } | null
}

HARD RULES:
- ALWAYS include schemaVersion: 1, action, confidence, filters, artistName, nextState, clarification
- NEVER omit fields (even if unknown: set to null)
- confidence MUST be a float between 0.0 (uncertain) and 1.0 (certain)
- If confidence < 0.75 or input is ambiguous, set action to "clarification_required" and provide targeted question in clarification.question
- For create_practice: action = "create_practice", artistName = person name, nextState = "CREATED", clarification = null, confidence = 1.0
- For transition_practice: action = "transition_practice", nextState = target status, clarification = null

STATUS INFERENCE:
- "valida" -> nextState = "VALIDATED", filters.status = "CREATED"
- "completa" -> nextState = "COMPLETED", filters.status = "VALIDATED"
- "invia" / "submit" -> nextState = "SUBMITTED"

Allowed status/nextState values (uppercase):
- "CREATED" | "VALIDATED" | "SUBMITTED" | "FAILED" | "COMPLETED"`;

const FEW_SHOT = `
Few-shot examples (CRITICAL). Output ONLY the JSON object:

Input:
"crea pratica per Mario Rossi"
Output:
{"schemaVersion":1,"action":"create_practice","confidence":1.0,"filters":{"practiceId":null,"status":null,"name":null},"artistName":"Mario Rossi","nextState":"CREATED","clarification":null}

Input:
"valida la pratica"
Output:
{"schemaVersion":1,"action":"transition_practice","confidence":0.95,"filters":{"practiceId":null,"status":"CREATED","name":null},"artistName":null,"nextState":"VALIDATED","clarification":null}

Input:
"valida la pratica di Mario Rossi"
Output:
{"schemaVersion":1,"action":"transition_practice","confidence":1.0,"filters":{"practiceId":null,"status":"CREATED","name":"Mario Rossi"},"artistName":null,"nextState":"VALIDATED","clarification":null}

Input:
"Valida la pratica 550e8400-e29b-41d4-a716-446655440000"
Output:
{"schemaVersion":1,"action":"transition_practice","confidence":1.0,"filters":{"practiceId":"550e8400-e29b-41d4-a716-446655440000","status":"CREATED","name":null},"artistName":null,"nextState":"VALIDATED","clarification":null}

Input:
"forse vorrei fare qualcosa con una pratica, non so bene"
Output:
{"schemaVersion":1,"action":"clarification_required","confidence":0.3,"filters":{"practiceId":null,"status":null,"name":null},"artistName":null,"nextState":null,"clarification":{"question":"Cosa desideri fare con le tue pratiche? Puoi creare una nuova pratica, controllarne lo stato o validarla.","reason":"Intento non chiaro","options":["Crea nuova pratica","Controlla stato pratiche","Valida pratica"]}}
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
    'Extract intent, confidence, and filters only. Do not resolve final practice selection.',
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

export function buildRepairPrompt(
  originalInput: string,
  invalidOutput: string,
  errorDescription: string,
): string {
  return [
    'You are repairing a JSON response for SinfonIA Input Interpreter.',
    'Your previous response failed validation with the following error:',
    `ERROR: ${errorDescription}`,
    '',
    'PREVIOUS INVALID OUTPUT:',
    invalidOutput,
    '',
    'ORIGINAL USER INPUT:',
    originalInput,
    '',
    STRICT_JSON_RULE,
    SCHEMA,
    'Return ONLY the corrected JSON object matching schemaVersion: 1.',
    'Output (JSON only):',
  ].join('\n');
}
