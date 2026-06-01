/**
 * Test script for the Sacnilk scraper.
 * Run with: npx tsx src/scripts/test-sacnilk-scraper.ts
 *
 * Tests against a known Malayalam movie page to verify the scraper works.
 */
import { scrapeMovieCollections } from '../lib/services/sacnilk.js';

const TEST_SLUG = 'drishyam_3_malayalam_2026_Box_Office_Collection_Day_Wise_Worldwide';
const RELEASE_DATE = new Date('2026-05-01');

async function main() {
	console.log(`Testing Sacnilk scraper for: ${TEST_SLUG}\n`);

	try {
		const result = await scrapeMovieCollections(TEST_SLUG, RELEASE_DATE);

		console.log(`Confirmed days: ${result.confirmed.length}`);
		for (const day of result.confirmed) {
			console.log(
				`  Day ${day.dayNumber}: India Gross=${day.indiaGross ?? '—'} Cr | India Net=${day.indiaNet ?? '—'} Cr | Kerala=${day.kerala ?? '—'} Cr`
			);
		}

		if (result.live) {
			console.log(`\nLive (today Day ${result.live.dayNumber}):`);
			console.log(
				`  India Gross=${result.live.indiaGross ?? '—'} Cr | India Net=${result.live.indiaNet ?? '—'} Cr | Kerala=${result.live.kerala ?? '—'} Cr`
			);
		} else {
			console.log('\nNo live data for today.');
		}

		if (result.confirmed.length === 0 && !result.live) {
			console.warn('\n⚠  No data returned — check the slug and release date.');
		} else {
			console.log('\n✓ Scraper working correctly.');
		}
	} catch (err) {
		console.error('✗ Scraper failed:', err);
		process.exit(1);
	}
}

main();
