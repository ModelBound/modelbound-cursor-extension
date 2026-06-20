export type SyncAction = 'noop' | 'pull' | 'push';

export type SyncDecisionInput = {
  localHash: string;
  cloudHash: string;
  lastSyncedHash?: string;
  hasPendingLocalEdit: boolean;
};

/** Normalize markdown bodies so IDE disk vs MCP fetch compare reliably. */
export function normalizeSkillContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n+$/, '\n');
}

export function skillContentMatches(a: string, b: string): boolean {
  return normalizeSkillContent(a) === normalizeSkillContent(b);
}

/**
 * Decide whether to push, pull, or do nothing for a local skill file.
 * Callers should hash normalized content before passing localHash/cloudHash.
 */
export function decideSyncAction(input: SyncDecisionInput): SyncAction {
  const { localHash, cloudHash, lastSyncedHash, hasPendingLocalEdit } = input;

  if (localHash === cloudHash) {
    return 'noop';
  }

  if (
    lastSyncedHash &&
    lastSyncedHash === localHash &&
    cloudHash !== lastSyncedHash &&
    !hasPendingLocalEdit
  ) {
    return 'pull';
  }

  if (lastSyncedHash && lastSyncedHash !== localHash) {
    return 'push';
  }

  if (!lastSyncedHash) {
    return localHash === cloudHash ? 'noop' : 'push';
  }

  return 'push';
}

export function shouldTreatConflictAsSynced(localContent: string, cloudContent: string): boolean {
  return skillContentMatches(localContent, cloudContent);
}
