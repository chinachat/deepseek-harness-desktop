import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger";

export type ServerStatus = "starting" | "running" | "stopped" | "error";

export interface ServerEvents {
  status: (status: ServerStatus, url?: string) => void;
  output: (stream: "stdout" | "stderr", text: string) => void;
  exit: (code: number | null, signal: string | null) => void;
}

const URL_PATTERN = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/;
const BOOT_TIMEOUT_MS = 90_000;
const RESTART_DELAY_MS = 3_000;
const MAX_CONSECUTIVE_RESTARTS = 3;
/** Uptime that credits a launch as "stable" and resets the crash budget. */
const STABLE_UPTIME_MS = 60_000;

function resolveDshBin(): string {
  const candidates = [
    path.join(app.getAppPath(), "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(process.resourcesPath ?? "", "app", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
    path.join(process.resourcesPath ?? "", "app.asar.unpacked", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`dsh CLI not found. Searched: ${candidates.join(", ")}`);
}

export class DshServerManager extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private currentUrl: string | undefined;
  private status: ServerStatus = "stopped";
  private stoppedByUs = false;
  private consecutiveFailures = 0;
  private bootTimer: NodeJS.Timeout | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  /** When the current child last reported its URL, for stable-uptime accounting. */
  private startedAt: number | undefined;
  /** Monotonic epoch bumped on every (re)start so stale async callbacks become no-ops. */
  private epoch = 0;
  /** Reused in-flight `start()` promise while a launch is in progress (dedupes concurrent starts). */
  private pendingStart: Promise<string> | undefined;

  on<K extends keyof ServerEvents>(event: K, listener: ServerEvents[K]): this {
    return super.on(event, listener as (...args: any[]) => void);
  }

  emit<K extends keyof ServerEvents>(event: K, ...args: Parameters<ServerEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  getState(): { status: ServerStatus; url: string | undefined } {
    return { status: this.status, url: this.currentUrl };
  }

  private setStatus(status: ServerStatus, url?: string): void {
    this.status = status;
    if (url !== undefined) this.currentUrl = url;
    this.emit("status", status, this.currentUrl);
  }

  async start(): Promise<string> {
    // Dedupe concurrent launches against a single in-flight promise.
    if (this.pendingStart) return this.pendingStart;
    // Already running and holding its URL — idempotent call.
    if (this.child && this.currentUrl) return this.currentUrl;

    this.pendingStart = this.doStart();
    try {
      return await this.pendingStart;
    } finally {
      this.pendingStart = undefined;
    }
  }

  private async doStart(): Promise<string> {
    const epoch = ++this.epoch;
    this.stoppedByUs = false;

    const bin = resolveDshBin();
    const patchFile = path.join(app.getAppPath(), "assets", "picker-browse.patch.yml");
    logger.info(`spawning dsh: ${bin}`);
    this.setStatus("starting");

    const args = ["--expose-internals", bin, "web"];
    if (fs.existsSync(patchFile)) {
      args.push("--patch", patchFile);
      logger.info(`dsh patch overlay: ${patchFile}`);
    } else {
      logger.warn(`dsh patch overlay not found: ${patchFile}`);
    }
    args.push("--host", "127.0.0.1", "--port", "0");
    // The desktop shell already renders the UI in its own view. Without this,
    // dsh hands the authenticated URL to the OS default browser on every start
    // (and on every crash restart), opening a duplicate tab that carries the
    // session token.
    args.push("--no-open");

    const child = spawn(process.execPath, args, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      cwd: app.getPath("home"),
      windowsHide: true,
    });
    this.child = child;

    return new Promise<string>((resolve, reject) => {
      let stdoutBuf = "";
      let settled = false;
      /** Set when this launch's failure was already recorded by another path. */
      let countedExit = false;

      // A callback is only authoritative for its own launch epoch. When a newer
      // launch has superseded this one (stop/restart), ignore it entirely.
      const isCurrent = (): boolean => this.epoch === epoch;

      this.bootTimer = setTimeout(() => {
        if (!isCurrent() || settled) return;
        settled = true;
        // A bounded process owns an unbounded resource: if the URL never
        // arrives, tear the child down. Otherwise it keeps running untracked
        // while scheduleRestart spawns a second server, and neither stop() nor
        // before-quit can reach it.
        this.killChild(child, "boot timeout");
        // This failure is already being handled here, so the exit event that
        // the kill produces must not count it a second time.
        countedExit = true;
        this.handleFailure(new Error(`dsh web did not print its URL within ${BOOT_TIMEOUT_MS}ms`));
        reject(new Error(`dsh web did not print its URL within ${BOOT_TIMEOUT_MS}ms`));
      }, BOOT_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        this.emit("output", "stdout", text);
        stdoutBuf += text;
        const match = URL_PATTERN.exec(stdoutBuf);
        if (match && isCurrent() && !settled) {
          settled = true;
          if (this.bootTimer) clearTimeout(this.bootTimer);
          this.startedAt = Date.now();
          this.setStatus("running", match[1]);
          resolve(match[1]);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        this.emit("output", "stderr", chunk.toString());
      });

      child.on("error", (error) => {
        this.emit("output", "stderr", `spawn error: ${String(error)}\n`);
        if (!isCurrent() || settled) return;
        settled = true;
        countedExit = true;
        if (this.bootTimer) clearTimeout(this.bootTimer);
        this.handleFailure(error);
        reject(error);
      });

      child.on("exit", (code, signal) => {
        if (this.bootTimer) clearTimeout(this.bootTimer);
        logger.info(`dsh exited code=${code} signal=${signal}`);
        this.emit("exit", code, signal);
        if (!isCurrent()) return;
        this.child = undefined;

        if (this.stoppedByUs) {
          this.setStatus("stopped");
          return;
        }

        // A launch that reached "running" but died soon after is a crash loop
        // just as much as one that never booted, so it counts against the same
        // budget. A launch that ran for a healthy stretch is credited as stable.
        const uptime = this.startedAt === undefined ? 0 : Date.now() - this.startedAt;
        this.startedAt = undefined;
        const stable = uptime >= STABLE_UPTIME_MS;

        if (stable) {
          this.consecutiveFailures = 0;
        } else if (!countedExit) {
          this.consecutiveFailures += 1;
        }

        if (!settled) {
          settled = true;
          const message = `dsh exited before the web server was ready (code=${code})`;
          logger.error(`dsh server failure: ${message}`);
          this.setStatus("error");
          reject(new Error(message));
          this.scheduleRestart();
          return;
        }

        this.scheduleRestart();
      });
    });
  }

  /**
   * Terminate the dsh child and its descendants.
   *
   * `child.kill()` signals only the direct child; on Windows the spawned shell
   * and tool subprocesses survive as an orphaned tree. `taskkill /T` is the
   * only way to take the whole tree down there.
   */
  private killChild(child: ChildProcessWithoutNullStreams | undefined, reason: string): void {
    if (!child || child.exitCode !== null || child.killed) return;
    logger.info(`killing dsh process tree (${reason})`);
    if (process.platform === "win32" && child.pid !== undefined) {
      const result = spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      if (result.error === undefined) return;
      logger.warn(`taskkill unavailable (${String(result.error)}); falling back to child.kill()`);
    }
    child.kill();
  }

  private handleFailure(error: Error): void {
    this.consecutiveFailures += 1;
    logger.error(`dsh server failure: ${String(error)}`);
    this.setStatus("error");
  }

  private scheduleRestart(): void {
    this.setStatus("error");
    // Never stack restart attempts: an exit arriving while one is already
    // pending must not queue a second launch.
    if (this.restartTimer) return;
    if (this.consecutiveFailures > MAX_CONSECUTIVE_RESTARTS) {
      logger.error(`dsh crashed ${this.consecutiveFailures} times consecutively; giving up`);
      return;
    }
    logger.info(`restarting dsh in ${RESTART_DELAY_MS}ms (attempt ${this.consecutiveFailures}/${MAX_CONSECUTIVE_RESTARTS})`);
    this.restartTimer = setTimeout(() => {
      this.start().catch((error) => {
        logger.error(`restart failed: ${String(error)}`);
      });
    }, RESTART_DELAY_MS);
  }

  stop(): void {
    this.stoppedByUs = true;
    this.epoch += 1; // invalidate any in-flight launch callbacks
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.killChild(child, "stop");
    this.pendingStart = undefined;
    this.currentUrl = undefined;
    this.setStatus("stopped");
  }

  restart(): void {
    this.stoppedByUs = true;
    this.epoch += 1; // invalidate any in-flight launch callbacks
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = undefined;
    }
    const child = this.child;
    this.child = undefined;
    this.killChild(child, "manual restart");
    this.startedAt = undefined;
    this.pendingStart = undefined;
    this.currentUrl = undefined;
    this.consecutiveFailures = 0;
    this.stoppedByUs = false;
    this.start().catch((error) => {
      logger.error(`manual restart failed: ${String(error)}`);
    });
  }
}