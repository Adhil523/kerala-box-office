import PgBoss from 'pg-boss';

const globalForPgBoss = globalThis as unknown as { pgBoss: PgBoss };

function createPgBoss() {
	return new PgBoss({
		connectionString: process.env.DATABASE_URL!,
		schema: 'pgboss'
	});
}

const pgBoss: PgBoss = globalForPgBoss.pgBoss || createPgBoss();

if (process.env.NODE_ENV !== 'production') {
	globalForPgBoss.pgBoss = pgBoss;
}

export default pgBoss;
