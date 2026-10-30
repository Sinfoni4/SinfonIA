import { ROLE_LABELS, type Me } from '../api/client';

const SECTIONS = [
  { title: 'Pratiche', text: 'Elenco, dettaglio, stati e allegati.' },
  { title: 'Scadenze', text: 'DURC, sicurezza, visite mediche e altre scadenze.' },
  { title: 'Export', text: 'Esportazione delle pratiche in CSV.' },
  { title: 'Persone', text: 'Membri, ruoli e inviti.', adminOnly: true },
];

/** Starting page: the sections of the dashboard, filled in by the next stages. */
export function HomePage({ me }: { me: Me }) {
  const current = me.organizations.find((o) => o.orgId === me.current.orgId);
  const isAdmin = me.current.role === 'ADMIN';
  return (
    <>
      <h1>{current?.name}</h1>
      <p className="muted">Accesso come {ROLE_LABELS[me.current.role]}.</p>
      <ul className="tiles">
        {SECTIONS.filter((s) => !s.adminOnly || isAdmin).map((s) => (
          <li key={s.title} className="card">
            <h2>{s.title}</h2>
            <p>{s.text}</p>
            <p className="muted">In arrivo</p>
          </li>
        ))}
      </ul>
    </>
  );
}
