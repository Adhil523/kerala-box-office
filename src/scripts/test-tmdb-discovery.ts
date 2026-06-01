/**
 * Test script for TMDB movie discovery.
 * Run with: TMDB_API_KEY="Bearer eyJ..." npx tsx src/scripts/test-tmdb-discovery.ts
 *
 * Fetches recent Malayalam movies from TMDB and prints them with generated Sacnilk slugs.
 */

function generateSacnilkSlug(title: string, releaseDate: string): string {
	const year = releaseDate.split('-')[0];
	const titlePart = title
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, '_')
		.trim();
	return `${titlePart}_malayalam_${year}_Box_Office_Collection_Day_Wise_Worldwide`;
}

async function main() {
	const apiKey = process.env.TMDB_API_KEY;
	if (!apiKey) {
		console.error('Error: TMDB_API_KEY env var not set.');
		console.error('Run: TMDB_API_KEY="Bearer eyJ..." npx tsx src/scripts/test-tmdb-discovery.ts');
		process.exit(1);
	}

	const url = new URL('https://api.themoviedb.org/3/discover/movie');
	url.searchParams.set('with_original_language', 'ml');
	url.searchParams.set('sort_by', 'release_date.desc');
	url.searchParams.set('region', 'IN');
	const since = new Date();
	since.setDate(since.getDate() - 60);
	url.searchParams.set('primary_release_date.gte', since.toISOString().split('T')[0]);

	console.log('Fetching latest Malayalam movies from TMDB...\n');

	const res = await fetch(url.toString(), {
		headers: { Authorization: apiKey }
	});

	if (!res.ok) {
		console.error(`TMDB request failed: ${res.status} ${res.statusText}`);
		process.exit(1);
	}

	const data = await res.json();
	const movies = data.results ?? [];

	if (movies.length === 0) {
		console.warn('No movies returned. Check the API key and date range.');
		process.exit(1);
	}

	console.log(`Found ${movies.length} movies:\n`);

	for (const movie of movies) {
		const slug = generateSacnilkSlug(movie.title, movie.release_date);
		const sacnilkUrl = `https://sacnilk.com/news/${slug}`;

		// Spot-check the Sacnilk URL
		let urlStatus = '';
		try {
			const headRes = await fetch(sacnilkUrl, {
				method: 'HEAD',
				headers: {
					'User-Agent':
						'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
				}
			});
			urlStatus = headRes.ok ? `✓ ${headRes.status} OK` : `✗ ${headRes.status}`;
		} catch {
			urlStatus = '✗ fetch error';
		}

		console.log(`${movie.title} (${movie.release_date})`);
		console.log(`  TMDB ID: ${movie.id}`);
		console.log(`  Slug: ${slug}`);
		console.log(`  Sacnilk: ${urlStatus}`);
		console.log();
	}
}

main();
