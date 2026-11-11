import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';

import { type IssuedLink, type ChatInvite } from '../api/channels';
import { ApiError, describeError, ROLE_LABELS, type Me, type Role } from '../api/client';
import { formatDate } from '../api/practices';
import { useSession } from '../session/session';

const STATUS: Record<ChatInvite['status'], string> = {
  PENDING: 'da usare',
  ACCEPTED: 'usato',
  REVOKED: 'revocato',
  EXPIRED: 'scaduto',
};

/** The link to hand over, with a copy button; without the bot's name, the command to write. */
export function IssuedLinkBox({ issued, validity }: { issued: IssuedLink; validity: string }) {
  const [copied, setCopied] = useState(false);
  const text = issued.link ?? `/start ${issued.token}`;
  return (
    <div
      className="card"
      role="status"
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <p>
        {issued.link
          ? 'Manda questo link alla persona: lo apre in Telegram e preme «Avvia».'
          : 'La persona scrive al bot di SinfonIA questo messaggio:'}
      </p>
      <code style={{ wordBreak: 'break-all' }}>{text}</code>
      <p className="muted">{validity} Una sola volta: dopo l&apos;uso non funziona più.</p>
      <div className="actions">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copiato' : 'Copia'}
        </button>
      </div>
    </div>
  );
}

/**
 * Personal Telegram invitations: a new person enters the organization by opening a single-use
 * link in Telegram, with the role chosen here (no email needed).
 */
export function ChatInvites({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [role, setRole] = useState<Role>('MEMBER');
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const key = ['chat-invites', me.current.orgId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<ChatInvite[]>('/members/chat-invites'),
  });
  const create = useMutation({
    mutationFn: (r: Role) =>
      api<IssuedLink>('/members/chat-invites', { method: 'POST', body: { role: r } }),
    onSuccess: async (link) => {
      setIssued(link);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/members/chat-invites/${id}/revoke`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  if (query.error instanceof ApiError && query.error.status === 404) return null;
  const pending = (query.data ?? []).filter((i) => i.status === 'PENDING');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setIssued(null);
    create.mutate(role);
  };

  return (
    <section aria-labelledby="chat-invites-title">
      <h2 id="chat-invites-title">Invito con link Telegram</h2>
      <p className="muted">
        Per chi usa solo la chat: crea un link personale, mandalo alla persona (per esempio su
        WhatsApp) e lei entra aprendolo in Telegram. Non serve l&apos;email.
      </p>
      <form className="filters" onSubmit={submit}>
        <label>
          Ruolo
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="MEMBER">{ROLE_LABELS.MEMBER}</option>
            <option value="OPERATOR">{ROLE_LABELS.OPERATOR}</option>
            <option value="ADMIN">{ROLE_LABELS.ADMIN}</option>
          </select>
        </label>
        <button type="submit" disabled={create.isPending}>
          Crea il link
        </button>
      </form>
      {create.isError && (
        <p className="error" role="alert">
          {describeError(create.error)}
        </p>
      )}
      {issued && <IssuedLinkBox issued={issued} validity="Vale 7 giorni." />}
      {pending.length > 0 && (
        <ul className="plain">
          {pending.map((i) => (
            <li key={i.id}>
              Link per {ROLE_LABELS[i.role]}, {STATUS[i.status]} fino al {formatDate(i.expiresAt)}{' '}
              <button
                type="button"
                className="link"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(i.id)}
              >
                Revoca
              </button>
            </li>
          ))}
        </ul>
      )}
      {revoke.isError && (
        <p className="error" role="alert">
          {describeError(revoke.error)}
        </p>
      )}
    </section>
  );
}
