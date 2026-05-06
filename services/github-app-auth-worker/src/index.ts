interface Env {
  GITHUB_APP_ID?: string;
  GITHUB_APP_CLIENT_ID: string;
  GITHUB_APP_CLIENT_SECRET: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEB_CALLBACK_URL?: string;
  GITHUB_APP_NATIVE_CALLBACK_URL?: string;
}

const DEFAULT_NATIVE_CALLBACK_URL = 'clawdex://github/callback';
const GITHUB_API_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    if (request.method === 'GET' && url.pathname === '/github/callback') {
      return handleCallback(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/github/exchange') {
      return handleExchange(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/github/refresh') {
      return handleRefresh(request, env);
    }
    if (request.method === 'POST' && url.pathname === '/api/github/installations/token') {
      return handleInstallationToken(request, env);
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return jsonResponse(
        {
          ok: true,
        },
        200,
        request
      );
    }

    return jsonResponse(
      {
        error: 'not_found',
        message: 'Route not found.',
      },
      404,
      request
    );
  },
};

async function handleExchange(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const code = readRequiredString(body, 'code');
  if (!code) {
    return jsonResponse(
      {
        error: 'invalid_request',
        message: 'Missing code.',
      },
      400,
      request
    );
  }

  const callbackUrl = resolveCallbackUrl(request, env);
  if (!callbackUrl) {
    return jsonResponse(
      {
        error: 'server_misconfigured',
        message: 'GitHub callback URL is not configured.',
      },
      500,
      request
    );
  }

  const form = new URLSearchParams();
  form.set('client_id', env.GITHUB_APP_CLIENT_ID);
  form.set('client_secret', env.GITHUB_APP_CLIENT_SECRET);
  form.set('code', code);
  form.set('redirect_uri', callbackUrl);

  return await forwardTokenRequest(request, form);
}

async function handleRefresh(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const refreshToken = readRequiredString(body, 'refreshToken');
  if (!refreshToken) {
    return jsonResponse(
      {
        error: 'invalid_request',
        message: 'Missing refreshToken.',
      },
      400,
      request
    );
  }

  const form = new URLSearchParams();
  form.set('client_id', env.GITHUB_APP_CLIENT_ID);
  form.set('client_secret', env.GITHUB_APP_CLIENT_SECRET);
  form.set('grant_type', 'refresh_token');
  form.set('refresh_token', refreshToken);

  return await forwardTokenRequest(request, form);
}

async function handleInstallationToken(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  const userAccessToken = readRequiredString(body, 'userAccessToken');
  const installationId = readRequiredNumber(body, 'installationId');
  const requestedRepositories = readStringArray(body, 'repositories');

  if (!userAccessToken) {
    return jsonResponse(
      {
        error: 'invalid_request',
        message: 'Missing userAccessToken.',
      },
      400,
      request
    );
  }
  if (!installationId || installationId <= 0) {
    return jsonResponse(
      {
        error: 'invalid_request',
        message: 'Missing installationId.',
      },
      400,
      request
    );
  }

  const repositories = normalizeRepositoryFullNames(requestedRepositories);
  if (repositories.length === 0) {
    return jsonResponse(
      {
        error: 'invalid_request',
        message: 'At least one owner/repository value is required.',
      },
      400,
      request
    );
  }

  const accessibleRepositories = await fetchInstallationRepositoriesForUser(
    request,
    userAccessToken,
    installationId
  );
  if (accessibleRepositories instanceof Response) {
    return accessibleRepositories;
  }

  const accessibleByFullName = new Set(
    accessibleRepositories.map((repository) => repository.fullName.toLowerCase())
  );
  const unauthorizedRepository = repositories.find(
    (repository) => !accessibleByFullName.has(repository.fullName.toLowerCase())
  );
  if (unauthorizedRepository) {
    return jsonResponse(
      {
        error: 'repository_not_accessible',
        message: `GitHub App installation does not expose ${unauthorizedRepository.fullName} to this user.`,
      },
      403,
      request
    );
  }

  const jwt = await createGitHubAppJwt(request, env);
  if (jwt instanceof Response) {
    return jwt;
  }

  const response = await fetch(
    `https://api.github.com/app/installations/${String(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: GITHUB_API_ACCEPT,
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      },
      body: JSON.stringify({
        repositories: repositories.map((repository) => repository.name),
      }),
    }
  );
  const payload = await readJsonResponse(response);
  if (!response.ok) {
    return jsonResponse(
      {
        error: 'github_request_failed',
        message:
          readGitHubErrorMessage(payload) ??
          `GitHub installation token request failed (${response.status}).`,
      },
      response.status,
      request
    );
  }

  const record = asRecord(payload);
  const accessToken = readRequiredString(record, 'token');
  if (!accessToken) {
    return jsonResponse(
      {
        error: 'invalid_github_response',
        message: 'GitHub did not return an installation access token.',
      },
      502,
      request
    );
  }

  const grantedRepositories = readRepositoryFullNames(record, 'repositories');
  return jsonResponse(
    {
      access_token: accessToken,
      token_type: 'bearer',
      expires_at: readOptionalString(record, 'expires_at'),
      installation_id: installationId,
      repositories:
        grantedRepositories.length > 0
          ? grantedRepositories
          : repositories.map((repository) => repository.fullName),
    },
    200,
    request
  );
}

async function forwardTokenRequest(request: Request, form: URLSearchParams): Promise<Response> {
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  });

  const payload = await readJsonResponse(response);
  if (!response.ok) {
    return jsonResponse(
      {
        error: 'github_request_failed',
        message: readGitHubErrorMessage(payload) ?? `GitHub token request failed (${response.status}).`,
      },
      response.status,
      request
    );
  }

  const record = asRecord(payload);
  const accessToken = readRequiredString(record, 'access_token');
  if (!accessToken) {
    return jsonResponse(
      {
        error: 'invalid_github_response',
        message: readGitHubErrorMessage(payload) ?? 'GitHub did not return an access token.',
      },
      502,
      request
    );
  }

  return jsonResponse(
    {
      access_token: accessToken,
      token_type: readOptionalString(record, 'token_type') ?? 'bearer',
      scope: readOptionalString(record, 'scope') ?? '',
      refresh_token: readOptionalString(record, 'refresh_token'),
      expires_in: readOptionalNumber(record, 'expires_in'),
      refresh_token_expires_in: readOptionalNumber(record, 'refresh_token_expires_in'),
    },
    200,
    request
  );
}

async function fetchInstallationRepositoriesForUser(
  request: Request,
  userAccessToken: string,
  installationId: number
): Promise<{ fullName: string; name: string }[] | Response> {
  const repositories: { fullName: string; name: string }[] = [];
  let page = 1;

  while (page <= 10) {
    const response = await fetch(
      `https://api.github.com/user/installations/${String(
        installationId
      )}/repositories?per_page=100&page=${String(page)}`,
      {
        headers: {
          Accept: GITHUB_API_ACCEPT,
          Authorization: `Bearer ${userAccessToken}`,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
        },
      }
    );
    const payload = await readJsonResponse(response);
    if (!response.ok) {
      return jsonResponse(
        {
          error: 'github_request_failed',
          message:
            readGitHubErrorMessage(payload) ??
            `GitHub installation repository lookup failed (${response.status}).`,
        },
        response.status,
        request
      );
    }

    const record = asRecord(payload);
    const pageRepositories = Array.isArray(record?.repositories)
      ? record.repositories
          .map((entry) => {
            const repository = asRecord(entry);
            const fullName = readOptionalString(repository, 'full_name');
            const name = readOptionalString(repository, 'name');
            return fullName && name ? { fullName, name } : null;
          })
          .filter((entry): entry is { fullName: string; name: string } => entry !== null)
      : [];
    repositories.push(...pageRepositories);

    if (pageRepositories.length < 100) {
      break;
    }
    page += 1;
  }

  return repositories;
}

async function createGitHubAppJwt(request: Request, env: Env): Promise<string | Response> {
  const appId = readEnvString(env.GITHUB_APP_ID);
  const privateKeyPem = readEnvString(env.GITHUB_APP_PRIVATE_KEY);
  if (!appId || !privateKeyPem) {
    return jsonResponse(
      {
        error: 'server_misconfigured',
        message: 'GitHub App ID and private key are required for installation tokens.',
      },
      500,
      request
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64UrlBytes(new Uint8Array(signature))}`;
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  const normalizedPem = privateKeyPem.replace(/\\n/g, '\n').trim();
  const isPkcs1 = normalizedPem.includes('BEGIN RSA PRIVATE KEY');
  const bytes = isPkcs1
    ? wrapPkcs1RsaPrivateKey(asDerBytes(normalizedPem))
    : asDerBytes(normalizedPem);

  return crypto.subtle.importKey(
    'pkcs8',
    toArrayBuffer(bytes),
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
    },
    false,
    ['sign']
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function asDerBytes(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function wrapPkcs1RsaPrivateKey(pkcs1: Uint8Array): Uint8Array {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const rsaEncryptionAlgorithm = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const privateKey = derEncode(0x04, pkcs1);
  return derEncode(0x30, concatBytes(version, rsaEncryptionAlgorithm, privateKey));
}

function derEncode(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(new Uint8Array([tag]), derLength(value.length), value);
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  parts.forEach((part) => {
    output.set(part, offset);
    offset += part.length;
  });
  return output;
}

function base64UrlJson(value: unknown): string {
  return base64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function handleCallback(request: Request, env: Env): Response {
  const callbackUrl = new URL(request.url);
  const appCallbackUrl = resolveNativeCallbackUrl(env);
  const deepLink = new URL(appCallbackUrl);
  deepLink.search = callbackUrl.search;
  deepLink.hash = callbackUrl.hash;

  const escapedDeepLink = escapeHtml(deepLink.toString());
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Return to Clawdex</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #090b10;
        --panel: rgba(255, 255, 255, 0.08);
        --border: rgba(255, 255, 255, 0.12);
        --text: #f4f7fb;
        --muted: rgba(244, 247, 251, 0.7);
        --accent: #ffffff;
        --accentText: #05070b;
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top, rgba(140, 160, 185, 0.18), transparent 42%),
          var(--bg);
        color: var(--text);
        font: 16px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif;
      }
      main {
        width: min(92vw, 420px);
        padding: 28px 24px;
        border-radius: 24px;
        background: var(--panel);
        border: 1px solid var(--border);
        backdrop-filter: blur(16px);
        box-shadow: 0 18px 80px rgba(0, 0, 0, 0.32);
      }
      h1 {
        margin: 0 0 10px;
        font-size: 26px;
        line-height: 1.15;
      }
      p {
        margin: 0;
        color: var(--muted);
      }
      a {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 20px;
        padding: 13px 16px;
        width: 100%;
        border-radius: 16px;
        background: var(--accent);
        color: var(--accentText);
        text-decoration: none;
        font-weight: 600;
      }
      code {
        display: block;
        margin-top: 16px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.06);
        color: var(--muted);
        word-break: break-all;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Returning to Clawdex…</h1>
      <p>If the app does not reopen automatically, use the button below.</p>
      <a href="${escapedDeepLink}">Open Clawdex</a>
      <code>${escapedDeepLink}</code>
    </main>
    <script>
      window.location.replace(${JSON.stringify(deepLink.toString())});
      setTimeout(function () {
        window.location.href = ${JSON.stringify(deepLink.toString())};
      }, 250);
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function resolveCallbackUrl(request: Request, env: Env): string | null {
  const configured = normalizeUrl(env.GITHUB_APP_WEB_CALLBACK_URL);
  if (configured) {
    return configured;
  }
  return new URL('/github/callback', request.url).toString();
}

function resolveNativeCallbackUrl(env: Env): string {
  return normalizeUrl(env.GITHUB_APP_NATIVE_CALLBACK_URL) ?? DEFAULT_NATIVE_CALLBACK_URL;
}

function normalizeUrl(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function jsonResponse(body: unknown, status: number, request: Request): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(await request.json());
  } catch {
    return null;
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function readGitHubErrorMessage(value: unknown): string | null {
  const record = asRecord(value);
  return readOptionalString(record, 'error_description') ?? readOptionalString(record, 'message');
}

function readRequiredString(record: Record<string, unknown> | null, key: string): string | null {
  return readOptionalString(record, key);
}

function readRequiredNumber(record: Record<string, unknown> | null, key: string): number | null {
  return readOptionalNumber(record, key);
}

function readOptionalString(record: Record<string, unknown> | null, key: string): string | null {
  if (!record || typeof record[key] !== 'string') {
    return null;
  }
  const trimmed = record[key].trim();
  return trimmed ? trimmed : null;
}

function readOptionalNumber(record: Record<string, unknown> | null, key: string): number | null {
  if (!record || typeof record[key] !== 'number' || !Number.isFinite(record[key])) {
    return null;
  }
  return record[key];
}

function readStringArray(record: Record<string, unknown> | null, key: string): string[] {
  if (!record || !Array.isArray(record[key])) {
    return [];
  }

  return record[key].filter((entry): entry is string => typeof entry === 'string');
}

function readRepositoryFullNames(record: Record<string, unknown> | null, key: string): string[] {
  if (!record || !Array.isArray(record[key])) {
    return [];
  }

  return record[key]
    .map((entry) => readOptionalString(asRecord(entry), 'full_name'))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeRepositoryFullNames(
  values: string[]
): { fullName: string; name: string }[] {
  const seen = new Set<string>();
  const repositories: { fullName: string; name: string }[] = [];

  values.forEach((value) => {
    const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
    const [owner, name, extra] = trimmed.split('/');
    if (!owner || !name || extra) {
      return;
    }

    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    repositories.push({
      fullName: `${owner}/${name}`,
      name,
    });
  });

  return repositories.sort((left, right) =>
    left.fullName.toLowerCase().localeCompare(right.fullName.toLowerCase())
  );
}

function readEnvString(value: string | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
