import { InterpreterError } from '../interpreter/interpreter.types.js';

import type { ExecutorInput } from '../execution/executor.types.js';
import type { InterpreterContext, InterpreterOutput } from '../interpreter/interpreter.types.js';

export class DecisionEngine {
  resolveCommand(input: InterpreterOutput, context: InterpreterContext): ExecutorInput {
    if (input.action !== 'transition_practice') {
      throw new InterpreterError('Ambiguous input: unsupported action');
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

    if (candidates.length !== 1) {
      throw new InterpreterError('Ambiguous input: cannot derive deterministic action');
    }

    const output: ExecutorInput = {
      action: 'transition_practice',
      data: {
        practiceId: candidates[0].id,
        nextState: input.nextState,
      },
    };

    console.log('[ai-flow]', { step: 'decision', input, output });
    return output;
  }
}
