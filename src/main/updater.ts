import { EventEmitter } from "node:events";
import { app } from "electron";
import { autoUpdater, type NsisUpdater } from "electron-updater";
import { applyGithubProxy } from "./settings";
import { logger } from "./logger";

/**
 * Online update manager backed by electron-updater + GitHub Releases.
 *
 * - Update feed: `latest.yml` published on
 *   `https://github.com/chinachat/deepseek-harness-desktop/releases` (the
 *   `publish.github` config in package.json).
 * - Proxy: a GitHub proxy configured in settings is applied to the process
 *   environment before every check, so Node's `https` (used by
 *   electron-updater through `proxy-from-env`) routes through it.
 *
 * The class owns the single autoUpdater instance and re-broadcasts its events
 * with stable, UI-friendly payloads.
 */

export type UpdateState =
  | { phase: "idle" }
  | { phase: "checking" }
  | { phase: "not-available"; version: string }
  | { phase: "available"; version: string }
  | { phase: "downloading"; percent: number; bytesPerSecond: number }
  | { phase: "downloaded"; version: string }
  | { phase: "error"; message: string };

export interface UpdaterEvents {
  state: (state: UpdateState) => void;
}

export class UpdateManager extends EventEmitter {
  private static instance: UpdateManager | undefined;

  private initialized = false;
  private checking = false;
  /** True between update-available and download completion/error. */
  private downloading = false;
  private currentState: UpdateState = { phase: "idle" };

  static get(): UpdateManager {
    if (!UpdateManager.instance) UpdateManager.instance = new UpdateManager();
    return UpdateManager.instance;
  }

  private constructor() {
    super();
  }

  on<K extends keyof UpdaterEvents>(event: K, listener: UpdaterEvents[K]): this {
    return super.on(event, listener as (...args: any[]) => void);
  }

  emit<K extends keyof UpdaterEvents>(event: K, ...args: Parameters<UpdaterEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  getState(): UpdateState {
    return this.currentState;
  }

  currentVersion(): string {
    return app.getVersion();
  }

  private setState(state: UpdateState): void {
    this.currentState = state;
    this.emit("state", state);
  }

  /**
   * Wire the autoUpdater events once (idempotent). Also applies the GitHub
   * proxy from settings before the first check.
   */
  init(proxy: string): void {
    if (this.initialized) {
      applyGithubProxy(proxy);
      return;
    }
    this.initialized = true;
    applyGithubProxy(proxy);

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    // Allow pre-releases so the updater can see rc/beta channel builds too.
    autoUpdater.allowPrerelease = true;

    // This project ships unsigned installers (no code-signing certificate).
    // electron-updater's NSIS verifier would reject the downloaded installer as
    // "not signed by the application owner", so bypass the signature check. The
    // download itself is still integrity-checked via the SHA-512 in
    // latest.yml, and the feed URL is pinned to our own GitHub repo.
    (autoUpdater as unknown as NsisUpdater).verifyUpdateCodeSignature = () => Promise.resolve(null);

    autoUpdater.logger = {
      info: (message?: unknown) => logger.info(`[updater] ${String(message)}`),
      warn: (message?: unknown) => logger.warn(`[updater] ${String(message)}`),
      error: (message?: unknown) => logger.error(`[updater] ${String(message)}`),
    };

    autoUpdater.on("checking-for-update", () => {
      this.setState({ phase: "checking" });
    });

    autoUpdater.on("update-available", (info) => {
      this.downloading = true;
      this.setState({ phase: "available", version: info.version });
    });

    autoUpdater.on("update-not-available", (info) => {
      // Do not regress a download that is already running: two overlapping
      // checks can deliver this after update-available.
      if (this.downloading) return;
      this.setState({ phase: "not-available", version: info.version });
    });

    autoUpdater.on("download-progress", (progress) => {
      this.setState({
        phase: "downloading",
        percent: Math.round(progress.percent),
        bytesPerSecond: progress.bytesPerSecond,
      });
    });

    autoUpdater.on("update-downloaded", (event) => {
      this.downloading = false;
      this.setState({ phase: "downloaded", version: event.version });
    });

    autoUpdater.on("error", (error) => {
      this.downloading = false;
      // `checking` is owned by check()'s finally block. Clearing it here races
      // a newer check and lets a second one start underneath the first.
      this.setState({ phase: "error", message: String(error?.message ?? error) });
    });
  }

  /**
   * Check for updates and download them. Applies the configured proxy first.
   */
  async check(proxy: string): Promise<void> {
    this.init(proxy);
    if (this.checking) return;
    this.checking = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result === null && !this.downloading) {
        this.setState({ phase: "not-available", version: this.currentVersion() });
      }
      // When autoDownload is true, download starts automatically and progress
      // events follow; nothing more to do here.
    } catch (error) {
      this.downloading = false;
      this.setState({ phase: "error", message: String((error as Error)?.message ?? error) });
    } finally {
      this.checking = false;
    }
  }

  /** Install the downloaded update and restart. */
  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, false);
  }
}
