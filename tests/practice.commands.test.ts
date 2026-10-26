import { describe, expect, it } from 'vitest';

import { parsePracticeCommand } from '../src/core/practice/practice.commands.js';

describe('practice commands', () => {
  it('parses deterministic practice commands', () => {
    expect(parsePracticeCommand('crea pratica Mario Rossi')).toEqual({
      type: 'CREATE_PRACTICE',
      payload: { name: 'Mario Rossi' },
    });

    expect(parsePracticeCommand('stato pratica Mario Rossi')).toEqual({
      type: 'GET_PRACTICE_STATUS',
      payload: { name: 'Mario Rossi' },
    });

    expect(parsePracticeCommand('elimina pratica Mario Rossi')).toEqual({
      type: 'DELETE_PRACTICE',
      payload: { name: 'Mario Rossi' },
    });

    expect(parsePracticeCommand('lista pratiche')).toEqual({
      type: 'LIST_PRACTICES',
      payload: {},
    });
  });

  it('parses export filters without passing raw input to the service', () => {
    expect(parsePracticeCommand('export pratiche mese invia')).toEqual({
      type: 'EXPORT_PRACTICES',
      payload: { filter: { type: 'month' }, send: true },
    });

    expect(parsePracticeCommand('export pratiche 2026')).toEqual({
      type: 'EXPORT_PRACTICES',
      payload: { filter: { type: 'year', value: 2026 }, send: false },
    });
  });

  it('returns null for natural language that must go through the AI flow', () => {
    expect(parsePracticeCommand('crea pratica per Mario Rossi')).toBeNull();
    expect(parsePracticeCommand('valida la pratica di Mario Rossi')).toBeNull();
    expect(parsePracticeCommand('completa la pratica di Mario Rossi')).toBeNull();
  });
});
