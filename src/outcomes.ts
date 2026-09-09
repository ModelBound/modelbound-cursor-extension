// Skill feedback loop — a thumbs up / down after a skill-backed action.
//
// Same vocabulary as the CLI, MCP server, and plugins, so a report from the
// editor is indistinguishable from one made anywhere else.
import * as vscode from "vscode";
import { api, ApiCtx } from "./api.js";

export const VERDICTS = ["worked", "partial", "failed"] as const;
export type Verdict = (typeof VERDICTS)[number];

const CATEGORIES: Array<{ id: string; label: string; detail: string }> = [
  { id: "ignored_rule", label: "Ignored the rule", detail: "The skill states a rule and the agent did not follow it." },
  { id: "out_of_scope", label: "Went out of scope", detail: "Touched files or features the task never asked for." },
  { id: "wrong_tool", label: "Used the wrong tool", detail: "Reached for the wrong command, library or API." },
  { id: "hallucinated", label: "Invented something", detail: "Made up a file, function or fact." },
  { id: "wrong_format", label: "Output format wrong", detail: "The shape of the output did not match the skill." },
  { id: "too_vague", label: "Too vague to act on", detail: "The skill did not give enough to act on." },
  { id: "other", label: "Something else", detail: "Anything that does not fit the above." },
];

export async function reportOutcome(
  getApi: () => Promise<ApiCtx>,
  slug: string,
  verdict?: Verdict,
): Promise<void> {
  let v = verdict;
  if (!v) {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(thumbsup) Worked", id: "worked" as const },
        { label: "$(circle-slash) Partly worked", id: "partial" as const },
        { label: "$(thumbsdown) Went wrong", id: "failed" as const },
      ],
      { title: `How did "${slug}" perform?` },
    );
    if (!picked) return;
    v = picked.id;
  }

  let category: string | undefined;
  if (v !== "worked") {
    const pick = await vscode.window.showQuickPick(
      CATEGORIES.map((c) => ({ label: c.label, detail: c.detail, id: c.id })),
      { title: "What went wrong?" },
    );
    if (!pick) return;
    category = pick.id;
  }

  const note = await vscode.window.showInputBox({
    prompt: "One sentence on what happened (optional)",
    ignoreFocusOut: true,
  });

  const editor = vscode.window.activeTextEditor;
  const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;

  const ax = await getApi();
  await api(ax, "/api/cli/skill/outcome", {
    method: "POST",
    body: {
      slug,
      verdict: v,
      category,
      note: note || undefined,
      output_excerpt: selection?.slice(0, 4000),
      source: "vscode",
    },
  });

  const action = await vscode.window.showInformationMessage(
    v === "worked" ? `Thanks — recorded that "${slug}" worked.` : `Recorded. "${slug}" is now queued for a suggested fix.`,
    v === "worked" ? "OK" : "Open needs-attention",
  );
  if (action === "Open needs-attention") {
    void vscode.env.openExternal(vscode.Uri.parse(`${ax.baseUrl}/skills/attention`));
  }
}

export async function showReliability(getApi: () => Promise<ApiCtx>): Promise<void> {
  const ax = await getApi();
  const res = await api<{
    days: number;
    skills: Array<{ skill_id: string; slug: string | null; reports: number; failed: number; partial: number; reliability: number | null }>;
  }>(ax, "/api/cli/skill/reliability?days=30");
  if (!res.skills.length) {
    vscode.window.showInformationMessage("No skill outcome reports in the last 30 days.");
    return;
  }
  const items = res.skills.map((s) => ({
    label: s.slug ?? s.skill_id,
    description:
      s.reports < 3 || s.reliability == null ? `${s.reports} report(s), too few to score` : `${s.reliability}% reliable`,
    detail: `${s.failed} failed, ${s.partial} partial (30 days)`,
  }));
  await vscode.window.showQuickPick(items, { title: "Skill reliability" });
}
