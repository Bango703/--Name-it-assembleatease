import { getSupabase } from '../_supabase.js';
import { verifyOwner } from '../_email.js';

const SITE_CHAT_EVENTS = ['website_chat_user', 'website_chat_ai'];
const SITE_CHAT_WINDOW_HOURS = 48;
const SITE_CHAT_MAX_ROWS = 600;

function roleForEvent(eventType) {
  return eventType === 'website_chat_ai' ? 'assistant' : 'user';
}

function visitorLabelFor(row, metadata) {
  if (metadata?.visitorId) {
    return `Visitor ${String(metadata.visitorId).slice(-6).toUpperCase()}`;
  }
  if (row.actor_name && row.actor_name !== 'Sora') return row.actor_name;
  return 'Visitor';
}

export default async function handler(req, res) {
  if (!verifyOwner(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const since = new Date(Date.now() - SITE_CHAT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const sb = getSupabase();
  const { data, error } = await sb
    .from('activity_logs')
    .select('id, event_type, actor_name, description, metadata, created_at')
    .is('booking_id', null)
    .in('event_type', SITE_CHAT_EVENTS)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(SITE_CHAT_MAX_ROWS);

  if (error) {
    console.error('Owner site chat load error:', error);
    return res.status(500).json({ error: 'Failed to load website chat history' });
  }

  const grouped = new Map();

  for (const row of data || []) {
    const metadata = row.metadata || {};
    const conversationId = String(metadata.conversationId || `legacy-${row.id}`);
    const role = roleForEvent(row.event_type);
    const visitorLabel = visitorLabelFor(row, metadata);
    const existing = grouped.get(conversationId) || {
      conversationId,
      visitorId: metadata.visitorId || null,
      visitorLabel,
      pagePath: metadata.pagePath || '/',
      pageTitle: metadata.pageTitle || '',
      userAgent: metadata.userAgent || '',
      startedAt: row.created_at,
      lastAt: row.created_at,
      preview: '',
      userMessageCount: 0,
      assistantMessageCount: 0,
      messages: [],
      _paths: new Set(),
    };

    existing.startedAt = row.created_at < existing.startedAt ? row.created_at : existing.startedAt;
    existing.lastAt = row.created_at > existing.lastAt ? row.created_at : existing.lastAt;
    if (metadata.pagePath) existing._paths.add(metadata.pagePath);
    if (!existing.pagePath && metadata.pagePath) existing.pagePath = metadata.pagePath;
    if (!existing.pageTitle && metadata.pageTitle) existing.pageTitle = metadata.pageTitle;
    if (!existing.userAgent && metadata.userAgent) existing.userAgent = metadata.userAgent;
    if (!existing.visitorId && metadata.visitorId) existing.visitorId = metadata.visitorId;

    if (role === 'user') {
      existing.userMessageCount += 1;
      if (!existing.preview) existing.preview = row.description || '';
    } else {
      existing.assistantMessageCount += 1;
    }

    existing.messages.push({
      id: row.id,
      role,
      body: row.description || '',
      createdAt: row.created_at,
    });

    grouped.set(conversationId, existing);
  }

  const conversations = Array.from(grouped.values())
    .map((conversation) => ({
      conversationId: conversation.conversationId,
      visitorId: conversation.visitorId,
      visitorLabel: conversation.visitorLabel,
      pagePath: conversation.pagePath || '/',
      pageTitle: conversation.pageTitle || '',
      userAgent: conversation.userAgent || '',
      startedAt: conversation.startedAt,
      lastAt: conversation.lastAt,
      preview: conversation.preview || '',
      messageCount: conversation.messages.length,
      userMessageCount: conversation.userMessageCount,
      assistantMessageCount: conversation.assistantMessageCount,
      paths: Array.from(conversation._paths).filter(Boolean),
      messages: conversation.messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
    }))
    .sort((a, b) => new Date(b.lastAt) - new Date(a.lastAt));

  const totalMessages = conversations.reduce((sum, conversation) => sum + conversation.messageCount, 0);
  const totalUserMessages = conversations.reduce((sum, conversation) => sum + conversation.userMessageCount, 0);

  return res.status(200).json({
    hours: SITE_CHAT_WINDOW_HOURS,
    summary: {
      conversations: conversations.length,
      totalMessages,
      totalUserMessages,
    },
    conversations,
  });
}
