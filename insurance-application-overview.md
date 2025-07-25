# IBM DB2 Blockchain Insurance Application Overview

This reference application demonstrates how to build a multi‑organization insurance
network on Hyperledger Fabric with analytics support via IBM Db2. It shows how
insurers, police, repair shops and retail stores can participate in a shared
ledger while keeping their own peers.

## Key Components

- **Smart Contract (Chaincode)**
  - Implemented in Go under `web/chaincode/src/bcins`
  - Defines contract templates, contracts, claims and repair orders
  - Provides functions for contract creation, claim filing and user
    authentication
- **Docker and Fabric Setup**
  - Shell scripts generate crypto material and Fabric configuration
  - `docker-compose.yaml` orchestrates peers, orderer, CAs, Db2 and Zeppelin
- **Web Application**
  - Node.js backend with a React frontend
  - Connection logic in `web/www/blockchain` handles enrollment and transaction
    submission
- **Db2 Integration**
  - Dockerfiles and SQL scripts under `db2-fabric` configure Db2 federation
  - Allows querying blockchain data using SQL via Zeppelin notebooks

## Workflow Summary

1. Build Docker images and generate certificates for all organizations
2. Launch the network with `docker-compose`
3. Deploy the insurance chaincode and connect the web app to the network
4. Users purchase products, enroll for insurance and file claims through the UI
5. Claims are processed by insurance staff, police and repair shops
6. Blockchain transactions can be analyzed in Db2 using Zeppelin

The full source and setup instructions can be found in the
[ibm-ibm-db2-blockchain-insurance-application](https://github.com/IBM/IBM-db2-blockchain-insurance-application) repository.
