// Latest-available-date resolvers for the daily-grain signal tables (Batch X9).
//
// The Intraday/Swing pipeline is daily-grain: trait_scores → curated_list →
// the virtual lists + the dip-bounce/band compute set. Keying every consumer on
// `asof_date = today` blanked the whole chain whenever today's sweep hadn't run
// (the build race, weekends, pre-market). These helpers resolve the *latest
// available* date instead, so the pipeline serves the most recent good data.
// Membership is slow-moving character data, so latest-available is safe; the
// money-safety gate lives at firing time (dip-bounce-scorer.md → Fresh-price
// firing gate), not here. See spec/signals/curated-list.md → Population & freshness.

import { notifyError } from '../notify.js';
import { traitScoresTableModule, type TraitKind } from '../../db/traitScoresTableModule.js';
import { curatedListTableModule } from '../../db/curatedListTableModule.js';

/** Days of slack past which "latest" is treated as stale (covers a weekend). */
export const STALENESS_CAP_DAYS = 4;

export function latestTraitAsof(trait: TraitKind): Promise<string | null> {
  return traitScoresTableModule.latestAsof(trait);
}

export async function latestCuratedAsof(): Promise<string | null> {
  try {
    return await curatedListTableModule.latestAsof();
  } catch (e) {
    void notifyError('asof.latest.curated_list', (e as Error).message);
    return null;
  }
}

/** True when `asof` (YYYY-MM-DD) is older than the staleness cap relative to now. */
export function isStale(asof: string | null, capDays = STALENESS_CAP_DAYS): boolean {
  if (!asof) return true;
  const ageDays = (Date.now() - Date.parse(`${asof}T00:00:00Z`)) / 86_400_000;
  return ageDays > capDays;
}
