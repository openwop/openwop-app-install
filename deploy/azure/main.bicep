// OpenWOP app — Azure deploy pack (Container Apps + PostgreSQL Flexible Server
// + Key Vault). Provisions the backend on Azure Container Apps with a
// user-assigned managed identity that wraps/unwraps the BYOK DEK via Key Vault
// (OPENWOP_BYOK_KMS_KEY=azure-keyvault:<key-url> — the Azure backend in
// backend/typescript/src/byok/kmsBackends.ts).
//
// Status: syntax-reviewed scaffold. NOT deployed live. Validate with
//   az bicep build --file main.bicep
//   az deployment group what-if --resource-group <rg> --template-file main.bicep
// before `az deployment group create`.

@description('Deployment region.')
param location string = resourceGroup().location

@description('Name prefix for all resources.')
param namePrefix string = 'openwop'

@description('Backend container image (push the root Dockerfile to ACR or a public registry).')
param image string

@description('PostgreSQL administrator login.')
param dbAdminUser string = 'openwop'

@description('PostgreSQL administrator password. MUST be URL-safe (it is embedded in the postgres:// DSN — no + / @ : ? #) AND meet Azure complexity (upper+lower+digit). A base64url value works: openssl rand -base64 24 | tr \'+/\' \'-_\'')
@secure()
param dbAdminPassword string

@description('Session cookie signing secret (32+ chars).')
@secure()
param sessionSecret string

@description('OPENWOP_DEPLOY_POSTURE: cookie-per-visitor | bearer-shared | auth.')
param deployPosture string = 'cookie-per-visitor'

@description('Comma-separated allowed SPA origins for CORS.')
param corsOrigins string = ''

var dbName = 'openwop'

// ── Observability ────────────────────────────────────────────────────────────
resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// ── Managed identity for the container app (Key Vault crypto) ────────────────
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-id'
  location: location
}

// ── Key Vault + BYOK key ─────────────────────────────────────────────────────
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${namePrefix}-kv-${uniqueString(resourceGroup().id)}'
  location: location
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
  }
}

resource byokKey 'Microsoft.KeyVault/vaults/keys@2023-07-01' = {
  parent: vault
  name: 'byok-wrap'
  properties: {
    kty: 'RSA'
    keySize: 3072
    keyOps: [ 'wrapKey', 'unwrapKey' ]
  }
}

// Built-in role: Key Vault Crypto User (wrap/unwrap, no key management).
var keyVaultCryptoUser = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12338af0-0e69-4776-bea7-57ae8d297424')

resource vaultRole 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, keyVaultCryptoUser)
  scope: vault
  properties: {
    roleDefinitionId: keyVaultCryptoUser
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// ── PostgreSQL Flexible Server ───────────────────────────────────────────────
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2023-06-01-preview' = {
  name: '${namePrefix}-pg-${uniqueString(resourceGroup().id)}'
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '16'
    administratorLogin: dbAdminUser
    administratorLoginPassword: dbAdminPassword
    storage: { storageSizeGB: 32 }
    highAvailability: { mode: 'Disabled' }
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2023-06-01-preview' = {
  parent: pg
  name: dbName
}

// Allow Azure services (incl. Container Apps) to reach the server.
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2023-06-01-preview' = {
  parent: pg
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// ── Container Apps environment + app ─────────────────────────────────────────
resource caEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// dbAdminPassword is embedded verbatim here, so it must be URL-safe (enforced by
// the param description's generation recipe — Bicep has no URL-encode function).
var storageDsn = 'postgres://${dbAdminUser}:${dbAdminPassword}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${namePrefix}-backend'
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: caEnv.id
    configuration: {
      // ACA ingress streams responses (no buffering) — SSE-safe.
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
      }
      secrets: [
        { name: 'session-secret', value: sessionSecret }
        { name: 'storage-dsn', value: storageDsn }
      ]
    }
    template: {
      containers: [
        {
          name: 'backend'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'OPENWOP_DEPLOY_POSTURE', value: deployPosture }
            { name: 'OPENWOP_COOKIE_SECURE', value: 'true' }
            { name: 'OPENWOP_SURFACE_BACKEND', value: 'durable' }
            { name: 'OPENWOP_CORS_ORIGINS', value: corsOrigins }
            { name: 'OPENWOP_BYOK_KMS_KEY', value: 'azure-keyvault:${byokKey.properties.keyUriWithVersion}' }
            // DefaultAzureCredential picks up the user-assigned identity.
            { name: 'AZURE_CLIENT_ID', value: identity.properties.clientId }
            { name: 'OPENWOP_SESSION_SECRET', secretRef: 'session-secret' }
            { name: 'OPENWOP_STORAGE_DSN', secretRef: 'storage-dsn' }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 3 }
    }
  }
}

output backendUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output byokKeyUri string = byokKey.properties.keyUriWithVersion
