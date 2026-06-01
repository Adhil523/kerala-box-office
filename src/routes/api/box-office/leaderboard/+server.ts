import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { dangerousDb: db } }) => {
	const movies = await db.movie.findMany({
		include: { collections: true }
	});

	const ranked = movies
		.map((m) => ({
			...m,
			total: m.collections.reduce((s, c) => s + Number(c.india ?? 0), 0)
		}))
		.filter((m) => m.total > 0)
		.sort((a, b) => b.total - a.total)
		.slice(0, 50);

	return json(ranked);
};
