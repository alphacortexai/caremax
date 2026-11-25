import { Router } from 'express';
import { getFirebaseStatus } from '../config/firebase.js';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  const firebase = getFirebaseStatus();
  res.status(firebase.ok ? 200 : 503).json({
    status: firebase.ok ? 'ok' : 'degraded',
    service: 'relay-api',
    channel: 'whatsapp',
    firebase: firebase.ok ? 'ok' : firebase.error,
  });
});
