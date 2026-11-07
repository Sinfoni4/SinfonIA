/** AGX-10 / MF7: chat accounts (Telegram, WhatsApp) linked to a person. */

export type ChatChannel = 'TELEGRAM' | 'WHATSAPP';

export type ChannelLink = {
  id: string;
  channel: ChatChannel;
  /** The chat id shortened (last digits). */
  ref: string;
  linkedAt: string;
  /** Linked with /accedi (code by email); false for the links made with an old invite code. */
  verified: boolean;
  lastUsedAt: string | null;
};

export type OwnChannelLinks = { links: ChannelLink[]; linkingAvailable: boolean };

export const CHANNEL_NAMES: Record<ChatChannel, string> = {
  TELEGRAM: 'Telegram',
  WHATSAPP: 'WhatsApp',
};

export function channelName(channel: string): string {
  return (CHANNEL_NAMES as Record<string, string>)[channel] ?? channel;
}
