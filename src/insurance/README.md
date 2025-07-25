# Insurance Demo Server

This server provides a minimal multi-organization insurance demo using the Model Context Protocol.
It recreates the workflow of the original IBM blockchain insurance sample but without the blockchain
dependency. All data is stored in memory and can be manipulated through HTTP endpoints.

A small React front end is served using a design reminiscent of the OpenAI UI.

## Endpoints

- `GET /api/contracts` – list contracts
- `POST /api/contracts` – create a new contract
- `GET /api/claims` – list claims
- `POST /api/claims` – file a claim

## Running

```
npx ts-node src/insurance/index.ts
```

