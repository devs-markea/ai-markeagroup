import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Meta Graph API client (Facebook Pages + Instagram via Facebook Login)
//
// Auth: a Business portfolio System User token (META_SYSTEM_USER_TOKEN) with
// the Pages/Instagram assets assigned. Page-level calls use the Page access
// token derived from it. Every call carries appsecret_proof, so a leaked token
// is useless without META_APP_SECRET.
// ---------------------------------------------------------------------------

const GRAPH_HOST = "https://graph.facebook.com";

function graphBase(): string {
  const version = process.env.META_GRAPH_VERSION || "v24.0";
  return `${GRAPH_HOST}/${version}`;
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function appSecretProof(token: string): string {
  return createHmac("sha256", env("META_APP_SECRET")).update(token).digest("hex");
}

/**
 * Graph object IDs: numeric, optionally joined by "_" (e.g. "{page}_{post}").
 * IDs are interpolated into the URL path, so anything else (slashes, "?",
 * "me", edge names…) would let a caller reach other endpoints with our token.
 */
export const GRAPH_ID = /^\d+(_\d+)*$/;

export function assertGraphId(id: string, label = "id"): string {
  if (!GRAPH_ID.test(id)) throw new Error(`Invalid ${label} "${id}": expected a numeric Graph API ID`);
  return id;
}

type Params = Record<string, string | number | boolean | undefined>;

interface GraphError {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number; fbtrace_id?: string };
}

async function graphRequest<T>(
  method: "GET" | "POST",
  path: string,
  token: string,
  params: Params = {}
): Promise<T> {
  const url = new URL(`${graphBase()}/${path}`);
  const body = new URLSearchParams();
  const target = method === "GET" ? url.searchParams : body;

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) target.set(key, String(value));
  }
  target.set("access_token", token);
  target.set("appsecret_proof", appSecretProof(token));

  const res = await fetch(url, {
    method,
    ...(method === "POST" ? { body, headers: { "Content-Type": "application/x-www-form-urlencoded" } } : {}),
  });

  const data = (await res.json().catch(() => ({}))) as T & GraphError;
  if (!res.ok || data.error) {
    // Never include the URL: it carries the access token.
    const e = data.error ?? {};
    const code = [e.code, e.error_subcode].filter((c) => c !== undefined).join("/");
    throw new Error(`Meta ${res.status}${code ? ` (code ${code})` : ""}: ${e.message ?? res.statusText}`);
  }
  return data;
}

export const graphGet = <T>(path: string, token: string, params?: Params) =>
  graphRequest<T>("GET", path, token, params);

export const graphPost = <T>(path: string, token: string, params?: Params) =>
  graphRequest<T>("POST", path, token, params);

export function systemUserToken(): string {
  return env("META_SYSTEM_USER_TOKEN");
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface PageAccount {
  id: string;
  name: string;
  category?: string;
  instagram_business_account?: { id: string; username?: string };
}

/** Pages assigned to the System User, with their linked Instagram account. */
export async function listPages(): Promise<PageAccount[]> {
  const res = await graphGet<{ data: PageAccount[] }>("me/accounts", systemUserToken(), {
    fields: "id,name,category,instagram_business_account{id,username}",
    limit: 100,
  });
  return res.data;
}

export interface PageContext {
  pageId: string;
  pageName: string;
  pageToken: string;
  instagram?: { id: string; username?: string };
}

/**
 * Page access token + linked Instagram account for a Page. Meta only returns
 * them for Pages assigned to the System User, which is the access boundary.
 */
export async function pageContext(pageId: string): Promise<PageContext> {
  const page = await graphGet<{
    id: string;
    name: string;
    access_token?: string;
    instagram_business_account?: { id: string; username?: string };
  }>(assertGraphId(pageId, "page_id"), systemUserToken(), {
    fields: "id,name,access_token,instagram_business_account{id,username}",
  });
  if (!page.access_token) {
    throw new Error(`No access to page ${pageId}: assign it to the System User with the required permissions`);
  }
  return {
    pageId: page.id,
    pageName: page.name,
    pageToken: page.access_token,
    instagram: page.instagram_business_account,
  };
}

export function requireInstagram(ctx: PageContext): { id: string; username?: string } {
  if (!ctx.instagram) {
    throw new Error(`Page "${ctx.pageName}" has no linked Instagram professional account`);
  }
  return ctx.instagram;
}

/**
 * Confirm a Facebook post actually belongs to this Page before acting on it.
 *
 * Do NOT do this by string-matching the id against "{pageId}_" — Meta does not
 * guarantee that prefix format (newer API versions, and ad-only/"promotable"
 * posts in particular, can return a bare numeric post id with no page prefix
 * at all). Always verify the post's own `from.id` against the Graph API instead.
 */
export async function verifyPageOwnsPost(postId: string, pageToken: string, pageId: string): Promise<void> {
  const post = await graphGet<{ from?: { id: string } }>(assertGraphId(postId, "post_id"), pageToken, {
    fields: "from",
  });
  if (post.from?.id !== pageId) {
    throw new Error(`Post ${postId} does not belong to page ${pageId} (owner: ${post.from?.id ?? "unknown"})`);
  }
}

/**
 * Resolve a public Facebook/Instagram permalink to its Graph object id, using
 * Meta's URL-to-object lookup (GET /?id=<url>). Only works for posts with a
 * public permalink — unpublished ("dark") ad posts don't have one; use
 * resolveAdToPostId for those.
 */
export async function resolveUrlToId(url: string): Promise<{ id: string }> {
  return graphGet<{ id: string }>("", systemUserToken(), { id: url });
}

/**
 * Resolve an ad to the post it promotes (its effective_object_story_id), which
 * covers unpublished "dark" posts that have no public permalink. Requires the
 * ads_read permission and the ad account assigned to the System User — NOT
 * part of the Phase 1 (comments-only) permission set. Fails with a clear error
 * until that's granted.
 */
export async function resolveAdToPostId(adId: string): Promise<string> {
  const res = await graphGet<{ creative?: { effective_object_story_id?: string } }>(
    assertGraphId(adId, "ad_id"),
    systemUserToken(),
    { fields: "creative{effective_object_story_id}" }
  );
  const storyId = res.creative?.effective_object_story_id;
  if (!storyId) throw new Error(`Ad ${adId} has no resolvable post (effective_object_story_id missing)`);
  return storyId;
}
