import { parse } from 'node-html-parser';

export interface ScrapedCollection {
	dayNumber: number;
	indiaGross: number | null;
	indiaNet: number | null;
	kerala: number | null;
}

export interface ScrapeResult {
	confirmed: ScrapedCollection[];
	live: ScrapedCollection | null;
}

export async function scrapeMovieCollections(
	sacnilkSlug: string,
	releaseDate: Date
): Promise<ScrapeResult> {
	const url = `https://sacnilk.com/news/${sacnilkSlug}`;

	const res = await fetch(url, {
		headers: {
			'User-Agent':
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
		}
	});

	if (!res.ok) throw new Error(`Sacnilk fetch failed: ${res.status} for ${sacnilkSlug}`);

	const html = await res.text();

	const labelsMatch = html.match(/const labels = (\[.*?\]);/);
	const grossMatch = html.match(/const grossData = (\[.*?\]);/);
	const netMatch = html.match(/const netData = (\[.*?\]);/);

	if (!labelsMatch || !grossMatch || !netMatch) {
		throw new Error(
			`Sacnilk chart data not found for ${sacnilkSlug} — page structure may have changed`
		);
	}

	const labels: string[] = JSON.parse(labelsMatch[1]);
	const grossData: number[] = JSON.parse(grossMatch[1]);
	const netData: number[] = JSON.parse(netMatch[1]);

	const root = parse(html);
	const headerCells = root.querySelectorAll('table thead th');
	const keralaColIndex = headerCells.findIndex((th) =>
		th.text.trim().toLowerCase().includes('kerala')
	);

	if (keralaColIndex === -1) {
		console.warn(`[sacnilk] Kerala column not found for ${sacnilkSlug}`);
	}

	const keralaByDay: Record<number, number | null> = {};
	for (const row of root.querySelectorAll('table tbody tr')) {
		const cells = row.querySelectorAll('td');
		if (cells.length < 2) continue;
		const dayMatch = cells[0].text.trim().match(/Day\s+(\d+)/i);
		if (!dayMatch) continue;
		const dayNumber = parseInt(dayMatch[1]);
		keralaByDay[dayNumber] =
			keralaColIndex !== -1 ? parseCrore(cells[keralaColIndex].text.trim()) : null;
	}

	const collections: ScrapedCollection[] = labels.map((label, i) => {
		const dayMatch = label.match(/\d+/);
		const dayNumber = dayMatch ? parseInt(dayMatch[0]) : i + 1;
		return {
			dayNumber,
			indiaGross: grossData[i] ?? null,
			indiaNet: netData[i] ?? null,
			kerala: keralaByDay[dayNumber] ?? null
		};
	});

	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const releaseMidnight = new Date(releaseDate);
	releaseMidnight.setHours(0, 0, 0, 0);
	const todayDayNumber =
		Math.floor((today.getTime() - releaseMidnight.getTime()) / 86400000) + 1;

	const confirmed = collections.filter((c) => c.dayNumber < todayDayNumber);
	const live = collections.find((c) => c.dayNumber === todayDayNumber) ?? null;

	return { confirmed, live };
}

function parseCrore(text: string): number | null {
	const match = text.match(/[\d.]+/);
	return match ? parseFloat(match[0]) : null;
}
