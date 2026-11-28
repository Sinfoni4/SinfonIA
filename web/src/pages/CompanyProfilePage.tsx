import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';

import { describeError, type Me } from '../api/client';
import { isoToItalian } from '../api/compliance';
import {
  formToProfile,
  OUTCOME_LABELS,
  profileChanges,
  profilePath,
  profileToForm,
  SOURCE_LABELS,
  type CompanyProfile,
  type ProfileChannel,
  type ProfileForm,
  type ProfileHistoryItem,
} from '../api/profile';
import { useSession } from '../session/session';

import type { SectorField } from '../api/sector';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect } from '@/components/ui/native-select';

/** Fase 1C: the profile of the company, written by its administrators. */
export function CompanyProfilePage({ me }: { me: Me }) {
  return <ProfileEditor key={me.current.orgId} channel="own" />;
}

/** The profile of the company that gave a delegation covering it. */
export function DelegatedProfilePage() {
  const { grantId = '' } = useParams();
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0">
        <Link to="/deleghe">← Deleghe</Link>
      </p>
      <ProfileEditor key={grantId} channel={{ grantId }} />
    </div>
  );
}

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function ProfileEditor({ channel }: { channel: ProfileChannel }) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const key = ['company-profile', typeof channel === 'object' ? channel.grantId : 'own'];
  const query = useQuery({
    queryKey: key,
    queryFn: () => api<CompanyProfile>(profilePath(channel)),
  });
  const profile = query.data;
  const delegated = typeof channel === 'object';
  const canEdit = delegated ? (profile?.delegation?.operations.includes('UPDATE') ?? false) : true;
  const [showHistory, setShowHistory] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {profile?.delegation && (
        <p className="notice banner m-0" role="note">
          Stai lavorando sul profilo di <strong>{profile.delegation.grantorName}</strong> per
          delega, fino al {isoToItalian(profile.delegation.validUntil.slice(0, 10))}. Ogni
          operazione resta nel suo registro attività.
        </p>
      )}
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-semibold tracking-tight">
          Profilo aziendale
          {profile?.delegation ? ` di ${profile.delegation.grantorName}` : ''}
        </h1>
        <p className="m-0 text-muted-foreground">
          Le attività dell’azienda e i loro dati principali. Non attiva nulla da solo: serve a
          capire quali registri e moduli possono essere utili.
        </p>
      </div>
      {query.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {query.isError && (
        <p className="error m-0" role="alert">
          {describeError(query.error)}
        </p>
      )}
      {profile && (
        <>
          <ProfileStatus profile={profile} />
          {delegated && canEdit && profile.current && (
            <ReviewForm channel={channel} profile={profile} onDone={refresh} />
          )}
          <ProfileFormCard
            key={profile.current?.version ?? 0}
            channel={channel}
            profile={profile}
            canEdit={canEdit}
            onSaved={refresh}
          />
          <div>
            <Button type="button" variant="outline" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? 'Nascondi lo storico' : 'Mostra lo storico'}
            </Button>
          </div>
          {showHistory && <ProfileHistory channel={channel} profile={profile} />}
        </>
      )}
    </div>
  );
}

function ProfileStatus({ profile }: { profile: CompanyProfile }) {
  const { current, review } = profile;
  return (
    <section aria-labelledby="profile-status" className="flex flex-col gap-2 rounded-lg border p-4">
      <h2 id="profile-status" className="m-0 text-base font-semibold">
        Stato del profilo
      </h2>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <Badge variant={profile.complete ? 'secondary' : 'warning'}>
          {profile.complete ? 'completo' : 'incompleto'}
        </Badge>
        {current ? (
          <span className="text-sm text-muted-foreground">
            Versione {current.version}, scritta {SOURCE_LABELS[current.source]}
            {current.author ? ` (${current.author})` : ''} il {dateTime(current.createdAt)}
          </span>
        ) : (
          <span className="text-sm text-muted-foreground">Non ancora compilato.</span>
        )}
      </p>
      {profile.missing.length > 0 && (
        <div className="text-sm">
          Mancano:
          <ul className="m-0 pl-5">
            {profile.missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="m-0 text-sm">
        {review ? (
          <>
            <strong>{OUTCOME_LABELS[review.outcome]}</strong> da {review.reviewer ?? 'un delegato'}{' '}
            il {dateTime(review.createdAt)}
            {review.note ? `: ${review.note}` : ''}
          </>
        ) : (
          <span className="text-muted-foreground">
            Questa versione non è ancora stata verificata da un delegato (rete, CAA o consulente).
          </span>
        )}
      </p>
      <p className="m-0 text-xs text-muted-foreground">
        Questionario: {profile.definition.edition}
      </p>
    </section>
  );
}

function ReviewForm({
  channel,
  profile,
  onDone,
}: {
  channel: ProfileChannel;
  profile: CompanyProfile;
  onDone: () => Promise<void>;
}) {
  const { api } = useSession();
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const review = useMutation({
    mutationFn: (outcome: 'VERIFIED' | 'NEEDS_INFO') =>
      api(`${profilePath(channel)}/review`, {
        method: 'POST',
        body: {
          outcome,
          ...(note.trim() ? { note: note.trim() } : {}),
          expectedVersion: profile.current!.version,
        },
      }),
    onSuccess: async () => {
      setNote('');
      await onDone();
    },
  });
  const send = (outcome: 'VERIFIED' | 'NEEDS_INFO') => {
    if (outcome === 'NEEDS_INFO' && note.trim().length < 3) {
      setProblem('Scrivi quali informazioni servono.');
      return;
    }
    setProblem(null);
    review.mutate(outcome);
  };
  return (
    <section aria-labelledby="profile-review" className="flex flex-col gap-2 rounded-lg border p-4">
      <h2 id="profile-review" className="m-0 text-base font-semibold">
        Verifica della versione {profile.current!.version}
      </h2>
      <Label>
        Nota (obbligatoria se servono informazioni)
        <textarea
          className="min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Label>
      {(problem || review.isError) && (
        <p className="error m-0" role="alert">
          {problem ?? describeError(review.error)}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={review.isPending} onClick={() => send('VERIFIED')}>
          Verificato
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={review.isPending}
          onClick={() => send('NEEDS_INFO')}
        >
          Servono informazioni
        </Button>
      </div>
    </section>
  );
}

function ProfileFormCard({
  channel,
  profile,
  canEdit,
  onSaved,
}: {
  channel: ProfileChannel;
  profile: CompanyProfile;
  canEdit: boolean;
  onSaved: () => Promise<void>;
}) {
  const { api } = useSession();
  const { definition } = profile;
  const [form, setForm] = useState<ProfileForm>(() => profileToForm(profile.current));
  const save = useMutation({
    mutationFn: () =>
      api<CompanyProfile>(profilePath(channel), {
        method: 'PUT',
        body: {
          ...formToProfile(definition, form),
          expectedVersion: profile.current?.version ?? 0,
        },
      }),
    onSuccess: onSaved,
  });
  const set = (name: string, value: string) =>
    setForm((f) => ({ ...f, values: { ...f.values, [name]: value } }));
  const toggle = (id: string) =>
    setForm((f) => ({
      ...f,
      activities: f.activities.includes(id)
        ? f.activities.filter((a) => a !== id)
        : [...f.activities, id],
    }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate();
  };

  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={submit}
      aria-labelledby="profile-form"
    >
      <h2 id="profile-form" className="m-0 text-lg font-semibold">
        {canEdit ? 'Compila il profilo' : 'Profilo'}
      </h2>
      <fieldset className="flex flex-col gap-1 border-0 p-0">
        <legend className="mb-1 font-medium">Attività dell’azienda (anche più di una)</legend>
        {definition.activities.map((a) => (
          <label key={a.id} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1"
              checked={form.activities.includes(a.id)}
              disabled={!canEdit}
              onChange={() => toggle(a.id)}
            />
            <span>
              {a.label}
              <span className="block text-sm text-muted-foreground">{a.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <fieldset className="grid gap-3 border-0 p-0 sm:grid-cols-2">
        <legend className="mb-1 font-medium">Dati generali</legend>
        {definition.common.map((field) => (
          <ProfileField
            key={field.key}
            field={field}
            value={form.values[`common.${field.key}`] ?? ''}
            disabled={!canEdit}
            onChange={(v) => set(`common.${field.key}`, v)}
          />
        ))}
      </fieldset>
      {definition.activities
        .filter((a) => form.activities.includes(a.id))
        .map((a) => (
          <fieldset key={a.id} className="grid gap-3 border-0 p-0 sm:grid-cols-2">
            <legend className="mb-1 font-medium">{a.label}</legend>
            {a.fields.map((field) => (
              <ProfileField
                key={field.key}
                field={field}
                value={form.values[`${a.id}.${field.key}`] ?? ''}
                disabled={!canEdit}
                onChange={(v) => set(`${a.id}.${field.key}`, v)}
              />
            ))}
          </fieldset>
        ))}
      {save.isError && (
        <p className="error m-0" role="alert">
          {describeError(save.error)}
        </p>
      )}
      {canEdit && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Salvataggio…' : 'Salva una nuova versione'}
          </Button>
          <span className="text-sm text-muted-foreground">
            Si può salvare anche incompleto; le versioni precedenti restano nello storico.
          </span>
        </div>
      )}
    </form>
  );
}

function ProfileField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: SectorField;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const label = `${field.label}${field.required ? ' *' : ''}`;
  if (field.type === 'choice') {
    return (
      <Label>
        {label}
        <NativeSelect value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </Label>
    );
  }
  return (
    <Label className={field.key === 'notes' || field.key === 'units' ? 'sm:col-span-2' : ''}>
      {label}
      <Input
        type={field.type === 'date' ? 'date' : 'text'}
        inputMode={field.type === 'number' ? 'decimal' : undefined}
        maxLength={field.type === 'text' ? field.maxLength : undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    </Label>
  );
}

function ProfileHistory({
  channel,
  profile,
}: {
  channel: ProfileChannel;
  profile: CompanyProfile;
}) {
  const { api } = useSession();
  const history = useQuery({
    queryKey: ['company-profile-history', channel, profile.current?.version ?? 0],
    queryFn: () => api<ProfileHistoryItem[]>(`${profilePath(channel)}/versions`),
  });
  return (
    <section
      aria-labelledby="profile-history"
      className="flex flex-col gap-3 rounded-lg border p-4"
    >
      <h2 id="profile-history" className="m-0 text-lg font-semibold">
        Storico delle versioni
      </h2>
      {history.isPending && <p className="m-0 text-muted-foreground">Caricamento…</p>}
      {history.isError && (
        <p className="error m-0" role="alert">
          {describeError(history.error)}
        </p>
      )}
      {history.data?.length === 0 && <p className="m-0 text-muted-foreground">Nessuna versione.</p>}
      {history.data && history.data.length > 0 && (
        <ol className="m-0 flex list-none flex-col gap-3 p-0">
          {history.data.map((v, i) => {
            const before = history.data[i + 1];
            const changes = before ? profileChanges(profile.definition, before, v) : [];
            return (
              <li key={v.version} className="flex flex-col gap-0.5 border-l-2 pl-3">
                <span className="font-medium">
                  Versione {v.version} · scritta {SOURCE_LABELS[v.source]} il{' '}
                  {dateTime(v.createdAt)}
                </span>
                <span className="text-sm text-muted-foreground">
                  {v.author ?? 'persona non più presente'}
                </span>
                {changes.length > 0 && (
                  <ul className="m-0 pl-4 text-sm">
                    {changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                {v.reviews.map((r) => (
                  <span key={r.createdAt} className="text-sm">
                    {OUTCOME_LABELS[r.outcome]} da {r.reviewer ?? 'un delegato'} il{' '}
                    {dateTime(r.createdAt)}
                    {r.note ? `: ${r.note}` : ''}
                  </span>
                ))}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
