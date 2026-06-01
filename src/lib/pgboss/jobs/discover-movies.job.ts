import { dangerousPrismaDoNotUse as prisma } from '$lib/server/prisma';
import pgBoss from '../pgBoss';

const JOB_NAME = 'discover-movies';
const CRON = '30 0 * * *'; // Daily at 00:30 UTC (6:00 AM IST)

export async function registerDiscoverMoviesWorker() {
	await pgBoss.work(JOB_NAME, async () => {
		try {
			const movies = await fetchLatestMalayalamMovies();

			for (const movie of movies) {
				await prisma.movie.upsert({
					where: { tmdbID: movie.id },
					create: {
						tmdbID: movie.id,
						title: movie.title,
						originalTitle: movie.original_title,
						releaseDate: new Date(movie.release_date),
						posterURL: movie.poster_path
							? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
							: null,
						backdropURL: movie.backdrop_path
							? `https://image.tmdb.org/t/p/original${movie.backdrop_path}`
							: null,
						overview: movie.overview,
						sacnilkSlug: generateSacnilkSlug(movie.title, movie.release_date),
						status: deriveStatus(movie.release_date)
					},
					update: {
						title: movie.title,
						posterURL: movie.poster_path
							? `https://image.tmdb.org/t/p/w500${movie.poster_path}`
							: null,
						status: deriveStatus(movie.release_date)
					}
				});
			}
		} catch (err) {
			console.error(`[${JOB_NAME}] Failed:`, err);
			throw err;
		}
	});
}

export async function scheduleDiscoverMovies() {
	await pgBoss.createQueue(JOB_NAME);
	await pgBoss.schedule(JOB_NAME, CRON, {}, { tz: 'UTC', singletonKey: JOB_NAME });
}

async function fetchLatestMalayalamMovies() {
	const url = new URL('https://api.themoviedb.org/3/discover/movie');
	url.searchParams.set('with_original_language', 'ml');
	url.searchParams.set('sort_by', 'release_date.desc');
	url.searchParams.set('region', 'IN');
	const since = new Date();
	since.setDate(since.getDate() - 60);
	url.searchParams.set('primary_release_date.gte', since.toISOString().split('T')[0]);

	const res = await fetch(url.toString(), {
		headers: { Authorization: process.env.TMDB_API_KEY! }
	});

	const data = await res.json();
	return data.results ?? [];
}

function generateSacnilkSlug(title: string, releaseDate: string): string {
	const year = releaseDate.split('-')[0];
	const titlePart = title
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, '_')
		.trim();
	return `${titlePart}_malayalam_${year}_Box_Office_Collection_Day_Wise_Worldwide`;
}

function deriveStatus(releaseDate: string): 'UPCOMING' | 'RUNNING' | 'COMPLETED' {
	const daysSince = Math.floor((Date.now() - new Date(releaseDate).getTime()) / 86400000);
	if (daysSince < 0) return 'UPCOMING';
	if (daysSince <= 42) return 'RUNNING';
	return 'COMPLETED';
}
