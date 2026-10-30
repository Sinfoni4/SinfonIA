import { Link } from 'react-router';

import { ROLE_LABELS, type Me } from '../api/client';

const SECTIONS: Array<{ title: string; text: string; to: string; adminOnly?: boolean }> = [
  { title: 'Pratiche', text: 'Elenco, dettaglio, stati e allegati.', to: '/pratiche' },
  {
    title: 'Scadenze',
    text: 'DURC, sicurezza, visite mediche e altre scadenze.',
    to: '/scadenze',
  },
  { title: 'Export', text: 'Esportazione delle pratiche in CSV.', to: '/export' },
  { title: 'Persone', text: 'Membri, ruoli e inviti.', to: '/persone', adminOnly: true },
];

/** Starting page: the sections of the dashboard. */
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
            <h2>
              <Link to={s.to}>{s.title}</Link>
            </h2>
            <p>{s.text}</p>
          </li>
        ))}
      </ul>
    </>
  );
}
