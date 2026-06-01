import { dangerousPrismaDoNotUse as prisma } from '$lib/server/prisma';
import { scrapeMovieCollections } from '$lib/services/sacnilk';
import pgBoss from '../pgBoss';

const JOB_NAME = 'sync-live-collections';
const CRON = '*/30 3-17 * * *'; // Every 30 min, 8:30 AM – 11:00 PM IST

export async function registerSyncLiveCollectionsWorker() {
	await pgBoss.work(JOB_NAME, async () => {
		const runningMovies = await prisma.movie.findMany({
			where: { status: 'RUNNING', sacnilkSlug: { not: null } }
		});

		for (const movie of runningMovies) {
			try {
				const { live } = await scrapeMovieCollections(movie.sacnilkSlug!, movie.releaseDate);
				if (!live) continue;

				const today = new Date();
				today.setHours(0, 0, 0, 0);

				await prisma.dailyCollection.upsert({
					where: { movieID_date: { movieID: movie.id, date: today } },
					create: {
						movieID: movie.id,
						date: today,
						dayNumber: live.dayNumber,
						kerala: live.kerala,
						india: live.indiaGross,
						worldwide: null,
						source: 'sacnilk'
					},
					update: {
						kerala: live.kerala,
						india: live.indiaGross
					}
				});
			} catch (err) {
				console.error(`[${JOB_NAME}] Failed for movie ${movie.title}:`, err);
			}
		}
	});
}

export async function scheduleSyncLiveCollections() {
	await pgBoss.createQueue(JOB_NAME);
	await pgBoss.schedule(JOB_NAME, CRON, {}, { tz: 'UTC', singletonKey: JOB_NAME });
}
