import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  normalizeWaId,
  parseWhatsAppWebhook,
  subscriptionChallenge,
  verifyWebhookSignature,
} from './whatsapp-cloud.js';

const samplePayload = {
  object: 'whatsapp_business_account',
  entry: [{
    changes: [{
      value: {
        messaging_product: 'whatsapp',
        metadata: {
          display_phone_number: '15550783881',
          phone_number_id: '12345',
        },
        contacts: [{ profile: { name: 'Amina' }, wa_id: '256700000001' }],
        messages: [{
          from: '256700000001',
          id: 'wamid.ABC',
          timestamp: '1710000000',
          type: 'text',
          text: { body: 'Where is my order?' },
        }],
        statuses: [{
          id: 'wamid.OUT',
          status: 'delivered',
          timestamp: '1710000002',
          recipient_id: '256700000001',
        }],
      },
    }],
  }],
};

test('normalizeWaId keeps country digits', () => {
  assert.equal(normalizeWaId('+256 700 000 001'), '256700000001');
  assert.equal(normalizeWaId('whatsapp:+256700000001'), '256700000001');
});

test('parseWhatsAppWebhook reads messages and delivery statuses', () => {
  const parsed = parseWhatsAppWebhook(samplePayload);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].phoneNumberId, '12345');
  assert.equal(parsed.messages[0].message.displayName, 'Amina');
  assert.equal(parsed.messages[0].message.body, 'Where is my order?');
  assert.equal(parsed.messages[0].message.timestampMs, 1710000000000);
  assert.equal(parsed.statuses[0].status, 'delivered');
  assert.equal(parsed.statuses[0].externalMessageId, 'wamid.OUT');
});

test('parseWhatsAppWebhook describes media without dropping the event', () => {
  const parsed = parseWhatsAppWebhook({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: '12345' },
          messages: [{
            from: '256700000001',
            id: 'wamid.IMG',
            timestamp: '1710000001',
            type: 'image',
            image: { caption: 'The receipt' },
          }],
        },
      }],
    }],
  });
  assert.equal(parsed.messages[0].message.type, 'image');
  assert.equal(parsed.messages[0].message.body, '[Image] The receipt');
});

test('subscriptionChallenge returns the hub challenge only for the saved token', () => {
  assert.equal(subscriptionChallenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'secret-token',
    'hub.challenge': '123456',
  }, 'secret-token'), '123456');
  assert.equal(subscriptionChallenge({
    'hub.mode': 'subscribe',
    'hub.verify_token': 'wrong',
    'hub.challenge': '123456',
  }, 'secret-token'), null);
});

test('verifyWebhookSignature accepts the Meta SHA256 signature', () => {
  const raw = Buffer.from(JSON.stringify(samplePayload));
  const signature = `sha256=${createHmac('sha256', 'app-secret').update(raw).digest('hex')}`;
  assert.equal(verifyWebhookSignature(raw, signature, 'app-secret'), true);
  assert.equal(verifyWebhookSignature(raw, signature, 'other-secret'), false);
  assert.equal(verifyWebhookSignature(raw, undefined, 'app-secret'), false);
});
