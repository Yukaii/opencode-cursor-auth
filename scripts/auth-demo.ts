/**
 * Authentication Demo Script
 *
 * This script demonstrates the real authentication workflow using the restored
 * Cursor CLI authentication modules.
 *
 * Usage:
 *   bun scripts/auth-demo.ts [command]
 *
 * Commands:
 *   status     - Show current authentication status
 *   check      - Check if token is valid/expiring
 *   refresh    - Force token refresh (requires API key)
 *   clear      - Clear stored credentials
 *   demo       - Run full demo with mock interceptor
 *   auth-key   - Authenticate using API key (from env or arg)
 *   auth-token - Authenticate using direct token (from env or arg)
 */

import { platform, homedir } from "node:os";
import { join, dirname } from "node:path";
import { promises as fs } from "node:fs";

// --- Types ---

interface CredentialManager {
  getAccessToken(): Promise<string | undefined>;
  getRefreshToken(): Promise<string | undefined>;
  getApiKey(): Promise<string | undefined>;
  getAllCredentials(): Promise<{
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
  }>;
  setAuthentication(
    accessToken: string,
    refreshToken: string,
    apiKey?: string
  ): Promise<void>;
  clearAuthentication(): Promise<void>;
}

interface AuthResult {
  isAuthenticated: boolean;
  usingApiKeyFromEnv?: boolean;
  usingAuthTokenFromEnv?: boolean;
}

// --- Helper Functions ---

/**
 * Decode JWT payload without signature verification (for display purposes only)
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const base64Payload = token.split(".")[1];
    if (!base64Payload) return null;
    const payloadBuffer = Buffer.from(base64Payload, "base64");
    return JSON.parse(payloadBuffer.toString());
  } catch {
    return null;
  }
}

/**
 * Check if a token is expiring soon (within 5 minutes)
 */
function isTokenExpiringSoon(token: string): boolean {
  try {
    const decoded = decodeJwtPayload(token);
    if (!decoded || typeof decoded.exp !== "number") return true;

    const currentTime = Math.floor(Date.now() / 1000);
    const expirationTime = decoded.exp;
    const timeLeft = expirationTime - currentTime;

    return timeLeft < 300; // 5 minutes
  } catch {
    return true;
  }
}

/**
 * Format seconds into human-readable duration
 */
function formatDuration(seconds: number): string {
  if (seconds < 0) return "expired";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Mask sensitive token data for display
 */
function maskToken(token: string | undefined): string {
  if (!token) return "(not set)";
  if (token.length < 20) return "***";
  return `${token.substring(0, 10)}...${token.substring(token.length - 10)}`;
}

// --- Credential Manager Factory ---

/**
 * FileCredentialManager - File-based credential storage
 * Used on Linux/Windows, or as fallback
 */
class FileCredentialManager implements CredentialManager {
  private cachedAccessToken: string | null = null;
  private cachedRefreshToken: string | null = null;
  private cachedApiKey: string | null = null;
  private authFilePath: string;

  constructor(domain: string) {
    this.authFilePath = this.getAuthFilePath(domain);
  }

  private toWindowsTitleCase(domain: string): string {
    if (domain.length === 0) return domain;
    return domain.charAt(0).toUpperCase() + domain.slice(1).toLowerCase();
  }

  private getAuthFilePath(domain: string): string {
    const currentPlatform = platform();

    switch (currentPlatform) {
      case "win32": {
        const appData =
          process.env.APPDATA || join(homedir(), "AppData", "Roaming");
        const folder = this.toWindowsTitleCase(domain);
        return join(appData, folder, "auth.json");
      }
      case "darwin":
        return join(homedir(), `.${domain}`, "auth.json");
      default: {
        const configDir =
          process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
        return join(configDir, domain, "auth.json");
      }
    }
  }

  private async ensureDirectoryExists(): Promise<void> {
    const dir = dirname(this.authFilePath);
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }

  private async readAuthData(): Promise<{
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
  } | null> {
    try {
      const data = await fs.readFile(this.authFilePath, "utf-8");
      return JSON.parse(data);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return null;
    }
  }

  private async writeAuthData(data: {
    accessToken: string;
    refreshToken: string;
    apiKey?: string;
  }): Promise<void> {
    await this.ensureDirectoryExists();
    await fs.writeFile(this.authFilePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async setAuthentication(
    accessToken: string,
    refreshToken: string,
    apiKey?: string
  ): Promise<void> {
    await this.writeAuthData({ accessToken, refreshToken, apiKey });
    this.cachedAccessToken = accessToken;
    this.cachedRefreshToken = refreshToken;
    this.cachedApiKey = apiKey ?? null;
  }

  async getAccessToken(): Promise<string | undefined> {
    if (this.cachedAccessToken) return this.cachedAccessToken;
    const authData = await this.readAuthData();
    if (authData?.accessToken) {
      this.cachedAccessToken = authData.accessToken;
      this.cachedRefreshToken = authData.refreshToken ?? null;
      return authData.accessToken;
    }
    return undefined;
  }

  async getRefreshToken(): Promise<string | undefined> {
    if (this.cachedRefreshToken) return this.cachedRefreshToken;
    const authData = await this.readAuthData();
    if (authData?.refreshToken) {
      this.cachedAccessToken = authData.accessToken ?? null;
      this.cachedRefreshToken = authData.refreshToken;
      return authData.refreshToken;
    }
    return undefined;
  }

  async getApiKey(): Promise<string | undefined> {
    if (this.cachedApiKey) return this.cachedApiKey;
    const authData = await this.readAuthData();
    if (authData?.apiKey) {
      this.cachedApiKey = authData.apiKey;
      return authData.apiKey;
    }
    return undefined;
  }

  async getAllCredentials(): Promise<{
    accessToken?: string;
    refreshToken?: string;
    apiKey?: string;
  }> {
    if (this.cachedAccessToken !== null && this.cachedRefreshToken !== null) {
      return {
        accessToken: this.cachedAccessToken || undefined,
        refreshToken: this.cachedRefreshToken || undefined,
        apiKey: this.cachedApiKey || undefined,
      };
    }
    const authData = await this.readAuthData();
    if (authData) {
      this.cachedAccessToken = authData.accessToken || null;
      this.cachedRefreshToken = authData.refreshToken || null;
      this.cachedApiKey = authData.apiKey || null;
      return authData;
    }
    return {};
  }

  async clearAuthentication(): Promise<void> {
    try {
      await fs.unlink(this.authFilePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.cachedAccessToken = null;
    this.cachedRefreshToken = null;
    this.cachedApiKey = null;
  }
}

/**
 * Create appropriate credential manager for the current platform
 */
function createCredentialManager(domain: string): CredentialManager {
  // For this demo, we use FileCredentialManager on all platforms
  // In production, macOS would use KeychainCredentialManager
  console.log(`[CredentialManager] Platform: ${platform()}`);
  console.log(
    `[CredentialManager] Using FileCredentialManager for demo (domain: ${domain})`
  );
  return new FileCredentialManager(domain);
}

// --- Auth Refresh Logic (from restored/src/auth-refresh.ts) ---

async function getValidAccessToken(
  credentialManager: CredentialManager,
  endpoint: string
): Promise<string | null> {
  const currentToken = await credentialManager.getAccessToken();
  if (!currentToken) {
    return null;
  }

  if (!isTokenExpiringSoon(currentToken)) {
    return currentToken;
  }

  // Token is expiring soon, try to refresh with API key
  const apiKey = await credentialManager.getApiKey();
  if (apiKey) {
    console.log("[Auth] Token expiring soon, attempting refresh with API key...");
    // In real implementation, this would call LoginManager.loginWithApiKey()
    // For demo purposes, we just log and return the current token
    console.log("[Auth] (Demo mode: refresh would happen here via LoginManager)");
  }

  return currentToken;
}

// --- API Key Auth Logic (from restored/src/api-key-auth.ts) ---

async function tryApiKeyAuth(
  credentialManager: CredentialManager,
  options: { apiKey?: string; endpoint: string }
): Promise<AuthResult> {
  const apiKey = options.apiKey ?? process.env.CURSOR_API_KEY;
  const usingApiKeyFromEnv = !options.apiKey && !!process.env.CURSOR_API_KEY;

  if (!apiKey) {
    return { isAuthenticated: false, usingApiKeyFromEnv: false };
  }

  console.log(
    `[Auth] Attempting API key authentication${usingApiKeyFromEnv ? " (from CURSOR_API_KEY env)" : ""}...`
  );

  // In real implementation, this would call LoginManager.loginWithApiKey()
  // For demo, we simulate success
  console.log("[Auth] (Demo mode: API key validation would happen here)");

  return { isAuthenticated: true, usingApiKeyFromEnv };
}

async function tryAuthTokenAuth(
  credentialManager: CredentialManager,
  options: { authToken?: string }
): Promise<AuthResult> {
  const authToken = options.authToken ?? process.env.CURSOR_AUTH_TOKEN;
  const usingAuthTokenFromEnv =
    !options.authToken && !!process.env.CURSOR_AUTH_TOKEN;

  if (!authToken) {
    return { isAuthenticated: false, usingAuthTokenFromEnv: false };
  }

  console.log(
    `[Auth] Using direct auth token${usingAuthTokenFromEnv ? " (from CURSOR_AUTH_TOKEN env)" : ""}...`
  );

  // Set the token directly (bypasses login flow)
  await credentialManager.setAuthentication(authToken, authToken);

  return { isAuthenticated: true, usingAuthTokenFromEnv };
}

// --- Interceptor Logic (from restored/src/client.ts) ---

type Request = { headers: Map<string, string>; url: string };
type NextFn = (req: Request) => Promise<unknown>;

function createAuthInterceptor(
  credentialManager: CredentialManager,
  opts: { baseUrl: string }
) {
  return (next: NextFn) => async (req: Request) => {
    const token = await getValidAccessToken(credentialManager, opts.baseUrl);

    if (token !== undefined && token !== null) {
      req.headers.set("authorization", `Bearer ${token}`);
    }

    // Set additional headers like the real implementation
    req.headers.set("x-ghost-mode", "true"); // Default to privacy mode
    req.headers.set("x-cursor-client-version", "cli-demo");
    req.headers.set("x-cursor-client-type", "cli");

    if (!req.headers.get("x-request-id")) {
      req.headers.set("x-request-id", crypto.randomUUID());
    }

    return next(req);
  };
}

// --- Demo Commands ---

async function showStatus(credentialManager: CredentialManager) {
  console.log("\n=== Authentication Status ===\n");

  const creds = await credentialManager.getAllCredentials();

  console.log("Stored Credentials:");
  console.log(`  Access Token:  ${maskToken(creds.accessToken)}`);
  console.log(`  Refresh Token: ${maskToken(creds.refreshToken)}`);
  console.log(`  API Key:       ${maskToken(creds.apiKey)}`);

  if (creds.accessToken) {
    const payload = decodeJwtPayload(creds.accessToken);
    if (payload) {
      console.log("\nAccess Token Details:");
      console.log(`  Subject (sub): ${payload.sub || "(not set)"}`);

      if (typeof payload.exp === "number") {
        const now = Math.floor(Date.now() / 1000);
        const timeLeft = payload.exp - now;
        const expDate = new Date(payload.exp * 1000);
        console.log(`  Expires:       ${expDate.toISOString()}`);
        console.log(
          `  Time Left:     ${formatDuration(timeLeft)}${timeLeft < 300 ? " (expiring soon!)" : ""}`
        );
      }

      if (typeof payload.iat === "number") {
        const iatDate = new Date(payload.iat * 1000);
        console.log(`  Issued At:     ${iatDate.toISOString()}`);
      }
    }
  }

  console.log("\nEnvironment Variables:");
  console.log(
    `  CURSOR_API_KEY:    ${process.env.CURSOR_API_KEY ? "(set)" : "(not set)"}`
  );
  console.log(
    `  CURSOR_AUTH_TOKEN: ${process.env.CURSOR_AUTH_TOKEN ? "(set)" : "(not set)"}`
  );
  console.log(
    `  CURSOR_API_ENDPOINT: ${process.env.CURSOR_API_ENDPOINT || "(not set, using default)"}`
  );
}

async function checkToken(credentialManager: CredentialManager) {
  console.log("\n=== Token Validation ===\n");

  const token = await credentialManager.getAccessToken();

  if (!token) {
    console.log("No access token stored.");
    return;
  }

  const payload = decodeJwtPayload(token);
  if (!payload) {
    console.log("Failed to decode token payload.");
    return;
  }

  const isExpiring = isTokenExpiringSoon(token);
  const now = Math.floor(Date.now() / 1000);
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  const timeLeft = exp - now;

  if (timeLeft < 0) {
    console.log(`Token Status: EXPIRED (${formatDuration(Math.abs(timeLeft))} ago)`);
  } else if (isExpiring) {
    console.log(`Token Status: EXPIRING SOON (${formatDuration(timeLeft)} remaining)`);
    console.log("  -> Token refresh would be triggered on next request");
  } else {
    console.log(`Token Status: VALID (${formatDuration(timeLeft)} remaining)`);
  }
}

async function runDemo(credentialManager: CredentialManager) {
  console.log("\n=== Authentication Flow Demo ===\n");

  // 1. Check current state
  console.log("1. Checking current credentials...");
  const creds = await credentialManager.getAllCredentials();

  if (!creds.accessToken) {
    console.log("   No credentials found. Creating demo token...");

    // Create a demo token that expires in 10 minutes
    const now = Math.floor(Date.now() / 1000);
    const demoPayload = {
      sub: "demo-auth-id-12345",
      exp: now + 600, // 10 minutes
      iat: now,
    };
    const demoToken = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${Buffer.from(JSON.stringify(demoPayload)).toString("base64url")}.demo-signature`;

    await credentialManager.setAuthentication(
      demoToken,
      "demo-refresh-token",
      "demo-api-key"
    );
    console.log("   Demo credentials created.");
  } else {
    console.log("   Found existing credentials.");
  }

  // 2. Create interceptor
  console.log("\n2. Creating auth interceptor...");
  const authInterceptor = createAuthInterceptor(credentialManager, {
    baseUrl: "https://api2.cursor.sh",
  });

  // 3. Mock request
  console.log("\n3. Simulating API request...");
  const mockRequest: Request = {
    headers: new Map(),
    url: "https://api2.cursor.sh/v1/test",
  };

  const mockNext: NextFn = async (req) => {
    console.log(`\n   [Network] Request to: ${req.url}`);
    console.log("   [Network] Headers:");
    req.headers.forEach((value, key) => {
      if (key === "authorization") {
        console.log(`     ${key}: Bearer ${maskToken(value.replace("Bearer ", ""))}`);
      } else {
        console.log(`     ${key}: ${value}`);
      }
    });
    return { status: 200, body: "OK" };
  };

  const interceptorChain = authInterceptor(mockNext);
  await interceptorChain(mockRequest);

  // 4. Final status
  console.log("\n4. Final status:");
  const finalToken = await credentialManager.getAccessToken();
  if (finalToken) {
    const isExpiring = isTokenExpiringSoon(finalToken);
    console.log(`   Token valid: ${!isExpiring ? "Yes" : "No (expiring soon)"}`);
  }

  console.log("\n Demo complete.");
}

async function clearCredentials(credentialManager: CredentialManager) {
  console.log("\n=== Clearing Credentials ===\n");

  await credentialManager.clearAuthentication();
  console.log("All stored credentials have been cleared.");
}

// --- Main Entry Point ---

async function main() {
  const command = process.argv[2] || "status";
  const domain = "cursor-demo"; // Use demo domain to avoid affecting real credentials

  console.log("Cursor CLI Authentication Demo");
  console.log("==============================");

  const credentialManager = createCredentialManager(domain);

  switch (command) {
    case "status":
      await showStatus(credentialManager);
      break;

    case "check":
      await checkToken(credentialManager);
      break;

    case "refresh":
      console.log("\n=== Token Refresh ===\n");
      const token = await getValidAccessToken(
        credentialManager,
        "https://api2.cursor.sh"
      );
      if (token) {
        console.log("Token retrieved (refresh attempted if needed).");
      } else {
        console.log("No token available.");
      }
      break;

    case "clear":
      await clearCredentials(credentialManager);
      break;

    case "demo":
      await runDemo(credentialManager);
      break;

    case "auth-key": {
      const apiKey = process.argv[3];
      const result = await tryApiKeyAuth(credentialManager, {
        apiKey,
        endpoint: "https://api2.cursor.sh",
      });
      if (result.isAuthenticated) {
        console.log("\nAPI key authentication simulated successfully.");
        if (result.usingApiKeyFromEnv) {
          console.log("(API key was read from CURSOR_API_KEY environment variable)");
        }
      } else {
        console.log("\nNo API key provided. Set CURSOR_API_KEY or pass as argument.");
      }
      break;
    }

    case "auth-token": {
      const authToken = process.argv[3];
      const result = await tryAuthTokenAuth(credentialManager, { authToken });
      if (result.isAuthenticated) {
        console.log("\nDirect token authentication successful.");
        if (result.usingAuthTokenFromEnv) {
          console.log("(Token was read from CURSOR_AUTH_TOKEN environment variable)");
        }
      } else {
        console.log("\nNo auth token provided. Set CURSOR_AUTH_TOKEN or pass as argument.");
      }
      break;
    }

    default:
      console.log(`\nUnknown command: ${command}`);
      console.log("\nAvailable commands:");
      console.log("  status     - Show current authentication status");
      console.log("  check      - Check if token is valid/expiring");
      console.log("  refresh    - Force token refresh (requires API key)");
      console.log("  clear      - Clear stored credentials");
      console.log("  demo       - Run full demo with mock interceptor");
      console.log("  auth-key   - Authenticate using API key (from env or arg)");
      console.log("  auth-token - Authenticate using direct token (from env or arg)");
      process.exit(1);
  }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
