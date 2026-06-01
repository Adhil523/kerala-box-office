import pgBoss from './pgBoss';

export async function initializePgBossJobs() {
	await pgBoss.start();
	await schedulePgBossJobs();
	await registerPgBossJobs();
}

async function schedulePgBossJobs() {
	// Jobs registered here
}

async function registerPgBossJobs() {
	// Workers registered here
}
