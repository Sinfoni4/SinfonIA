export type ToneType = 'success' | 'info' | 'warning' | 'error' | 'suggestion';

export function formatMessage(type: ToneType, lines: string[]): string {
  const prefixMap: Record<ToneType, string> = {
    success: '✅',
    info: 'ℹ️',
    warning: '⚠️',
    error: '❌',
    suggestion: '👉',
  };

  const prefix = prefixMap[type];
  return [prefix + ' ' + lines[0], ...lines.slice(1)].join('\n');
}
