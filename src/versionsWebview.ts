// Versions webview — side panel that lists every version of a skill with
// per-row Diff / Restore / Benchmark actions.
//
// Render strategy: server-side rendered HTML string; small enough that
// we don't need a bundler. Postmessage out → execute commands.
import * as vscode from "vscode";
import { ApiCtx, api } from "./api";

interface Version {
  id: string;
  created_at: string;
  author?: string;
  tokens: number;
  summary?: string;
}

export async function openVersionsWebview(
  getApi: () => Promise<ApiCtx>,
  slug: string,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "modelbound.versions",
    `ModelBound — Versions: ${slug}`,
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true },
  );

  panel.webview.html = renderLoading(slug);

  try {
    const ax = await getApi();
    const res = await api<{ versions: Version[] }>(
      ax,
      `/api/cli/skill/versions?slug=${encodeURIComponent(slug)}&limit=50`,
    );
    panel.webview.html = renderVersions(slug, res.versions);
  } catch (e) {
    panel.webview.html = renderError((e as Error).message);
    return;
  }

  panel.webview.onDidReceiveMessage(async (msg: { type: string; versionId?: string; a?: string; b?: string }) => {
    if (msg.type === "diff" && msg.versionId) {
      await vscode.commands.executeCommand("modelbound.diff", { slug, from: msg.versionId, to: "current" });
    } else if (msg.type === "restore" && msg.versionId) {
      await vscode.commands.executeCommand("modelbound.restore", { slug, versionId: msg.versionId });
    } else if (msg.type === "benchmark" && msg.a && msg.b) {
      await vscode.commands.executeCommand("modelbound.benchmark", { slug, a: msg.a, b: msg.b });
    }
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function shell(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"/>
    <style>
      body { font: 13px/1.5 -apple-system, system-ui, sans-serif; padding: 16px; color: var(--vscode-foreground); }
      h2 { margin: 0 0 12px 0; font-size: 14px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
      th { font-weight: 600; opacity: .8; }
      button { font: inherit; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 0; padding: 3px 8px; border-radius: 3px; cursor: pointer; margin-right: 4px; }
      button:hover { background: var(--vscode-button-secondaryHoverBackground); }
      code { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: .8; }
      .muted { opacity: .65; }
    </style></head><body>${body}</body></html>`;
}

function renderLoading(slug: string): string {
  return shell(`<h2>Loading versions for ${esc(slug)}…</h2>`);
}
function renderError(msg: string): string {
  return shell(`<h2>Failed to load versions</h2><p class="muted">${esc(msg)}</p>`);
}
function renderVersions(slug: string, versions: Version[]): string {
  if (!versions.length) return shell(`<h2>No versions yet for ${esc(slug)}</h2>`);
  const rows = versions
    .map(
      (v, i) => `<tr>
        <td><code>${esc(v.id.slice(0, 10))}</code></td>
        <td>${esc(v.created_at)}</td>
        <td>${v.tokens.toLocaleString()}</td>
        <td>${esc(v.author ?? "—")}</td>
        <td>${esc(v.summary ?? "")}</td>
        <td>
          <button data-act="diff" data-v="${esc(v.id)}">Diff vs current</button>
          <button data-act="restore" data-v="${esc(v.id)}">Restore</button>
          ${i + 1 < versions.length ? `<button data-act="benchmark" data-v="${esc(v.id)}" data-b="${esc(versions[i + 1].id)}">Benchmark vs prev</button>` : ""}
        </td>
      </tr>`,
    )
    .join("");
  return shell(`
    <h2>Versions — ${esc(slug)}</h2>
    <table>
      <thead><tr><th>ID</th><th>Created</th><th>Tokens</th><th>Author</th><th>Summary</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <script>
      const vscode = acquireVsCodeApi();
      document.body.addEventListener("click", (e) => {
        const t = e.target;
        if (!(t instanceof HTMLButtonElement)) return;
        const act = t.dataset.act, v = t.dataset.v, b = t.dataset.b;
        if (act === "diff") vscode.postMessage({ type: "diff", versionId: v });
        else if (act === "restore") vscode.postMessage({ type: "restore", versionId: v });
        else if (act === "benchmark") vscode.postMessage({ type: "benchmark", a: v, b });
      });
    </script>`);
}
