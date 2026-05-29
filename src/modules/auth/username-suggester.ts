/**
 * Username generation + suggestion. Takes a free-form display name like
 * "Jane O'Doe!" and produces a URL/handle-safe slug ("jane_o_doe"), then
 * — given a set of taken handles — assembles a short ranked list of
 * available alternatives.
 *
 * Rules: ASCII fold, lowercase, [a-z0-9_-] only, runs of separators
 * collapsed to a single `_`, trimmed at the ends, length 3-24.
 */

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 24;

const VARIANT_NUMBERS = [2, 3, 7, 42, 99];
const RANDOM_VARIANTS = 2;

const COMBINING_MARKS = /[̀-ͯ]/g;

export function slugifyDisplayName(displayName: string): string {
  const folded = displayName
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return folded.slice(0, USERNAME_MAX);
}

export function isValidUsername(candidate: string): boolean {
  return (
    candidate.length >= USERNAME_MIN &&
    candidate.length <= USERNAME_MAX &&
    /^[a-z0-9][a-z0-9_-]*[a-z0-9]$/.test(candidate)
  );
}

/**
 * Build a deterministic-ish list of candidates to probe in a single DB
 * lookup. Always includes the base slug first (so the caller can tell
 * whether the user gets exactly what they typed), followed by numeric
 * variants and a couple of random suffixes for variety.
 */
export function buildCandidates(baseSlug: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const push = (c: string) => {
    if (!seen.has(c) && isValidUsername(c)) {
      seen.add(c);
      candidates.push(c);
    }
  };

  if (isValidUsername(baseSlug)) push(baseSlug);

  const padded = baseSlug.length < USERNAME_MIN ? `${baseSlug}_${randomSuffix(3)}` : baseSlug;
  const root = padded.length >= USERNAME_MIN ? padded : `user_${randomSuffix(4)}`;

  for (const n of VARIANT_NUMBERS) {
    push(trimToFit(root, `_${n}`));
  }
  for (let i = 0; i < RANDOM_VARIANTS; i++) {
    push(trimToFit(root, `_${randomSuffix(3)}`));
  }
  return candidates;
}

function trimToFit(root: string, suffix: string): string {
  const maxRoot = USERNAME_MAX - suffix.length;
  const trimmed = root.slice(0, Math.max(0, maxRoot)).replace(/[_-]+$/, '');
  return `${trimmed}${suffix}`;
}

function randomSuffix(len: number): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < len; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}
