import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { dangerousDb: db }, params }) => {
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	const live = await db.dailyCollection.findUnique({
		where: { movieID_date: { movieID: params.id, date: today } }
	});

	return json({ live: live ?? null });
};
