import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

      // A callback is only authoritative for its own launch epoch. When a newer
      // launch has superseded this one (stop/restart), ignore it entirely.
      const isCurrent = (): boolean => this.epoch === epoch;

      this.bootTimer = setTimeout(() => {
        if (!isCurrent() || settled) return;
        settled = true;
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
          this.consecutiveFailures = 0;
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
        if (!settled) {
          settled = true;
          this.handleFailure(new Error(`dsh exited before the web server was ready (code=${code})`));
          reject(new Error(`dsh exited before the web server was ready (code=${code})`));
          return;
        }
        if (!this.stoppedByUs) {
          this.scheduleRestart();
        } else {
          this.setStatus("stopped");
        }
      });
    });
  }

  private handleFailure(error: Error): void {
    this.consecutiveFailures += 1;
    logger.error(`dsh server failure: ${String(error)}`);
    this.setStatus("error");
  }

  private scheduleRestart(): void {
    this.setStatus("error");
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
    if (child && !child.killed) {
      logger.info("stopping dsh");
      child.kill();
    }
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
    if (child && !child.killed) {
      child.kill();
    }
    this.pendingStart = undefined;
    this.currentUrl = undefined;
    this.consecutiveFailures = 0;
    this.stoppedByUs = false;
    this.start().catch((error) => {
      logger.error(`manual restart failed: ${String(error)}`);
    });
  }
}