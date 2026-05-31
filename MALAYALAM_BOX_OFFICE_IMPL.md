# Malayalam Box Office Tracker — Step-by-Step Implementation Guide

## How to use this guide

Each step is a discrete unit of work. After completing a step, **stop and wait for review and approval** before proceeding to the next one. Do not combine steps. If anything is ambiguous within a step, ask before implementing.

---

## Codebase context (read before starting)

This is a SvelteKit 2 + Prisma + ZenStack project already in production. The following conventions are established and **must be followed exactly**:

### Schema
- The source of truth for the schema is **`schema.zmodel`** (ZenStack), NOT `prisma/schema.prisma`. Always edit `schema.zmodel`. After editing, run `pnpm zenstack generate` which regenerates `prisma/schema.prisma` and the Prisma client, then run `pnpm prisma migrate dev --name <migration-name>` to apply the migration.
- Model IDs: `String @id @default(cuid())`
- Foreign keys: uppercase model name prefix — `movieID`, not `movieId` or `movie_id`
- Timestamps on every model: `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt`
- Financial values: `Decimal?` type

### DB access
- **In pg-boss jobs**: `import { dangerousPrismaDoNotUse as prisma } from '$lib/server/prisma'`
- **In API routes**: `locals.dangerousDb` (already typed via `src/app.d.ts`)
- Never use `locals.db` in routes that don't need auth checks — use `locals.dangerousDb`

### pg-boss jobs
- Job files live in `src/lib/pgboss/jobs/`
- Each job file exports two functions: `scheduleX()` and `registerXWorker()`
- Both are registered in `src/lib/pgboss/setup.ts`
- pgBoss instance is imported as: `import pgBoss from '../pgBoss'`
- Pattern: `pgBoss.createQueue(JOB_NAME)` → `pgBoss.schedule(...)` in `scheduleX()`, and `pgBoss.work(JOB_NAME, handler)` in `registerXWorker()`

### Styling
- Tailwind CSS 4. Use utility classes. No custom CSS unless unavoidable.
- Look at existing Svelte components in `src/lib/components/` for style patterns.

### Test scripts
- Runnable with `npx tsx src/scripts/<name>.ts`
- Two test scripts already exist:
  - `src/scripts/test-sacnilk-scraper.ts` — validates the Sacnilk scraper against the live Drishyam 3 page
  - `src/scripts/test-tmdb-discovery.ts` — tests TMDB API (requires `TMDB_API_KEY` env var)

---

## Step 1 — Add `TMDB_API_KEY` to environment

**What to do:**
Add `TMDB_API_KEY=Bearer eyJ...` to the `.env` file.

Get the Bearer token ("API Read Access Token") from: https://www.themoviedb.org/settings/api

**Verify before proceeding:**
Run the test script and confirm it outputs Malayalam movies with correct slugs:
```
TMDB_API_KEY="Bearer eyJ..." npx tsx src/scripts/test-tmdb-discovery.ts
```
Expected: a list of Malayalam movies released in the last 60 days, each with a `sacnilkSlug` and a Sacnilk URL spot-check result. At least one movie should show `✓ 200 OK`.

For now, just create .env and .env.example. The user will manually add keys later. In both fields, add just the key name now.
---

## Step 2 — Prisma schema: add `Movie` and `DailyCollection` models

**What to do:**
Open `schema.zmodel`. Add the following two models and the enum **at the end of the file**, after all existing models:

```prisma
enum MovieStatus {
  UPCOMING
  RUNNING
  COMPLETED
}

model Movie {
  id            String      @id @default(cuid())
  tmdbID        Int         @unique
  title         String
  originalTitle String
  releaseDate   DateTime    @db.Date
  posterURL     String?
  backdropURL   String?
  overview      String?
  budget        Decimal?
  sacnilkSlug   String?
  status        MovieStatus @default(UPCOMING)
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  collections   DailyCollection[]
}

model DailyCollection {
  id         String   @id @default(cuid())
  movieID    String
  date       DateTime @db.Date
  dayNumber  Int
  kerala     Decimal?
  india      Decimal?
  worldwide  Decimal?
  screens    Int?
  source     String   @default("sacnilk")
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  movie      Movie    @relation(fields: [movieID], references: [id], onDelete: Cascade)

  @@unique([movieID, date])
  @@index([movieID])
}
```

Then run:
```
pnpm zenstack generate
pnpm prisma migrate dev --name add-box-office-models
```

**Verify before proceeding:**
- Migration ran without errors
- `prisma/schema.prisma` contains the new models
- `pnpm prisma studio` shows the new `Movie` and `DailyCollection` tables (optional sanity check)

---

## Step 3 — Sacnilk scraper service

**What to do:**
Install the HTML parser dependency:
```
pnpm add node-html-parser
```

Create `src/lib/services/sacnilk.ts` with the following implementation:

```typescript
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
```

**Verify before proceeding:**
Run the existing test script and confirm it still outputs correct data:
```
npx tsx src/scripts/test-sacnilk-scraper.ts
```
Expected: 10–12 days parsed, all three columns (India Gross, India Net, Kerala) populated.

---

## Step 4 — pg-boss job: `discover-movies`

**What to do:**
Create `src/lib/pgboss/jobs/discover-movies.job.ts`:

```typescript
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
```

Then register it in `src/lib/pgboss/setup.ts`. Add these imports at the top alongside the existing ones:
```typescript
import { registerDiscoverMoviesWorker, scheduleDiscoverMovies } from './jobs/discover-movies.job';
```

Add to `schedulePgBossJobs`:
```typescript
await scheduleDiscoverMovies();
```

Add to `registerPgBossJobs`:
```typescript
await registerDiscoverMoviesWorker();
```

**Verify before proceeding:**
- TypeScript compiles without errors: `pnpm check`
- Trigger the job manually once to seed the DB. You can do this by temporarily adding a one-shot `pgBoss.send(JOB_NAME, {})` call in a dev-only route, or by running the `fetchLatestMalayalamMovies` logic directly in a test script.
- Check `prisma studio` or a raw DB query — `Movie` table should now have rows.

---

## Step 5 — pg-boss job: `sync-daily-collections`

**What to do:**
Create `src/lib/pgboss/jobs/sync-daily-collections.job.ts`:

```typescript
import { dangerousPrismaDoNotUse as prisma } from '$lib/server/prisma';
import { scrapeMovieCollections } from '$lib/services/sacnilk';
import pgBoss from '../pgBoss';

const JOB_NAME = 'sync-daily-collections';
const CRON = '30 17 * * *'; // Daily at 17:30 UTC (11:00 PM IST)

export async function registerSyncDailyCollectionsWorker() {
  await pgBoss.work(JOB_NAME, async () => {
    const runningMovies = await prisma.movie.findMany({
      where: { status: 'RUNNING', sacnilkSlug: { not: null } }
    });

    for (const movie of runningMovies) {
      try {
        const { confirmed } = await scrapeMovieCollections(movie.sacnilkSlug!, movie.releaseDate);

        for (const day of confirmed) {
          const date = new Date(movie.releaseDate);
          date.setDate(date.getDate() + day.dayNumber - 1);

          await prisma.dailyCollection.upsert({
            where: { movieID_date: { movieID: movie.id, date } },
            create: {
              movieID: movie.id,
              date,
              dayNumber: day.dayNumber,
              kerala: day.kerala,
              india: day.indiaGross,
              worldwide: null,
              source: 'sacnilk'
            },
            update: {
              kerala: day.kerala,
              india: day.indiaGross
            }
          });
        }
      } catch (err) {
        console.error(`[${JOB_NAME}] Failed for movie ${movie.title}:`, err);
      }
    }
  });
}

export async function scheduleSyncDailyCollections() {
  await pgBoss.createQueue(JOB_NAME);
  await pgBoss.schedule(JOB_NAME, CRON, {}, { tz: 'UTC', singletonKey: JOB_NAME });
}
```

Register in `src/lib/pgboss/setup.ts` (same pattern as Step 4):
```typescript
import { registerSyncDailyCollectionsWorker, scheduleSyncDailyCollections } from './jobs/sync-daily-collections.job';
// add to schedulePgBossJobs: await scheduleSyncDailyCollections();
// add to registerPgBossJobs: await registerSyncDailyCollectionsWorker();
```

**Verify before proceeding:**
- `pnpm check` passes
- Trigger the job manually for one RUNNING movie (add a temporary test script that calls `scrapeMovieCollections` and upserts for one known movie ID)
- Confirm rows appear in `DailyCollection` with correct `kerala` and `india` values

---

## Step 6 — pg-boss job: `sync-live-collections`

**What to do:**
Create `src/lib/pgboss/jobs/sync-live-collections.job.ts`:

```typescript
import { dangerousPrismaDoNotUse as prisma } from '$lib/server/prisma';
import { scrapeMovieCollections } from '$lib/services/sacnilk';
import pgBoss from '../pgBoss';

const JOB_NAME = 'sync-live-collections';
const CRON = '*/30 3-17 * * *'; // Every 30 min, 8:30 AM – 11:00 PM IST

export async function registerSyncLiveCollectionsWorker() {
  await pgBoss.work(JOB_NAME, async () => {
    const runningMovies = await prisma.movie.findMany({
      where: { status: 'RUNNING', sacnilkSlug: { not: null } }
    });

    for (const movie of runningMovies) {
      try {
        const { live } = await scrapeMovieCollections(movie.sacnilkSlug!, movie.releaseDate);
        if (!live) continue;

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        await prisma.dailyCollection.upsert({
          where: { movieID_date: { movieID: movie.id, date: today } },
          create: {
            movieID: movie.id,
            date: today,
            dayNumber: live.dayNumber,
            kerala: live.kerala,
            india: live.indiaGross,
            worldwide: null,
            source: 'sacnilk'
          },
          update: {
            kerala: live.kerala,
            india: live.indiaGross
          }
        });
      } catch (err) {
        console.error(`[${JOB_NAME}] Failed for movie ${movie.title}:`, err);
      }
    }
  });
}

export async function scheduleSyncLiveCollections() {
  await pgBoss.createQueue(JOB_NAME);
  await pgBoss.schedule(JOB_NAME, CRON, {}, { tz: 'UTC', singletonKey: JOB_NAME });
}
```

Register in `setup.ts` (same pattern).

**Verify before proceeding:**
- `pnpm check` passes
- Manually trigger the job; if it's daytime in IST and a movie is running, a row should appear in `DailyCollection` with today's date
- Confirm that running the job a second time upserts (updates values) without creating duplicate rows

---

## Step 7 — API routes

**What to do:**
Create the following five files. All routes are under `src/routes/api/box-office/` and are public (no auth required) — use `locals.dangerousDb`.

### `src/routes/api/box-office/movies/+server.ts`
```typescript
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
```

### `src/routes/api/box-office/movies/[id]/+server.ts`
```typescript
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
```

### `src/routes/api/box-office/movies/[id]/live/+server.ts`
```typescript
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
```

### `src/routes/api/box-office/leaderboard/+server.ts`
```typescript
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
```

### `src/routes/api/box-office/admin/movies/[id]/+server.ts`
```typescript
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals: { dangerousDb: db, user }, request, params }) => {
  if (!user?.isAdmin) return error(403, 'Forbidden');

  const body = await request.json();
  const { sacnilkSlug, budget, status } = body;

  const updated = await db.movie.update({
    where: { id: params.id },
    data: { sacnilkSlug, budget, status }
  });

  return json(updated);
};
```

**Verify before proceeding:**
- `pnpm check` passes
- Start the dev server (`pnpm dev`) and hit each endpoint:
  - `GET /api/box-office/movies` — returns array (may be empty if DB has no RUNNING movies yet)
  - `GET /api/box-office/leaderboard` — returns array
  - `GET /api/box-office/movies/<valid-id>` — returns the movie with collections
  - `GET /api/box-office/movies/<valid-id>/live` — returns `{ live: null }` or live data

---

## Step 8 — Home page and `MovieCard` component

**What to do:**

Create `src/lib/components/box-office/MovieCard.svelte`:

```svelte
<script lang="ts">
  export let movie: {
    id: string;
    title: string;
    posterURL: string | null;
    releaseDate: string;
    status: 'RUNNING' | 'COMPLETED' | 'UPCOMING';
    grandTotal: number;
    liveToday: number;
    dayNumber: number;
  };

  $: isRunning = movie.status === 'RUNNING';
  $: displayTotal = movie.grandTotal.toFixed(2);
</script>

<a href="/box-office/movies/{movie.id}" class="block rounded-xl overflow-hidden shadow-md hover:shadow-lg transition-shadow bg-white">
  <div class="relative">
    {#if movie.posterURL}
      <img src={movie.posterURL} alt={movie.title} class="w-full aspect-[2/3] object-cover" loading="lazy" />
    {:else}
      <div class="w-full aspect-[2/3] bg-gray-200 flex items-center justify-center text-gray-400 text-sm">No poster</div>
    {/if}

    <div class="absolute top-2 right-2">
      {#if isRunning}
        <span class="flex items-center gap-1 bg-green-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
          <span class="w-1.5 h-1.5 rounded-full bg-white animate-pulse"></span>
          Day {movie.dayNumber}
        </span>
      {:else}
        <span class="bg-gray-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full">
          Day {movie.dayNumber}
        </span>
      {/if}
    </div>
  </div>

  <div class="p-3">
    <p class="font-semibold text-sm text-gray-900 truncate">{movie.title}</p>
    <p class="text-xl font-bold text-blue-700 mt-1">₹{displayTotal} Cr</p>
    {#if isRunning && movie.liveToday > 0}
      <p class="text-xs text-green-600 font-medium mt-0.5">Live today: ₹{movie.liveToday.toFixed(2)} Cr</p>
    {/if}
  </div>
</a>
```

Create/update `src/routes/box-office/+page.svelte` (new route, not replacing the existing home page):

```svelte
<script lang="ts">
  import MovieCard from '$lib/components/box-office/MovieCard.svelte';

  let movies: any[] = [];
  let loading = true;
  let error = '';

  async function load() {
    try {
      const res = await fetch('/api/box-office/movies');
      movies = await res.json();
    } catch {
      error = 'Failed to load movies';
    } finally {
      loading = false;
    }
  }

  import { onMount } from 'svelte';
  onMount(load);

  $: running = movies.filter((m) => m.status === 'RUNNING');
  $: completed = movies.filter((m) => m.status === 'COMPLETED');
</script>

<svelte:head><title>Malayalam Box Office</title></svelte:head>

<main class="max-w-5xl mx-auto px-4 py-8">
  <h1 class="text-3xl font-bold text-gray-900 mb-8">Malayalam Box Office</h1>

  {#if loading}
    <p class="text-gray-500">Loading...</p>
  {:else if error}
    <p class="text-red-500">{error}</p>
  {:else}
    {#if running.length > 0}
      <section class="mb-10">
        <h2 class="text-sm font-bold text-gray-500 uppercase tracking-widest mb-4">Now Running</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {#each running as movie (movie.id)}
            <MovieCard {movie} />
          {/each}
        </div>
      </section>
    {/if}

    {#if completed.length > 0}
      <section>
        <h2 class="text-sm font-bold text-gray-500 uppercase tracking-widest mb-4">Recently Completed</h2>
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
          {#each completed as movie (movie.id)}
            <MovieCard {movie} />
          {/each}
        </div>
      </section>
    {/if}

    {#if movies.length === 0}
      <p class="text-gray-500">No movies yet. Run the discover-movies job to populate.</p>
    {/if}
  {/if}
</main>
```

Note: This creates a new `/box-office` route, not touching the existing `/` home page.

**Verify before proceeding:**
- Open `http://localhost:5173/box-office` in a browser
- If DB has movies: grid renders correctly, posters load, totals show
- If DB is empty: "No movies yet" message shows
- Clicking a card navigates to `/box-office/movies/[id]` (404 is expected until Step 9)

---

## Step 9 — Movie detail page and `LiveCounter` component

**What to do:**

Create `src/lib/components/box-office/LiveCounter.svelte`:

```svelte
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import { tweened } from 'svelte/motion';

  export let movieID: string;
  export let metric: 'india' | 'kerala' = 'india';

  const displayValue = tweened(0, { duration: 1200, easing: cubicOut });
  let lastUpdatedAt: Date | null = null;
  let interval: ReturnType<typeof setInterval>;

  async function fetchLive() {
    try {
      const res = await fetch(`/api/box-office/movies/${movieID}/live`);
      const { live } = await res.json();
      if (live) {
        displayValue.set(Number(live[metric] ?? 0));
        lastUpdatedAt = new Date(live.updatedAt);
      }
    } catch {
      // silently keep showing last value
    }
  }

  onMount(() => {
    fetchLive();
    interval = setInterval(fetchLive, 5 * 60 * 1000);
  });

  onDestroy(() => clearInterval(interval));

  $: timeLabel = lastUpdatedAt
    ? lastUpdatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : null;
</script>

<div class="text-center">
  {#if $displayValue > 0}
    <p class="text-5xl font-bold tabular-nums text-blue-700">₹{$displayValue.toFixed(2)} Cr</p>
    {#if timeLabel}
      <p class="text-xs text-gray-500 mt-1">as of {timeLabel}</p>
    {/if}
  {:else}
    <p class="text-sm text-gray-400">Awaiting today's data</p>
  {/if}
</div>
```

Create `src/routes/box-office/movies/[id]/+page.svelte`:

```svelte
<script lang="ts">
  import { page } from '$app/stores';
  import LiveCounter from '$lib/components/box-office/LiveCounter.svelte';
  import { onMount } from 'svelte';

  let movie: any = null;
  let loading = true;
  let error = '';

  onMount(async () => {
    try {
      const res = await fetch(`/api/box-office/movies/${$page.params.id}`);
      if (!res.ok) { error = 'Movie not found'; return; }
      movie = await res.json();
    } catch {
      error = 'Failed to load movie';
    } finally {
      loading = false;
    }
  });

  $: confirmedCollections = movie?.collections?.filter(
    (c: any) => new Date(c.date).toDateString() !== new Date().toDateString()
  ) ?? [];

  $: confirmedTotal = confirmedCollections.reduce(
    (sum: number, c: any) => sum + Number(c.india ?? 0), 0
  );

  $: releaseYear = movie ? new Date(movie.releaseDate).getFullYear() : '';
</script>

<svelte:head>
  {#if movie}<title>{movie.title} | Box Office</title>{/if}
</svelte:head>

<main class="max-w-3xl mx-auto px-4 py-8">
  <a href="/box-office" class="text-sm text-blue-600 hover:underline mb-6 block">← Back</a>

  {#if loading}
    <p class="text-gray-500">Loading...</p>
  {:else if error}
    <p class="text-red-500">{error}</p>
  {:else if movie}

    <!-- Header -->
    <div class="flex gap-4 mb-8">
      {#if movie.posterURL}
        <img src={movie.posterURL} alt={movie.title} class="w-24 rounded-lg shadow" />
      {/if}
      <div>
        <h1 class="text-2xl font-bold text-gray-900">{movie.title}</h1>
        <p class="text-sm text-gray-500 mt-1">
          Released {new Date(movie.releaseDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}
        </p>
        <p class="text-sm font-semibold mt-1 {movie.status === 'RUNNING' ? 'text-green-600' : 'text-gray-500'}">
          Day {movie.collections.length} · {movie.status}
        </p>
      </div>
    </div>

    <!-- Live counter -->
    {#if movie.status === 'RUNNING'}
      <section class="bg-blue-50 rounded-xl p-6 mb-6 text-center">
        <p class="text-xs font-bold text-blue-400 uppercase tracking-widest mb-2">Today (Live)</p>
        <LiveCounter movieID={movie.id} metric="india" />
      </section>
    {/if}

    <!-- Total collection -->
    <section class="bg-white rounded-xl border border-gray-200 p-6 mb-6">
      <p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">Total Collection</p>
      <p class="text-3xl font-bold text-gray-900">
        ₹{confirmedTotal.toFixed(2)} Cr
        <span class="text-sm font-normal text-gray-400">(confirmed)</span>
      </p>
    </section>

    <!-- Day table -->
    {#if confirmedCollections.length > 0}
      <section class="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table class="w-full text-sm">
          <thead class="bg-gray-50 border-b border-gray-200">
            <tr>
              <th class="text-left px-4 py-3 font-semibold text-gray-600">Day</th>
              <th class="text-left px-4 py-3 font-semibold text-gray-600">Date</th>
              <th class="text-right px-4 py-3 font-semibold text-gray-600">Kerala</th>
              <th class="text-right px-4 py-3 font-semibold text-gray-600">India</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-gray-100">
            {#each confirmedCollections as c}
              <tr class="hover:bg-gray-50">
                <td class="px-4 py-3 font-medium text-gray-800">Day {c.dayNumber}</td>
                <td class="px-4 py-3 text-gray-500">
                  {new Date(c.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                </td>
                <td class="px-4 py-3 text-right text-gray-700">
                  {c.kerala ? `₹${Number(c.kerala).toFixed(2)} Cr` : '—'}
                </td>
                <td class="px-4 py-3 text-right font-semibold text-gray-900">
                  {c.india ? `₹${Number(c.india).toFixed(2)} Cr` : '—'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}

  {/if}
</main>
```

**Verify before proceeding:**
- Open `/box-office/movies/<id>` for a RUNNING movie — header, live counter, total, and day table all render
- The live counter shows "Awaiting today's data" or a value depending on whether today's scrape has run
- Open `/box-office/movies/<id>` for a COMPLETED movie — no live counter section shown
- Numbers look correct against what the Sacnilk test script reported

---

## Step 10 — Leaderboard page

**What to do:**
Create `src/routes/box-office/leaderboard/+page.svelte`:

```svelte
<script lang="ts">
  import { onMount } from 'svelte';

  let movies: any[] = [];
  let loading = true;

  onMount(async () => {
    const res = await fetch('/api/box-office/leaderboard');
    movies = await res.json();
    loading = false;
  });
</script>

<svelte:head><title>All-Time Leaderboard | Malayalam Box Office</title></svelte:head>

<main class="max-w-3xl mx-auto px-4 py-8">
  <a href="/box-office" class="text-sm text-blue-600 hover:underline mb-6 block">← Back</a>
  <h1 class="text-2xl font-bold text-gray-900 mb-6">All-Time Top Grossers</h1>

  {#if loading}
    <p class="text-gray-500">Loading...</p>
  {:else}
    <div class="bg-white rounded-xl border border-gray-200 overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="text-left px-4 py-3 font-semibold text-gray-600 w-10">#</th>
            <th class="text-left px-4 py-3 font-semibold text-gray-600">Movie</th>
            <th class="text-right px-4 py-3 font-semibold text-gray-600">Total (India)</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">
          {#each movies as m, i}
            <tr class="hover:bg-gray-50">
              <td class="px-4 py-3 text-gray-400 font-medium">{i + 1}</td>
              <td class="px-4 py-3">
                <a href="/box-office/movies/{m.id}" class="font-medium text-gray-900 hover:text-blue-600">
                  {m.title}
                </a>
                <span class="text-xs text-gray-400 ml-2">{new Date(m.releaseDate).getFullYear()}</span>
                {#if m.status === 'RUNNING'}
                  <span class="ml-2 inline-flex items-center gap-1 text-xs text-green-600 font-semibold">
                    <span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>Live
                  </span>
                {/if}
              </td>
              <td class="px-4 py-3 text-right font-bold text-gray-900">₹{m.total.toFixed(2)} Cr</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</main>
```

Add a link to the leaderboard from the home page (`/box-office/+page.svelte`) in the heading area:
```svelte
<div class="flex items-center justify-between mb-8">
  <h1 class="text-3xl font-bold text-gray-900">Malayalam Box Office</h1>
  <a href="/box-office/leaderboard" class="text-sm text-blue-600 hover:underline">All-time records →</a>
</div>
```

**Verify before proceeding:**
- `/box-office/leaderboard` renders the ranked list correctly
- Rankings match expected collection values
- Clicking a row navigates to the movie detail page
- Live badge shows for RUNNING movies

---

## Step 11 — UX polish: day-over-day trend, holding/fading tag, animated numbers

This step adds three engagement features. Implement them one at a time within the same step.

### 11a. Day-over-day trend arrows in the day table

In the detail page's day table, add a "vs Yesterday" column that shows `▲ X%` or `▼ X%`. Compute this in the `<script>` block:

```typescript
$: withTrend = confirmedCollections.map((c: any, i: number) => {
  if (i === 0) return { ...c, trend: null };
  const prev = Number(confirmedCollections[i - 1].india ?? 0);
  const curr = Number(c.india ?? 0);
  if (prev === 0) return { ...c, trend: null };
  const pct = ((curr - prev) / prev) * 100;
  return { ...c, trend: pct };
});
```

Render in the table row:
```svelte
<td class="px-4 py-3 text-right text-xs font-semibold {c.trend > 0 ? 'text-green-600' : 'text-red-500'}">
  {#if c.trend !== null}
    {c.trend > 0 ? '▲' : '▼'} {Math.abs(c.trend).toFixed(1)}%
  {:else}—{/if}
</td>
```

### 11b. "Holding Well / Steady / Fading Fast" tag on the movie detail page

Add below the status line in the header section. Compute from the last 3 confirmed days:

```typescript
$: trend = (() => {
  const last3 = confirmedCollections.slice(-3);
  if (last3.length < 2) return null;
  const drops = last3.slice(1).map((c: any, i: number) => {
    const prev = Number(last3[i].india ?? 0);
    const curr = Number(c.india ?? 0);
    return prev > 0 ? ((prev - curr) / prev) * 100 : 0;
  });
  const avg = drops.reduce((a: number, b: number) => a + b, 0) / drops.length;
  if (avg < 15) return { label: 'Holding Well', color: 'text-green-600 bg-green-50' };
  if (avg < 35) return { label: 'Steady', color: 'text-amber-600 bg-amber-50' };
  return { label: 'Fading Fast', color: 'text-red-600 bg-red-50' };
})();
```

Render as a pill badge next to the status:
```svelte
{#if trend && movie.status === 'RUNNING'}
  <span class="text-xs font-semibold px-2 py-0.5 rounded-full {trend.color}">{trend.label}</span>
{/if}
```

### 11c. Animated number on total collection

The `LiveCounter` already uses `svelte/motion tweened`. Apply the same pattern to the confirmed total on the detail page — wrap `confirmedTotal` in a tweened store so it animates on page load.

**Verify before proceeding:**
- Trend arrows show in day table (green up, red down)
- "Holding Well / Fading Fast" badge shows for RUNNING movies with enough days of data
- Total collection animates smoothly on page load
- No console errors

---

## Step 12 — Nav link and routing cleanup

**What to do:**
This step ensures the box office section is discoverable from the rest of the app.

1. In the existing app layout (`src/routes/+layout.svelte` or wherever the global nav lives), add a "Box Office" nav link pointing to `/box-office`.

2. Check `src/routes/box-office/+layout.svelte` — if it doesn't exist, create a minimal one that inherits the app shell but doesn't add anything:
```svelte
<slot />
```
(or use the existing `+layout.svelte` if the route is inside an existing layout group)

3. Ensure all three routes (`/box-office`, `/box-office/movies/[id]`, `/box-office/leaderboard`) are accessible and don't require authentication. If the existing app wraps everything in an auth guard layout group (like `(secure)`), these routes must be placed **outside** that group.

**Verify before proceeding:**
- Nav link visible and functional
- All three pages load without login prompt
- Back-navigation works from detail and leaderboard pages

---

## Deferred features (do not implement until explicitly instructed)

The following features from the UX plan are deliberately excluded from this implementation guide. They are addictive extras, not core functionality. Implement them only after Steps 1–12 are reviewed and approved:

- **`HitFlopMeter`** — needs `budget` field populated per movie (manual data entry)
- **`MilestoneToast`** — celebratory overlay when live total crosses 50/100/150 Cr milestones
- **`CollectionChart`** — Chart.js day-wise bar chart with Kerala/India toggle
- **Compare mode** — overlay ghost line of a second movie on the chart
- **Share card** — html2canvas-based shareable image
- **Collection velocity** — ₹X Cr/hr pace indicator on the live counter
- **Weekend surge badge** — "⬆ Weekend ahead" / "Weekend: ₹X Cr"
- **Tab title freshness** — `Movie (updated 3m ago) | Kerala Box Office`
- **First-week retention chart** — Day 1–7 collection as % of Day 1

---

## Known issues to watch for

| Issue | What to do |
|---|---|
| Sacnilk page returns non-200 for a movie | Check the auto-generated slug. Correct it manually via the admin PATCH endpoint (`sacnilkSlug`). Use `test-sacnilk-scraper.ts` to test the corrected slug before saving. |
| Sacnilk changes HTML structure | The scraper throws a clear error. Check that `grossData`, `netData`, `labels` JS arrays and the `<table>` are still present on the page. |
| TMDB returns 401 | `TMDB_API_KEY` is wrong or missing. The key must be the "API Read Access Token" (Bearer JWT), not the shorter v3 API key. |
| Movie shows 0 collections | The `sync-daily-collections` job hasn't run yet, or the sacnilkSlug is wrong. Trigger manually and check logs. |
| `pnpm zenstack generate` fails | Check that the new models in `schema.zmodel` don't have syntax errors, and that the ZenStack access policy rules (if any) are correctly formed. |
