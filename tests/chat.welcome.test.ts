/** The greeting of the chat names the organization the person works for. */
import { describe, expect, it } from 'vitest';

import { onboardingMessage } from '../src/interface/conversation/conversation.service.js';

describe('the greeting of the chat', () => {
  it('names the organization, for staff and for members', () => {
    expect(onboardingMessage('MEMBER', 'Azienda Agricola Collio')).toMatch(
      /^👋 Ciao! Ti aiuto a gestire le tue pratiche di Azienda Agricola Collio\./,
    );
    expect(onboardingMessage('OPERATOR', 'TerreFVG')).toMatch(
      /^👋 Ciao! Ti aiuto a gestire le pratiche di TerreFVG\./,
    );
  });

  it('stays as before without a name', () => {
    expect(onboardingMessage('MEMBER')).toMatch(/^👋 Ciao! Ti aiuto a gestire le tue pratiche\./);
  });
});
