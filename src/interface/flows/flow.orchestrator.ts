import { handleAmbiguity, handleList, handleNextStep, handleStatus } from './flow.handlers.js';
import {
  isAmbiguousName,
  isListIntent,
  isNextStepIntent,
  isStatusIntent,
} from './flow.matchers.js';

import type { FlowHandler, FlowOrchestrator } from './flow.types.js';

const handlers: {
  status: FlowHandler;
  list: FlowHandler;
  next: FlowHandler;
  ambiguity: FlowHandler;
} = {
  status: async () => handleStatus(),
  list: async () => handleList(),
  next: async (_input, userId) => handleNextStep(userId),
  ambiguity: async (_input, userId) => handleAmbiguity(userId),
};

function shouldSimulateAmbiguity(input: string): boolean {
  const t = input.toLowerCase();

  // Only simulate if NO explicit disambiguation
  return !t.includes('10 marzo') && !t.includes('12 marzo') && !t.includes('id');
}

export const handleFlow: FlowOrchestrator = async (input, userId) => {
  if (isStatusIntent(input)) {
    return handlers.status(input, userId);
  }

  if (isListIntent(input)) {
    return handlers.list(input, userId);
  }

  if (isNextStepIntent(input)) {
    return handlers.next(input, userId);
  }

  if (isAmbiguousName(input) && shouldSimulateAmbiguity(input)) {
    return handlers.ambiguity(input, userId);
  }

  return null;
};
