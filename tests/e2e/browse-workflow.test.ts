import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
/**
 * E2E tests for the /browse and /browse/conversations pages. These two
 * routes previously had zero e2e coverage and relied entirely on manual
 * browser smoke-testing during the React Query migration - this file
 * replaces that with automated coverage of the same interactions.
 *
 * Deliberately NOT covered here: actually submitting a new comment through
 * the UI, or clicking "Ask Claude"/"Ask & Commit". Both pages auto-trigger a
 * real, fire-and-forget `claude` CLI subprocess (with
 * --dangerously-skip-permissions) after a comment is added - spawning that
 * from an automated test (especially in CI) would run a live, unsupervised
 * agent with edit permissions against the test repo. Comment/reply data is
 * seeded directly via lib/database.ts instead, and only the read/filter/
 * resolve/delete/form-open-and-cancel interactions are driven through the
 * browser.
 */
import { chromium, Browser, Page } from 'playwright';

process.env.DATABASE_DIR = global.__TEST_DB_DIR__;
process.env.DATABASE_PATH = `${global.__TEST_DB_DIR__}/test.db`;

import {
  createRepoConversation,
  addRepoConversationMessage,
  updateRepoConversationStatus,
  closeDatabase,
} from '../../lib/database';
import { AuthorKind, ConversationStatus } from '../../lib/enum';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

// page.waitForFunction's signature is (pageFunction, arg, options) - a bare
// `page.waitForFunction(fn, { timeout: N })` resolves `{ timeout: N }` as
// `arg` (data passed into the browser-context function), NOT as `options`,
// silently discarding the requested timeout and falling back to Playwright's
// 30s default. Every call below explicitly passes `undefined` as `arg` so
// `options` lands in the right position.
async function waitForText(page: Page, predicate: () => boolean, timeout: number) {
  await page.waitForFunction(predicate, undefined, { timeout });
}

describe('Browse Workflow E2E Tests', () => {
  let browser: Browser;
  let page: Page;
  let testRepoDir: string;
  let activeConversationUuid: string;

  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    page = await browser.newPage();

    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-reviewer-e2e-browse-repo-'));
    git(['init', '-q'], testRepoDir);
    git(['config', 'user.email', 'e2e@test.local'], testRepoDir);
    git(['config', 'user.name', 'E2E Test'], testRepoDir);

    fs.mkdirSync(path.join(testRepoDir, 'src'));
    fs.writeFileSync(
      path.join(testRepoDir, 'src', 'index.ts'),
      'const hello = "world";\nconst foo = "bar";\nexport { hello, foo };\n',
    );
    git(['add', '.'], testRepoDir);
    git(['commit', '-q', '-m', 'initial'], testRepoDir);

    // One active conversation (with an agent reply, to exercise message
    // rendering for both author kinds) and one already-resolved conversation,
    // both anchored to src/index.ts so both pages have real grouped data.
    activeConversationUuid = createRepoConversation(
      testRepoDir,
      'src/index.ts',
      1,
      'What does hello do here?',
    );
    addRepoConversationMessage(
      activeConversationUuid,
      'It is a greeting constant.',
      AuthorKind.Agent,
    );

    const resolvedConversationUuid = createRepoConversation(
      testRepoDir,
      'src/index.ts',
      2,
      'This looks fine now',
    );
    updateRepoConversationStatus(resolvedConversationUuid, ConversationStatus.Resolved);
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

  // Scoped to .repo-input-form specifically - the header nav also has a
  // "Browse" link, and a bare `text=Browse` click matches that instead of
  // the actual submit button, silently no-oping instead of submitting the
  // repo path.
  //
  // The single retry below is a safety net, not the primary fix. The real
  // bug (confirmed via a targeted repro: 5/180 failures with
  // `waitUntil: 'domcontentloaded'` vs. 0/180 with `'load'`, see every
  // page.goto() in this file) was that 'domcontentloaded' fires as soon as
  // the HTML is parsed - before the JS bundle finishes loading and React
  // hydrates. Filling and clicking in that window can land on a button
  // that doesn't have its onClick listener wired up yet, so the click is a
  // silent no-op and the page is left stuck on the repo picker. Every
  // goto() in this file now waits for 'load' instead, which closed the race
  // in ~300 combined local samples; this retry only guards the residual
  // possibility that CI is slower/weirder than what was reproduced locally.
  async function enterRepoPath() {
    for (let attempt = 0; attempt < 2; attempt++) {
      await page.fill('input[placeholder="/path/to/your/repo"]', testRepoDir);
      await page.click('.repo-input-form button');
      try {
        await page.waitForSelector('.repo-input-form', { state: 'detached', timeout: 3000 });
        return;
      } catch {
        // Still on the picker screen - the submit didn't register, retry.
      }
    }
    throw new Error('enterRepoPath: repo picker form never dismissed after 2 attempts');
  }

  // testRepoDir's mkdtemp-generated random suffix could in principle contain
  // "src" as a substring, and Playwright's `text=` selector matches
  // substrings - so folder/file names are looked up by exact DOM text
  // instead of a generic `text=` click, matching the precision
  // clickDeleteButtonForComment() uses in pr-workflow.test.ts. Each helper
  // waitForFunction()s until a match exists before clicking - unlike
  // page.click(selector), a one-shot evaluateHandle query doesn't retry, so
  // it can lose a race against the tree still rendering.
  async function clickFolder(name: string) {
    await page.waitForFunction(
      (folderName) =>
        Array.from(document.querySelectorAll('.folder-item')).some(
          (el) => el.querySelector('span')?.textContent === folderName,
        ),
      name,
      { timeout: 20000 },
    );
    await page.evaluate((folderName) => {
      const el = Array.from(document.querySelectorAll('.folder-item')).find(
        (b) => b.querySelector('span')?.textContent === folderName,
      ) as HTMLElement | undefined;
      el?.click();
    }, name);
  }

  async function clickFile(name: string) {
    await page.waitForFunction(
      (fileName) =>
        Array.from(document.querySelectorAll('.file-item')).some(
          (el) => el.querySelector('.file-name')?.textContent === fileName,
        ),
      name,
      { timeout: 20000 },
    );
    await page.evaluate((fileName) => {
      const el = Array.from(document.querySelectorAll('.file-item')).find(
        (b) => b.querySelector('.file-name')?.textContent === fileName,
      ) as HTMLElement | undefined;
      el?.click();
    }, name);
  }

  // Conversations are ordered by updated_at DESC; the active conversation
  // seeded in beforeAll gets a reply (bumping its updated_at) before the
  // resolved one is created, so the resolved conversation actually sorts
  // first - locate the active one by its anchored line number instead of
  // assuming a position.
  async function clickConversationSummaryForLine(lineNumber: number) {
    await page.waitForFunction(
      (line) =>
        Array.from(document.querySelectorAll('.conversation-summary')).some((el) =>
          el.textContent?.includes(`Line ${line}`),
        ),
      lineNumber,
      { timeout: 20000 },
    );
    await page.evaluate((line) => {
      const el = Array.from(document.querySelectorAll('.conversation-summary')).find((s) =>
        s.textContent?.includes(`Line ${line}`),
      ) as HTMLElement | undefined;
      el?.click();
    }, lineNumber);
  }

  // The "All" tab appends a count badge to its own text (e.g. "All2"), so
  // matching is by prefix, not exact equality.
  async function clickFilterTab(label: string) {
    // Playwright's own locator click (auto-waiting/retrying for
    // actionability) rather than a one-shot evaluate()-based click - the
    // 2s-polled conversations list can re-render at an unlucky moment and
    // silently swallow a manually dispatched click.
    await page
      .locator('.filter-tab', { hasText: new RegExp(`^${label}`) })
      .first()
      .click();
  }

  describe('Browse Page', () => {
    test('shows the repo path picker when no repo is selected', async () => {
      await page.goto(`${global.__BASE_URL__}/browse`, { waitUntil: 'load' });
      await page.waitForSelector('body');
      const content = await page.content();
      expect(content).toContain('Browse Repository');
    });

    test('loads the file tree after entering a repo path', async () => {
      await page.goto(`${global.__BASE_URL__}/browse`, { waitUntil: 'load' });
      await enterRepoPath();

      await waitForText(page, () => document.body.textContent?.includes('src') ?? false, 20000);
      const content = await page.content();
      expect(content).toContain('src');
    });

    test('expands a folder and selects a file to view its content', async () => {
      await page.goto(`${global.__BASE_URL__}/browse`, { waitUntil: 'load' });
      await enterRepoPath();
      await waitForText(page, () => document.body.textContent?.includes('src') ?? false, 20000);

      await clickFolder('src');
      await waitForText(
        page,
        () => document.body.textContent?.includes('index.ts') ?? false,
        20000,
      );
      await clickFile('index.ts');

      await waitForText(page, () => document.body.textContent?.includes('hello') ?? false, 20000);
      const content = await page.content();
      expect(content).toContain('const');
      expect(content).toContain('hello');
    }, 60000);

    test('displays an existing conversation inline at its anchored line', async () => {
      await page.goto(`${global.__BASE_URL__}/browse`, { waitUntil: 'load' });
      await enterRepoPath();
      await waitForText(page, () => document.body.textContent?.includes('src') ?? false, 20000);
      await clickFolder('src');
      await waitForText(
        page,
        () => document.body.textContent?.includes('index.ts') ?? false,
        20000,
      );
      await clickFile('index.ts');

      await waitForText(
        page,
        () => document.body.textContent?.includes('What does hello do here?') ?? false,
        20000,
      );
      const content = await page.content();
      expect(content).toContain('What does hello do here?');
      // The agent reply should render too, distinguishing author kinds.
      expect(content).toContain('It is a greeting constant.');
    }, 60000);

    test('opens and cancels the new-comment form without submitting', async () => {
      await page.goto(`${global.__BASE_URL__}/browse`, { waitUntil: 'load' });
      await enterRepoPath();
      await waitForText(page, () => document.body.textContent?.includes('src') ?? false, 20000);
      await clickFolder('src');
      await waitForText(
        page,
        () => document.body.textContent?.includes('index.ts') ?? false,
        20000,
      );
      await clickFile('index.ts');
      await waitForText(page, () => document.body.textContent?.includes('hello') ?? false, 20000);

      // Line 3 ("export { hello, foo };") has no existing conversation.
      await page.click('.code-line >> nth=2');
      await page.waitForSelector('.new-comment-form', { timeout: 5000 });
      const textarea = await page.$('.new-comment-form textarea');
      expect(textarea).not.toBeNull();

      // Cancel never calls the mutation at all (see onAddComment/onCancelComment
      // wiring in FileViewer.tsx), so there's nothing server-side to
      // re-verify with a reload - closing the form is the whole behavior.
      await page.click('.new-comment-form >> text=Cancel');
      await page.waitForSelector('.new-comment-form', { state: 'hidden', timeout: 5000 });
    }, 60000);

    test('resolves an existing conversation', async () => {
      await page.goto(`${global.__BASE_URL__}/browse`, { waitUntil: 'load' });
      await enterRepoPath();
      await waitForText(page, () => document.body.textContent?.includes('src') ?? false, 20000);
      await clickFolder('src');
      await waitForText(
        page,
        () => document.body.textContent?.includes('index.ts') ?? false,
        20000,
      );
      await clickFile('index.ts');
      await waitForText(
        page,
        () => document.body.textContent?.includes('What does hello do here?') ?? false,
        20000,
      );

      const resolveRequestPromise = page.waitForResponse(
        (resp) =>
          resp.request().method() === 'PATCH' && resp.url().includes('/browse/conversations'),
        { timeout: 20000 },
      );
      await page.click('.inline-comment >> text=Resolve');
      await resolveRequestPromise;

      await waitForText(
        page,
        () => !(document.body.textContent?.includes('What does hello do here?') ?? false),
        20000,
      );
      const content = await page.content();
      expect(content).not.toContain('What does hello do here?');

      // This test permanently PATCHes the shared activeConversationUuid seeded
      // in beforeAll - the "Conversations List Page" tests below reuse that
      // same fixture and depend on it still being active (e.g. to verify the
      // Resolved filter actually excludes it). Restore its status directly via
      // the DB so this test's side effect doesn't leak into later tests.
      updateRepoConversationStatus(activeConversationUuid, ConversationStatus.Active);
    }, 60000);
  });

  describe('Conversations List Page', () => {
    test('shows the repo path picker when no repo is selected', async () => {
      await page.goto(`${global.__BASE_URL__}/browse/conversations`, {
        waitUntil: 'load',
      });
      await page.waitForSelector('body');
      const content = await page.content();
      expect(content).toContain('All Conversations');
    });

    test('lists conversations grouped by file after entering a repo', async () => {
      await page.goto(`${global.__BASE_URL__}/browse/conversations`, {
        waitUntil: 'load',
      });
      await enterRepoPath();

      await waitForText(
        page,
        () => document.body.textContent?.includes('src/index.ts') ?? false,
        20000,
      );
      const content = await page.content();
      expect(content).toContain('src/index.ts');
      expect(content).toContain('This looks fine now');
    });

    // Runs before "the Resolved filter tab" test below: that test leaves the
    // page's filter state on "resolved" (a fresh page.goto to the *same*
    // /browse/conversations URL isn't guaranteed to force a hard reload that
    // resets it), and this test needs the default "all" view to see the
    // active conversation.
    test('expands a conversation to show its message thread', async () => {
      await page.goto(`${global.__BASE_URL__}/browse/conversations`, {
        waitUntil: 'load',
      });
      await enterRepoPath();
      // The collapsed summary previews only the *latest* message - since
      // the active conversation has a reply, its preview shows "It is a
      // greeting constant.", never the original question. Wait for the
      // line label instead of message content.
      await waitForText(page, () => document.body.textContent?.includes('Line 1') ?? false, 20000);

      await clickConversationSummaryForLine(1);
      // Expanded view renders the full thread, so both messages appear.
      await waitForText(
        page,
        () => document.body.textContent?.includes('It is a greeting constant.') ?? false,
        20000,
      );
      const content = await page.content();
      expect(content).toContain('What does hello do here?');
      expect(content).toContain('It is a greeting constant.');
    }, 60000);

    test('the Resolved filter tab shows only resolved conversations', async () => {
      await page.goto(`${global.__BASE_URL__}/browse/conversations`, {
        waitUntil: 'load',
      });
      await enterRepoPath();
      await waitForText(
        page,
        () => document.body.textContent?.includes('src/index.ts') ?? false,
        20000,
      );

      // Explicitly starts from "All" - the previous test in this file
      // ("expands a conversation...") can leave the *actual browser tab*
      // showing a stale render for a moment right after this test's fresh
      // page.goto(), and clicking straight to "Resolved" occasionally raced
      // that stale paint. Clicking "All" first and waiting for both lines to
      // be present establishes a known-good baseline before switching.
      await clickFilterTab('All');
      await waitForText(
        page,
        () =>
          (document.body.textContent?.includes('Line 1') ?? false) &&
          (document.body.textContent?.includes('Line 2') ?? false),
        20000,
      );

      await clickFilterTab('Resolved');
      // Line 1 (active) should drop out; Line 2 (resolved) should remain.
      await waitForText(
        page,
        () =>
          (document.body.textContent?.includes('Line 2') ?? false) &&
          !(document.body.textContent?.includes('Line 1') ?? false),
        20000,
      );
      const content = await page.content();
      expect(content).toContain('This looks fine now');
      expect(content).not.toContain('Line 1');
    }, 60000);

    // The resolved conversation is visible whether the leftover filter from
    // the test above is "resolved" or "all", so this doesn't need to
    // explicitly reset it first.
    test('deletes a conversation via the confirm dialog', async () => {
      await page.goto(`${global.__BASE_URL__}/browse/conversations`, {
        waitUntil: 'load',
      });
      await enterRepoPath();
      await waitForText(
        page,
        () => document.body.textContent?.includes('This looks fine now') ?? false,
        20000,
      );

      // The resolved conversation from beforeAll is the one being deleted
      // here - expand it, then delete it.
      const summaries = await page.$$('.conversation-summary');
      let resolvedSummary = null;
      for (const summary of summaries) {
        const text = await summary.textContent();
        if (text?.includes('Line 2')) {
          resolvedSummary = summary;
          break;
        }
      }
      expect(resolvedSummary).not.toBeNull();
      await resolvedSummary!.click();
      await page.waitForSelector('.delete-btn', { timeout: 5000 });

      const deleteRequestPromise = page.waitForResponse(
        (resp) =>
          resp.request().method() === 'DELETE' && resp.url().includes('/browse/conversations'),
        { timeout: 20000 },
      );
      await page.click('.delete-btn');
      await page.waitForSelector('.confirm-dialog-backdrop', { timeout: 5000 });
      await page.click('.confirm-dialog-confirm-btn');
      await page.waitForSelector('.confirm-dialog-backdrop', { state: 'hidden', timeout: 5000 });
      await deleteRequestPromise;

      await waitForText(
        page,
        () => !(document.body.textContent?.includes('This looks fine now') ?? false),
        20000,
      );
      const content = await page.content();
      expect(content).not.toContain('This looks fine now');
    }, 60000);
  });
});
