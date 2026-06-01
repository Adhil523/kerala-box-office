import { dangerousPrismaDoNotUse as prisma } from '$lib/server/prisma';
import { scrapeMovieCollections } from '$lib/services/sacnilk';
import pgBoss from '../pgBoss';

const JOB_NAME = 'sync-daily-collections';
const CRON = '30 17 * * *'; // Daily at 17:30 UTC (11:00 PM IST)

export async function registerSyncDailyCollectionsWorker() {
	await pgBoss.work(JOB_NAME, async () => {
		const runningMovies = await prisma.movie.findMany({
			where: { status: 'RUNNING', sacnilkSlug: { not: null } }
		});

		for (const movie of runningMovies) {
			try {
				const { confirmed } = await scrapeMovieCollections(movie.sacnilkSlug!, movie.releaseDate);

				for (const day of confirmed) {
					const date = new Date(movie.releaseDate);
					date.setDate(date.getDate() + day.dayNumber - 1);

					await prisma.dailyCollection.upsert({
						where: { movieID_date: { movieID: movie.id, date } },
						create: {
							movieID: movie.id,
							date,
							dayNumber: day.dayNumber,
							kerala: day.kerala,
							india: day.indiaGross,
							worldwide: null,
							source: 'sacnilk'
						},
						update: {
							kerala: day.kerala,
							india: day.indiaGross
						}
					});
				}
			} catch (err) {
				console.error(`[${JOB_NAME}] Failed for movie ${movie.title}:`, err);
				// Continue to next movie — don't let one failure block others
			}
		}
	});
}

export async function scheduleSyncDailyCollections() {
	await pgBoss.createQueue(JOB_NAME);
	await pgBoss.schedule(JOB_NAME, CRON, {}, { tz: 'UTC', singletonKey: JOB_NAME });
}
