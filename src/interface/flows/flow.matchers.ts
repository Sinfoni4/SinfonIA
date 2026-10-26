export function isStatusIntent(input: string): boolean {
  const lower = input.toLowerCase();

  return (
    lower.includes('che stato ha') ||
    lower.includes('stato pratica') ||
    lower.includes('status practice') ||
    lower.includes('è validata') ||
    lower.includes("e' validata") ||
    lower.includes('validata') ||
    lower.includes('è completata') ||
    lower.includes("e' completata") ||
    lower.includes('completata')
  );
}

export function isListIntent(input: string): boolean {
  const lower = input.toLowerCase();

  return (
    lower.includes('quali pratiche ho') ||
    lower.includes('lista pratiche') ||
    lower.includes('mostra pratiche') ||
    lower.includes('le mie pratiche')
  );
}

export function isNextStepIntent(input: string): boolean {
  const lower = input.toLowerCase();

  return (
    lower.includes('e dopo') ||
    lower.includes('che faccio') ||
    lower.includes('cosa posso fare') ||
    lower.includes('next')
  );
}

export function isAmbiguousName(input: string): boolean {
  const t = input.toLowerCase();

  return t.includes('mario rossi') && (t.includes('valida') || t.includes('completa'));
}
