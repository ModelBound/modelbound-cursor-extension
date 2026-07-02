export type ParsedSkillPayload = {
  content: string;
  id: string;
  slug: string | null;
  sourcePath: string | null;
};

export function isModelBoundErrorContent(content: string): boolean {
  const normalized = content.trim().toLowerCase();
  return (
    /^skill not found\b/.test(normalized) ||
    /^not found\b/.test(normalized) ||
    /^error[:\s]/.test(normalized)
  );
}

/** Parse hosted MCP get_skill / skills.get tool payloads into skill markdown. */
export function parseSkillMcpPayload(data: unknown, skillId: string): ParsedSkillPayload | null {
  if (!data) return null;

  if (typeof data === 'string') {
    if (!data.trim() || isModelBoundErrorContent(data)) return null;
    return { content: data, id: skillId, slug: null, sourcePath: null };
  }

  if (typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const nested = obj.skill && typeof obj.skill === 'object'
    ? (obj.skill as Record<string, unknown>)
    : null;

  const textField =
    typeof obj.text === 'string'
      ? obj.text
      : typeof data === 'object' &&
          data !== null &&
          'text' in data &&
          typeof (data as { text?: unknown }).text === 'string'
        ? (data as { text: string }).text
        : null;

  const content =
    (typeof obj.body_md === 'string' ? obj.body_md : null) ??
    (nested && typeof nested.body_md === 'string' ? nested.body_md : null) ??
    (typeof obj.body === 'string' ? obj.body : null) ??
    textField ??
    '';

  if (!content.trim() || isModelBoundErrorContent(content)) return null;

  return {
    content,
    id: String(obj.skill_id ?? obj.id ?? skillId),
    slug: typeof obj.slug === 'string' ? obj.slug : null,
    sourcePath: typeof obj.source_path === 'string' ? obj.source_path : null,
  };
}
