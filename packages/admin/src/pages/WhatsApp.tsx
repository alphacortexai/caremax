import { FormEvent, useEffect, useState } from 'react';
import { api } from '../api';
import { useTenant } from '../TenantContext';
import './Inbox.css';

type WhatsAppSettings = {
  connected: boolean;
  phoneNumberId: string;
  wabaId: string;
  displayPhoneNumber: string;
  verifiedName: string;
  accessTokenSet: boolean;
  accessTokenMasked: string;
  verifyToken: string;
  appSecretSet: boolean;
  appSecretMasked: string;
  autoReplyEnabled: boolean;
  businessName: string;
  aiInstructions: string;
  webhookUrl: string;
  aiConfigured: boolean;
};

const emptySettings: WhatsAppSettings = {
  connected: false,
  phoneNumberId: '',
  wabaId: '',
  displayPhoneNumber: '',
  verifiedName: '',
  accessTokenSet: false,
  accessTokenMasked: '',
  verifyToken: '',
  appSecretSet: false,
  appSecretMasked: '',
  autoReplyEnabled: false,
  businessName: '',
  aiInstructions: '',
  webhookUrl: '',
  aiConfigured: false,
};

export default function WhatsAppIntegration() {
  const { tenantId } = useTenant();
  const [settings, setSettings] = useState<WhatsAppSettings>(emptySettings);
  const [accessToken, setAccessToken] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const res = await api<WhatsAppSettings>(`/tenants/${tenantId}/integrations/whatsapp-cloud`);
      setSettings(res);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load WhatsApp settings.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [tenantId]);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const res = await api<WhatsAppSettings>(`/tenants/${tenantId}/integrations/whatsapp-cloud`, {
        method: 'PUT',
        body: JSON.stringify({
          phoneNumberId: settings.phoneNumberId,
          wabaId: settings.wabaId,
          displayPhoneNumber: settings.displayPhoneNumber,
          accessToken,
          appSecret,
          verifyToken: settings.verifyToken,
          autoReplyEnabled: settings.autoReplyEnabled,
          businessName: settings.businessName,
          aiInstructions: settings.aiInstructions,
        }),
      });
      setSettings(res);
      setAccessToken('');
      setAppSecret('');
      setMessage(`Connected${res.verifiedName ? ` as ${res.verifiedName}` : ''}${res.displayPhoneNumber ? ` (${res.displayPhoneNumber})` : ''}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to connect WhatsApp.');
    } finally {
      setSaving(false);
    }
  };

  const saveAssistant = async (event: FormEvent) => {
    event.preventDefault();
    if (!tenantId) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const res = await api<WhatsAppSettings>(`/tenants/${tenantId}/integrations/whatsapp-cloud/assistant`, {
        method: 'PATCH',
        body: JSON.stringify({
          autoReplyEnabled: settings.autoReplyEnabled,
          businessName: settings.businessName,
          aiInstructions: settings.aiInstructions,
        }),
      });
      setSettings(res);
      setMessage('Assistant settings saved.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save assistant settings.');
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!tenantId) return;
    setSaving(true);
    setMessage('');
    setError('');
    try {
      const res = await api<WhatsAppSettings>(`/tenants/${tenantId}/integrations/whatsapp-cloud`, { method: 'DELETE' });
      setSettings(res);
      setMessage('WhatsApp number disconnected. Existing conversations stay in the inbox.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to disconnect WhatsApp.');
    } finally {
      setSaving(false);
    }
  };

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setMessage('Copied.');
  };

  if (loading) return <p>Loading WhatsApp settings…</p>;

  return (
    <div className="settings-grid">
      <div>
        <p className="inbox-kicker">Channel</p>
        <h1 style={{ marginTop: 4 }}>Register WhatsApp</h1>
        <p className="muted">Connect the business WhatsApp number through the official Cloud API. Customer messages land in the shared inbox.</p>
      </div>

      <section className="settings-card">
        <strong>{settings.connected ? 'Connected' : 'Not connected'}</strong>
        {settings.connected && (
          <p className="muted">
            {settings.verifiedName || 'WhatsApp Business'} · {settings.displayPhoneNumber || settings.phoneNumberId}
            {settings.accessTokenMasked ? ` · token ${settings.accessTokenMasked}` : ''}
          </p>
        )}
        <ol className="steps">
          <li>In Meta for Developers, add the WhatsApp product to your app.</li>
          <li>Copy the phone number ID, business account ID, and a permanent access token.</li>
          <li>Paste the callback URL and verify token below into the WhatsApp webhook configuration.</li>
          <li>Subscribe the webhook to the messages field.</li>
        </ol>
      </section>

      {error && <div className="banner">{error}</div>}
      {message && <div className="banner ok">{message}</div>}

      <section className="settings-card">
        <h2 style={{ marginTop: 0 }}>Webhook</h2>
        <label className="muted">Callback URL</label>
        <div className="secret-row">
          <code>{settings.webhookUrl}</code>
          <button type="button" onClick={() => void copy(settings.webhookUrl)}>Copy</button>
        </div>
        <label className="muted">Verify token</label>
        <div className="secret-row">
          <code>{settings.verifyToken}</code>
          <button type="button" onClick={() => void copy(settings.verifyToken)}>Copy</button>
        </div>
      </section>

      <form className="settings-card settings-grid" onSubmit={connect}>
        <h2 style={{ margin: 0 }}>Number credentials</h2>
        <label>
          Phone number ID
          <input required value={settings.phoneNumberId} onChange={(event) => setSettings((prev) => ({ ...prev, phoneNumberId: event.target.value }))} />
        </label>
        <label>
          WhatsApp Business Account ID
          <input value={settings.wabaId} onChange={(event) => setSettings((prev) => ({ ...prev, wabaId: event.target.value }))} />
        </label>
        <label>
          Display phone number
          <input value={settings.displayPhoneNumber} placeholder="+256…" onChange={(event) => setSettings((prev) => ({ ...prev, displayPhoneNumber: event.target.value }))} />
        </label>
        <label>
          Access token {settings.accessTokenSet ? `(saved ${settings.accessTokenMasked})` : ''}
          <input type="password" value={accessToken} placeholder={settings.accessTokenSet ? 'Leave blank to keep the saved token' : 'Permanent access token'} onChange={(event) => setAccessToken(event.target.value)} />
        </label>
        <label>
          App secret {settings.appSecretSet ? `(saved ${settings.appSecretMasked})` : '(recommended)'}
          <input type="password" value={appSecret} placeholder={settings.appSecretSet ? 'Leave blank to keep the saved secret' : 'Used to verify webhook signatures'} onChange={(event) => setAppSecret(event.target.value)} />
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" type="submit" disabled={saving}>{saving ? 'Checking…' : 'Connect number'}</button>
          {settings.connected && <button type="button" onClick={() => void disconnect()} disabled={saving}>Disconnect</button>}
        </div>
      </form>

      <form className="settings-card settings-grid" onSubmit={saveAssistant}>
        <h2 style={{ margin: 0 }}>AI assistant</h2>
        <p className="muted">
          When this is on, new open conversations get an automatic WhatsApp reply. Assigning a conversation to a person pauses the assistant.
          {!settings.aiConfigured && ' Add GEMINI_API_KEY on the API before auto-replies can be generated.'}
        </p>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={settings.autoReplyEnabled}
            onChange={(event) => setSettings((prev) => ({ ...prev, autoReplyEnabled: event.target.checked }))}
          />
          Reply automatically to unassigned open chats
        </label>
        <label>
          Business name
          <input value={settings.businessName} onChange={(event) => setSettings((prev) => ({ ...prev, businessName: event.target.value }))} />
        </label>
        <label>
          Instructions
          <textarea
            rows={5}
            value={settings.aiInstructions}
            placeholder="Hours, delivery areas, what the assistant may promise, and when to hand the chat to a person."
            onChange={(event) => setSettings((prev) => ({ ...prev, aiInstructions: event.target.value }))}
          />
        </label>
        <button className="primary" type="submit" disabled={saving}>Save assistant</button>
      </form>
    </div>
  );
}
