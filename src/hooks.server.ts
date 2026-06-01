import { dangerousPrismaDoNotUse } from '$lib/server/prisma';
import { initializePgBossJobs } from '$lib/pgboss/setup';
import type { Handle } from '@sveltejs/kit';

let pgBossInitialized = false;

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.dangerousDb = dangerousPrismaDoNotUse;
	event.locals.user = null;

	if (!pgBossInitialized) {
		pgBossInitialized = true;
		initializePgBossJobs().catch((err) => {
			console.error('[pgboss] Failed to initialize:', err);
			pgBossInitialized = false;
		});
	}

	return resolve(event);
};
