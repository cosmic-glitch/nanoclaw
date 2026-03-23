/**
 * OAuth token refresh for Claude Code credentials.
 * Refreshes the access token using the refresh token when expired,
 * so scheduled tasks don't fail on stale tokens.
 */
import fs from 'fs';
import https from 'https';
import path from 'path';

import { logger } from './logger.js';

const CLAUDE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** Refresh 5 minutes before expiry, matching Claude Code's own logic. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

interface CredentialsFile {
  claudeAiOauth?: ClaudeOAuthCredentials;
  [key: string]: unknown;
}

function getCredentialsPath(): string {
  return path.join(process.env.HOME || '/home/node', '.claude', '.credentials.json');
}

function readCredentials(): CredentialsFile | null {
  try {
    return JSON.parse(fs.readFileSync(getCredentialsPath(), 'utf-8'));
  } catch {
    return null;
  }
}

function writeCredentials(creds: CredentialsFile): void {
  const credsPath = getCredentialsPath();
  fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

function postJSON(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          try {
            const json = JSON.parse(text);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`OAuth refresh failed (${res.statusCode}): ${text}`));
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${text}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Get a valid OAuth access token, refreshing if needed.
 * Returns the access token string, or empty string on failure.
 */
export async function getValidOAuthToken(): Promise<string> {
  const creds = readCredentials();
  const oauth = creds?.claudeAiOauth;
  if (!oauth?.accessToken) {
    return '';
  }

  // Check if token is still valid (with buffer)
  if (Date.now() + REFRESH_BUFFER_MS < oauth.expiresAt) {
    return oauth.accessToken;
  }

  // Token expired or about to expire — refresh it
  if (!oauth.refreshToken) {
    logger.warn('OAuth token expired but no refresh token available');
    return oauth.accessToken; // return stale token as last resort
  }

  logger.info('OAuth token expired, refreshing...');
  try {
    const scopes = oauth.scopes?.join(' ') || 'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
    const response = await postJSON(CLAUDE_OAUTH_TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: oauth.refreshToken,
      client_id: CLAUDE_OAUTH_CLIENT_ID,
      scope: scopes,
    });

    const newAccessToken = response.access_token as string;
    const newRefreshToken = (response.refresh_token as string) || oauth.refreshToken;
    const expiresIn = response.expires_in as number;

    if (!newAccessToken) {
      logger.error({ response }, 'OAuth refresh returned no access_token');
      return oauth.accessToken;
    }

    // Update credentials file
    const updatedCreds: CredentialsFile = {
      ...creds,
      claudeAiOauth: {
        ...oauth,
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expiresAt: Date.now() + (expiresIn ? expiresIn * 1000 : 8 * 60 * 60 * 1000),
      },
    };
    writeCredentials(updatedCreds);
    logger.info('OAuth token refreshed successfully');

    return newAccessToken;
  } catch (err) {
    logger.error({ err }, 'Failed to refresh OAuth token');
    return oauth.accessToken; // return stale token as fallback
  }
}
