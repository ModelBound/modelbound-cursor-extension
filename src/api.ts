// Minimal HTTP client for the ModelBound public API used by the VS Code /
// Cursor extension. Mirrors the surface of @modelbound/cli so behavior is
// identical regardless of which interface the user is in.
import * as vscode from "vscode";

const SECRET_KEY = "modelbound.token";

export interface ApiCtx {
  baseUrl: string;
  token?: string;
}

export async function getCtx(secrets: vscode.SecretStorage): Promise<ApiCtx> {
  const cfg = vscode.workspace.getConfiguration("modelbound");
  const globalCfg = vscode.workspace.getConfiguration("modelbound", null);
  const configToken =
    globalCfg.get<string>("apiKey")?.trim() ||
    cfg.get<string>("apiKey")?.trim() ||
    undefined;
  return {
    baseUrl: (cfg.get<string>("apiUrl") || "https://modelbound.co").replace(/\/+$/, ""),
    token: process.env.MODELBOUND_API_KEY?.trim() || configToken || (await secrets.get(SECRET_KEY)) || undefined,
  };
}

export async function setToken(secrets: vscode.SecretStorage, token: string): Promise<void> {
  await secrets.store(SECRET_KEY, token);
}
export async function clearToken(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(SECRET_KEY);
}

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = unknown>(
  ctx: ApiCtx,
  path: string,
  init: { method?: string; body?: unknown; anonymous?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "modelbound-vscode/0.3.0",
  };
  if (!init.anonymous && ctx.token) headers["Authorization"] = `Bearer ${ctx.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const resp = await fetch(ctx.baseUrl + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await resp.text();
  let body: any = null;
  if (text) try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  if (!resp.ok) {
    throw new ApiError(resp.status, body?.error || body?.message || `HTTP ${resp.status}`);
  }
  return body as T;
}
