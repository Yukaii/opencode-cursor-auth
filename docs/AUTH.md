# Authentication Flow Documentation

This document outlines the authentication mechanisms and flow within the restored Cursor CLI codebase.

## Overview

The Cursor CLI supports multiple authentication methods to interact with the Cursor backend services (`api2.cursor.sh`, `agent.api5.cursor.sh`, etc.). Authentication is primarily token-based (JWT), managed via a `CredentialManager` and enforced through request interceptors.

## Restored Source Files

The following authentication-related modules have been restored:

### Core Authentication (`src/`)

| File | Description |
|------|-------------|
| `src/auth-refresh.ts` | Token expiration checking and automatic refresh logic |
| `src/api-key-auth.ts` | API key and auth token authentication handlers |
| `src/client.ts` | Client factory with auth interceptors for various services |
| `src/privacy.ts` | Privacy mode cache management and ghost mode detection |
| `src/analytics.ts` | Analytics event tracking with credential-aware buffering |
| `src/commands/login.tsx` | Interactive browser-based login command |
| `src/commands/logout.tsx` | Logout command with credential clearing |
| `src/commands/dev-login.tsx` | Development login for local testing |
| `src/components/login-ui.tsx` | React (Ink) UI components for login status display |
| `src/console-io.ts` | Direct terminal I/O utilities for auth warnings |
| `src/utils/api-endpoint.ts` | API endpoint resolution and agent backend URL logic |
| `src/constants.ts` | Feature flags and configuration constants |
| `src/debug.ts` | Debug logging infrastructure |

### CLI Credentials (`cli-credentials/`)

| File | Description |
|------|-------------|
| `cli-credentials/dist/index.js` | Factory function to create platform-appropriate credential manager |
| `cli-credentials/dist/file.js` | `FileCredentialManager` - File-based credential storage |
| `cli-credentials/dist/keychain.js` | `KeychainCredentialManager` - macOS Keychain-based storage |

### Keychain Access (`keychain/`)

| File | Description |
|------|-------------|
| `keychain/dist/index.js` | Module entry point with usage examples |
| `keychain/dist/keychain.js` | `KeychainAccess` - macOS Keychain wrapper using `security` CLI |
| `keychain/dist/errors.js` | Custom error classes for keychain operations |

## Authentication Methods

The CLI supports four primary ways to authenticate:

### 1. Interactive Login
*   **Command**: `cursor login`
*   **Mechanism**: Browser-based OAuth flow using `LoginManager.startLogin()` and `waitForResult()`.
*   **Flow**:
    1.  Generates a login URL and opens the browser
    2.  Displays status via `LoginStatus` React component
    3.  Waits for authentication callback
    4.  Stores tokens via `credentialManager.setAuthentication()`
    5.  Resets and refreshes privacy cache in background
    6.  Auto-configures staging channel for `@anysphere.co` users
*   **Code Reference**: `src/commands/login.tsx:52-147`

### 2. API Key Authentication
*   **Usage**:
    *   CLI Option: `--api-key <key>`
    *   Environment Variable: `CURSOR_API_KEY`
*   **Mechanism**: Exchanges API key for access/refresh tokens via `LoginManager.loginWithApiKey()`.
*   **Implementation**:
    ```typescript
    // src/api-key-auth.ts:37-63
    const loginManager = new LoginManager();
    const authResult = await loginManager.loginWithApiKey(apiKey, { endpoint });
    await credentialManager.setAuthentication(
        authResult.accessToken, 
        authResult.refreshToken, 
        apiKey
    );
    ```
*   **Error Handling**: Displays warning with ANSI colors if API key is invalid.
*   **Code Reference**: `src/api-key-auth.ts` (`tryApiKeyAuth`)

### 3. Direct Auth Token
*   **Usage**:
    *   CLI Option: `--auth-token <token>`
    *   Environment Variable: `CURSOR_AUTH_TOKEN`
*   **Mechanism**: Bypasses login flow; uses the provided JWT directly for requests.
*   **Implementation**:
    ```typescript
    // src/api-key-auth.ts:64-81
    await credentialManager.setAuthentication(authToken, authToken);
    ```
*   **Use Case**: CI/CD pipelines or debugging scenarios.
*   **Code Reference**: `src/api-key-auth.ts` (`tryAuthTokenAuth`)

### 4. Development Login (Internal/Dev only)
*   **Command**: `cursor dev-login`
*   **Options**:
    *   `-t, --trial`: Login with free trial account
    *   `-k, --insecure`: Ignore SSL certificate validation
    *   `--endpoint <url>`: Custom backend URL (default: `https://localhost:8000`)
*   **Mechanism**: Fetches dev session token from `/auth/cursor_dev_session_token` endpoint.
*   **Code Reference**: `src/commands/dev-login.tsx:44-120`

## Token Management

Token lifecycle is handled primarily in `src/auth-refresh.ts`.

### Token Structure
*   **Access Token**: A JWT containing user identity claims (e.g., `sub` for Auth ID, `exp` for expiration).
*   **Refresh Token**: Used to obtain new access tokens when the current one expires.

### Refresh Logic
The system automatically checks token validity before requests:

1.  **Expiration Check** (`isTokenExpiringSoon`):
    ```typescript
    // src/auth-refresh.ts:38-54
    function decodeJwt_ONLY_FOR_EXPIRATION_CHECK(token) {
        const base64Payload = token.split(".")[1];
        const payloadBuffer = Buffer.from(base64Payload, "base64");
        return JSON.parse(payloadBuffer.toString());
    }
    
    function isTokenExpiringSoon(token) {
        const decoded = decodeJwt_ONLY_FOR_EXPIRATION_CHECK(token);
        const currentTime = Math.floor(Date.now() / 1000);
        const expirationTime = decoded.exp;
        // Token expires in less than 5 minutes (300 seconds)
        return expirationTime - currentTime < 300;
    }
    ```
    *   **Note**: Signature is NOT verified (only for expiration check).
    *   **Threshold**: 5 minutes (300 seconds) before expiry.

2.  **Auto-Refresh** (`getValidAccessToken`):
    ```typescript
    // src/auth-refresh.ts:76-96
    async function getValidAccessToken(credentialManager, endpoint) {
        const currentToken = await credentialManager.getAccessToken();
        if (!currentToken) return null;
        
        if (!isTokenExpiringSoon(currentToken)) {
            return currentToken;
        }
        
        const apiKey = await credentialManager.getApiKey();
        if (apiKey) {
            const newToken = await refreshTokenWithApiKey(credentialManager, endpoint);
            if (newToken) return newToken;
        }
        return currentToken;
    }
    ```

## Key Components

### `CredentialManager`
*   **Location**: `cli-credentials/dist/index.js`
*   **Role**: Secure storage for authentication credentials with platform-specific backends.
*   **Factory Function**:
    ```typescript
    // cli-credentials/dist/index.js
    function createCredentialManager(domain) {
        if (platform() === "darwin") {
            return new KeychainCredentialManager(domain);
        }
        return new FileCredentialManager(domain);
    }
    ```
*   **Interface** (implemented by both managers):
    | Method | Description |
    |--------|-------------|
    | `getAccessToken()` | Retrieve current access token |
    | `getRefreshToken()` | Retrieve current refresh token |
    | `getApiKey()` | Retrieve stored API key |
    | `getAllCredentials()` | Retrieve all credentials at once |
    | `setAuthentication(accessToken, refreshToken, apiKey?)` | Store credentials |
    | `clearAuthentication()` | Remove all stored credentials |

### `FileCredentialManager`
*   **Location**: `cli-credentials/dist/file.js`
*   **Role**: File-based credential storage for non-macOS platforms.
*   **Storage Locations**:
    | Platform | Path |
    |----------|------|
    | Windows | `%APPDATA%\<TitleCase(domain)>\auth.json` |
    | macOS | `~/.<domain>/auth.json` |
    | Linux | `$XDG_CONFIG_HOME/<domain>/auth.json` or `~/.config/<domain>/auth.json` |
*   **File Format**:
    ```json
    {
        "accessToken": "eyJ...",
        "refreshToken": "eyJ...",
        "apiKey": "cur_..."
    }
    ```
*   **Features**:
    *   In-memory caching to reduce file I/O
    *   Automatic directory creation
    *   Graceful handling of missing/corrupted files

### `KeychainCredentialManager`
*   **Location**: `cli-credentials/dist/keychain.js`
*   **Role**: macOS Keychain-based secure credential storage.
*   **Keychain Services** (for domain `cursor`):
    | Service Name | Content |
    |--------------|---------|
    | `cursor-access-token` | Access Token JWT |
    | `cursor-refresh-token` | Refresh Token JWT |
    | `cursor-api-key` | API Key |
*   **Account**: `<domain>-user` (e.g., `cursor-user`)
*   **Features**:
    *   In-memory caching
    *   Uses `@anysphere/keychain` library for Keychain access
    *   Proper error handling for `PasswordNotFoundError`

### `KeychainAccess` (Low-level Keychain API)
*   **Location**: `keychain/dist/keychain.js`
*   **Role**: Modern TypeScript wrapper around macOS `security` CLI tool.
*   **Configuration**:
    ```typescript
    const keychain = new KeychainAccess({
        executablePath: '/usr/bin/security',  // default
        timeoutMs: 30000                       // default: 30 seconds
    });
    ```
*   **Methods**:
    | Method | Description |
    |--------|-------------|
    | `getPassword({ account, service, type? })` | Retrieve password from keychain |
    | `setPassword({ account, service, password, type? })` | Store/update password |
    | `deletePassword({ account, service, type? })` | Delete password |
    | `createKeychain({ keychainName, password })` | Create new keychain |
    | `deleteKeychain({ keychainName })` | Delete a keychain |
    | `setDefaultKeychain({ keychainName })` | Set default keychain |
*   **Password Types**: `generic` (default) or `internet`
*   **Password Parsing**: Handles both quoted strings and hex-encoded passwords

### Keychain Error Classes
*   **Location**: `keychain/dist/errors.js`
*   **Hierarchy**:
    ```
    KeychainError (base)
    ├── UnsupportedPlatformError    - Non-macOS platform detected
    ├── NoAccountProvidedError      - Missing account parameter
    ├── NoServiceProvidedError      - Missing service parameter
    ├── NoPasswordProvidedError     - Missing password parameter
    ├── NoKeychainNameProvidedError - Missing keychain name
    ├── SecurityCommandError        - security CLI execution failed
    ├── PasswordNotFoundError       - Password not in keychain
    ├── KeychainTimeoutError        - Operation timed out
    └── PasswordParsingError        - Failed to parse security output
    ```

### `LoginManager`
*   **Location**: `../cursor-config/dist/index.js` (External dependency)
*   **Role**: Handles OAuth flow and API key exchange.
*   **Methods**:
    *   `startLogin()` - Returns `{ metadata, loginUrl }`
    *   `waitForResult(metadata)` - Polls for auth result
    *   `loginWithApiKey(apiKey, { endpoint })` - Exchange API key for tokens

### Request Interceptor (`createAuthInterceptor`)
*   **Location**: `src/client.ts:34-81`
*   **Role**: Middleware that attaches authentication headers to outgoing requests.
*   **Headers Set**:
    | Header | Value |
    |--------|-------|
    | `Authorization` | `Bearer <token>` |
    | `x-ghost-mode` | `"true"` or `"false"` (privacy setting) |
    | `x-cursor-client-version` | `cli-<version>` (e.g., `cli-2025.11.25-d5b3271`) |
    | `x-cursor-client-type` | `cli` |
    | `x-request-id` | UUID (generated if not present) |
*   **Implementation**:
    ```typescript
    // src/client.ts:34-81
    function createAuthInterceptor(credentialManager, requestMiddleware, opts) {
        return next => req => {
            // Background privacy cache refresh
            maybeRefreshPrivacyCacheInBackground({
                credentialManager,
                baseUrl: opts.baseUrl,
                configProvider: opts.configProvider
            });
            
            const token = await getValidAccessToken(credentialManager, baseUrl);
            if (token !== undefined) {
                req.header.set("authorization", `Bearer ${token}`);
            }
            
            // Set ghost mode, client version, and request ID headers
            // ...
            return requestMiddleware(anyReq, req => next(req.inner));
        };
    }
    ```

### Privacy Cache (`maybeRefreshPrivacyCacheInBackground`)
*   **Location**: `src/privacy.ts:59-122`
*   **Role**: Caches user privacy mode settings to determine ghost mode.
*   **Refresh Strategy**:
    *   **Max Age**: 1 hour (configurable via `CURSOR_PRIVACY_CACHE_MAX_AGE_MS`)
    *   **Sample Rate**: 1 in 10 requests (configurable via `CURSOR_PRIVACY_SAMPLE_RATE`)
*   **Privacy Modes** (from `aiserver.v1.PrivacyMode` enum):
    | Value | Mode | Ghost Mode |
    |-------|------|------------|
    | 0 | UNSPECIFIED | true |
    | 1 | NO_STORAGE | true |
    | 2 | NO_TRAINING | true |
    | 3+ | Other | false |

## API Endpoints

*   **Default API**: `https://api2.cursor.sh` (configurable via `CURSOR_API_ENDPOINT`)
*   **Agent Backend (Privacy Mode)**: `https://agent.api5.cursor.sh`
*   **Agent Backend (Non-Privacy Mode)**: `https://agentn.api5.cursor.sh`

Endpoint selection logic (`src/utils/api-endpoint.ts:22-33`):
```typescript
function getAgentBackendUrl(backendUrl, isPrivacyMode, useNlbForNal) {
    // Localhost/staging URLs: use backendUrl directly
    if (backendUrl.includes("localhost") || 
        backendUrl.includes("staging.cursor.sh")) {
        return backendUrl;
    }
    // Production: use privacy-aware endpoints when flag enabled
    if (!useNlbForNal) return backendUrl;
    return isPrivacyMode ? AGENT_BACKEND_PRIVACY : AGENT_BACKEND_NON_PRIVACY;
}
```

## Client Factories

The `src/client.ts` module provides factory functions for various service clients:

| Function | Service | Transport |
|----------|---------|-----------|
| `createServerConfigServiceClient` | `ServerConfigService` | HTTP/1.1 Connect |
| `createBackgroundComposerClient` | `BackgroundComposerService` | Fetch |
| `createAgentClient` | `AgentService` | HTTP/1.1 or HTTP/2 Connect |
| `createAnalyticsClient` | `AnalyticsService` | Fetch |
| `createAiServerClient` | `AiService` | HTTP/1.1 Connect |

### Agent Client Special Features
*   Supports bidirectional streaming via `BidiSseTransport` for HTTP/1.1
*   Custom system prompt injection via `CURSOR_AGENT_SYSTEM_PROMPT_PATH` environment variable
*   Zscaler SSE compatibility with `x-cursor-streaming` header

## Analytics Integration

Analytics (`src/analytics.ts`) is credential-aware:
*   Uses a deferred buffer until credentials are available
*   Flushes events in background every 3 seconds
*   Respects privacy mode (diagnostic telemetry only for non-privacy users)
*   Exports: `initAnalytics`, `trackEvent`, `trackCancelAndFlush`

## Logout Flow

The logout command (`src/commands/logout.tsx`):
1.  Checks if user is already logged out
2.  Calls `credentialManager.clearAuthentication()`
3.  Resets privacy cache: `configProvider.transform(c => ({ ...c, privacyCache: undefined }))`

## Usage Example

```typescript
// Create an authenticated agent client
const agentClient = createAgentClient(credentialManager, {
    backendUrl: getApiEndpoint(options.endpoint),
    configProvider,
    insecure: options.insecure,
    useNlbForNal: serverConfig.useNlbForNal,
    requestMiddleware
});

// The client automatically handles:
// - Token refresh before expiry
// - Privacy mode detection
// - Request ID generation
// - Version headers
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CURSOR_API_KEY` | API key for authentication |
| `CURSOR_AUTH_TOKEN` | Direct JWT token for authentication |
| `CURSOR_API_ENDPOINT` | Override default API endpoint |
| `CURSOR_PRIVACY_CACHE_MAX_AGE_MS` | Privacy cache TTL (default: 3600000) |
| `CURSOR_PRIVACY_SAMPLE_RATE` | Privacy refresh sample rate (default: 10) |
| `CURSOR_AGENT_SYSTEM_PROMPT_PATH` | Custom system prompt file path |
| `CURSOR_AGENT_DEBUG_PORT` | Debug server base port (default: 43111) |
| `NODE_TLS_REJECT_UNAUTHORIZED` | Set to "0" for insecure connections |
