import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router';

import { describeError, request, type Me } from '../api/client';
import { CATEGORY_LABELS, type DeadlineCategory } from '../api/compliance';
import { useSession, type SessionState } from '../session/session';

import {
  CalendarIcon,
  CameraIcon,
  ChatIcon,
  CloseIcon,
  FolderPlusIcon,
  Logo,
  PersonIcon,
} from './icons';
import { AgendaScreen, PracticeScreen, TodayScreen, useSummary } from './MiniAppScreens';
import './miniapp.css';

/** What the «+» sheet shows: the menu, or one of its forms. */
export type SheetIntent =
  | { kind: 'menu' }
  | { kind: 'upload'; practiceId?: string; requestId?: string }
  | { kind: 'practice' }
  | { kind: 'deadline' }
  | { kind: 'operator' }
  | { kind: 'invite' };

type TelegramWebApp = { ready?: () => void; expand?: () => void; close?: () => void };

function telegram(): TelegramWebApp | undefined {
  return (window as unknown as { Telegram?: { WebApp?: TelegramWebApp } }).Telegram?.WebApp;
}

/**
 * Telegram Mini App of SinfonIA (`/app/tg`): the person opens it from the bot and is logged in
 * with the data Telegram signs (their Telegram account must be linked, AGX-10). The same API and
 * grants as the dashboard; dark look with a green glow, as in the approved mockup.
 */
export function MiniApp() {
  const { state } = useSession();
  useEffect(() => {
    telegram()?.ready?.();
    telegram()?.expand?.();
    // A dark page around the app, scrollbars included, while it is open.
    const root = document.documentElement;
    // A phone app: no desktop scrollbar over the content (a page still scrolls).
    const previous = {
      body: document.body.style.background,
      scheme: root.style.colorScheme,
      scrollbar: root.style.scrollbarWidth,
    };
    document.body.style.background = '#16191d';
    root.style.colorScheme = 'dark';
    root.style.scrollbarWidth = 'none';
    return () => {
      document.body.style.background = previous.body;
      root.style.colorScheme = previous.scheme;
      root.style.scrollbarWidth = previous.scrollbar;
    };
  }, []);

  if (state.status === 'loading') {
    return (
      <main className="ma">
        <div className="ma-center">
          <Logo size={56} />
          <p>Un attimo…</p>
        </div>
      </main>
    );
  }
  if (state.status === 'ready') return <MiniAppHome me={state.me} />;
  return (
    <main className="ma">
      <Outside state={state} />
    </main>
  );
}

/** Not logged in, or several organizations to choose from. */
function Outside({ state }: { state: Exclude<SessionState, { status: 'loading' | 'ready' }> }) {
  const { enter, telegramLogin } = useSession();
  const [telegramId, setTelegramId] = useState('');
  const [error, setError] = useState<string | null>(null);

  if (state.status === 'choosing') {
    return (
      <div className="ma-center">
        <div className="ma-brand">
          <Logo /> SinfonIA
        </div>
        <p>Per quale organizzazione vuoi lavorare?</p>
        <div className="ma-list" style={{ width: '100%' }}>
          {state.organizations.map((o) => (
            <button
              key={o.orgId}
              type="button"
              className="ma-row"
              onClick={() =>
                void enter(o.orgId).catch((err: unknown) => setError(describeError(err)))
              }
            >
              <span className="ma-row-title">{o.name}</span>
            </button>
          ))}
        </div>
        {error && <p className="ma-message error">{error}</p>}
      </div>
    );
  }

  // Development only: the server signs an opening for a Telegram id (the route exists only there).
  const preview = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      const { initData } = await request<{ initData: string }>('/auth/telegram-webapp/dev', {
        method: 'POST',
        body: { telegramId: telegramId.trim() },
      });
      await telegramLogin(initData);
    } catch (err: unknown) {
      setError(describeError(err));
    }
  };

  return (
    <div className="ma-center">
      <div className="ma-brand">
        <Logo size={44} /> SinfonIA
      </div>
      <p>
        {state.status === 'anonymous' && state.notice
          ? state.notice
          : 'Apri SinfonIA dal pulsante del bot in Telegram: ti riconosco dal tuo account.'}
      </p>
      {import.meta.env.DEV || window.location.hostname === 'localhost' ? (
        <form
          className="ma-form"
          style={{ width: '100%', maxWidth: 320 }}
          onSubmit={(e) => void preview(e)}
        >
          <label>
            Anteprima di prova: id Telegram collegato
            <input
              inputMode="numeric"
              value={telegramId}
              onChange={(e) => setTelegramId(e.target.value)}
              placeholder="es. 123456789"
            />
          </label>
          <button type="submit" className="ma-primary green" style={{ alignSelf: 'center' }}>
            Entra in anteprima
          </button>
        </form>
      ) : null}
      {error && <p className="ma-message error">{error}</p>}
    </div>
  );
}

function MiniAppHome({ me }: { me: Me }) {
  const [sheet, setSheet] = useState<SheetIntent | null>(null);
  return (
    <main className="ma">
      <Routes>
        <Route path="tg" element={<TodayScreen me={me} openSheet={setSheet} />} />
        <Route path="tg/agenda" element={<AgendaScreen me={me} openSheet={setSheet} />} />
        <Route path="tg/pratiche/:id" element={<PracticeScreen me={me} openSheet={setSheet} />} />
        <Route path="*" element={<Navigate to="/tg" replace />} />
      </Routes>
      {sheet && <Sheet me={me} intent={sheet} onIntent={setSheet} onClose={() => setSheet(null)} />}
    </main>
  );
}

const CATEGORIES = Object.keys(CATEGORY_LABELS) as DeadlineCategory[];

/** The «+» sheet: the actions of the bot, as buttons and short forms. */
function Sheet({
  me,
  intent,
  onIntent,
  onClose,
}: {
  me: Me;
  intent: SheetIntent;
  onIntent: (i: SheetIntent) => void;
  onClose: () => void;
}) {
  const { api } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const summary = useSummary(me);
  const [done, setDone] = useState<string | null>(null);
  const staff = me.current.role !== 'MEMBER';

  const refresh = () => queryClient.invalidateQueries();

  const upload = useMutation({
    mutationFn: async (input: { practiceId: string; requestId?: string; file: File }) => {
      const form = new FormData();
      if (input.requestId) form.append('requestId', input.requestId);
      form.append('file', input.file);
      return api<{ fulfilledRequest?: { expectedLabel: string | null; message: string } | null }>(
        `/practices/${input.practiceId}/attachments?allowDuplicate=true`,
        { method: 'POST', form },
      );
    },
    onSuccess: async (result) => {
      await refresh();
      const answered = result.fulfilledRequest;
      setDone(
        answered
          ? `✅ Documento ricevuto: risponde alla richiesta «${answered.expectedLabel ?? answered.message}».`
          : '✅ Documento ricevuto: lo leggo e lo collego alla pratica.',
      );
    },
  });
  const practice = useMutation({
    mutationFn: (name: string) =>
      api<{ id: string }>('/practices', { method: 'POST', body: { name } }),
    onSuccess: async (created) => {
      await refresh();
      onClose();
      void navigate(`/tg/pratiche/${created.id}`);
    },
  });
  const deadline = useMutation({
    mutationFn: (body: { category: DeadlineCategory; title: string; dueDate: string }) =>
      api('/compliance/deadlines', { method: 'POST', body }),
    onSuccess: async () => {
      await refresh();
      setDone('✅ Scadenza registrata: riceverai i promemoria in chat.');
    },
  });
  const operator = useMutation({
    mutationFn: () =>
      api<{ created: boolean }>('/assistance/requests', { method: 'POST', body: {} }),
    onSuccess: (result) =>
      setDone(
        result.created
          ? '✅ Richiesta inviata: un operatore ti ricontatterà.'
          : 'Hai già una richiesta aperta: un operatore ti ricontatterà.',
      ),
  });

  const failure = [upload, practice, deadline, operator].find((m) => m.isError)?.error;

  return (
    <div
      className="ma-sheet-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        className="ma-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ma-sheet-title"
      >
        <span className="ma-grip" aria-hidden="true" />
        {done ? (
          <>
            <h2 id="ma-sheet-title">Fatto</h2>
            <p className="ma-message">{done}</p>
          </>
        ) : intent.kind === 'menu' ? (
          <>
            <h2 id="ma-sheet-title">Cosa vuoi fare?</h2>
            <button
              type="button"
              className="ma-action main"
              onClick={() => onIntent({ kind: 'upload' })}
            >
              <span className="ma-tile">
                <CameraIcon color="#ffffff" />
              </span>
              <span>
                <strong>Manda un documento</strong>
                <small>Foto o file: lo leggo e lo collego alla pratica</small>
              </span>
            </button>
            <button
              type="button"
              className="ma-action"
              onClick={() => onIntent({ kind: 'practice' })}
            >
              <span className="ma-tile small info" style={{ width: 40, height: 40 }}>
                <FolderPlusIcon size={20} color="#f3f5f7" />
              </span>
              <span>
                <strong>Nuova pratica</strong>
                <small>Per una domanda, un bando, una consulenza</small>
              </span>
            </button>
            {staff && (
              <button
                type="button"
                className="ma-action"
                onClick={() => onIntent({ kind: 'deadline' })}
              >
                <span className="ma-tile small ask" style={{ width: 40, height: 40 }}>
                  <CalendarIcon size={20} color="#f3f5f7" />
                </span>
                <span>
                  <strong>Nuova scadenza</strong>
                  <small>DURC, BIO, visite mediche, patentini</small>
                </span>
              </button>
            )}
            <button
              type="button"
              className="ma-action"
              onClick={() => {
                const app = telegram();
                if (app?.close) app.close();
                else
                  setDone('Scrivi la tua domanda al bot nella chat di Telegram: ti rispondo lì.');
              }}
            >
              <span
                className="ma-tile small"
                style={{ width: 40, height: 40, background: '#4f46e5' }}
              >
                <ChatIcon size={20} color="#f3f5f7" />
              </span>
              <span>
                <strong>Chiedi all’assistente</strong>
                <small>Torna alla chat e scrivi come sempre</small>
              </span>
            </button>
            <button
              type="button"
              className="ma-action"
              onClick={() => onIntent({ kind: 'operator' })}
            >
              <span className="ma-tile small bad" style={{ width: 40, height: 40 }}>
                <PersonIcon size={20} color="#f3f5f7" />
              </span>
              <span>
                <strong>Parla con un operatore</strong>
                <small>Una persona della tua organizzazione ti ricontatta</small>
              </span>
            </button>
            {me.current.role === 'ADMIN' && (
              <button
                type="button"
                className="ma-action"
                onClick={() => onIntent({ kind: 'invite' })}
              >
                <span className="ma-tile small info" style={{ width: 40, height: 40 }}>
                  <PersonIcon size={20} color="#f3f5f7" />
                </span>
                <span>
                  <strong>Invita una persona</strong>
                  <small>Un link personale da mandarle: entra aprendolo in Telegram</small>
                </span>
              </button>
            )}
          </>
        ) : intent.kind === 'upload' ? (
          <UploadForm
            summary={summary.data}
            intent={intent}
            pending={upload.isPending}
            onSend={(input) => upload.mutate(input)}
          />
        ) : intent.kind === 'practice' ? (
          <PracticeForm pending={practice.isPending} onSend={(name) => practice.mutate(name)} />
        ) : intent.kind === 'deadline' ? (
          <DeadlineForm pending={deadline.isPending} onSend={(body) => deadline.mutate(body)} />
        ) : intent.kind === 'invite' ? (
          <InviteForm />
        ) : (
          <>
            <h2 id="ma-sheet-title">Parla con un operatore</h2>
            <p style={{ fontSize: 16, lineHeight: 1.5, color: '#cbd3dc' }}>
              Chiedo a una persona della tua organizzazione di ricontattarti.
            </p>
            <button
              type="button"
              className="ma-primary green"
              disabled={operator.isPending}
              onClick={() => operator.mutate()}
            >
              <PersonIcon size={18} />
              Chiedi di essere ricontattato
            </button>
          </>
        )}
        {failure !== undefined && !done && (
          <p className="ma-message error" role="alert">
            {describeError(failure)}
          </p>
        )}
        <button type="button" className="ma-close" aria-label="Chiudi" onClick={onClose}>
          <CloseIcon size={22} />
        </button>
      </section>
    </div>
  );
}

function UploadForm({
  summary,
  intent,
  pending,
  onSend,
}: {
  summary: ReturnType<typeof useSummary>['data'];
  intent: Extract<SheetIntent, { kind: 'upload' }>;
  pending: boolean;
  onSend: (input: { practiceId: string; requestId?: string; file: File }) => void;
}) {
  const practices = summary?.practices ?? [];
  // The practice with an open request comes first, as in the chat (AGX-06).
  const suggested = intent.practiceId ?? summary?.requests[0]?.practiceId ?? practices[0]?.id ?? '';
  const [practiceId, setPracticeId] = useState(suggested);
  const [file, setFile] = useState<File | null>(null);
  const answering = summary?.requests.find((r) =>
    intent.requestId && practiceId === intent.practiceId
      ? r.id === intent.requestId
      : r.practiceId === practiceId,
  );

  return (
    <form
      className="ma-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && practiceId) onSend({ practiceId, requestId: answering?.id, file });
      }}
    >
      <h2 id="ma-sheet-title">Manda un documento</h2>
      {practices.length === 0 ? (
        <p className="ma-muted">Non hai pratiche in corso: aprine una prima.</p>
      ) : (
        <label>
          Pratica
          <select value={practiceId} onChange={(e) => setPracticeId(e.target.value)}>
            {practices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.openRequests > 0 ? ' · documento richiesto' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {answering && (
        <p className="ma-message">
          Risponde alla richiesta: {answering.label ?? answering.message}
          {answering.dueDate
            ? ` (entro il ${answering.dueDate.split('-').reverse().join('/')})`
            : ''}
        </p>
      )}
      <label>
        Foto o file (PDF, JPEG, PNG)
        <input
          type="file"
          accept="image/*,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <button type="submit" className="ma-primary green" disabled={!file || !practiceId || pending}>
        {pending ? 'Invio…' : 'Manda'}
      </button>
    </form>
  );
}

/** A personal Telegram invitation, from the app (administrators): link to copy or share. */
function InviteForm() {
  const { api } = useSession();
  const [role, setRole] = useState<'MEMBER' | 'OPERATOR' | 'ADMIN'>('MEMBER');
  const [copied, setCopied] = useState(false);
  const create = useMutation({
    mutationFn: () =>
      api<{ token: string; link: string | null }>('/members/chat-invites', {
        method: 'POST',
        body: { role },
      }),
  });
  const text = create.data ? (create.data.link ?? `/start ${create.data.token}`) : '';
  return (
    <div className="ma-form">
      <h2 id="ma-sheet-title">Invita una persona</h2>
      {create.data ? (
        <>
          <p className="ma-message">
            Manda questo link alla persona (per esempio su WhatsApp): lo apre in Telegram, preme
            «Avvia» ed entra. Vale 7 giorni e una sola volta.
          </p>
          <p style={{ wordBreak: 'break-all', fontSize: 15 }}>{text}</p>
          <button
            type="button"
            className="ma-primary green"
            onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true))}
          >
            {copied ? 'Copiato' : 'Copia il link'}
          </button>
        </>
      ) : (
        <>
          <label>
            Ruolo
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'MEMBER' | 'OPERATOR' | 'ADMIN')}
            >
              <option value="MEMBER">Socio / collaboratore</option>
              <option value="OPERATOR">Operatore</option>
              <option value="ADMIN">Amministratore</option>
            </select>
          </label>
          <button
            type="button"
            className="ma-primary green"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            Crea il link
          </button>
        </>
      )}
      {create.isError && (
        <p className="ma-message error" role="alert">
          {describeError(create.error)}
        </p>
      )}
    </div>
  );
}

function PracticeForm({ pending, onSend }: { pending: boolean; onSend: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <form
      className="ma-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onSend(name.trim());
      }}
    >
      <h2 id="ma-sheet-title">Nuova pratica</h2>
      <label>
        Nome della pratica
        <input
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
          placeholder="es. Domanda PAC 2026"
        />
      </label>
      <button type="submit" className="ma-primary green" disabled={!name.trim() || pending}>
        Apri la pratica
      </button>
    </form>
  );
}

function DeadlineForm({
  pending,
  onSend,
}: {
  pending: boolean;
  onSend: (body: { category: DeadlineCategory; title: string; dueDate: string }) => void;
}) {
  const [category, setCategory] = useState<DeadlineCategory>('DURC');
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  return (
    <form
      className="ma-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim() && dueDate) onSend({ category, title: title.trim(), dueDate });
      }}
    >
      <h2 id="ma-sheet-title">Nuova scadenza</h2>
      <label>
        Tipo
        <select value={category} onChange={(e) => setCategory(e.target.value as DeadlineCategory)}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {CATEGORY_LABELS[c]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Descrizione
        <input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label>
        Data
        <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
      </label>
      <button
        type="submit"
        className="ma-primary green"
        disabled={!title.trim() || !dueDate || pending}
      >
        Registra la scadenza
      </button>
    </form>
  );
}
