import { scheduleDiscoverMovies, registerDiscoverMoviesWorker } from './jobs/discover-movies.job';
import {
	scheduleSyncDailyCollections,
	registerSyncDailyCollectionsWorker
} from './jobs/sync-daily-collections.job';
import {
	scheduleSyncLiveCollections,
	registerSyncLiveCollectionsWorker
} from './jobs/sync-live-collections.job';
import pgBoss from './pgBoss';

export async function initializePgBossJobs() {
	await pgBoss.start();
	await schedulePgBossJobs();
	await registerPgBossJobs();
}

async function schedulePgBossJobs() {
	await scheduleDiscoverMovies();
	await scheduleSyncDailyCollections();
	await scheduleSyncLiveCollections();
}

async function registerPgBossJobs() {
	await registerDiscoverMoviesWorker();
	await registerSyncDailyCollectionsWorker();
	await registerSyncLiveCollectionsWorker();
}
