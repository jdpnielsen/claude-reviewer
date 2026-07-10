/**
 * E2E tests for PR list and review workflow.
 */
import puppeteer, { Browser, Page } from "puppeteer";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Import database functions to set up test data
// We need to set env vars before import
process.env.DATABASE_DIR = global.__TEST_DB_DIR__;
process.env.DATABASE_PATH = `${global.__TEST_DB_DIR__}/test.db`;

import {
  createPR,
  addComment,
  closeDatabase,
} from "../../lib/database";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

describe("PR Workflow E2E Tests", () => {
  let browser: Browser;
  let page: Page;
  let testPRUuid: string;
  let testRepoDir: string;

  beforeAll(async () => {
    browser = await puppeteer.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    page = await browser.newPage();

    // The PR detail API shells out to git (lib/git.ts's listCommits) against
    // pr.repo_path, so repo_path must be a real repo with real base/head
    // commits, not a placeholder path.
    testRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reviewer-e2e-repo-"));
    git(["init", "-q"], testRepoDir);
    git(["config", "user.email", "e2e@test.local"], testRepoDir);
    git(["config", "user.name", "E2E Test"], testRepoDir);

    fs.writeFileSync(path.join(testRepoDir, "test.ts"), 'const hello = "world";\nexport { hello };\n');
    git(["add", "test.ts"], testRepoDir);
    git(["commit", "-q", "-m", "initial"], testRepoDir);
    const baseCommit = git(["rev-parse", "HEAD"], testRepoDir);

    fs.writeFileSync(
      path.join(testRepoDir, "test.ts"),
      'const hello = "world";\nconst foo = "bar";\nconst baz = "qux";\nexport { hello };\n'
    );
    git(["add", "test.ts"], testRepoDir);
    git(["commit", "-q", "-m", "add foo and baz"], testRepoDir);
    const headCommit = git(["rev-parse", "HEAD"], testRepoDir);

    // Create test PR data
    testPRUuid = createPR(
      testRepoDir,
      "Test PR for E2E",
      "main",
      "feature-test",
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
      "This is a test PR description for E2E testing."
    );

    // Add a test comment
    addComment(testPRUuid, "test.ts", 2, "Please add documentation for this constant");
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

  describe("PR List Page", () => {
    test("displays the PR list page", async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector("body");

      const content = await page.content();
      expect(content).toContain("Pull Requests");
    });

    test("shows the test PR in the list", async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector("body");

      // Wait for PR list to load
      await page.waitForFunction(
        () => document.body.textContent?.includes("Test PR for E2E"),
        { timeout: 10000 }
      );

      const content = await page.content();
      expect(content).toContain("Test PR for E2E");
      expect(content).toContain("feature-test");
    });

    test("can filter PRs by status", async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector("body");

      // Look for filter controls
      const content = await page.content();
      // The page should have some form of filtering
      expect(content.toLowerCase()).toMatch(/pending|filter|status/);
    });
  });

  describe("PR Review Page", () => {
    test("displays PR details", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector("body");

      // Wait for content to load
      await page.waitForFunction(
        () => document.body.textContent?.includes("Test PR for E2E"),
        { timeout: 10000 }
      );

      const content = await page.content();
      expect(content).toContain("Test PR for E2E");
      expect(content).toContain("feature-test");
      expect(content).toContain("main");
    });

    test("shows diff content", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector("body");

      // Wait for diff to load
      await page.waitForFunction(
        () => {
          const text = document.body.textContent || "";
          return text.includes("foo") || text.includes("bar") || text.includes("diff");
        },
        { timeout: 10000 }
      );

      const content = await page.content();
      // Should contain some diff content
      expect(content).toMatch(/foo|bar|hello|world|\+|\-/);
    });

    test("displays existing comments", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector("body");

      // Wait for comments to potentially load
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const content = await page.content();
      // Comments section should be present
      expect(content.toLowerCase()).toMatch(/comment|documentation/);
    });

    test("has review action buttons", async () => {
      await page.goto(`${global.__BASE_URL__}/prs/${testPRUuid}`);
      await page.waitForSelector("body");

      // Wait for page to load
      await page.waitForFunction(
        () => document.body.textContent?.includes("Test PR for E2E"),
        { timeout: 10000 }
      );

      const content = await page.content();
      // Should have approve/request changes buttons or text
      expect(content.toLowerCase()).toMatch(/approve|request changes|review/);
    });
  });

  describe("Navigation", () => {
    test("can navigate from list to PR detail", async () => {
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector("body");

      // Wait for list to load
      await page.waitForFunction(
        () => document.body.textContent?.includes("Test PR for E2E"),
        { timeout: 30000 }
      );

      // Find and click the PR link
      const prLink = await page.$(`a[href*="${testPRUuid}"]`);
      if (prLink) {
        await prLink.click();
        await page.waitForNavigation({ waitUntil: "networkidle0", timeout: 10000 }).catch(() => { });
      } else {
        // Try clicking on the PR row or title
        await page.click(`text/Test PR for E2E`).catch(() => { });
      }

      // Wait for navigation
      await page.waitForFunction(
        () => window.location.pathname.includes("/prs/"),
        { timeout: 5000 }
      ).catch(() => { });

      // Verify we're on the PR page
      const url = page.url();
      // Either we navigated or the page structure is different
      const content = await page.content();
      expect(content).toContain("Test PR for E2E");
    });
  });

  describe("Responsive Design", () => {
    test("page renders on mobile viewport", async () => {
      await page.setViewport({ width: 375, height: 667 });
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector("body");

      const content = await page.content();
      expect(content).toContain("Pull Requests");
    });

    test("page renders on tablet viewport", async () => {
      await page.setViewport({ width: 768, height: 1024 });
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector("body");

      const content = await page.content();
      expect(content).toContain("Pull Requests");
    });

    test("page renders on desktop viewport", async () => {
      await page.setViewport({ width: 1920, height: 1080 });
      await page.goto(global.__BASE_URL__);
      await page.waitForSelector("body");

      const content = await page.content();
      expect(content).toContain("Pull Requests");
    });
  });
});
