// Subscribes to Supabase Realtime via a short-lived JWT minted by the
// ModelBound `issue-realtime-token` edge function and pulls skills to disk
// when they change in the cloud — so users don't have to manually pull.
//
// The token is bound to the caller's user_id and team_id. RLS on the
// `skills` table ensures Postgres only fans out events for rows the user
// can read.

import * as vscode from 'vscode';
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';

const TOKEN_ENDPOINT = 'https://modelbound.co/api/issue-realtime-token';
// Refresh ~2 min before expiry to absorb clock skew.
const REFRESH_LEAD_SECONDS = 120;

interface TokenResponse {
  token: string;
  expires_at: number; // unix seconds
  expires_in: number;
  supabase_url: string;
  supabase_anon_key?: string;
  user_id: string;
  team_id: string;
  user_email?: string | null;
  realtime: {
    channel: string;
    table: string;
    schema: string;
    filter: string;
  };
}

interface SkillRow {
  id: string;
  slug?: string | null;
  team_id?: string | null;
  deleted_at?: string | null;
  updated_at?: string | null;
  last_ide_sync_at?: string | null;
}

export interface RealtimeSyncOptions {
  apiKey: string;
  tokenEndpoint?: string;
  workspaceRoot: string;
  log: (msg: string) => void;
  /**
   * Lets the extension ignore realtime echoes caused by its own recent local
   * save. Without this, local save → cloud update → realtime pull → local write
   * can re-trigger the file watcher forever.
   */
  shouldSkipPull?: (skillId: string, row: SkillRow) => boolean;
  /**
   * Decides whether the skill is mirrored in this workspace. The realtime
   * watcher only pulls down updates for files the user already has.
   */
  hasLocalCopy: (slug: string | null | undefined, skillId: string) => boolean;
  /**
   * Pulls a skill from the MCP server to disk. Reuses the same code path
   * as the manual "Pull Skill" command.
   */
  pullSkillToDisk: (skillId: string) => Promise<void>;
}

export class RealtimeSync {
  private client: SupabaseClient | null = null;
  private channel: RealtimeChannel | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private inflightPulls = new Set<string>();

  constructor(private opts: RealtimeSyncOptions) {}

  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      this.opts.log(`RealtimeSync: initial connect failed — ${(err as Error).message ?? String(err)}`);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.channel) {
      try { this.channel.unsubscribe(); } catch { /* noop */ }
      this.channel = null;
    }
    if (this.client) {
      try { this.client.removeAllChannels(); } catch { /* noop */ }
      this.client = null;
    }
  }

  private async fetchToken(): Promise<TokenResponse> {
    const endpoint = this.opts.tokenEndpoint || TOKEN_ENDPOINT;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: '{}',
    });
    if (!res.ok) {
      throw new Error(`issue-realtime-token failed: HTTP ${res.status}`);
    }
    return (await res.json()) as TokenResponse;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const tok = await this.fetchToken();

    // Tear down any previous client/channel.
    if (this.channel) { try { this.channel.unsubscribe(); } catch { /* noop */ } this.channel = null; }
    if (this.client) { try { this.client.removeAllChannels(); } catch { /* noop */ } this.client = null; }

    this.client = createClient(tok.supabase_url, tok.supabase_anon_key || tok.token, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${tok.token}` } },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    // Some supabase-js versions need realtime.setAuth() to attach the JWT.
    try { (this.client as any).realtime?.setAuth?.(tok.token); } catch { /* noop */ }

    this.channel = this.client
      .channel(tok.realtime.channel)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: tok.realtime.schema,
          table: tok.realtime.table,
          filter: tok.realtime.filter,
        },
        (payload: any) => this.handleEvent(payload),
      )
      .subscribe((status) => {
        this.opts.log(`RealtimeSync: channel status=${status}`);
      });

    // Schedule a refresh before expiry.
    const ttl = Math.max(60, tok.expires_in - REFRESH_LEAD_SECONDS);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.connect().catch((err) => {
        this.opts.log(`RealtimeSync: refresh failed — ${(err as Error).message ?? String(err)}`);
        // Backoff retry in 30s.
        if (!this.stopped) {
          this.refreshTimer = setTimeout(() => this.connect().catch(() => { /* noop */ }), 30_000);
        }
      });
    }, ttl * 1000);

    this.opts.log(`RealtimeSync: subscribed to ${tok.realtime.channel} (team=${tok.team_id})`);
  }

  private handleEvent(payload: any): void {
    const newRow: SkillRow | undefined = payload?.new;
    const oldRow: SkillRow | undefined = payload?.old;
    const row = newRow || oldRow;
    if (!row?.id) return;

    // Skip soft-deletes — let the manual delete flow handle removals.
    if (newRow?.deleted_at) {
      this.opts.log(`RealtimeSync: skill ${newRow.slug ?? newRow.id} soft-deleted; not removing local copy.`);
      return;
    }

    if (this.opts.shouldSkipPull?.(row.id, row)) {
      this.opts.log(`RealtimeSync: skipped local echo for ${row.slug ?? row.id}`);
      return;
    }
    if (!this.opts.hasLocalCopy(row.slug ?? null, row.id)) return;
    if (this.inflightPulls.has(row.id)) return;

    this.inflightPulls.add(row.id);
    this.opts.pullSkillToDisk(row.id)
      .then(() => {
        vscode.window.setStatusBarMessage(`$(sync) ModelBound: pulled update for ${row.slug ?? row.id}`, 3000);
      })
      .catch((err) => {
        this.opts.log(`RealtimeSync: pull failed for ${row.id} — ${(err as Error).message ?? String(err)}`);
      })
      .finally(() => {
        this.inflightPulls.delete(row.id);
      });
  }
}
