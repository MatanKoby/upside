import { readFile } from 'node:fs/promises';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { env } from '../env.js';
import { appConfigTableModule } from '../adapters/supabase/appConfigTableModule.js';
import { notifyError } from './notify.js';

// Detects current Cloudflare Quick Tunnel URLs from cloudflared logfiles
// (mounted in from the cloudflared compose services via a shared volume) and
// upserts them into Supabase's app_config table. The FE reads these on
// bootstrap and subscribes to changes via Realtime.
//
// One watcher per tunnel: one for the api tunnel (app_config.api_url), one
// for the IB Gateway tunnel (app_config.ib_portal_url). Architecture:
// UPSIDE_MVP_SPEC.md → "Public URL Discovery" + "IB Authentication Flow".

const POLL_INTERVAL_MS = 30_000;
const TRYCLOUDFLARE_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

interface WatcherHandle {
  stop: () => void;
}

const handles: WatcherHandle[] = [];

async function parseLatestUrl(logPath: string): Promise<string | null> {
  try {
    const content = await readFile(logPath, 'utf8');
    const matches = content.match(TRYCLOUDFLARE_URL_REGEX);
    if (!matches || matches.length === 0) return null;
    return matches[matches.length - 1] ?? null;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null;
    throw e;
  }
}

async function upsertUrl(configKey: string, url: string): Promise<boolean> {
  try {
    await appConfigTableModule.setValue(configKey, url);
  } catch (e: unknown) {
    void notifyError(`tunnelWatcher.${configKey}.upsert`, e instanceof Error ? e.message : String(e));
    return false;
  }
  console.log(`[tunnelWatcher:${configKey}] upserted: ${url}`);
  return true;
}

function startOne(logPath: string, configKey: string): WatcherHandle {
  let lastKnownUrl: string | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let dirWatcher: FSWatcher | null = null;

  async function detectAndPublish(): Promise<void> {
    let url: string | null;
    try {
      url = await parseLatestUrl(logPath);
    } catch (e: unknown) {
      void notifyError(`tunnelWatcher.${configKey}.read`, 'log read failed', e);
      return;
    }
    if (!url || url === lastKnownUrl) return;

    // Optimistic claim, sync, before await — see comment on the original
    // single-watcher version for the race-condition rationale.
    const previousUrl = lastKnownUrl;
    lastKnownUrl = url;
    console.log(`[tunnelWatcher:${configKey}] detected url change: ${previousUrl ?? '(none)'} -> ${url}`);
    const ok = await upsertUrl(configKey, url);
    if (!ok) lastKnownUrl = previousUrl;
  }

  const logDir = dirname(logPath);
  const logFile = basename(logPath);
  console.log(`[tunnelWatcher:${configKey}] starting — watching ${logPath}`);

  void detectAndPublish();

  try {
    dirWatcher = fsWatch(logDir, (_eventType, fileName) => {
      if (fileName === logFile) {
        void detectAndPublish();
      }
    });
    dirWatcher.on('error', (e) => {
      console.error(`[tunnelWatcher:${configKey}] dir watch error:`, e instanceof Error ? e.message : e);
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[tunnelWatcher:${configKey}] failed to start dir watch:`, msg);
  }

  pollTimer = setInterval(() => {
    void detectAndPublish();
  }, POLL_INTERVAL_MS);

  return {
    stop() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (dirWatcher) {
        dirWatcher.close();
        dirWatcher = null;
      }
    },
  };
}

export function startTunnelWatcher(): void {
  handles.push(startOne(env.cloudflaredLogPath, 'api_url'));
}

export function stopTunnelWatcher(): void {
  while (handles.length) {
    handles.pop()!.stop();
  }
}
