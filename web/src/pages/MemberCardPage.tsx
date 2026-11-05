import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';

import { describeError, type Me, type Role } from '../api/client';
import { CATEGORY_LABELS, daysLabel, isoToItalian, type DeadlineCategory } from '../api/compliance';
import { ROLE_NAMES } from '../api/members';
import { formatDate, STATE_LABELS, type PracticeState } from '../api/practices';
import { useSession } from '../session/session';

type CardPractice = {
  id: string;
  name: string;
  status: PracticeState;
  typeLabel: string;
  updatedAt: string;
};

export type MemberCard = {
  userId: string;
  email: string | null;
  role: Role;
  customRole: { id: string; name: string } | null;
  status: string;
  since: string;
  practices: { total: number; open: number; items: CardPractice[] };
  assigned: CardPractice[];
  deadlines: Array<{
    id: string;
    title: string;
    category: string;
    dueDate: string;
    daysLeft: number;
  }>;
  documents: {
    total: number;
    toReview: number;
    items: Array<{
      id: string;
      practiceId: string;
      practiceName: string;
      fileName: string;
      ocrStatus: string;
      validated: boolean;
      createdAt: string;
    }>;
  };
};

const DOCUMENT_STATES: Record<string, string> = {
  PENDING: 'da leggere',
  PROCESSING: 'in lettura',
  FAILED: 'non letto',
};

function PracticeList({ items, empty }: { items: CardPractice[]; empty: string }) {
  if (items.length === 0) return <p className="muted">{empty}</p>;
  return (
    <ul className="plain">
      {items.map((p) => (
        <li key={p.id}>
          <Link to={`/pratiche/${p.id}`}>{p.name}</Link>{' '}
          <span className={`state state-${p.status.toLowerCase()}`}>{STATE_LABELS[p.status]}</span>{' '}
          <span className="muted">aggiornata il {formatDate(p.updatedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Cantiere 3 (item 43): one member in one view, for the administrators. */
export function MemberCardPage({ me }: { me: Me }) {
  const { userId = '' } = useParams();
  const { api } = useSession();
  const query = useQuery({
    queryKey: ['members', me.current.orgId, 'card', userId],
    queryFn: () => api<MemberCard>(`/members/${userId}`),
    enabled: me.current.role === 'ADMIN',
  });

  if (me.current.role !== 'ADMIN') {
    return (
      <>
        <h1>Persona</h1>
        <p className="muted">Solo gli amministratori vedono le schede delle persone.</p>
      </>
    );
  }
  const card = query.data;
  return (
    <>
      <p>
        <Link to="/persone">← Persone</Link>
      </p>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {card && (
        <>
          <h1>{card.email ?? 'Account della chat, senza email'}</h1>
          <section className="card">
            <dl className="facts">
              <dt>Ruolo</dt>
              <dd>
                {ROLE_NAMES[card.role]}
                {card.customRole && ` · ${card.customRole.name}`}
              </dd>
              <dt>Stato</dt>
              <dd>{card.status === 'ACTIVE' ? 'attivo' : card.status.toLowerCase()}</dd>
              <dt>Nell&apos;organizzazione dal</dt>
              <dd>{formatDate(card.since)}</dd>
              <dt>Pratiche</dt>
              <dd>
                {card.practices.total}, di cui {card.practices.open} in corso
              </dd>
              <dt>Documenti</dt>
              <dd>
                {card.documents.total}
                {card.documents.toReview > 0 && `, ${card.documents.toReview} da verificare`}
              </dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="card-practices">
            <h2 id="card-practices">Pratiche</h2>
            <PracticeList items={card.practices.items} empty="Nessuna pratica." />
          </section>

          {card.assigned.length > 0 && (
            <section className="card" aria-labelledby="card-assigned">
              <h2 id="card-assigned">Pratiche che segue</h2>
              <PracticeList items={card.assigned} empty="" />
            </section>
          )}

          <section className="card" aria-labelledby="card-deadlines">
            <h2 id="card-deadlines">Scadenze aperte</h2>
            {card.deadlines.length === 0 ? (
              <p className="muted">Nessuna scadenza aperta.</p>
            ) : (
              <ul className="plain">
                {card.deadlines.map((d) => (
                  <li key={d.id}>
                    {d.title}{' '}
                    <span className="muted">
                      ({CATEGORY_LABELS[d.category as DeadlineCategory] ?? d.category},{' '}
                      {isoToItalian(d.dueDate)}, {daysLabel(d.daysLeft)})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="card-documents">
            <h2 id="card-documents">Documenti</h2>
            {card.documents.items.length === 0 ? (
              <p className="muted">Nessun documento.</p>
            ) : (
              <ul className="plain">
                {card.documents.items.map((d) => (
                  <li key={d.id}>
                    {d.fileName}{' '}
                    <span className="muted">
                      in <Link to={`/pratiche/${d.practiceId}`}>{d.practiceName}</Link>,{' '}
                      {d.validated
                        ? 'verificato'
                        : d.ocrStatus === 'COMPLETED'
                          ? 'da verificare'
                          : (DOCUMENT_STATES[d.ocrStatus] ?? d.ocrStatus)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
