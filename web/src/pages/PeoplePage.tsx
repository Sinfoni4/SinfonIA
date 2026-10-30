import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { ApiError, describeError, type Me, type Role } from '../api/client';
import {
  exportsWholeOrganization,
  INVITATION_LABELS,
  invitationLink,
  memberState,
  ROLE_HINTS,
  ROLE_NAMES,
  ROLES,
  type Invitation,
  type Member,
} from '../api/members';
import { formatDate } from '../api/practices';
import { useSession } from '../session/session';

type Pending =
  { kind: 'role'; userId: string; role: Role } | { kind: 'revoke'; userId: string } | null;

/** P8: members, roles, revocation and invitations; administrators only (members.manage). */
export function PeoplePage({ me }: { me: Me }) {
  if (me.current.role !== 'ADMIN') {
    return (
      <>
        <h1>Persone</h1>
        <p className="muted">Solo gli amministratori gestiscono le persone dell&apos;azienda.</p>
      </>
    );
  }
  return (
    <>
      <h1>Persone</h1>
      <Members me={me} />
      <Invitations me={me} />
    </>
  );
}

function Members({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [reason, setReason] = useState('');
  const [showRevoked, setShowRevoked] = useState(false);

  const query = useQuery({
    queryKey: ['members', me.current.orgId],
    queryFn: () => api<Member[]>('/members'),
  });

  const act = useMutation({
    mutationFn: (call: { path: string; body: unknown }) =>
      api(call.path, { method: 'POST', body: call.body }),
    onSuccess: async () => {
      setPending(null);
      setReason('');
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
  const run = (userId: string, action: string, body: unknown = {}) =>
    act.mutate({ path: `/members/${userId}/${action}`, body });

  const members = (query.data ?? []).filter((m) => showRevoked || m.status !== 'REVOKED');
  const revokedCount = (query.data ?? []).filter((m) => m.status === 'REVOKED').length;

  return (
    <section aria-labelledby="members-title">
      <h2 id="members-title">Membri</h2>
      {revokedCount > 0 && (
        <label className="check">
          <input
            type="checkbox"
            checked={showRevoked}
            onChange={(e) => setShowRevoked(e.target.checked)}
          />
          Mostra anche le persone revocate ({revokedCount})
        </label>
      )}
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {query.data && (
        <table className="list cards">
          <thead>
            <tr>
              <th scope="col">Persona</th>
              <th scope="col">Ruolo</th>
              <th scope="col">Stato</th>
              <th scope="col">Export</th>
              <th scope="col">Azioni</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const self = m.userId === me.userId;
              const state = memberState(m);
              const editable = state.active && !self;
              const shownRole =
                pending?.kind === 'role' && pending.userId === m.userId ? pending.role : m.role;
              return (
                <tr key={m.userId}>
                  <td data-label="Persona">
                    {m.email ?? <span className="muted">account della chat, senza email</span>}
                    {self && <span className="badge">tu</span>}
                  </td>
                  <td data-label="Ruolo">
                    {editable ? (
                      <select
                        aria-label={`Ruolo di ${m.email ?? 'questa persona'}`}
                        value={shownRole}
                        disabled={act.isPending}
                        onChange={(e) => {
                          const role = e.target.value as Role;
                          setPending(
                            role === m.role ? null : { kind: 'role', userId: m.userId, role },
                          );
                        }}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_NAMES[r]}
                          </option>
                        ))}
                      </select>
                    ) : (
                      ROLE_NAMES[m.role]
                    )}
                  </td>
                  <td data-label="Stato">
                    <span className={`state ${state.active ? '' : 'state-failed'}`}>
                      {state.label}
                    </span>
                    <div className="muted">dal {formatDate(m.since)}</div>
                  </td>
                  <td data-label="Export">
                    <ExportCell
                      member={m}
                      self={self}
                      active={state.active}
                      busy={act.isPending}
                      onPermission={(granted) =>
                        run(m.userId, 'permissions', { permission: 'practice.export', granted })
                      }
                      onScheduled={(enabled) => run(m.userId, 'scheduled-export', { enabled })}
                    />
                  </td>
                  <td data-label="Azioni">
                    {pending?.userId === m.userId && pending.kind === 'role' && (
                      <span className="actions">
                        <button
                          type="button"
                          disabled={act.isPending}
                          onClick={() => run(m.userId, 'role', { role: pending.role })}
                        >
                          Conferma: {ROLE_NAMES[pending.role].toLowerCase()}
                        </button>
                        <button type="button" className="link" onClick={() => setPending(null)}>
                          Annulla
                        </button>
                      </span>
                    )}
                    {pending?.userId === m.userId && pending.kind === 'revoke' && (
                      <span className="actions confirm">
                        <label>
                          Motivo (facoltativo)
                          <input
                            maxLength={500}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          className="danger"
                          disabled={act.isPending}
                          onClick={() =>
                            run(m.userId, 'revoke', reason.trim() ? { reason: reason.trim() } : {})
                          }
                        >
                          Conferma revoca
                        </button>
                        <button type="button" className="link" onClick={() => setPending(null)}>
                          Annulla
                        </button>
                      </span>
                    )}
                    {pending?.userId !== m.userId && !self && m.status === 'ACTIVE' && (
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setReason('');
                          setPending({ kind: 'revoke', userId: m.userId });
                        }}
                      >
                        Revoca accesso
                      </button>
                    )}
                    {!self && m.status === 'REVOKED' && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={act.isPending}
                        onClick={() => run(m.userId, 'reactivate')}
                      >
                        Riattiva
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {act.isError && (
        <p className="error" role="alert">
          {describeError(act.error)}
        </p>
      )}
      <p className="muted">
        La revoca e il cambio di ruolo valgono subito, su dashboard, API e chat. Per cambiare il tuo
        ruolo o revocare te stesso serve un altro amministratore.
      </p>
    </section>
  );
}

/** Export rights (D5): organization-wide export for an OPERATOR, scheduled export for an ADMIN. */
function ExportCell(props: {
  member: Member;
  self: boolean;
  active: boolean;
  busy: boolean;
  onPermission: (granted: boolean) => void;
  onScheduled: (enabled: boolean) => void;
}) {
  const { member, self, active, busy } = props;
  if (!active) return null;
  if (member.role === 'OPERATOR') {
    const granted = exportsWholeOrganization(member);
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={granted}
          disabled={busy}
          onChange={(e) => props.onPermission(e.target.checked)}
        />
        tutta l&apos;azienda
      </label>
    );
  }
  if (member.role === 'ADMIN') {
    // Only the person turns the scheduled export on; anyone of the administrators turns it off.
    return (
      <>
        <div>Pianificato in chat: {member.receivesScheduledExport ? 'sì' : 'no'}</div>
        {member.receivesScheduledExport ? (
          <button
            type="button"
            className="link"
            disabled={busy}
            onClick={() => props.onScheduled(false)}
          >
            Disattiva
          </button>
        ) : (
          self && (
            <button
              type="button"
              className="link"
              disabled={busy}
              onClick={() => props.onScheduled(true)}
            >
              Attiva per me
            </button>
          )
        )}
      </>
    );
  }
  return <span className="muted">solo le proprie</span>;
}

function Invitations({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [showClosed, setShowClosed] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['invitations', me.current.orgId],
    queryFn: () => api<Invitation[]>('/members/invitations'),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/members/invitations/${id}/revoke`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
  });

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <section aria-labelledby="invitations-title">
        <h2 id="invitations-title">Inviti</h2>
        <p className="muted">Gli inviti per email non sono attivi su questo server.</p>
      </section>
    );
  }

  const invitations = (query.data ?? []).filter((i) => showClosed || i.status === 'PENDING');

  return (
    <section aria-labelledby="invitations-title">
      <h2 id="invitations-title">Inviti</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={showClosed}
          onChange={(e) => setShowClosed(e.target.checked)}
        />
        Mostra anche quelli accettati, revocati o scaduti
      </label>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="muted">Caricamento…</p>}
      {query.data && invitations.length === 0 && (
        <p className="muted">Nessun invito {showClosed ? '' : 'in attesa'}.</p>
      )}
      {invitations.length > 0 && (
        <table className="list cards">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Ruolo</th>
              <th scope="col">Stato</th>
              <th scope="col">Azioni</th>
            </tr>
          </thead>
          <tbody>
            {invitations.map((i) => (
              <tr key={i.id}>
                <td data-label="Email">{i.email}</td>
                <td data-label="Ruolo">{ROLE_NAMES[i.role]}</td>
                <td data-label="Stato">
                  <span className={`state ${i.status === 'ACCEPTED' ? 'state-completed' : ''}`}>
                    {INVITATION_LABELS[i.status]}
                  </span>
                  {i.status === 'PENDING' && (
                    <div className="muted">scade il {formatDate(i.expiresAt)}</div>
                  )}
                </td>
                <td data-label="Azioni">
                  {i.status === 'PENDING' &&
                    (revoking === i.id ? (
                      <span className="actions">
                        <button
                          type="button"
                          className="danger"
                          disabled={revoke.isPending}
                          onClick={() => revoke.mutate(i.id)}
                        >
                          Conferma revoca
                        </button>
                        <button type="button" className="link" onClick={() => setRevoking(null)}>
                          Annulla
                        </button>
                      </span>
                    ) : (
                      <button type="button" className="secondary" onClick={() => setRevoking(i.id)}>
                        Revoca invito
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {revoke.isError && (
        <p className="error" role="alert">
          {describeError(revoke.error)}
        </p>
      )}
      <NewInvitationForm />
    </section>
  );
}

function NewInvitationForm() {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('MEMBER');
  const [sent, setSent] = useState<{ email: string; devToken?: string } | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api<{ invitationId: string; devToken?: string }>('/members/invitations', {
        method: 'POST',
        body: { email: email.trim(), role },
      }),
    onSuccess: async (data) => {
      setSent({ email: email.trim(), devToken: data.devToken });
      setEmail('');
      await queryClient.invalidateQueries({ queryKey: ['invitations'] });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSent(null);
    create.mutate();
  };

  return (
    <form className="card form" onSubmit={submit} aria-labelledby="new-invitation">
      <h3 id="new-invitation">Invita una persona</h3>
      <label htmlFor="invite-email">Email</label>
      <input
        id="invite-email"
        type="email"
        autoComplete="off"
        maxLength={254}
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <label htmlFor="invite-role">Ruolo</label>
      <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_NAMES[r]} — {ROLE_HINTS[r]}
          </option>
        ))}
      </select>
      <button type="submit" disabled={!email.includes('@') || create.isPending}>
        Invia invito
      </button>
      {create.isError && (
        <p className="error" role="alert">
          {describeError(create.error)}
        </p>
      )}
      {sent && (
        <p role="status">
          Invito inviato a <strong>{sent.email}</strong>. Vale 7 giorni e una sola volta.
        </p>
      )}
      {sent?.devToken && (
        <p className="dev-code" role="note">
          Ambiente di sviluppo: per provare l&apos;accettazione apri questo link in una finestra
          anonima (qui resteresti collegato come amministratore):{' '}
          <code className="dev-link">{invitationLink(window.location.origin, sent.devToken)}</code>
        </p>
      )}
    </form>
  );
}
