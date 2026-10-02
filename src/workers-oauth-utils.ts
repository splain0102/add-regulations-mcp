// OAuth utility functions adapted from Cloudflare's remote-mcp-cf-access example.

import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";

export class OAuthError extends Error {
  constructor(
    public code: string,
    public description: string,
    public statusCode = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }

  toResponse(): Response {
    return new Response(
      JSON.stringify({
        error: this.code,
        error_description: this.description,
      }),
      {
        status: this.statusCode,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

export interface OAuthStateResult {
  stateToken: string;
  codeChallenge: string;
}

export interface ValidateStateResult {
  oauthReqInfo: AuthRequest;
  codeVerifier: string;
}

export interface CSRFProtectionResult {
  token: string;
  setCookie: string;
}

export interface ValidateCSRFResult {
  clearCookie: string;
}

export function sanitizeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function sanitizeUrl(url: string): string {
  const normalized = url.trim();
  if (normalized.length === 0) return "";

  for (let i = 0; i < normalized.length; i++) {
    const code = normalized.charCodeAt(i);
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      return "";
    }
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalized);
  } catch {
    return "";
  }

  const scheme = parsedUrl.protocol.slice(0, -1).toLowerCase();
  if (!["https", "http"].includes(scheme)) return "";

  return normalized;
}

export function generateCSRFProtection(): CSRFProtectionResult {
  const csrfCookieName = "__Host-CSRF_TOKEN";
  const token = crypto.randomUUID();
  const setCookie =
    `${csrfCookieName}=${token}; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=600`;
  return { token, setCookie };
}

export function validateCSRFToken(
  formData: FormData,
  request: Request,
): ValidateCSRFResult {
  const csrfCookieName = "__Host-CSRF_TOKEN";
  const tokenFromForm = formData.get("csrf_token");

  if (!tokenFromForm || typeof tokenFromForm !== "string") {
    throw new OAuthError("invalid_request", "Missing CSRF token in form data", 400);
  }

  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const csrfCookie = cookies.find((c) => c.startsWith(`${csrfCookieName}=`));
  const tokenFromCookie = csrfCookie
    ? csrfCookie.substring(csrfCookieName.length + 1)
    : null;

  if (!tokenFromCookie) {
    throw new OAuthError("invalid_request", "Missing CSRF token cookie", 400);
  }

  if (tokenFromForm !== tokenFromCookie) {
    throw new OAuthError("invalid_request", "CSRF token mismatch", 400);
  }

  const clearCookie =
    `${csrfCookieName}=; HttpOnly; Secure; Path=/; SameSite=Lax; Max-Age=0`;

  return { clearCookie };
}

export async function createOAuthState(
  oauthReqInfo: AuthRequest,
  kv: KVNamespace,
  secret: string,
  stateTTL = 600,
): Promise<OAuthStateResult> {
  const uuid = crypto.randomUUID();
  const { codeVerifier, codeChallenge } = await generatePKCE();

  const hmac = await signData(uuid, secret);
  const stateToken = `${uuid}.${hmac}`;

  await kv.put(
    `oauth:state:${uuid}`,
    JSON.stringify({ oauthReqInfo, codeVerifier }),
    { expirationTtl: stateTTL },
  );

  return { stateToken, codeChallenge };
}

export async function validateOAuthState(
  request: Request,
  kv: KVNamespace,
  secret: string,
): Promise<ValidateStateResult> {
  const url = new URL(request.url);
  const stateFromQuery = url.searchParams.get("state");

  if (!stateFromQuery) {
    throw new OAuthError("invalid_request", "Missing state parameter", 400);
  }

  const dotIndex = stateFromQuery.lastIndexOf(".");
  if (dotIndex === -1) {
    throw new OAuthError("invalid_request", "Invalid state format", 400);
  }

  const uuid = stateFromQuery.substring(0, dotIndex);
  const hmac = stateFromQuery.substring(dotIndex + 1);

  const isValid = await verifySignature(hmac, uuid, secret);
  if (!isValid) {
    throw new OAuthError("invalid_request", "Invalid state signature", 400);
  }

  const storedDataJson = await kv.get(`oauth:state:${uuid}`);
  if (!storedDataJson) {
    throw new OAuthError("invalid_request", "Invalid or expired state", 400);
  }

  let stored: { oauthReqInfo: AuthRequest; codeVerifier: string };
  try {
    stored = JSON.parse(storedDataJson) as {
      oauthReqInfo: AuthRequest;
      codeVerifier: string;
    };
  } catch {
    throw new OAuthError("server_error", "Invalid state data", 500);
  }

  await kv.delete(`oauth:state:${uuid}`);
  return {
    oauthReqInfo: stored.oauthReqInfo,
    codeVerifier: stored.codeVerifier,
  };
}

export async function isClientApproved(
  request: Request,
  clientId: string,
  cookieSecret: string,
): Promise<boolean> {
  const approvedClients = await getApprovedClientsFromCookie(
    request,
    cookieSecret,
  );
  return approvedClients?.includes(clientId) ?? false;
}

export async function addApprovedClient(
  request: Request,
  clientId: string,
  cookieSecret: string,
): Promise<string> {
  const approvedClientsCookieName = "__Host-APPROVED_CLIENTS";
  const THIRTY_DAYS_IN_SECONDS = 2592000;

  const existingApprovedClients =
    (await getApprovedClientsFromCookie(request, cookieSecret)) || [];

  const updatedApprovedClients = Array.from(
    new Set([...existingApprovedClients, clientId]),
  );

  const payload = JSON.stringify(updatedApprovedClients);
  const signature = await signData(payload, cookieSecret);
  const cookieValue = `${signature}.${btoa(payload)}`;

  return (
    `${approvedClientsCookieName}=${cookieValue}; HttpOnly; Secure; Path=/; ` +
    `SameSite=Lax; Max-Age=${THIRTY_DAYS_IN_SECONDS}`
  );
}

export interface ApprovalDialogOptions {
  client: ClientInfo | null;
  server: {
    name: string;
    logo?: string;
    description?: string;
  };
  state: Record<string, any>;
  csrfToken: string;
  setCookie: string;
}

export function renderApprovalDialog(
  request: Request,
  options: ApprovalDialogOptions,
): Response {
  const { client, server, state, csrfToken, setCookie } = options;
  const encodedState = btoa(JSON.stringify(state));

  const serverName = sanitizeText(server.name);
  const clientName = client?.clientName
    ? sanitizeText(client.clientName)
    : "Unknown MCP Client";
  const serverDescription = server.description
    ? sanitizeText(server.description)
    : "";

  const logoUrl = server.logo
    ? sanitizeText(sanitizeUrl(server.logo))
    : "";
  const clientUri = client?.clientUri
    ? sanitizeText(sanitizeUrl(client.clientUri))
    : "";
  const policyUri = client?.policyUri
    ? sanitizeText(sanitizeUrl(client.policyUri))
    : "";
  const tosUri = client?.tosUri
    ? sanitizeText(sanitizeUrl(client.tosUri))
    : "";

  const contacts =
    client?.contacts && client.contacts.length > 0
      ? sanitizeText(client.contacts.join(", "))
      : "";

  const redirectUris =
    client?.redirectUris && client.redirectUris.length > 0
      ? client.redirectUris
          .map((uri) => {
            const validated = sanitizeUrl(uri);
            return validated ? sanitizeText(validated) : "";
          })
          .filter((uri) => uri !== "")
      : [];

  const htmlContent = `
<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${clientName} | ADD Regulations MCP</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f9;color:#222;margin:0}
.container{max-width:620px;margin:48px auto;padding:16px}
.card{background:white;border-radius:12px;padding:28px;box-shadow:0 8px 30px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 12px}
h2{font-size:18px;margin-top:24px}
p{line-height:1.6}
.info{border:1px solid #e5e7eb;border-radius:8px;padding:14px;margin:18px 0;word-break:break-all}
.actions{display:flex;gap:10px;justify-content:flex-end;margin-top:24px}
button{padding:10px 18px;border-radius:7px;font-size:15px;cursor:pointer}
.primary{border:0;background:#111827;color:white}
.secondary{border:1px solid #d1d5db;background:white}
.small{font-size:13px;color:#555}
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h1>${serverName}</h1>
    ${serverDescription ? `<p>${serverDescription}</p>` : ""}
    <h2>${clientName}에서 접근을 요청했습니다.</h2>
    <div class="info">
      ${logoUrl ? `<div><img src="${logoUrl}" alt="" width="36"></div>` : ""}
      <div><strong>클라이언트:</strong> ${clientName}</div>
      ${clientUri ? `<div class="small">웹사이트: ${clientUri}</div>` : ""}
      ${policyUri ? `<div class="small">개인정보처리방침: ${policyUri}</div>` : ""}
      ${tosUri ? `<div class="small">이용약관: ${tosUri}</div>` : ""}
      ${contacts ? `<div class="small">연락처: ${contacts}</div>` : ""}
      ${redirectUris.length ? `<div class="small">Redirect URI: ${redirectUris.join("<br>")}</div>` : ""}
    </div>
    <p>승인하면 Cloudflare Access 로그인으로 이동합니다.</p>
    <form method="post" action="${new URL(request.url).pathname}">
      <input type="hidden" name="state" value="${encodedState}">
      <input type="hidden" name="csrf_token" value="${csrfToken}">
      <div class="actions">
        <button type="button" class="secondary" onclick="history.back()">취소</button>
        <button type="submit" class="primary">승인</button>
      </div>
    </form>
  </div>
</div>
</body>
</html>`;

  return new Response(htmlContent, {
    headers: {
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src https:; frame-ancestors 'none'",
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": setCookie,
      "X-Frame-Options": "DENY",
    },
  });
}

async function generatePKCE(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );

  const codeChallenge = btoa(
    String.fromCharCode(...new Uint8Array(digest)),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");

  return { codeVerifier, codeChallenge };
}

async function getApprovedClientsFromCookie(
  request: Request,
  cookieSecret: string,
): Promise<string[] | null> {
  const approvedClientsCookieName = "__Host-APPROVED_CLIENTS";
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  const targetCookie = cookies.find((c) =>
    c.startsWith(`${approvedClientsCookieName}=`),
  );
  if (!targetCookie) return null;

  const cookieValue = targetCookie.substring(
    approvedClientsCookieName.length + 1,
  );
  const parts = cookieValue.split(".");
  if (parts.length !== 2) return null;

  const [signatureHex, base64Payload] = parts;
  const payload = atob(base64Payload);

  const isValid = await verifySignature(
    signatureHex,
    payload,
    cookieSecret,
  );
  if (!isValid) return null;

  try {
    const approvedClients = JSON.parse(payload);
    if (
      !Array.isArray(approvedClients) ||
      !approvedClients.every((item) => typeof item === "string")
    ) {
      return null;
    }
    return approvedClients as string[];
  } catch {
    return null;
  }
}

async function signData(data: string, secret: string): Promise<string> {
  const key = await importKey(secret);
  const signatureBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifySignature(
  signatureHex: string,
  data: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHex || !/^[0-9a-f]+$/i.test(signatureHex)) {
    return false;
  }

  const key = await importKey(secret);
  try {
    const signatureBytes = new Uint8Array(
      signatureHex
        .match(/.{1,2}/g)!
        .map((byte) => Number.parseInt(byte, 16)),
    );

    return await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes.buffer,
      new TextEncoder().encode(data),
    );
  } catch {
    return false;
  }
}

async function importKey(secret: string): Promise<CryptoKey> {
  if (!secret) {
    throw new Error("COOKIE_ENCRYPTION_KEY is required");
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign", "verify"],
  );
}

export function getUpstreamAuthorizeUrl(params: {
  upstream_url: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  state: string;
  code_challenge: string;
  code_challenge_method?: string;
}): string {
  const url = new URL(params.upstream_url);
  url.searchParams.set("client_id", params.client_id);
  url.searchParams.set("redirect_uri", params.redirect_uri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", params.scope);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.code_challenge);
  url.searchParams.set(
    "code_challenge_method",
    params.code_challenge_method ?? "S256",
  );
  return url.toString();
}

export async function fetchUpstreamAuthToken(params: {
  upstream_url: string;
  client_id: string;
  client_secret: string;
  code?: string;
  redirect_uri: string;
  code_verifier: string;
}): Promise<[string, string, null] | [null, null, Response]> {
  if (!params.code) {
    return [
      null,
      null,
      new Response("Missing authorization code", { status: 400 }),
    ];
  }

  const data = new URLSearchParams({
    client_id: params.client_id,
    client_secret: params.client_secret,
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: params.redirect_uri,
    code_verifier: params.code_verifier,
  });

  const response = await fetch(params.upstream_url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: data.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return [
      null,
      null,
      new Response(`Failed to exchange code for token: ${errorText}`, {
        status: response.status,
      }),
    ];
  }

  const body = (await response.json()) as any;
  const accessToken = body.access_token as string;
  const idToken = body.id_token as string;

  if (!accessToken) {
    return [
      null,
      null,
      new Response("Missing access token", { status: 400 }),
    ];
  }

  if (!idToken) {
    return [
      null,
      null,
      new Response("Missing id token", { status: 400 }),
    ];
  }

  return [accessToken, idToken, null];
}

export interface Props {
  accessToken: string;
  email: string;
  login: string;
  name: string;
  [key: string]: unknown;
}
