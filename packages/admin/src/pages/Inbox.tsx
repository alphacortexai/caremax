import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useTenant } from '../TenantContext';
import './Inbox.css';

type InboxStatus = 'open' | 'pending' | 'resolved';

type Conversation = {
  id: string;
  customerName: string;
  customerPhone: string;
  status: InboxStatus;
  assigneeId: string | null;
  assigneeEmail: string | null;
  unreadCount: number;
  lastMessagePreview: string;
  lastMessageAtMs: number;
  lastDirection: 'inbound' | 'outbound';
};

type ChatMessage = {
  id: string;
  direction: 'inbound' | 'outbound';
  authorType: 'customer' | 'agent' | 'bot';
  authorName: string | null;
  body: string;
  status: string;
  error: string | null;
  createdAtMs: number;
};

type Counts = Record<InboxStatus, number>;

const emptyCounts: Counts = { open: 0, pending: 0, resolved: 0 };

const previewConversations: Conversation[] = [
  {
    id: 'preview-amina',
    customerName: 'Amina Nakato',
    customerPhone: '256700111222',
    status: 'open',
    assigneeId: null,
    assigneeEmail: null,
    unreadCount: 1,
    lastMessagePreview: 'Is the blue dress still available in size M?',
    lastMessageAtMs: Date.now() - 1000 * 60 * 8,
    lastDirection: 'inbound',
  },
  {
    id: 'preview-joseph',
    customerName: 'Joseph Okello',
    customerPhone: '256772333444',
    status: 'pending',
    assigneeId: 'agent',
    assigneeEmail: 'agent@shop.test',
    unreadCount: 0,
    lastMessagePreview: 'A teammate will confirm the delivery window.',
    lastMessageAtMs: Date.now() - 1000 * 60 * 50,
    lastDirection: 'outbound',
  },
];

const previewMessages: Record<string, ChatMessage[]> = {
  'preview-amina': [
    {
      id: 'm1',
      direction: 'inbound',
      authorType: 'customer',
      authorName: 'Amina Nakato',
      body: 'Hello, is the blue dress still available in size M?',
      status: 'received',
      error: null,
      createdAtMs: Date.now() - 1000 * 60 * 8,
    },
  ],
  'preview-joseph': [
    {
      id: 'm2',
      direction: 'inbound',
      authorType: 'customer',
      authorName: 'Joseph Okello',
      body: 'Can someone call me about tomorrow’s delivery?',
      status: 'received',
      error: null,
      createdAtMs: Date.now() - 1000 * 60 * 70,
    },
    {
      id: 'm3',
      direction: 'outbound',
      authorType: 'agent',
      authorName: 'Agent',
      body: 'A teammate will confirm the delivery window.',
      status: 'sent',
      error: null,
      createdAtMs: Date.now() - 1000 * 60 * 50,
    },
  ],
};

function formatWhen(ms: number): string {
  const date = new Date(ms);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function phoneLabel(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

export default function Inbox({ mode = 'live' }: { mode?: 'live' | 'preview' }) {
  const { tenantId, uid, email } = useTenant();
  const preview = mode === 'preview';
  const [status, setStatus] = useState<InboxStatus | 'all'>('open');
  const [search, setSearch] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>(preview ? previewConversations : []);
  const [counts, setCounts] = useState<Counts>(preview ? { open: 1, pending: 1, resolved: 0 } : emptyCounts);
  const [selectedId, setSelectedId] = useState<string | null>(preview ? previewConversations[0].id : null);
  const [messages, setMessages] = useState<ChatMessage[]>(preview ? previewMessages[previewConversations[0].id] : []);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [simulate, setSimulate] = useState({ from: '+256700000001', name: 'New customer', text: 'Hi, I need help with an order.' });
  const statusRef = useRef(status);
  statusRef.current = status;

  const loadConversations = async (requested: InboxStatus | 'all') => {
    if (preview || !tenantId) return;
    const res = await api<{ conversations: Conversation[]; counts: Counts }>(
      `/tenants/${tenantId}/inbox/conversations?status=${requested}`,
    );
    if (statusRef.current !== requested) return;
    setConversations(res.conversations);
    setCounts(res.counts);
    setSelectedId((current) => {
      if (current && res.conversations.some((item) => item.id === current)) return current;
      return res.conversations[0]?.id ?? null;
    });
  };

  const loadMessages = async (conversationId: string) => {
    if (preview || !tenantId) return;
    const res = await api<{ messages: ChatMessage[] }>(
      `/tenants/${tenantId}/inbox/conversations/${conversationId}/messages`,
    );
    setMessages(res.messages);
    await api(`/tenants/${tenantId}/inbox/conversations/${conversationId}/read`, { method: 'POST' });
  };

  useEffect(() => {
    if (preview) return;
    void loadConversations(status).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Failed to load the inbox.');
    });
    const timer = window.setInterval(() => {
      void loadConversations(status).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [tenantId, status, preview]);

  useEffect(() => {
    if (status === 'all' || !selectedId) return;
    const current = conversations.find((conversation) => conversation.id === selectedId);
    if (current && current.status !== status) {
      setSelectedId(conversations.find((conversation) => conversation.status === status)?.id ?? null);
    }
  }, [status, conversations, selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      return;
    }
    if (preview) {
      setMessages(previewMessages[selectedId] ?? []);
      return;
    }
    void loadMessages(selectedId).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'Failed to load the conversation.');
    });
    const timer = window.setInterval(() => {
      void loadMessages(selectedId).catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedId, preview, tenantId]);

  const visibleCounts = useMemo<Counts>(() => (
    preview
      ? {
          open: conversations.filter((conversation) => conversation.status === 'open').length,
          pending: conversations.filter((conversation) => conversation.status === 'pending').length,
          resolved: conversations.filter((conversation) => conversation.status === 'resolved').length,
        }
      : counts
  ), [preview, conversations, counts]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return conversations.filter((conversation) => {
      if (status !== 'all' && conversation.status !== status) return false;
      if (!query) return true;
      return [conversation.customerName, conversation.customerPhone, conversation.lastMessagePreview]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }, [conversations, search, status]);

  const selected = conversations.find((conversation) => conversation.id === selectedId) ?? null;

  const sendReply = async (event?: FormEvent) => {
    event?.preventDefault();
    const body = draft.trim();
    if (!body || !selected) return;
    setSending(true);
    setError('');
    try {
      if (preview) {
        const message: ChatMessage = {
          id: `local-${Date.now()}`,
          direction: 'outbound',
          authorType: 'agent',
          authorName: 'You',
          body,
          status: 'saved',
          error: null,
          createdAtMs: Date.now(),
        };
        previewMessages[selected.id] = [...(previewMessages[selected.id] ?? []), message];
        setMessages(previewMessages[selected.id]);
        setConversations((current) => current.map((item) => (
          item.id === selected.id
            ? { ...item, lastMessagePreview: body, lastMessageAtMs: message.createdAtMs, lastDirection: 'outbound', unreadCount: 0 }
            : item
        )));
      } else {
        const res = await api<{ message: ChatMessage }>(
          `/tenants/${tenantId}/inbox/conversations/${selected.id}/messages`,
          { method: 'POST', body: JSON.stringify({ body }) },
        );
        setMessages((current) => [...current.filter((item) => item.id !== res.message.id), res.message]);
        if (res.message.status === 'failed') setError(res.message.error || 'WhatsApp rejected the reply.');
        await loadConversations(status);
      }
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send the reply.');
    } finally {
      setSending(false);
    }
  };

  const updateStatus = async (next: InboxStatus) => {
    if (!selected) return;
    if (preview) {
      setConversations((current) => current.map((item) => (
        item.id === selected.id ? { ...item, status: next } : item
      )));
      return;
    }
    await api<{ conversation: Conversation }>(
      `/tenants/${tenantId}/inbox/conversations/${selected.id}/status`,
      { method: 'POST', body: JSON.stringify({ status: next }) },
    );
    await loadConversations(statusRef.current);
  };

  const assignToMe = async () => {
    if (!selected || preview) return;
    await api<{ conversation: Conversation }>(
      `/tenants/${tenantId}/inbox/conversations/${selected.id}/assign`,
      { method: 'POST', body: JSON.stringify({ assigneeId: uid ?? email ?? 'agent', assigneeEmail: email }) },
    );
    await loadConversations(statusRef.current);
  };

  const simulateInbound = async (event: FormEvent) => {
    event.preventDefault();
    if (preview) {
      setNotice('Simulation is available after you sign in.');
      return;
    }
    setError('');
    setNotice('');
    try {
      const res = await api<{ conversation: Conversation }>(`/tenants/${tenantId}/inbox/simulate`, {
        method: 'POST',
        body: JSON.stringify(simulate),
      });
      statusRef.current = 'all';
      setStatus('all');
      setSelectedId(res.conversation.id);
      setNotice(`Saved a test message from ${res.conversation.customerName}.`);
      await loadConversations('all');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not simulate a message.');
    }
  };

  return (
    <div className="inbox">
      <section className={`inbox-list${selected ? ' mobile-hidden' : ''}`}>
        <div className="inbox-list-head">
          <p className="inbox-kicker">WhatsApp</p>
          <h1>Inbox</h1>
        </div>
        <div className="inbox-filters">
          {(['open', 'pending', 'resolved', 'all'] as const).map((item) => (
            <button key={item} className={status === item ? 'active' : ''} onClick={() => setStatus(item)}>
              {item === 'all' ? 'All' : item[0].toUpperCase() + item.slice(1)}
              {item !== 'all' ? ` ${visibleCounts[item]}` : ''}
            </button>
          ))}
        </div>
        <input
          className="inbox-search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search name, phone, or message"
        />
        {error && <div className="banner">{error}</div>}
        {notice && <div className="banner ok">{notice}</div>}
        <div className="conversation-scroll">
          {visible.length === 0 && (
            <div className="empty-list">
              <strong>No conversations in this view.</strong>
              <p className="muted">Connect WhatsApp, or simulate a customer message to see the thread here.</p>
            </div>
          )}
          {visible.map((conversation) => (
            <button
              key={conversation.id}
              className={`conversation-row${conversation.id === selectedId ? ' selected' : ''}`}
              onClick={() => setSelectedId(conversation.id)}
            >
              <span className="conversation-name">{conversation.customerName}</span>
              <span className="muted">{formatWhen(conversation.lastMessageAtMs)}</span>
              <span className="conversation-preview">{conversation.lastMessagePreview}</span>
              {conversation.unreadCount > 0 && <span className="unread">{conversation.unreadCount}</span>}
            </button>
          ))}
        </div>
        <form className="simulate-form" onSubmit={simulateInbound}>
          <strong>Simulate a customer</strong>
          <input value={simulate.from} onChange={(event) => setSimulate((prev) => ({ ...prev, from: event.target.value }))} placeholder="Customer phone" />
          <input value={simulate.name} onChange={(event) => setSimulate((prev) => ({ ...prev, name: event.target.value }))} placeholder="Customer name" />
          <textarea value={simulate.text} onChange={(event) => setSimulate((prev) => ({ ...prev, text: event.target.value }))} />
          <button className="primary" type="submit">Add test message</button>
        </form>
      </section>

      <section className={`inbox-thread${!selected ? ' mobile-hidden' : ''}`}>
        {!selected && (
          <div className="empty-thread">
            <h2>One inbox for every WhatsApp customer</h2>
            <p className="muted">Messages that arrive on your registered WhatsApp number show up here. Reply as your team, or let the assistant answer when you turn it on.</p>
            <p><Link to="/whatsapp">Connect a WhatsApp number</Link></p>
          </div>
        )}
        {selected && (
          <>
            <div className="thread-head">
              <div>
                <button className="back-btn" onClick={() => setSelectedId(null)}>Back</button>
                <div className="thread-customer">{selected.customerName}</div>
                <div className="muted">{phoneLabel(selected.customerPhone)} · {selected.status}{selected.assigneeEmail ? ` · ${selected.assigneeEmail}` : ''}</div>
              </div>
              <div className="thread-actions">
                <button onClick={() => void updateStatus('open')}>Open</button>
                <button onClick={() => void updateStatus('pending')}>Pending</button>
                <button onClick={() => void updateStatus('resolved')}>Resolve</button>
                {!preview && <button onClick={() => void assignToMe()}>Assign to me</button>}
              </div>
            </div>
            <div className="thread-scroll">
              {messages.map((message) => (
                <article key={message.id} className={`bubble ${message.direction}${message.authorType === 'bot' ? ' bot' : ''}`}>
                  <div className="bubble-body">{message.body}</div>
                  <div className="bubble-meta">
                    <span>{message.authorType === 'customer' ? message.authorName : message.authorType === 'bot' ? 'AI assistant' : message.authorName || 'Agent'}</span>
                    <span>{formatWhen(message.createdAtMs)} · {message.status}</span>
                  </div>
                  {message.error && <div className="delivery-note">{message.error}</div>}
                </article>
              ))}
            </div>
            <form className="composer" onSubmit={sendReply}>
              <textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={`Reply to ${selected.customerName} on WhatsApp`}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendReply();
                  }
                }}
              />
              <div className="composer-row">
                <span className="muted">Enter to send. Shift+Enter for a new line.</span>
                <button className="primary" type="submit" disabled={sending || !draft.trim()}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
    </div>
  );
}
