import { staticScan } from './flightCheckRules';

/** Estimated instruction footprint, not model usage or money spent. Offline only. */
export function tokenProfile(content: string) {
  const result = staticScan(content);
  return { tokens: result.tokens, blocking: result.blocking, warnings: result.warnings, findings: result.findings };
}