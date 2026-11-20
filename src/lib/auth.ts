import { createRemoteJWKSet, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { collection, now } from "./mongo";
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";

/**
 * Server-only Pocket ID (OIDC) authentication.
 * Sessions live in MongoDB; the browser only receives an opaque HttpOnly cookie.
 */
export type AuthUser = {
  id: string;
  /** Compatibility alias for older components that read `uid`. */
  uid: string;
  email: string;
  name: string;
  picture?: string;
  groups: string[];
  provider: string;
  createdAt: string;
  updatedAt: string;
};

type UserDoc = {
  _id: string;
  email: string;
  name: string;
  picture?: string;
  groups: string[];
  provider: string;
  createdAt: Date;
  updatedAt: Date;
};

type SessionDoc = {
  _id: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
  lastSeenAt: Date;
  userAgent?: string;
  ip?: string;
};

type OidcStateDoc = {
  _id: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: Date;
  createdAt: Date;
};

type OidcConfiguration = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

const SESSION_COOKIE = "sf_session";
const STATE_COOKIE = "sf_oidc_state";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;

let configPromise: Promise<OidcConfiguration> | undefined;
let jwksPromise: Promise<ReturnType<typeof createRemoteJWKSet>> | undefined;

function issuer(): string {
  const value = process.env.POCKET_ID_ISSUER || process.env.POCKET_ID_URL;
  if (!value) throw new Error("POCKET_ID_ISSUER is not configured");
  return value.replace(/\/+$/, "");
}

function clientId(): string {
  const value = process.env.POCKET_ID_CLIENT_ID;
  if (!value) throw new Error("POCKET_ID_CLIENT_ID is not configured");
  return value;
}

function clientSecret(): string | undefined {
  return process.env.POCKET_ID_CLIENT_SECRET || undefined;
}

export function appUrl(): string {
  return (process.env.APP_URL || process.env.VITE_SITE_URL || "http://localhost:8080").replace(/\/+$/, "");
}

export function redirectUri(): string {
  if (process.env.POCKET_ID_REDIRECT_URI) return process.env.POCKET_ID_REDIRECT_URI;
  return `${appUrl()}/api/auth/callback`;
}

/** `Response.redirect` requires an absolute URL in Node/Nitro. */
export function redirectTo(path: string, status = 302): Response {
  return Response.redirect(new URL(path, appUrl()).toString(), status);
}

function cookieOptions(maxAge: number) {
  return {
    httpOnly: true as const,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

async function getConfig(): Promise<OidcConfiguration> {
  if (!configPromise) {
    configPromise = (async () => {
      const url = `${issuer()}/.well-known/openid-configuration`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
      const cfg = (await res.json()) as OidcConfiguration;
      if (!cfg.authorization_endpoint || !cfg.token_endpoint || !cfg.jwks_uri) {
        throw new Error("OIDC discovery document is incomplete");
      }
      return cfg;
    })().catch((err) => {
      configPromise = undefined;
      throw err;
    });
  }
  return configPromise;
}

function getJwks(cfg: OidcConfiguration) {
  if (!jwksPromise) jwksPromise = Promise.resolve(createRemoteJWKSet(new URL(cfg.jwks_uri)));
  return jwksPromise;
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export async function buildAuthorizationUrl(): Promise<string> {
  const cfg = await getConfig();
  const state = base64url(randomBytes(24));
  const nonce = base64url(randomBytes(24));
  const codeVerifier = base64url(randomBytes(48));
  const redirect = redirectUri();
  const id = base64url(randomBytes(16));

  const states = await collection<OidcStateDoc>("oidc_states");
  await states.insertOne({
    _id: id,
    state,
    nonce,
    codeVerifier,
    redirectUri: redirect,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
    createdAt: now(),
  });

  setCookie(STATE_COOKIE, id, cookieOptions(Math.floor(STATE_TTL_MS / 1000)));

  const url = new URL(cfg.authorization_endpoint);
  url.searchParams.set("client_id", clientId());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("redirect_uri", redirect);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", sha256(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

function toPublicUser(doc: UserDoc): AuthUser {
  return {
    id: doc._id,
    uid: doc._id,
    email: doc.email,
    name: doc.name,
    picture: doc.picture,
    groups: doc.groups ?? [],
    provider: doc.provider,
    createdAt: new Date(doc.createdAt).toISOString(),
    updatedAt: new Date(doc.updatedAt).toISOString(),
  };
}

async function upsertUser(claims: {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
  preferred_username?: string;
  groups?: string[];
}): Promise<AuthUser> {
  const users = await collection<UserDoc>("users");
  const email = claims.email || `${claims.sub}@pocketid.local`;
  const name = claims.name || claims.preferred_username || email.split("@")[0];
  const current = await users.findOne({ _id: claims.sub });
  const timestamp = now();
  const doc: UserDoc = {
    _id: claims.sub,
    email,
    name,
    picture: claims.picture,
    groups: Array.isArray(claims.groups) ? claims.groups : [],
    provider: "pocketid",
    createdAt: current?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  await users.updateOne({ _id: claims.sub }, { $set: doc }, { upsert: true });
  return toPublicUser(doc);
}

async function createSession(userId: string): Promise<string> {
  const token = base64url(randomBytes(48));
  const sessions = await collection<SessionDoc>("auth_sessions");
  await sessions.insertOne({
    _id: token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    createdAt: now(),
    lastSeenAt: now(),
  });
  setCookie(SESSION_COOKIE, token, cookieOptions(Math.floor(SESSION_TTL_MS / 1000)));
  return token;
}

export class AuthError extends Error {}

export async function completeLogin(code: string, state: string): Promise<AuthUser> {
  const stateId = getCookie(STATE_COOKIE);
  if (!stateId) throw new AuthError("Missing OIDC state cookie");
  const states = await collection<OidcStateDoc>("oidc_states");
  const record = await states.findOne({ _id: stateId });
  await states.deleteOne({ _id: stateId });
  deleteCookie(STATE_COOKIE, { path: "/" });

  if (!record || record.state !== state || record.expiresAt.getTime() < Date.now()) {
    throw new AuthError("Invalid or expired OIDC state");
  }

  const cfg = await getConfig();
  const tokenRes = await fetch(cfg.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: record.redirectUri,
      client_id: clientId(),
      code_verifier: record.codeVerifier,
      ...(clientSecret() ? { client_secret: clientSecret()! } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!tokenRes.ok) throw new AuthError(`Token exchange failed: ${tokenRes.status}`);
  const tokens = (await tokenRes.json()) as {
    id_token?: string;
    access_token?: string;
  };
  if (!tokens.id_token) throw new AuthError("No id_token returned by the provider");

  const jwks = await getJwks(cfg);
  const { payload } = await jwtVerify(tokens.id_token, jwks, {
    issuer: cfg.issuer,
    audience: clientId(),
  });
  if (payload.nonce && payload.nonce !== record.nonce) {
    throw new AuthError("OIDC nonce mismatch");
  }
  if (!payload.sub) throw new AuthError("OIDC id_token has no subject");

  let claims: Record<string, unknown> = payload as Record<string, unknown>;
  if (cfg.userinfo_endpoint && tokens.access_token && (!payload.email || !payload.name)) {
    try {
      const infoRes = await fetch(cfg.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (infoRes.ok) claims = { ...claims, ...(await infoRes.json()) };
    } catch {
      // id_token claims are enough
    }
  }

  const user = await upsertUser({
    sub: payload.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    name: typeof claims.name === "string" ? claims.name : undefined,
    picture: typeof claims.picture === "string" ? claims.picture : undefined,
    preferred_username:
      typeof claims.preferred_username === "string" ? claims.preferred_username : undefined,
    groups: Array.isArray(claims.groups) ? (claims.groups as string[]) : [],
  });
  await createSession(user.id);
  return user;
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  const token = getCookie(SESSION_COOKIE);
  if (!token) return null;
  const sessions = await collection<SessionDoc>("auth_sessions");
  const session = await sessions.findOne({ _id: token });
  if (!session || session.expiresAt.getTime() < Date.now()) {
    if (session) await sessions.deleteOne({ _id: token });
    deleteCookie(SESSION_COOKIE, { path: "/" });
    return null;
  }
  const users = await collection<UserDoc>("users");
  const user = await users.findOne({ _id: session.userId });
  if (!user) return null;
  await sessions.updateOne({ _id: token }, { $set: { lastSeenAt: now() } });
  return toPublicUser(user);
}

export async function requireUser(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("Unauthorized");
  return user;
}

export async function logout(): Promise<void> {
  const token = getCookie(SESSION_COOKIE);
  if (token) {
    const sessions = await collection<SessionDoc>("auth_sessions");
    await sessions.deleteOne({ _id: token });
  }
  deleteCookie(SESSION_COOKIE, { path: "/" });
}

export async function getLogoutUrl(): Promise<string | null> {
  try {
    const cfg = await getConfig();
    return cfg.end_session_endpoint ?? null;
  } catch {
    return null;
  }
}
