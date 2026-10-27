import type { ExecutorInput } from '../execution/executor.types.js';
import type { InterpreterContext, InterpreterOutput } from '../interpreter/interpreter.types.js';

export class DecisionEngine {
  resolveCommand(input: InterpreterOutput, context: InterpreterContext): ExecutorInput {
    // 1. Explicit Clarification State from Interpreter (e.g. low confidence or ambiguous prompt)
    if (input.action === 'clarification_required') {
      return {
        action: 'clarification_required',
        data: {
          question:
            input.clarification?.question ?? 'Potresti chiarire a quale pratica ti riferisci?',
          reason: input.clarification?.reason ?? 'CLARIFICATION_REQUIRED',
          options: input.clarification?.options ?? [],
          candidatePracticeIds: input.clarification?.candidatePracticeIds ?? [],
          confidence: input.confidence,
        },
      };
    }

    // 2. Unsupported action fallback
    if (input.action !== 'transition_practice') {
      return {
        action: 'clarification_required',
        data: {
          question: `Azione "${input.action}" non supportata. Desideri creare una pratica o avanzarne una esistente?`,
          reason: 'UNSUPPORTED_ACTION',
          options: ['Crea nuova pratica', 'Modifica stato pratica'],
          candidatePracticeIds: [],
          confidence: 0.0,
        },
      };
    }

    const practices = context.practices ?? [];
    let candidates = [...practices];

    if (input.filters.practiceId) {
      candidates = candidates.filter((p) => p.id === input.filters.practiceId);
    }
    if (input.filters.status) {
      candidates = candidates.filter((p) => p.status === input.filters.status);
    }
    if (input.filters.name) {
      const needle = input.filters.name.toLowerCase();
      candidates = candidates.filter((p) => {
        const hay = `${p.name ?? ''} ${p.type} ${p.summary}`.toLowerCase();
        return hay.includes(needle);
      });
    }

    // 3. Zero-Ambiguity Enforcement:
    // If multiple candidates exist, prevent state mutation and generate structured clarification
    if (candidates.length > 1) {
      const candidateList = candidates
        .map((c, i) => `[${i + 1}] "${c.name ?? 'Pratica'}" (${c.status})`)
        .join(', ');

      return {
        action: 'clarification_required',
        data: {
          question: `Ho individuato ${candidates.length} pratiche corrispondenti alla tua richiesta: ${candidateList}. A quale desideri fare riferimento?`,
          reason: 'MULTIPLE_CANDIDATES',
          options: candidates.map((c) => c.name ?? c.id),
          candidatePracticeIds: candidates.map((c) => c.id),
          confidence: 0.5,
        },
      };
    }

    // If zero candidates found:
    if (candidates.length === 0) {
      return {
        action: 'clarification_required',
        data: {
          question:
            "Non ho trovato alcuna pratica attiva corrispondente ai filtri specificati. Desideri crearne una nuova o consultare l'elenco?",
          reason: 'ZERO_CANDIDATES',
          options: ['Crea nuova pratica', 'Mostra tutte le pratiche'],
          candidatePracticeIds: [],
          confidence: 0.2,
        },
      };
    }

    // Deterministic single candidate: allow transition
    const output: ExecutorInput = {
      action: 'transition_practice',
      data: {
        practiceId: candidates[0].id,
        nextState: input.nextState,
      },
    };

    return output;
  }
}
