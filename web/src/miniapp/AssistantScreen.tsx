import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { describeError } from '../api/client';
import { useSession } from '../session/session';

import { BackIcon, ChatIcon } from './icons';

/** One answer of the assistant, with the buttons that answer it (as in the chat). */
export type AppChatReply = { text: string; buttons: Array<{ label: string; answer: string }> };

type Message = { id: number; from: 'me' | 'bot'; text: string; buttons: AppChatReply['buttons'] };

/** Quick questions shown before the first message. */
const SUGGESTIONS = ['Le mie pratiche', 'I miei documenti', 'Le mie scadenze', 'Aiuto'];
const SUGGESTION_ANSWERS: Record<string, string> = {
  'Le mie pratiche': 'lista pratiche',
  'I miei documenti': 'documenti',
  'Le mie scadenze': 'scadenze',
  Aiuto: 'aiuto',
};

/**
 * «Assistente»: the same conversation as the bot's chat (commands, questions in plain words,
 * confirmations), inside the Mini App. Files are still sent in the chat or with «+».
 */
export function AssistantScreen() {
  const { api } = useSession();
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const nextId = useRef(0);
  const end = useRef<HTMLDivElement>(null);

  const add = (from: Message['from'], body: string, buttons: Message['buttons'] = []) =>
    setMessages((list) => [...list, { id: nextId.current++, from, text: body, buttons }]);

  const ask = useMutation({
    mutationFn: (question: string) =>
      api<{ replies: AppChatReply[] }>('/miniapp/chat', {
        method: 'POST',
        body: { text: question },
      }),
    onSuccess: (data) => {
      for (const r of data.replies) add('bot', r.text, r.buttons);
    },
    onError: (err) => add('bot', `⚠️ ${describeError(err)}`),
  });

  useEffect(() => {
    end.current?.scrollIntoView?.({ behavior: 'smooth', block: 'end' });
  }, [messages.length, ask.isPending]);

  /** `shown` is what the person sees as their message; `sent` what the assistant receives. */
  const send = (shown: string, sent = shown) => {
    if (!sent.trim() || ask.isPending) return;
    add('me', shown);
    ask.mutate(sent.trim());
  };

  // The question written in the line of «Oggi»: sent once, then removed from the history entry
  // so that going back and forth does not send it again.
  const location = useLocation();
  const navigate = useNavigate();
  const asked = useRef(false);
  useEffect(() => {
    const question = (location.state as { question?: unknown } | null)?.question;
    if (asked.current || typeof question !== 'string' || !question.trim()) return;
    asked.current = true;
    add('me', question);
    ask.mutate(question.trim());
    void navigate('.', { replace: true, state: null });
    // Only when the screen opens.
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(text);
    setText('');
  };

  const lastBot = [...messages].reverse().find((m) => m.from === 'bot');

  return (
    <>
      <div className="ma-panel">
        <header className="ma-panel-head">
          <Link to="/tg" className="ma-iconbtn" aria-label="Torna a Oggi">
            <BackIcon />
          </Link>
          <h1>Assistente</h1>
          <span className="ma-tile small" style={{ width: 40, height: 40 }}>
            <ChatIcon size={20} />
          </span>
        </header>
      </div>

      <section className="ma-chat" aria-label="Conversazione" aria-live="polite">
        {messages.length === 0 && (
          <>
            <p className="ma-muted">
              Scrivi come nella chat del bot: «crea pratica Domanda PAC», «documenti», oppure una
              domanda con parole tue.
            </p>
            <div className="ma-chat-buttons">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  className="ma-chip info"
                  onClick={() => send(s, SUGGESTION_ANSWERS[s])}
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`ma-bubble ${m.from}`}>
            {m.text}
          </div>
        ))}
        {lastBot && lastBot.buttons.length > 0 && !ask.isPending && (
          <div className="ma-chat-buttons">
            {lastBot.buttons.map((b) => (
              <button
                key={b.label}
                type="button"
                className="ma-chip info"
                onClick={() => send(b.label, b.answer)}
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
        {ask.isPending && <div className="ma-bubble bot ma-muted">Sto scrivendo…</div>}
        <div ref={end} />
      </section>

      <form className="ma-chat-input" onSubmit={submit}>
        <label className="ma-sr-only" htmlFor="ma-chat-text">
          Messaggio per l’assistente
        </label>
        <input
          id="ma-chat-text"
          value={text}
          maxLength={2000}
          autoComplete="off"
          placeholder="Scrivi un messaggio…"
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="ma-primary green" disabled={!text.trim() || ask.isPending}>
          Invia
        </button>
      </form>
    </>
  );
}
