import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import {
  addApprovedClient,
  createOAuthState,
  fetchUpstreamAuthToken,
  generateCSRFProtection,
  getUpstreamAuthorizeUrl,
  isClientApproved,
  OAuthError,
  type Props,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

export interface Env {
  OAUTH_KV: KVNamespace;
  CORPUS_INDEX_COORDINATOR: DurableObjectNamespace;
  INDEX_ADMIN_TOKEN?: string;
  OAUTH_PROVIDER: OAuthHelpers;

  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
  ACCESS_TOKEN_URL: string;
  ACCESS_AUTHORIZATION_URL: string;
  ACCESS_JWKS_URL: string;
  COOKIE_ENCRYPTION_KEY: string;
}

type EnvWithOauth = Env & {
  OAUTH_PROVIDER: OAuthHelpers;
};

export async function handleAccessRequest(
  request: Request,
  env: EnvWithOauth,
  _ctx: ExecutionContext,
): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);

  if (request.method === "GET" && pathname === "/") {
    return new Response(
      [
        "ADD Regulations MCP is running.",
        "",
        "Organization: 국방과학연구소",
        "ALIO ID: C0345",
        "Mode: Latest regulation only",
        "HWPX text extraction: ON",
        "OAuth protection: ON",
        "MCP endpoint: /mcp",
        "",
        "Tools:",
        "- hello",
        "- list_regulations",
        "- search_regulations",
        "- get_regulation",
        "- get_regulation_text",
        "- search_regulation_text",
      ].join("\n"),
      {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      },
    );
  }

  if (request.method === "GET" && pathname === "/health") {
    return Response.json({
      ok: true,
      organization: "국방과학연구소",
      alioId: "C0345",
      latestOnly: true,
      hwpxTextExtraction: true,
      oauthProtection: true,
      mcpEndpoint: "/mcp",
    });
  }

  if (request.method === "GET" && pathname === "/authorize") {
    let oauthReqInfo: AuthRequest;

    try {
      oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error: any) {
      const description =
        error?.description ??
        error?.message ??
        "Invalid OAuth authorization request";

      if (!error?.redirectUri) {
        return new Response(description, { status: 400 });
      }

      const redirect = new URL(error.redirectUri);
      redirect.searchParams.set("error", error.code ?? "invalid_request");
      redirect.searchParams.set("error_description", description);

      if (error.state) {
        redirect.searchParams.set("state", error.state);
      }

      if (error.issuer) {
        redirect.searchParams.set("iss", error.issuer);
      }

      return Response.redirect(redirect.toString(), 302);
    }

    const { clientId } = oauthReqInfo;

    if (!clientId) {
      return new Response("Invalid request", { status: 400 });
    }

    if (
      await isClientApproved(
        request,
        clientId,
        env.COOKIE_ENCRYPTION_KEY,
      )
    ) {
      const { stateToken, codeChallenge } = await createOAuthState(
        oauthReqInfo,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );

      return redirectToAccess(
        request,
        env,
        stateToken,
        codeChallenge,
      );
    }

    const { token: csrfToken, setCookie } =
      generateCSRFProtection();

    return renderApprovalDialog(request, {
      client: await env.OAUTH_PROVIDER.lookupClient(clientId),
      csrfToken,
      server: {
        name: "ADD Regulations MCP",
        description:
          "국방과학연구소(ALIO C0345) 최신 내부규정을 조회하는 개인용 MCP 서버입니다.",
      },
      setCookie,
      state: { oauthReqInfo },
    });
  }

  if (request.method === "POST" && pathname === "/authorize") {
    try {
      const formData = await request.formData();
      const csrfResult = validateCSRFToken(formData, request);

      const encodedState = formData.get("state");

      if (!encodedState || typeof encodedState !== "string") {
        return new Response("Missing state in form data", {
          status: 400,
        });
      }

      let state: { oauthReqInfo?: AuthRequest };

      try {
        state = JSON.parse(atob(encodedState));
      } catch {
        return new Response("Invalid state data", { status: 400 });
      }

      if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
        return new Response("Invalid request", { status: 400 });
      }

      const approvedClientCookie = await addApprovedClient(
        request,
        state.oauthReqInfo.clientId,
        env.COOKIE_ENCRYPTION_KEY,
      );

      const { stateToken, codeChallenge } = await createOAuthState(
        state.oauthReqInfo,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );

      const redirectHeaders = new Headers();
      redirectHeaders.append(
        "Set-Cookie",
        approvedClientCookie,
      );
      redirectHeaders.append(
        "Set-Cookie",
        csrfResult.clearCookie,
      );

      return redirectToAccess(
        request,
        env,
        stateToken,
        codeChallenge,
        redirectHeaders,
      );
    } catch (error: any) {
      console.error("POST /authorize error:", error);

      if (error instanceof OAuthError) {
        return error.toResponse();
      }

      return new Response(
        `Internal server error: ${error?.message ?? String(error)}`,
        { status: 500 },
      );
    }
  }

  if (request.method === "GET" && pathname === "/callback") {
    let oauthReqInfo: AuthRequest;
    let codeVerifier: string;

    try {
      const result = await validateOAuthState(
        request,
        env.OAUTH_KV,
        env.COOKIE_ENCRYPTION_KEY,
      );

      oauthReqInfo = result.oauthReqInfo;
      codeVerifier = result.codeVerifier;
    } catch (error: any) {
      if (error instanceof OAuthError) {
        return error.toResponse();
      }

      return new Response("Internal server error", {
        status: 500,
      });
    }

    if (!oauthReqInfo.clientId) {
      return new Response("Invalid OAuth request data", {
        status: 400,
      });
    }

    const [accessToken, idToken, errResponse] =
      await fetchUpstreamAuthToken({
        client_id: env.ACCESS_CLIENT_ID,
        client_secret: env.ACCESS_CLIENT_SECRET,
        code: searchParams.get("code") ?? undefined,
        redirect_uri: new URL("/callback", request.url).href,
        upstream_url: env.ACCESS_TOKEN_URL,
        code_verifier: codeVerifier,
      });

    if (errResponse) {
      return errResponse;
    }

    const idTokenClaims = await verifyToken(env, idToken);

    const user = {
      email:
        typeof idTokenClaims.email === "string"
          ? idTokenClaims.email
          : "",
      name:
        typeof idTokenClaims.name === "string"
          ? idTokenClaims.name
          : typeof idTokenClaims.email === "string"
            ? idTokenClaims.email
            : "ADD Regulations user",
      sub:
        typeof idTokenClaims.sub === "string"
          ? idTokenClaims.sub
          : "",
    };

    if (!user.sub || !user.email) {
      return new Response(
        "Cloudflare Access identity did not include email/sub.",
        { status: 403 },
      );
    }

    const { redirectTo } =
      await env.OAUTH_PROVIDER.completeAuthorization({
        metadata: {
          label: user.name,
        },
        props: {
          accessToken,
          email: user.email,
          login: user.sub,
          name: user.name,
        } as Props,
        request: oauthReqInfo,
        scope: oauthReqInfo.scope,
        userId: user.sub,
      });

    return Response.redirect(redirectTo, 302);
  }

  return new Response("Not Found", { status: 404 });
}

async function redirectToAccess(
  request: Request,
  env: Env,
  stateToken: string,
  codeChallenge: string,
  extraHeaders: Headers = new Headers(),
): Promise<Response> {
  const headers = new Headers(extraHeaders);

  headers.set(
    "location",
    getUpstreamAuthorizeUrl({
      client_id: env.ACCESS_CLIENT_ID,
      code_challenge: codeChallenge,
      redirect_uri: new URL("/callback", request.url).href,
      scope: "openid email profile",
      state: stateToken,
      upstream_url: env.ACCESS_AUTHORIZATION_URL,
    }),
  );

  return new Response(null, {
    headers,
    status: 302,
  });
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded =
    normalized +
    "=".repeat((4 - (normalized.length % 4)) % 4);

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function parseJWT(token: string) {
  const tokenParts = token.split(".");

  if (tokenParts.length !== 3) {
    throw new Error("token must have 3 parts");
  }

  const header = JSON.parse(
    new TextDecoder().decode(
      base64UrlToBytes(tokenParts[0]),
    ),
  );

  const payload = JSON.parse(
    new TextDecoder().decode(
      base64UrlToBytes(tokenParts[1]),
    ),
  );

  return {
    data: `${tokenParts[0]}.${tokenParts[1]}`,
    header,
    payload,
    signature: tokenParts[2],
  };
}

async function fetchAccessPublicKey(
  env: Env,
  kid: string,
): Promise<CryptoKey> {
  if (!env.ACCESS_JWKS_URL) {
    throw new Error("ACCESS_JWKS_URL is not configured");
  }

  const resp = await fetch(env.ACCESS_JWKS_URL);

  if (!resp.ok) {
    throw new Error(
      `Failed to fetch Access JWKS: HTTP ${resp.status}`,
    );
  }

  const keys = (await resp.json()) as {
    keys: (JsonWebKey & { kid: string })[];
  };

  const jwk = keys.keys.find((key) => key.kid === kid);

  if (!jwk) {
    throw new Error("Matching Access signing key not found");
  }

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      hash: "SHA-256",
      name: "RSASSA-PKCS1-v1_5",
    },
    false,
    ["verify"],
  );
}

async function verifyToken(
  env: Env,
  token: string,
): Promise<Record<string, any>> {
  const jwt = parseJWT(token);

  if (!jwt.header?.kid) {
    throw new Error("ID token has no kid");
  }

  const key = await fetchAccessPublicKey(
    env,
    jwt.header.kid,
  );

  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(jwt.signature),
    new TextEncoder().encode(jwt.data),
  );

  if (!verified) {
    throw new Error("failed to verify token");
  }

  const claims = jwt.payload as Record<string, any>;
  const now = Math.floor(Date.now() / 1000);

  if (
    typeof claims.exp !== "number" ||
    claims.exp < now
  ) {
    throw new Error("expired token");
  }

  const audience = claims.aud;

  if (
    typeof audience === "string" &&
    audience !== env.ACCESS_CLIENT_ID
  ) {
    throw new Error("unexpected token audience");
  }

  if (
    Array.isArray(audience) &&
    !audience.includes(env.ACCESS_CLIENT_ID)
  ) {
    throw new Error("unexpected token audience");
  }

  return claims;
}

