import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Global test state
declare global {
  var __SERVER__: ChildProcess | undefined;
  var __BASE_URL__: string;
  var __TEST_DB_DIR__: string;
}

// Create a temp directory for the test database
const testDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-reviewer-e2e-"));
const testDbPath = path.join(testDbDir, "test.db");

// Set environment variables for tests
process.env.DATABASE_DIR = testDbDir;
process.env.DATABASE_PATH = testDbPath;

const PORT = 3099;
global.__BASE_URL__ = `http://localhost:${PORT}`;
global.__TEST_DB_DIR__ = testDbDir;

// Wait for server to be ready
async function waitForServer(url: string, timeout = 30000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) {
        return;
      }
    } catch {
      // Server not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Server did not start within ${timeout}ms`);
}

beforeAll(async () => {
  // Start the Next.js server
  console.log("Starting Next.js server...");
  global.__SERVER__ = spawn("npm", ["run", "dev", "--", "-p", PORT.toString()], {
    cwd: process.cwd(),
    stdio: "pipe",
    detached: true,
    env: {
      ...process.env,
      DATABASE_DIR: testDbDir,
      DATABASE_PATH: testDbPath,
    },
  });

  global.__SERVER__.stdout?.on("data", (data) => {
    if (process.env.DEBUG) {
      console.log(`[server] ${data.toString()}`);
    }
  });

  global.__SERVER__.stderr?.on("data", (data) => {
    if (process.env.DEBUG) {
      console.error(`[server] ${data.toString()}`);
    }
  });

  // Wait for server to be ready
  await waitForServer(global.__BASE_URL__);
  console.log("Server ready");
}, 60000);

// npm run dev spawns next dev, which spawns next-server (and Turbopack
// workers); killing only the npm process orphans the rest, which keep the
// inherited stdout/stderr pipes open and block Jest from exiting. Since the
// server was spawned with detached: true, its pid is also its process group
// id, so killing -pid kills the whole tree.
function killServerGroup(server: ChildProcess) {
  if (!server.pid) {
    server.kill("SIGKILL");
    return;
  }
  try {
    process.kill(-server.pid, "SIGKILL");
  } catch {
    server.kill("SIGKILL");
  }
}

afterAll(async () => {
  // Stop the server
  if (global.__SERVER__) {
    console.log("Stopping server...");
    killServerGroup(global.__SERVER__);

    // Wait for process to exit
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (global.__SERVER__) {
          killServerGroup(global.__SERVER__);
        }
        resolve();
      }, 3000);

      if (global.__SERVER__) {
        global.__SERVER__.on("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      } else {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  // Clean up test database
  try {
    fs.rmSync(global.__TEST_DB_DIR__, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}, 10000);
