// Reviewed marks cascading between the autosquash preview and the PR's own
// commits. A squashed commit is the fold of its members - the target plus
// the fixup!/amend!/squash! commits absorbed into it - so reviewing one side
// covers the other: every member's mark on a file adds up to the squashed
// commit's, and the squashed commit's mark covers each member's share of it.
//
// Nothing is copied. The cascade is derived on every read from the marks
// actually stored, and only from those - a derived mark never feeds another
// derivation, so marking a member can't reach its siblings through the
// squashed commit. Unmarking goes through the same links the other way: it
// deletes the stored marks a derived one came from, so it doesn't just
// reappear on the next poll.

import { isFixupishSubject } from './autosquash';
import { unsetReviewedCommitMessage, unsetReviewedFile } from './database';
import { parseDiffFiles } from './diff';
import {
  getAutosquashPreview,
  getCommitDiff,
  isRepoAvailable,
  listCommits,
  resolveRepoPath,
  type CommitInfo,
} from './git';

/** One rewritten preview commit, and the PR commits it's built from. */
export interface CascadeGroup {
  sha: string;
  /** The target and everything folded into it - where its diff came from. */
  members: string[];
  /** The commits whose message text is in the squashed message: all of
   * them marked makes the squashed message reviewed. */
  messageSources: string[];
  /** The commits whose message mark the squashed message's covers: its
   * sources, plus the fixup!s, whose message is nothing but a pointer to it.
   * An amend!'s wording that a later one replaced is in neither. */
  messageCovers: string[];
}

export type MarkVia = 'preview' | 'commits';

export interface FileMark {
  file_path: string;
  commit_sha: string | null;
  marked_at: string;
  current: boolean;
  via?: MarkVia;
}

export interface MessageMark {
  commit_sha: string;
  marked_at: string;
  current: boolean;
  via?: MarkVia;
}

/**
 * The groups the cascade runs over, for a PR's current base and head - none
 * unless the branch has something for autosquash to fold (so an ordinary PR
 * never builds a preview for this) and the preview got built. A conflict
 * leaves only the groups replayed before it, so nothing cascades past it.
 */
export function cascadeGroups(
  repoPath: string,
  baseCommit: string,
  headCommit: string,
  commits?: CommitInfo[],
): CascadeGroup[] {
  if (!commits && !isRepoAvailable(repoPath)) return [];
  const list = commits ?? listCommits(repoPath, baseCommit, headCommit);
  if (!list.some((c) => isFixupishSubject(c.message))) return [];

  const preview = getAutosquashPreview(repoPath, baseCommit, headCommit);
  if (preview.error !== null) return [];
  return preview.commits
    .filter((c) => c.rewritten)
    .map((c) => ({
      sha: c.sha,
      members: [c.originalSha, ...c.absorbed.map((a) => a.sha)],
      messageSources: c.messageSources,
      messageCovers: [
        ...c.messageSources,
        ...c.absorbed.filter((a) => a.kind === 'fixup').map((a) => a.sha),
      ],
    }));
}

const FILES_CACHE_SIZE = 2000;
const filesCache = new Map<string, string[]>();

/** The paths a commit's own diff touches - cached, since a sha's diff
 * never changes and the PR route asks on every poll. */
export function commitFilePaths(repoPath: string, sha: string): string[] {
  const key = `${resolveRepoPath(repoPath)}\0${sha}`;
  const cached = filesCache.get(key);
  if (cached) return cached;
  const paths = parseDiffFiles(getCommitDiff(repoPath, sha)).map((f) => f.path);
  if (filesCache.size >= FILES_CACHE_SIZE) filesCache.clear();
  filesCache.set(key, paths);
  return paths;
}

const latest = (marks: { marked_at: string }[]) =>
  marks.reduce((a, m) => (m.marked_at > a ? m.marked_at : a), '');

/**
 * The marks that follow from the stored ones - `current` stored marks only,
 * so a mark gone stale stops cascading - leaving out any that's already
 * stored and current itself. Each comes back `current`, with `via` saying
 * which side it came from.
 */
export function deriveReviewedMarks(
  groups: CascadeGroup[],
  files: FileMark[],
  messages: MessageMark[],
  filesOf: (sha: string) => string[],
): { files: FileMark[]; messages: MessageMark[] } {
  const storedFile = (path: string, sha: string) =>
    files.find((m) => m.file_path === path && m.commit_sha === sha && m.current && !m.via);
  const storedMessage = (sha: string) =>
    messages.find((m) => m.commit_sha === sha && m.current && !m.via);

  const derivedFiles: FileMark[] = [];
  const derivedMessages: MessageMark[] = [];

  for (const group of groups) {
    for (const path of filesOf(group.sha)) {
      // Only the members that touch the file make up the squashed
      // commit's change to it; a member whose change to it the squash
      // cancels out doesn't reach the squashed diff at all, so has no part
      // on either side.
      const touching = group.members.filter((m) => filesOf(m).includes(path));
      const own = storedFile(path, group.sha);
      if (own) {
        for (const member of touching) {
          if (storedFile(path, member)) continue;
          derivedFiles.push({
            file_path: path,
            commit_sha: member,
            marked_at: own.marked_at,
            current: true,
            via: 'preview',
          });
        }
        continue;
      }
      const memberMarks = touching.map((m) => storedFile(path, m));
      if (touching.length > 0 && memberMarks.every((m) => m !== undefined)) {
        derivedFiles.push({
          file_path: path,
          commit_sha: group.sha,
          marked_at: latest(memberMarks as FileMark[]),
          current: true,
          via: 'commits',
        });
      }
    }

    const own = storedMessage(group.sha);
    if (own) {
      for (const sha of group.messageCovers) {
        if (storedMessage(sha)) continue;
        derivedMessages.push({
          commit_sha: sha,
          marked_at: own.marked_at,
          current: true,
          via: 'preview',
        });
      }
      continue;
    }
    const sourceMarks = group.messageSources.map(storedMessage);
    if (group.messageSources.length > 0 && sourceMarks.every((m) => m !== undefined)) {
      derivedMessages.push({
        commit_sha: group.sha,
        marked_at: latest(sourceMarks as MessageMark[]),
        current: true,
        via: 'commits',
      });
    }
  }

  return { files: derivedFiles, messages: derivedMessages };
}

/**
 * Unmarking `path` on `sha` also drops the stored marks on the other side
 * that would otherwise derive it straight back: a squashed commit's members
 * that touch the file, or a member's squashed commit. Returns how many.
 */
export function unmarkFileCascade(
  prUuid: string,
  groups: CascadeGroup[],
  path: string,
  sha: string,
  filesOf: (sha: string) => string[],
): number {
  let removed = 0;
  for (const group of groups) {
    if (group.sha === sha) {
      for (const member of group.members) {
        if (filesOf(member).includes(path) && unsetReviewedFile(prUuid, path, member)) removed++;
      }
    } else if (group.members.includes(sha) && filesOf(group.sha).includes(path)) {
      if (unsetReviewedFile(prUuid, path, group.sha)) removed++;
    }
  }
  return removed;
}

/** unmarkFileCascade for a commit message. */
export function unmarkMessageCascade(prUuid: string, groups: CascadeGroup[], sha: string): number {
  let removed = 0;
  for (const group of groups) {
    if (group.sha === sha) {
      for (const covered of group.messageCovers) {
        if (unsetReviewedCommitMessage(prUuid, covered)) removed++;
      }
    } else if (group.messageCovers.includes(sha)) {
      if (unsetReviewedCommitMessage(prUuid, group.sha)) removed++;
    }
  }
  return removed;
}
