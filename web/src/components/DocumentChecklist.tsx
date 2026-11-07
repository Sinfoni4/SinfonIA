import type { ChecklistState, DocumentChecklist as Checklist } from '../api/practices';

const STATE_TEXT: Record<ChecklistState, string> = {
  missing: 'mancante',
  to_verify: 'da verificare',
  valid: 'valido',
  rejected: 'respinto',
};

const STATE_CLASS: Record<ChecklistState, string> = {
  missing: 'state',
  to_verify: 'state',
  valid: 'state state-completed',
  rejected: 'state state-failed',
};

/**
 * AGX-05: the documents the practice's type expects, each with its state computed by the backend
 * (missing, to verify, valid, rejected with the reason). Shared by one's own practices and those
 * reached through a delegation.
 */
export function DocumentChecklist({ checklist }: { checklist: Checklist }) {
  if (checklist.items.length === 0) return null;
  const required = checklist.items.filter((i) => i.required);
  return (
    <section className="card" aria-labelledby="checklist-title">
      <h2 id="checklist-title">Documenti previsti</h2>
      <p className={checklist.complete ? 'muted' : undefined} role="status">
        {checklist.complete
          ? 'Tutti i documenti obbligatori sono validi.'
          : `Documenti obbligatori validi: ${required.filter((i) => i.state === 'valid').length} su ${required.length}.`}
      </p>
      <ul className="plain">
        {checklist.items.map((item) => (
          <li key={item.key}>
            {item.label}
            {item.required ? '' : <span className="muted"> (se c’è)</span>}{' '}
            <span className={STATE_CLASS[item.state]}>{STATE_TEXT[item.state]}</span>
            {item.attachment && <span className="muted"> · {item.attachment.fileName}</span>}
            {item.state === 'rejected' && item.rejectionReason && (
              <p className="error">Motivo: {item.rejectionReason}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
