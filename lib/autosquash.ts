// The pure half of the autosquash preview: working out which commits
// `git rebase -i --autosquash` would fold into which, and what message each
// folded commit would end up with. No git or Node imports, so the client can
// use isFixupishSubject too - the replay itself (building the actual commits)
// lives in lib/git.ts's autosquashCommits.

import type { CommitInfo } from './git';

export type AutosquashKind = 'fixup' | 'amend' | 'squash';

// The markers git recognises, each with its trailing space - `fixup!foo` is
// not a marker (skip_fixupish in git's sequencer.c).
const FIXUPISH_PREFIXES = ['fixup! ', 'amend! ', 'squash! '];

function skipFixupish(subject: string): string | null {
  for (const prefix of FIXUPISH_PREFIXES) {
    if (subject.startsWith(prefix)) return subject.slice(prefix.length);
  }
  return null;
}

/** Whether a commit subject is one `--autosquash` would try to fold away. */
export function isFixupishSubject(subject: string): boolean {
  return skipFixupish(subject) !== null;
}

export interface AutosquashStep {
  commit: CommitInfo;
  kind: AutosquashKind;
}

export interface AutosquashGroup {
  /** The commit that survives, with `steps` folded into it in order. */
  target: CommitInfo;
  steps: AutosquashStep[];
  /** The target's own subject is a fixup!/amend!/squash! marker that matched
   * no earlier commit, so it stays a commit of its own - almost always a typo
   * in the marker, or a target outside the PR. */
  unmatchedMarker: boolean;
}

/**
 * Group `commits` (oldest-first, as listCommits returns them) the way
 * `git rebase -i --autosquash` rearranges its todo list. This is a port of
 * todo_list_rearrange_squash in git's sequencer.c, including its lookup order
 * for a marker's target, all among *earlier* commits only:
 *
 * 1. an exact subject match (the first commit with that subject that wasn't
 *    itself folded away),
 * 2. a commit name - a sha, or anything else rev-parse resolves - when the
 *    text has no spaces; `resolveCommitName` does that lookup,
 * 3. a subject prefix match.
 *
 * Stacked markers (`fixup! fixup! foo`) are stripped down to `foo`. A marker
 * that names another fixup commit joins that fixup's chain, so it still lands
 * in the right group, after it. The kind comes from the outermost marker only,
 * as in git.
 */
export function planAutosquash(
  commits: CommitInfo[],
  resolveCommitName: (name: string) => string | null,
): AutosquashGroup[] {
  const n = commits.length;
  // Singly linked chains, exactly as git keeps them: next[i] is what follows
  // i once rearranged, tail[i] the last commit so far chained onto target i.
  const next = Array.from({ length: n }, () => -1);
  const tail = Array.from({ length: n }, () => -1);
  const kinds = Array.from<AutosquashKind | null>({ length: n }).fill(null);
  const subjectToIndex = new Map<string, number>();
  const indexBySha = new Map<string, number>();

  commits.forEach((commit, i) => {
    const subject = commit.message;
    let target = -1;

    let rest = skipFixupish(subject);
    if (rest !== null) {
      for (;;) {
        rest = rest.trimStart();
        const inner = skipFixupish(rest);
        if (inner === null) break;
        rest = inner;
      }
      const p = rest;

      const bySubject = subjectToIndex.get(p);
      if (bySubject !== undefined) {
        target = bySubject;
      } else {
        const resolved = p.includes(' ') ? null : resolveCommitName(p);
        const byName = resolved ? indexBySha.get(resolved) : undefined;
        if (byName !== undefined) {
          target = byName;
        } else {
          target = commits.findIndex((c, j) => j < i && c.message.startsWith(p));
        }
      }
    }

    if (target >= 0) {
      kinds[i] = subject.startsWith('fixup!')
        ? 'fixup'
        : subject.startsWith('amend!')
          ? 'amend'
          : 'squash';
      if (tail[target] < 0) {
        next[i] = next[target];
        next[target] = i;
      } else {
        next[i] = next[tail[target]];
        next[tail[target]] = i;
      }
      tail[target] = i;
    } else if (!subjectToIndex.has(subject)) {
      subjectToIndex.set(subject, i);
    }

    indexBySha.set(commit.sha, i);
  });

  const groups: AutosquashGroup[] = [];
  for (let i = 0; i < n; i++) {
    if (kinds[i] !== null) continue;
    const steps: AutosquashStep[] = [];
    for (let cur = next[i]; cur >= 0; cur = next[cur]) {
      steps.push({ commit: commits[cur], kind: kinds[cur]! });
    }
    groups.push({
      target: commits[i],
      steps,
      unmatchedMarker: isFixupishSubject(commits[i].message),
    });
  }
  return groups;
}

// A message minus its subject paragraph, and any blank lines after it -
// what git keeps of an amend!/squash! commit's own message once it has
// commented out the marker line.
function stripSubject(message: string): string {
  const breakAt = message.indexOf('\n\n');
  if (breakAt < 0) return '';
  return message.slice(breakAt + 2).replace(/^(?:[ \t]*\n)+/, '');
}

export interface SquashedMessage {
  message: string;
  /** A squash! was folded in, so git would stop and open an editor on this
   * message - what's shown is the message as it'd be saved unedited. */
  needsEdit: boolean;
  /** Per message - the target's, then each step's - whether its text is in
   * `message`: a fixup!'s never is, and an amend! drops everything before it. */
  sources: boolean[];
}

/**
 * The message a folded commit ends up with, following the sequencer's rules:
 * a fixup! keeps the message as it is, an amend! replaces it with the amend
 * commit's own body, and a squash! appends its body (its marker subject
 * dropped). Once a squash! has been seen, a later amend! appends like one
 * too, rather than replacing everything before it.
 */
export function squashMessages(
  targetMessage: string,
  steps: { kind: AutosquashKind; message: string }[],
): SquashedMessage {
  let message = targetMessage.trimEnd();
  let seenSquash = false;
  const sources = [true, ...steps.map(() => false)];

  steps.forEach((step, i) => {
    if (step.kind === 'fixup') return;
    // Every step's subject is its marker line - that's what made it a step.
    const body = stripSubject(step.message).trimEnd();
    if (step.kind === 'amend' && !seenSquash) {
      // git refuses to commit an empty message, so an amend! with no body
      // would stop the rebase - keep the old message rather than show that.
      if (body) {
        message = body;
        sources.fill(false);
        sources[i + 1] = true;
      }
      return;
    }
    seenSquash = true;
    if (body) {
      message = `${message}\n\n${body}`;
      sources[i + 1] = true;
    }
  });

  return { message, needsEdit: seenSquash, sources };
}
