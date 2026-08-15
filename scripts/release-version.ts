const STABLE_VERSION = /^\d+\.\d+\.\d+$/u;
const RELEASE_CANDIDATE_NUMBER = /^[1-9]\d*$/u;

export function isNumberedReleaseCandidate(stableVersion: string, candidateVersion: string): boolean {
  if (!STABLE_VERSION.test(stableVersion)) return false;
  const prefix = `${stableVersion}-rc.`;
  return candidateVersion.startsWith(prefix) &&
    RELEASE_CANDIDATE_NUMBER.test(candidateVersion.slice(prefix.length));
}
