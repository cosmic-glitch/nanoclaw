import { ASSISTANT_NAME } from './config.js';
import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    const attrs = `sender="${escapeXml(m.sender_name)}" time="${m.timestamp}"`;
    let body = escapeXml(m.content);
    if (m.media_path) {
      const filename = m.media_path.split('/').pop() || '';
      body += `\n<image path="/workspace/media/${escapeXml(filename)}" type="${escapeXml(m.media_mime_type || 'image/jpeg')}" />`;
    }
    return `<message ${attrs}>${body}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  let text = stripInternalTags(rawText);
  if (!text) return '';
  // Strip "Bot:" or similar name prefix the LLM likes to add (start of string or after newlines)
  const name = ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  text = text.replace(new RegExp(`^${name}:\\s*`, 'im'), '');
  return text.trim();
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
