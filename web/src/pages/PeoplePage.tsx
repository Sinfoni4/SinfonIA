import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router';

import { ApiError, describeError, type Me, type Role } from '../api/client';
import {
  exportsWholeOrganization,
  INVITATION_LABELS,
  invitationLink,
  memberState,
  permissionLabel,
  ROLE_HINTS,
  ROLE_NAMES,
  ROLES,
  SCOPE_LABELS,
  ASSIGNABLE,
  type CustomRole,
  type Invitation,
  type Member,
  type PermissionScope,
  type RoleCatalog,
} from '../api/members';
import { formatDate } from '../api/practices';
import { ChatInvites } from '../components/ChatInvites';
import { DataTable, type DataColumn } from '../components/DataTable';
import { useSession } from '../session/session';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCell,
  TableFrame,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
    <div className="flex flex-col gap-8">
      <h1 className="m-0 text-2xl font-semibold tracking-tight">Persone</h1>
      <Members me={me} />
      <ChatInvites me={me} />
      <Invitations me={me} />
      <CustomRoles me={me} />
    </div>
  );
}

function Members({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const [pending, setPending] = useState<Pending>(null);
  const [showRevoked, setShowRevoked] = useState(false);

  const query = useQuery({
    queryKey: ['members', me.current.orgId],
    queryFn: () => api<Member[]>('/members'),
  });
  const roles = useQuery({
    queryKey: ['members', me.current.orgId, 'roles'],
    queryFn: () => api<CustomRole[]>('/roles'),
  });

  const act = useMutation({
    mutationFn: (call: { path: string; body: unknown }) =>
      api(call.path, { method: 'POST', body: call.body }),
    onSuccess: async () => {
      setPending(null);
      await queryClient.invalidateQueries({ queryKey: ['members'] });
    },
  });
  const { mutate } = act;
  const run = useCallback(
    (userId: string, action: string, body: unknown = {}) =>
      mutate({ path: `/members/${userId}/${action}`, body }),
    [mutate],
  );

  const members = (query.data ?? []).filter((m) => showRevoked || m.status !== 'REVOKED');
  const revokedCount = (query.data ?? []).filter((m) => m.status === 'REVOKED').length;

  // The cells are components for the table: rebuilt only when what they show changes, so a
  // field being filled (the reason of a revocation) keeps its text and focus.
  const busy = act.isPending;
  const customRoles = roles.data;
  const columns = useMemo<Array<DataColumn<Member>>>(
    () => [
      {
        id: 'person',
        header: 'Persona',
        enableHiding: false,
        meta: { label: 'Persona' },
        cell: ({ row: { original: m } }) => (
          <span className="flex flex-wrap items-center gap-2">
            <Link to={`/persone/${m.userId}`} className="font-medium">
              {m.email ?? <span className="muted">account della chat, senza email</span>}
            </Link>
            {m.userId === me.userId && <Badge>tu</Badge>}
          </span>
        ),
      },
      {
        id: 'role',
        header: 'Ruolo',
        meta: { label: 'Ruolo' },
        cell: ({ row: { original: m } }) => {
          const editable = memberState(m).active && m.userId !== me.userId;
          const shownRole =
            pending?.kind === 'role' && pending.userId === m.userId ? pending.role : m.role;
          return (
            <div className="flex flex-col gap-1.5">
              {editable ? (
                <NativeSelect
                  className="h-8 w-auto"
                  aria-label={`Ruolo di ${m.email ?? 'questa persona'}`}
                  value={shownRole}
                  disabled={busy}
                  onChange={(e) => {
                    const role = e.target.value as Role;
                    setPending(role === m.role ? null : { kind: 'role', userId: m.userId, role });
                  }}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_NAMES[r]}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                ROLE_NAMES[m.role]
              )}
              <CustomRoleCell
                member={m}
                roles={customRoles ?? []}
                editable={editable}
                busy={busy}
                onChange={(roleId) => run(m.userId, 'custom-role', { roleId })}
              />
            </div>
          );
        },
      },
      {
        id: 'status',
        header: 'Stato',
        meta: { label: 'Stato', className: 'whitespace-nowrap' },
        cell: ({ row: { original: m } }) => {
          const state = memberState(m);
          return (
            <div className="flex flex-col items-start gap-1">
              <Badge variant="outline" className="px-1.5 text-muted-foreground">
                {state.active ? (
                  <CircleCheck aria-hidden className="fill-green-600 text-white" />
                ) : (
                  <CircleX aria-hidden className="fill-destructive text-white" />
                )}
                <span className="text-foreground">{state.label}</span>
              </Badge>
              <span className="text-xs text-muted-foreground">dal {formatDate(m.since)}</span>
            </div>
          );
        },
      },
      {
        id: 'export',
        header: 'Export',
        meta: { label: 'Export' },
        cell: ({ row: { original: m } }) => (
          <ExportCell
            member={m}
            self={m.userId === me.userId}
            active={memberState(m).active}
            busy={busy}
            onPermission={(granted) =>
              run(m.userId, 'permissions', { permission: 'practice.export', granted })
            }
            onScheduled={(enabled) => run(m.userId, 'scheduled-export', { enabled })}
          />
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Azioni</span>,
        enableHiding: false,
        meta: { label: 'Azioni', className: 'text-right' },
        cell: ({ row: { original: m } }) => {
          const self = m.userId === me.userId;
          return (
            <div className="flex flex-wrap items-center justify-end gap-2">
              {pending?.userId === m.userId && pending.kind === 'role' && (
                <>
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => run(m.userId, 'role', { role: pending.role })}
                  >
                    Conferma: {ROLE_NAMES[pending.role].toLowerCase()}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
                    Annulla
                  </Button>
                </>
              )}
              {pending?.userId === m.userId && pending.kind === 'revoke' && (
                <RevokeForm
                  busy={busy}
                  onConfirm={(reason) => run(m.userId, 'revoke', reason ? { reason } : {})}
                  onCancel={() => setPending(null)}
                />
              )}
              {pending?.userId !== m.userId && !self && m.status === 'ACTIVE' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-foreground"
                  onClick={() => setPending({ kind: 'revoke', userId: m.userId })}
                >
                  Revoca accesso
                </Button>
              )}
              {!self && m.status === 'REVOKED' && (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-foreground"
                  disabled={busy}
                  onClick={() => run(m.userId, 'reactivate')}
                >
                  Riattiva
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [pending, busy, customRoles, me.userId, run],
  );

  return (
    <section aria-labelledby="members-title" className="flex flex-col gap-3">
      <h2 id="members-title" className="m-0">
        Membri
      </h2>
      {query.isError && (
        <p className="error m-0" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {query.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {query.data && (
        <DataTable
          label="Membri dell'azienda"
          columns={columns}
          data={members}
          rowKey={(m) => m.userId}
          empty="Nessuna persona."
          toolbar={
            revokedCount > 0 && (
              <label className="m-0 flex h-9 items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="m-0 size-4 p-0 accent-primary"
                  checked={showRevoked}
                  onChange={(e) => setShowRevoked(e.target.checked)}
                />
                Mostra anche le persone revocate ({revokedCount})
              </label>
            )
          }
        />
      )}
      {act.isError && (
        <p className="error m-0" role="alert">
          {describeError(act.error)}
        </p>
      )}
      <p className="m-0 text-sm text-muted-foreground">
        La revoca e il cambio di ruolo valgono subito, su dashboard, API e chat. Per cambiare il tuo
        ruolo o revocare te stesso serve un altro amministratore.
      </p>
    </section>
  );
}

/**
 * The confirmation of a revocation with its optional reason. The text lives here, not in the
 * table: a keystroke must not redraw the table (it would rebuild the field and lose the focus).
 */
function RevokeForm(props: {
  busy: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <>
      <Label className="text-left">
        Motivo (facoltativo)
        <Input
          className="h-8"
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Label>
      <Button
        size="sm"
        variant="destructive"
        className="self-end"
        disabled={props.busy}
        onClick={() => props.onConfirm(reason.trim())}
      >
        Conferma revoca
      </Button>
      <Button size="sm" variant="ghost" className="self-end" onClick={props.onCancel}>
        Annulla
      </Button>
    </>
  );
}

/** B2: the custom role of a member, chosen among those built on the member's role. */
function CustomRoleCell(props: {
  member: Member;
  roles: CustomRole[];
  editable: boolean;
  busy: boolean;
  onChange: (roleId: string | null) => void;
}) {
  const { member } = props;
  const options = props.roles.filter((r) => r.baseRole === member.role);
  if (!props.editable || options.length === 0) {
    return member.customRole ? (
      <span className="text-xs text-muted-foreground">{member.customRole.name}</span>
    ) : null;
  }
  return (
    <NativeSelect
      className="h-8 w-auto"
      aria-label={`Ruolo personalizzato di ${member.email ?? 'questa persona'}`}
      value={member.customRole?.id ?? ''}
      disabled={props.busy}
      onChange={(e) => props.onChange(e.target.value || null)}
    >
      <option value="">Tutto il ruolo</option>
      {options.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </NativeSelect>
  );
}

/**
 * B2 (H6): roles of the organization built on a base role, keeping only some of its permissions
 * or narrowing them to one's own practices. The backend checks the same rules.
 */
function CustomRoles({ me }: { me: Me }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const roles = useQuery({
    queryKey: ['members', me.current.orgId, 'roles'],
    queryFn: () => api<CustomRole[]>('/roles'),
  });
  const catalog = useQuery({
    queryKey: ['roles-catalog'],
    queryFn: () => api<RoleCatalog>('/roles/catalog'),
    staleTime: Infinity,
  });
  const [name, setName] = useState('');
  const [baseRole, setBaseRole] = useState<Role>('OPERATOR');
  const [chosen, setChosen] = useState<Record<string, PermissionScope>>({});

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['members'] });
  const create = useMutation({
    mutationFn: () =>
      api('/roles', { method: 'POST', body: { name: name.trim(), baseRole, permissions: chosen } }),
    onSuccess: async () => {
      setName('');
      setChosen({});
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/roles/${id}`, { method: 'DELETE' }),
    onSuccess: refresh,
  });

  const ceiling = catalog.data?.[baseRole] ?? {};
  const pickBase = (role: Role) => {
    setBaseRole(role);
    setChosen({});
  };
  const toggle = (permission: string, on: boolean) =>
    setChosen((current) => {
      const next = { ...current };
      if (on) next[permission] = ceiling[permission] ?? 'own';
      else delete next[permission];
      return next;
    });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  const list = roles.data ?? [];
  return (
    <section aria-labelledby="roles-title">
      <h2 id="roles-title">Ruoli personalizzati</h2>
      <p className="muted">
        Un ruolo personalizzato parte da un ruolo di base e ne tiene solo alcuni permessi, o li
        limita alle proprie pratiche: non dà mai più del ruolo di base. Vale subito, su dashboard,
        API e chat.
      </p>
      {roles.isError && (
        <p className="error" role="alert">
          {describeError(roles.error)}
        </p>
      )}
      {list.length > 0 && (
        <TableFrame>
          <Table aria-label="Ruoli personalizzati">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Ruolo</TableHead>
                <TableHead scope="col">Base</TableHead>
                <TableHead scope="col">Permessi</TableHead>
                <TableHead scope="col" className="text-right">
                  Persone
                </TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Azioni</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="px-1.5 text-muted-foreground">
                      {ROLE_NAMES[r.baseRole]}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ul className="m-0 list-none p-0">
                      {Object.entries(r.permissions).map(([p, scope]) => (
                        <li key={p}>
                          {permissionLabel(p)}
                          {scope !== 'tenant' && (
                            <span className="muted"> ({SCOPE_LABELS[scope]})</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.members}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="text-foreground"
                      disabled={remove.isPending || r.members > 0}
                      title={r.members > 0 ? 'Toglilo prima alle persone' : undefined}
                      onClick={() => remove.mutate(r.id)}
                    >
                      Elimina
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      )}
      {remove.isError && (
        <p className="error" role="alert">
          {describeError(remove.error)}
        </p>
      )}
      <form className="card form" onSubmit={submit} aria-labelledby="new-role-title">
        <h3 id="new-role-title">Nuovo ruolo</h3>
        <label htmlFor="role-name">Nome</label>
        <input
          id="role-name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="Es. Segreteria"
        />
        <label htmlFor="role-base">Parte dal ruolo</label>
        <select id="role-base" value={baseRole} onChange={(e) => pickBase(e.target.value as Role)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_NAMES[r]}
            </option>
          ))}
        </select>
        <fieldset>
          <legend>Permessi</legend>
          {Object.entries(ceiling).map(([permission, max]) => (
            <div key={permission}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={chosen[permission] !== undefined}
                  onChange={(e) => toggle(permission, e.target.checked)}
                />{' '}
                {permissionLabel(permission)}
              </label>
              {max === 'tenant' && chosen[permission] !== undefined && (
                <select
                  aria-label={`Ambito di ${permissionLabel(permission)}`}
                  value={chosen[permission]}
                  onChange={(e) =>
                    setChosen((c) => ({ ...c, [permission]: e.target.value as PermissionScope }))
                  }
                >
                  <option value="tenant">{SCOPE_LABELS.tenant}</option>
                  {ASSIGNABLE.includes(permission) && (
                    <option value="assigned">{SCOPE_LABELS.assigned}</option>
                  )}
                  <option value="own">{SCOPE_LABELS.own}</option>
                </select>
              )}
            </div>
          ))}
        </fieldset>
        <span className="actions">
          <button
            type="submit"
            disabled={
              create.isPending || name.trim().length < 2 || Object.keys(chosen).length === 0
            }
          >
            Crea il ruolo
          </button>
        </span>
        {create.isError && (
          <p className="error" role="alert">
            {describeError(create.error)}
          </p>
        )}
      </form>
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
      <label className="m-0 flex items-center gap-2 text-sm font-normal">
        <input
          type="checkbox"
          className="m-0 size-4 p-0 accent-primary"
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
        <div className="text-sm">
          Pianificato in chat: {member.receivesScheduledExport ? 'sì' : 'no'}
        </div>
        {member.receivesScheduledExport ? (
          <Button variant="link" size="sm" disabled={busy} onClick={() => props.onScheduled(false)}>
            Disattiva
          </Button>
        ) : (
          self && (
            <Button
              variant="link"
              size="sm"
              disabled={busy}
              onClick={() => props.onScheduled(true)}
            >
              Attiva per me
            </Button>
          )
        )}
      </>
    );
  }
  return <span className="text-sm text-muted-foreground">solo le proprie</span>;
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
        <TableFrame>
          <Table aria-label="Inviti">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col">Email</TableHead>
                <TableHead scope="col">Ruolo</TableHead>
                <TableHead scope="col">Stato</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Azioni</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invitations.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-medium">{i.email}</TableCell>
                  <TableCell>{ROLE_NAMES[i.role]}</TableCell>
                  <TableCell>
                    <div className="flex flex-col items-start gap-1">
                      <Badge variant="outline" className="px-1.5 text-muted-foreground">
                        {i.status === 'ACCEPTED' ? (
                          <CircleCheck aria-hidden className="fill-green-600 text-white" />
                        ) : (
                          <CircleDashed aria-hidden />
                        )}
                        <span className="text-foreground">{INVITATION_LABELS[i.status]}</span>
                      </Badge>
                      {i.status === 'PENDING' && (
                        <span className="text-xs text-muted-foreground">
                          scade il {formatDate(i.expiresAt)}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      {i.status === 'PENDING' &&
                        (revoking === i.id ? (
                          <>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={revoke.isPending}
                              onClick={() => revoke.mutate(i.id)}
                            >
                              Conferma revoca
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>
                              Annulla
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-foreground"
                            onClick={() => setRevoking(i.id)}
                          >
                            Revoca invito
                          </Button>
                        ))}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
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
