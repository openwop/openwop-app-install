# Deploy pack: Azure (Container Apps)

Enterprise / Microsoft-shop target. Bicep provisions the backend on **Azure
Container Apps**, with **PostgreSQL Flexible Server**, and **Key Vault** for
production BYOK envelope encryption. The container app's **user-assigned managed
identity** wraps/unwraps the DEK via Key Vault
(`OPENWOP_BYOK_KMS_KEY=azure-keyvault:<key-url>` — the Azure backend in
`backend/typescript/src/byok/kmsBackends.ts`), authenticated by
`DefaultAzureCredential` (`AZURE_CLIENT_ID` is wired to the identity).

> Status: syntax-reviewed scaffold. NOT deployed live. Validate with
> `az bicep build` + `az deployment group what-if` before `create`.

## What it creates

| Capability | Resource |
|---|---|
| Container runtime | Azure Container Apps (root Dockerfile image) |
| Relational store | PostgreSQL Flexible Server → DSN as an ACA secret |
| BYOK secret wrap | Key Vault RSA key + Crypto User role on the app identity |
| Identity (cloud) | user-assigned managed identity (Key Vault auth) |
| Edge / SSE | ACA ingress (streams; SSE-safe) |
| App identity (users) | anon cookie; set `OPENWOP_OIDC_*` for Entra ID / any OIDC |

## Deploy

```bash
RG=openwop-rg
az group create --name $RG --location eastus

# 1. Build + push the backend image (ACR shown; any registry works).
az acr create --resource-group $RG --name openwopacr --sku Basic
az acr login --name openwopacr
docker build -t openwopacr.azurecr.io/openwop-app:latest .   # from repo root
docker push openwopacr.azurecr.io/openwop-app:latest

# 2. Deploy the infra.
# dbAdminPassword goes into the postgres:// DSN, so it must be URL-safe; it must
# also meet Azure's complexity policy (upper+lower+digit). base64url satisfies
# both (sessionSecret is not in a URL, so plain base64 is fine).
az deployment group create \
  --resource-group $RG \
  --template-file deploy/azure/main.bicep \
  --parameters \
      image=openwopacr.azurecr.io/openwop-app:latest \
      dbAdminPassword="$(openssl rand -base64 24 | tr '+/' '-_')" \
      sessionSecret="$(openssl rand -base64 32)"
```

The deployment outputs `backendUrl` (check `…/readiness`) and `byokKeyUri`.

> ACR pull: grant the container app's managed identity `AcrPull` on the registry
> (or use admin creds / a registry secret). Omitted from the template since the
> registry may be external.

## Frontend (SPA)

Host the static SPA on **Azure Static Web Apps** or **Storage static website +
Front Door**. Build `frontend/react` with `VITE_OPENWOP_BASE_URL` /
`VITE_OPENWOP_SSE_BASE_URL` pointed at the ACA backend URL, then pass
`corsOrigins=https://<spa-host>` so the backend allows the SPA origin. Front Door
must not buffer `/api` (disable response caching on that route) — the same
non-buffering-edge requirement every pack documents.

## Production notes

- `OPENWOP_DEPLOY_POSTURE=auth` is fully supported: Postgres + the Key Vault key
  meet the persistent-secret requirement. Wire `OPENWOP_OIDC_*` to Entra ID
  (`https://login.microsoftonline.com/<tenant>/v2.0`) or any issuer.
- The Postgres firewall rule opens `0.0.0.0` (Azure-services) for simplicity;
  use VNet integration + a private endpoint for production.
