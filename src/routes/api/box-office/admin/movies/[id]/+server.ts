import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({
	locals: { dangerousDb: db, user },
	request,
	params
}) => {
	if (!user?.isAdmin) return error(403, 'Forbidden');

	const body = await request.json();
	const { sacnilkSlug, budget, status } = body;

	const updated = await db.movie.update({
		where: { id: params.id },
		data: { sacnilkSlug, budget, status }
	});

	return json(updated);
};
