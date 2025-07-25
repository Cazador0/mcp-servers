#!/usr/bin/env node
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(express.json());

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use('/', express.static(path.join(__dirname, 'public')));

interface Contract { id: string; org: string; product: string; user: string; }
interface Claim { id: string; contractId: string; description: string; status: string; }

const contracts: Contract[] = [];
const claims: Claim[] = [];

app.get('/api/contracts', (_req, res) => { res.json(contracts); });
app.post('/api/contracts', (req, res) => {
  const contract: Contract = { id: String(Date.now()), ...req.body };
  contracts.push(contract);
  res.json(contract);
});

app.get('/api/claims', (_req, res) => { res.json(claims); });
app.post('/api/claims', (req, res) => {
  const claim: Claim = { id: String(Date.now()), status: 'new', ...req.body };
  claims.push(claim);
  res.json(claim);
});

const port = process.env.PORT || 3000;
app.listen(port, () => { console.error(`Insurance server listening on ${port}`); });

