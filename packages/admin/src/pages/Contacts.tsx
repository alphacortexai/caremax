import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useTenant } from '../TenantContext';
import './Inbox.css';

type Contact = {
  id: string;
  displayName: string;
  phone: string;
  channel: string;
  lastMessageAtMs: number;
  conversationId: string;
};

export default function Contacts() {
  const { tenantId } = useTenant();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tenantId) return;
    api<{ contacts: Contact[] }>(`/tenants/${tenantId}/inbox/contacts`)
      .then((res) => setContacts(res.contacts))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Failed to load contacts.'));
  }, [tenantId]);

  return (
    <div>
      <p style={{ margin: 0, color: '#0f766e', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>WhatsApp</p>
      <h1 style={{ marginTop: 4 }}>Contacts</h1>
      <p style={{ color: '#5f736b' }}>People who have messaged the WhatsApp number registered to this business.</p>
      {error && <p style={{ color: '#9a3412' }}>{error}</p>}
      {contacts.length === 0 && !error && (
        <p>No contacts yet. They appear here after the first inbound WhatsApp message. <Link to="/">Open the inbox</Link></p>
      )}
      {contacts.length > 0 && (
        <table className="contacts-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Channel</th>
              <th>Last message</th>
            </tr>
          </thead>
          <tbody>
            {contacts.map((contact) => (
              <tr key={contact.id}>
                <td>{contact.displayName}</td>
                <td>+{contact.phone}</td>
                <td>WhatsApp</td>
                <td>{new Date(contact.lastMessageAtMs).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
