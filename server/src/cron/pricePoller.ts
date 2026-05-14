// Skeleton — full implementation lands in Batch 9.
// Intent: during market hours, poll IB Gateway every 5-15s for active position quotes,
// cache in Redis, write to Supabase only on change to keep Realtime notifications minimal.

let timer: NodeJS.Timeout | null = null;

export function startPricePoller(): void {
  if (timer) return;
  console.log('[pricePoller] skeleton started — no work performed (Batch 9 will implement)');
  timer = setInterval(() => {
    // TODO Batch 9
  }, 10_000);
}

export function stopPricePoller(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
