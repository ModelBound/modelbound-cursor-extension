export type SyncAction = 'noop' | 'pull' | 'push';

export type SyncDecisionInput = {
  localHash: string;
  cloudHash: string;
  lastSyncedHash?: string;
  hasPendingLocalEdit: boolean;
};

/**
 * Decide whether to push, pull, or do nothing for a local skill file.
 * Does not account for server-side conflict flags — callers must compare content
 * with cloud before pushing even when this returns "push".
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

export function shouldTreatConflictAsSynced(localHash: string, cloudHash: string): boolean {
  return localHash === cloudHash;
}
