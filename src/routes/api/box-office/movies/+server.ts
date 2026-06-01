import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { dangerousDb: db } }) => {
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	const movies = await db.movie.findMany({
		where: { status: { in: ['RUNNING', 'COMPLETED'] } },
		include: { collections: { orderBy: { date: 'asc' } } },
		orderBy: { releaseDate: 'desc' }
	});

	const enriched = movies.map((movie) => {
		const liveRow = movie.collections.find((c) => c.date.getTime() === today.getTime());
		const grandTotal = movie.collections.reduce((sum, c) => sum + Number(c.india ?? 0), 0);

		return {
			...movie,
			liveToday: liveRow ? Number(liveRow.india ?? 0) : 0,
			liveUpdatedAt: liveRow?.updatedAt ?? null,
			grandTotal,
			dayNumber: movie.collections.length
		};
	});

	enriched.sort((a, b) => {
		if (a.status === 'RUNNING' && b.status !== 'RUNNING') return -1;
		if (a.status !== 'RUNNING' && b.status === 'RUNNING') return 1;
		return b.grandTotal - a.grandTotal;
	});

	return json(enriched);
};
