/** «Parla con un operatore» (H10): requests from the chat, handled by administrators and operators. */

export type AssistanceTopic = 'PRACTICE' | 'DOCUMENT' | 'DEADLINE' | 'OTHER';
export type AssistanceStatus = 'OPEN' | 'IN_PROGRESS' | 'CLOSED';
export type AssistanceFilter = 'open' | 'closed';
export type ChatChannel = 'TELEGRAM' | 'WHATSAPP';

export type AssistanceItem = {
  id: string;
  topic: AssistanceTopic;
  channel: ChatChannel;
  status: AssistanceStatus;
  createdAt: string;
  takenAt: string | null;
  closedAt: string | null;
  requester: {
    userId: string;
    email: string | null;
    phones: string[];
    channels: ChatChannel[];
    practices: number;
  };
  takenByEmail: string | null;
  closedByEmail: string | null;
};

export type AssistancePage = {
  items: AssistanceItem[];
  total: number;
  page: number;
  totalPages: number;
};

export const TOPIC_LABELS: Record<AssistanceTopic, string> = {
  PRACTICE: 'Una pratica',
  DOCUMENT: 'Un documento',
  DEADLINE: 'Una scadenza',
  OTHER: 'Altro',
};

export const ASSISTANCE_STATUS_LABELS: Record<AssistanceStatus, string> = {
  OPEN: 'da prendere in carico',
  IN_PROGRESS: 'in carico',
  CLOSED: 'chiusa',
};

export const CHAT_CHANNEL_LABELS: Record<ChatChannel, string> = {
  TELEGRAM: 'Telegram',
  WHATSAPP: 'WhatsApp',
};

export function assistanceQuery(status: AssistanceFilter, page: number): string {
  return `/assistance?status=${status}&page=${page}&limit=20`;
}

/** How to reach the person: a real email, WhatsApp numbers, or only the chat they wrote from. */
export function contactLines(item: AssistanceItem): string[] {
  const lines = [
    ...(item.requester.email ? [`Email: ${item.requester.email}`] : []),
    ...item.requester.phones.map((p) => `WhatsApp: ${p}`),
  ];
  return lines.length > 0
    ? lines
    : [`Solo dalla chat ${CHAT_CHANNEL_LABELS[item.channel]}: nessun recapito registrato`];
}
