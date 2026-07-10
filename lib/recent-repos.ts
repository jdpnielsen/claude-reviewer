// Tracks recently-browsed repository paths in localStorage so users can
// quickly switch back without retyping the full path.
const RECENT_REPOS_KEY = 'claude-reviewer-recent-repos';
const MAX_RECENT_REPOS = 5;

export function getRecentRepos(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const stored = localStorage.getItem(RECENT_REPOS_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

export function saveRecentRepo(path: string): void {
  if (typeof window === 'undefined') return;
  try {
    const recent = getRecentRepos().filter((p) => p !== path);
    recent.unshift(path);
    localStorage.setItem(RECENT_REPOS_KEY, JSON.stringify(recent.slice(0, MAX_RECENT_REPOS)));
  } catch {
    // Ignore localStorage errors
  }
}
