import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { dangerousDb: db }, params }) => {
	const movie = await db.movie.findUnique({
		where: { id: params.id },
		include: { collections: { orderBy: { dayNumber: 'asc' } } }
	});

	if (!movie) return error(404, 'Movie not found');

	return json(movie);
};
