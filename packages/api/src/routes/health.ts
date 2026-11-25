import { Router } from 'express';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'relay-api', channel: 'whatsapp' });
});
