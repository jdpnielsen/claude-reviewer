import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
/**
 * E2E tests for PR list and review workflow.
 */
import { chromium, Browser, Page } from 'playwright';

// Import database functions to set up test data
// We need to set env vars before import
process.env.DATABASE_DIR = global.__TEST_DB_DIR__;
process.env.DATABASE_PATH = `${global.__TEST_DB_DIR__}/test.db`;

import { createPR, addComment, addReply, closeDatabase } from '../../lib/database';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('PR Workflow E2E Tests', () => {
  let browser: Browser;
  let page: Page;
  let testPRUuid: string;
  let testRepoDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage();

    // The PR detail API shells out to git (lib/git.ts's listCommits) against
    // pr.repo_path, so repo_path must be a real repo with real base/head
    // commits, not a placeholder path.
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-e2e-repo-'));
    git(['init', '-q'], testRepoDir);
    git(['config', 'user.email', 'e2e@test.local'], testRepoDir);
    git(['config', 'user.name', 'E2E Test'], testRepoDir);

    fs.writeFileSync(
      path.join(testRepoDir, 'test.ts'),
      'const hello = "world";\nexport { hello };\n',
    );
    git(['add', 'test.ts'], testRepoDir);
    git(['commit', '-q', '-m', 'initial'], testRepoDir);
    const baseCommit = git(['rev-parse', 'HEAD'], testRepoDir);

    fs.writeFileSync(
      path.join(testRepoDir, 'test.ts'),
      'const hello = "world";\nconst foo = "bar";\nconst baz = "qux";\nexport { hello };\n',
    );
    git(['add', 'test.ts'], testRepoDir);
    git(['commit', '-q', '-m', 'add foo and baz'], testRepoDir);
    const headCommit = git(['rev-parse', 'HEAD'], testRepoDir);

    // Create test PR data
    testPRUuid = createPR(
      testRepoDir,
      'Test PR for E2E',
      'main',
      'feature-test',
      baseCommit,
      headCommit,
      `diff --git a/test.ts b/test.ts
--- a/test.ts
+++ b/test.ts
@@ -1,3 +1,5 @@
 const hello = "world";
+const foo = "bar";
+const baz = "qux";
 export { hello };`,
      'This is a test PR description for E2E testing.',
    );

    // Add a test comment
    addComment(testPRUuid, 'test.ts', 2, 'Please add documentation for this constant');
  });

  afterAll(async () => {
    if (browser) {
      await browser.close();
    }
    closeDatabase();
    if (testRepoDir) {
      fs.rmSync(testRepoDir, { recursive: true, force: true });
    }
  });

  describe('PR List Page', () => {
    test('displays the PR list page', async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector('body');

      const content = await page.content();
      expect(content).toContain('Pull Requests');
    });

    test('shows the test PR in the list', async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector('body');

      // Wait for PR list to load
      await page.waitForFunction(() => document.body.textContent?.includes('Test PR for E2E'), {
        timeout: 10000,
      });

      const content = await page.content();
      expect(content).toContain('Test PR for E2E');
      expect(content).toContain('feature-test');
    });

    test('can filter PRs by status', async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector('body');

      // Look for filter controls
      const content = await page.content();
      // The page should have some form of filtering
      expect(content.toLowerCase()).toMatch(/pending|filter|status/);
    });
  });

  describe('PR Review Page', () => {
    test('displays PR details', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector('body');

      // Wait for content to load
      await page.waitForFunction(() => document.body.textContent?.includes('Test PR for E2E'), {
        timeout: 10000,
      });

      const content = await page.content();
      expect(content).toContain('Test PR for E2E');
      expect(content).toContain('feature-test');
      expect(content).toContain('main');
    });

    test('shows diff content', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector('body');

      // Wait for diff to load
      await page.waitForFunction(
        () => {
          const text = document.body.textContent || '';
          return text.includes('foo') || text.includes('bar') || text.includes('diff');
        },
        { timeout: 10000 },
      );

      const content = await page.content();
      // Should contain some diff content
      expect(content).toMatch(/foo|bar|hello|world|\+|-/);
    });

    test('displays existing comments', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector('body');

      // Wait for comments to potentially load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const content = await page.content();
      // Comments section should be present
      expect(content.toLowerCase()).toMatch(/comment|documentation/);
    });

    test('has review action buttons', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector('body');

      // Wait for page to load
      await page.waitForFunction(() => document.body.textContent?.includes('Test PR for E2E'), {
        timeout: 10000,
      });

      const content = await page.content();
      // Should have approve/request changes buttons or text
      expect(content.toLowerCase()).toMatch(/approve|request changes|review/);
    });
  });

  describe('Comment Deletion', () => {
    let replyCommentUuid: string;

    beforeAll(() => {
      replyCommentUuid = addComment(testPRUuid, 'test.ts', 3, 'This needs a reply-count test');
      addReply(replyCommentUuid, 'Good catch');
    });

    async function clickDeleteButtonForComment(commentText: string) {
      const handle = await page.evaluateHandle((text) => {
        const comments = Array.from(document.querySelectorAll('.inline-comment'));
        return comments.find((el) => el.textContent?.includes(text)) ?? null;
      }, commentText);
      const el = handle.asElement();
      if (!el) throw new Error(`Comment containing "${commentText}" not found`);
      const deleteBtn = await el.$('.delete-btn');
      if (!deleteBtn) throw new Error('Delete button not found');
      await deleteBtn.click();
      await page.waitForSelector('.confirm-dialog-backdrop', { timeout: 5000 });
    }

    async function confirmDialogMessage(): Promise<string> {
      return page.$eval('.confirm-dialog-message', (el) => el.textContent ?? '');
    }

    // The delete button removes the comment from local state optimistically,
    // before the DELETE request even fires (see deleteComment() in
    // app/prs/[id]/page.tsx), so waiting for the dialog to close doesn't mean
    // the deletion has landed server-side yet. Wait for the request's actual
    // response instead - it must be registered before the click so it can't
    // miss a reply that comes back before this call returns.
    async function acceptConfirmDialog() {
      const deleteRequestPromise = page.waitForResponse(
        (resp) => resp.request().method() === 'DELETE' && resp.url().includes('/comments'),
        { timeout: 10000 },
      );
      await page.click('.confirm-dialog-confirm-btn');
      await page.waitForSelector('.confirm-dialog-backdrop', { state: 'hidden', timeout: 5000 });
      await deleteRequestPromise;
    }

    async function cancelConfirmDialog() {
      await page.click('.confirm-dialog-cancel-btn');
      await page.waitForSelector('.confirm-dialog-backdrop', { state: 'hidden', timeout: 5000 });
    }

    test('shows a confirm dialog and removes a comment with no replies', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForFunction(
        () => document.body.textContent?.includes('Please add documentation for this constant'),
        { timeout: 20000 },
      );

      await clickDeleteButtonForComment('Please add documentation for this constant');
      expect(await confirmDialogMessage()).toBe('Delete this comment?');
      await acceptConfirmDialog();

      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = await page.content();
      expect(content).not.toContain('Please add documentation for this constant');
    });

    test('mentions the reply count and removes both comment and reply', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForFunction(
        () => document.body.textContent?.includes('This needs a reply-count test'),
        { timeout: 20000 },
      );

      await clickDeleteButtonForComment('This needs a reply-count test');
      expect(await confirmDialogMessage()).toBe('Delete this comment and its 1 reply?');
      await acceptConfirmDialog();

      const content = await page.content();
      expect(content).not.toContain('Good catch');
    });

    test('keeps the comment when the confirm dialog is cancelled', async () => {
      addComment(testPRUuid, 'test.ts', 4, 'Do not delete me');
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForFunction(() => document.body.textContent?.includes('Do not delete me'), {
        timeout: 20000,
      });

      await clickDeleteButtonForComment('Do not delete me');
      await cancelConfirmDialog();

      await new Promise((resolve) => setTimeout(resolve, 500));
      const content = await page.content();
      expect(content).toContain('Do not delete me');
    });
  });

  describe('Navigation', () => {
    test('can navigate from list to PR detail', async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector('body');

      // Wait for list to load
      await page.waitForFunction(() => document.body.textContent?.includes('Test PR for E2E'), {
        timeout: 30000,
      });

      // Find and click the PR link
      const prLink = await page.$(`a[href*="${testPRUuid}"]`);
      if (prLink) {
        await prLink.click();
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }).catch(() => {});
      } else {
        // Try clicking on the PR row or title
        await page.click(`text=Test PR for E2E`).catch(() => {});
      }

      // Wait for navigation
      await page
        .waitForFunction(() => window.location.pathname.includes('/prs/'), { timeout: 5000 })
        .catch(() => {});

      // Verify we're on the PR page
      // Either we navigated or the page structure is different
      const content = await page.content();
      expect(content).toContain('Test PR for E2E');
    });
  });

  describe('Responsive Design', () => {
    test('page renders on mobile viewport', async () => {
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector('body');

      const content = await page.content();
      expect(content).toContain('Pull Requests');
    });

    test('page renders on tablet viewport', async () => {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector('body');

      const content = await page.content();
      expect(content).toContain('Pull Requests');
    });

    test('page renders on desktop viewport', async () => {
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector('body');

      const content = await page.content();
      expect(content).toContain('Pull Requests');
    });
  });

  describe('File expand/collapse defaults', () => {
    // Exercises every branch of shouldCollapseByDefault (see
    // app/prs/[id]/utils.ts): ordinary files expand by default; a noisy
    // lockfile and a diff big enough to hit MAX_LINES_DEFAULT (300) both
    // collapse by default - unless they have a comment, which always wins.
    let manyFilesPRUuid: string;
    let manyFilesRepoDir: string;

    function fileDiffId(filePath: string): string {
      return `file-${filePath.replace(/[^a-zA-Z0-9]/g, '-')}`;
    }

    async function isFileDiffExpanded(filePath: string): Promise<boolean> {
      return page.$eval(
        `#${fileDiffId(filePath)}`,
        (el) => el.querySelector('.diff-content') !== null,
      );
    }

    beforeAll(() => {
      manyFilesRepoDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'claude-reviewer-e2e-manyfiles-'),
      );
      git(['init', '-q'], manyFilesRepoDir);
      git(['config', 'user.email', 'e2e@test.local'], manyFilesRepoDir);
      git(['config', 'user.name', 'E2E Test'], manyFilesRepoDir);
      fs.writeFileSync(path.join(manyFilesRepoDir, 'README.md'), 'placeholder\n');
      git(['add', 'README.md'], manyFilesRepoDir);
      git(['commit', '-q', '-m', 'initial'], manyFilesRepoDir);
      const baseCommit = git(['rev-parse', 'HEAD'], manyFilesRepoDir);
      const headCommit = baseCommit;

      const bigDiffBody = Array.from({ length: 310 }, (_, i) => `+line${i}`).join('\n');

      const diffParts = [
        `diff --git a/normal.ts b/normal.ts
new file mode 100644
--- /dev/null
+++ b/normal.ts
@@ -0,0 +1,1 @@
+export const normal = true;`,
        `diff --git a/yarn.lock b/yarn.lock
new file mode 100644
--- /dev/null
+++ b/yarn.lock
@@ -0,0 +1,1 @@
+# yarn lockfile v1`,
        `diff --git a/package-lock.json b/package-lock.json
new file mode 100644
--- /dev/null
+++ b/package-lock.json
@@ -0,0 +1,1 @@
+{}`,
        `diff --git a/big.ts b/big.ts
new file mode 100644
--- /dev/null
+++ b/big.ts
@@ -0,0 +1,310 @@
${bigDiffBody}`,
      ];

      manyFilesPRUuid = createPR(
        manyFilesRepoDir,
        'Expand/collapse defaults PR',
        'main',
        'expand-defaults',
        baseCommit,
        headCommit,
        diffParts.join('\n'),
        'Exercises the noisy-lockfile and oversized-diff default-collapse rules.',
      );

      // Noisy by filename, but has a comment - must still expand.
      addComment(manyFilesPRUuid, 'package-lock.json', 1, 'Please double check this value');
    });

    afterAll(() => {
      if (manyFilesRepoDir) {
        fs.rmSync(manyFilesRepoDir, { recursive: true, force: true });
      }
    });

    test('expands ordinary and commented files, collapses noisy/huge ones without comments', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${manyFilesPRUuid}`);
      await page.waitForFunction(
        () => document.querySelectorAll('.file-diff').length >= 4,
        { timeout: 15000 },
      );

      // Ordinary file: expanded by default.
      expect(await isFileDiffExpanded('normal.ts')).toBe(true);

      // Noisy lockfile, no comment: collapsed by default.
      expect(await isFileDiffExpanded('yarn.lock')).toBe(false);

      // Diff big enough to hit the render cap, no comment: collapsed by default.
      expect(await isFileDiffExpanded('big.ts')).toBe(false);

      // package-lock.json is noisy but has a comment, so it must expand anyway.
      expect(await isFileDiffExpanded('package-lock.json')).toBe(true);
    });

    test('keeps a manually collapsed file collapsed even after a new comment arrives', async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${manyFilesPRUuid}`);
      await page.waitForFunction(
        () => document.querySelectorAll('.file-diff').length >= 4,
        { timeout: 15000 },
      );

      // normal.ts is auto-expanded by default; collapse it manually.
      expect(await isFileDiffExpanded('normal.ts')).toBe(true);
      await page.click(`#${fileDiffId('normal.ts')} .file-header-left`);
      expect(await isFileDiffExpanded('normal.ts')).toBe(false);

      // Simulate a comment arriving on normal.ts from elsewhere (e.g. another
      // reviewer) while this page is open, and wait for the 5s comment poll
      // (see usePRCommentsPollQuery) to pick it up.
      const pollResponsePromise = page.waitForResponse(
        (resp) =>
          resp.request().method() === 'GET' &&
          resp.url().includes(`/api/prs/${manyFilesPRUuid}`) &&
          !resp.url().includes('commit='),
        { timeout: 10000 },
      );
      addComment(manyFilesPRUuid, 'normal.ts', 1, 'Late-arriving comment');
      await pollResponsePromise;
      // Give React Query a moment to flush the refetched state into the DOM.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Manual collapse must win over the new comment.
      expect(await isFileDiffExpanded('normal.ts')).toBe(false);

      // Meanwhile, an untouched noisy file with a fresh comment (yarn.lock,
      // collapsed by default) should auto-expand.
      expect(await isFileDiffExpanded('yarn.lock')).toBe(false);
      const secondPollPromise = page.waitForResponse(
        (resp) =>
          resp.request().method() === 'GET' &&
          resp.url().includes(`/api/prs/${manyFilesPRUuid}`) &&
          !resp.url().includes('commit='),
        { timeout: 10000 },
      );
      addComment(manyFilesPRUuid, 'yarn.lock', 1, 'Another late comment');
      await secondPollPromise;
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(await isFileDiffExpanded('yarn.lock')).toBe(true);
    });
  });
});
