import { readFile } from 'node:fs/promises';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { dirname, basename } from 'node:path';
import { env } from '../env.js';
import { supabase } from './supabase.js';

// Detects the current Cloudflare Quick Tunnel URL from cloudflared's logfile
// (mounted in from the cloudflared compose service via a shared volume) and
// upserts it into Supabase's app_config table keyed `api_url`. The FE reads
// this on bootstrap and subscribes to changes via Realtime.
//
// Architecture rationale: UPSIDE_MVP_SPEC.md → "Public URL Discovery
// (self-healing Quick Tunnel)".

const POLL_INTERVAL_MS = 30_000;
const TRYCLOUDFLARE_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;

let lastKnownUrl: string | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let dirWatcher: FSWatcher | null = null;

async function parseLatestUrl(logPath: string): Promise<string | null> {
  try {
    const content = await readFile(logPath, 'utf8');
    const matches = content.match(TRYCLOUDFLARE_URL_REGEX);
    if (!matches || matches.length === 0) return null;
    // cloudflared appends to --logfile across restarts, so the most recent
    // URL is the last match. (If the file is recreated, the new run's URL
    // is still the last match in the current contents.)
    return matches[matches.length - 1] ?? null;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return null; // logfile not yet created — cloudflared still starting
    throw e;
  }
}

async function upsertUrl(url: string): Promise<boolean> {
  const { error } = await supabase()
    .from('app_config')
    .upsert(
      { key: 'api_url', value: url, updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
  if (error) {
    console.error('[tunnelWatcher] upsert error:', error.message);
    return false;
  }
  console.log(`[tunnelWatcher] api_url upserted: ${url}`);
  return true;
}

async function detectAndPublish(logPath: string): Promise<void> {
  let url: string | null;
  try {
    url = await parseLatestUrl(logPath);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[tunnelWatcher] read error:', msg);
    return;
  }
  if (!url || url === lastKnownUrl) return;
  console.log(`[tunnelWatcher] detected url change: ${lastKnownUrl ?? '(none)'} -> ${url}`);
  // Only mark as published on a successful upsert — otherwise the next poll
  // would short-circuit and we'd never retry a transient Supabase failure.
  const ok = await upsertUrl(url);
  if (ok) lastKnownUrl = url;
}

export function startTunnelWatcher(): void {
  const logPath = env.cloudflaredLogPath;
  const logDir = dirname(logPath);
  const logFile = basename(logPath);
  console.log(`[tunnelWatcher] starting — watching ${logPath}`);

  void detectAndPublish(logPath);

  // Watching the directory rather than the file directly survives cloudflared
  // recreating the file on restart (fs.watch on a deleted file silently stops
  // firing events).
  try {
    dirWatcher = fsWatch(logDir, (_eventType, fileName) => {
      if (fileName === logFile) {
        void detectAndPublish(logPath);
      }
    });
    dirWatcher.on('error', (e) => {
      console.error('[tunnelWatcher] dir watch error:', e instanceof Error ? e.message : e);
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[tunnelWatcher] failed to start dir watch:', msg);
    // Polling fallback below still covers us.
  }

  // Polling fallback. fs.watch can miss events on Docker bind mounts /
  // named volumes depending on kernel + storage driver.
  pollTimer = setInterval(() => {
    void detectAndPublish(logPath);
  }, POLL_INTERVAL_MS);
}

export function stopTunnelWatcher(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (dirWatcher) {
    dirWatcher.close();
    dirWatcher = null;
  }
}
