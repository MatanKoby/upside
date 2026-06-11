// TableModule for `access_attempts` — the SOLE server-side gatekeeper for the
// Google-auth audit log. Writer: the /auth/google/callback route (one append
// per sign-in attempt, granted or not). No server-side reader.
//
// Batch ARCH-4 — finishes Phase 1 ("every table behind a module").
// See docs/arch/target-architecture.md → Phase 1.

import { TableModule } from './TableModule.js';

export interface AccessAttempt {
  email: string;
  granted: boolean;
  ipAddress: string | null;
  userAgent: string | null;
}

class AccessAttemptsTableModule extends TableModule {
  constructor() {
    super('access_attempts');
  }

  /** Append one access attempt (audit log). Sole writer. */
  async record(a: AccessAttempt): Promise<void> {
    await this.run(
      'record',
      this.from().insert({
        email: a.email,
        granted: a.granted,
        ip_address: a.ipAddress,
        user_agent: a.userAgent,
      }),
    );
  }
}

export const accessAttemptsTableModule = new AccessAttemptsTableModule();
