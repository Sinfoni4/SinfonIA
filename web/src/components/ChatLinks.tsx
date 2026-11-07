import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { CHANNEL_NAMES, type ChannelLink, type OwnChannelLinks } from '../api/channels';
import { describeError } from '../api/client';
import { formatDate } from '../api/practices';
import { useSession } from '../session/session';

type Props = { mode: 'own' } | { mode: 'member'; userId: string; orgId: string };

/**
 * AGX-10 / MF7: the chat accounts linked to a person, with their revocation: one's own in the
 * profile, a member's in their card (administrators). A revoked chat is no longer recognized.
 */
export function ChatLinks(props: Props) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<string | null>(null);
  const key =
    props.mode === 'own' ? ['channels', 'own'] : ['channels', props.orgId, 'member', props.userId];
  const query = useQuery({
    queryKey: key,
    queryFn: async (): Promise<OwnChannelLinks> =>
      props.mode === 'own'
        ? api<OwnChannelLinks>('/me/channels')
        : {
            links: await api<ChannelLink[]>(`/members/${props.userId}/channels`),
            linkingAvailable: true,
          },
  });
  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(
        props.mode === 'own'
          ? `/me/channels/${id}/revoke`
          : `/members/${props.userId}/channels/${id}/revoke`,
        { method: 'POST', body: {} },
      ),
    onSuccess: async () => {
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const links = query.data?.links ?? [];

  return (
    <section className="card" aria-labelledby="chat-links">
      <h2 id="chat-links">Chat collegate</h2>
      {query.isError && (
        <p className="error" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.data && links.length === 0 && (
        <p className="muted">
          {props.mode === 'own'
            ? 'Nessuna chat collegata.'
            : 'Nessuna chat collegata a questa persona.'}
        </p>
      )}
      {links.length > 0 && (
        <ul className="plain">
          {links.map((l) => (
            <li key={l.id}>
              {CHANNEL_NAMES[l.channel]} {l.ref}, dal {formatDate(l.linkedAt)}
              {!l.verified && (
                <span className="badge" title="Collegata con un vecchio codice d'invito">
                  da verificare
                </span>
              )}{' '}
              {confirming === l.id ? (
                <>
                  <span>Scollegare? Il bot non la riconoscerà più.</span>{' '}
                  <button
                    type="button"
                    className="danger"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(l.id)}
                  >
                    Sì, scollega
                  </button>{' '}
                  <button type="button" className="link" onClick={() => setConfirming(null)}>
                    Annulla
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    revoke.reset();
                    setConfirming(l.id);
                  }}
                >
                  Scollega
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revoke.isError && (
        <p className="error" role="alert">
          {describeError(revoke.error)}
        </p>
      )}
      {props.mode === 'own' && query.data && (
        <p className="muted">
          {query.data.linkingAvailable
            ? 'Per collegare Telegram o WhatsApp scrivi /accedi al bot, poi la tua email: ti arriva un codice da scrivere nella stessa chat.'
            : 'Il collegamento delle chat con email non è ancora attivo su questa installazione.'}
        </p>
      )}
    </section>
  );
}
