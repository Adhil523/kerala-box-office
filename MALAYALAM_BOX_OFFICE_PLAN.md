# Malayalam Box Office Tracker — Implementation Plan

## Overview

A SvelteKit web app that automatically discovers new Malayalam movies, tracks their day-wise box office collections, stores confirmed data through the previous day (n-1), and shows the current day's collection live as it gets updated throughout the day. No manual data entry required as the primary path — all data is fetched from external sources on a schedule.

---

## 1. Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | SvelteKit 2 (adapter-node) | Server-side rendering + API routes |
| ORM | Zenstack | Same as reference project |
| Database | PostgreSQL (Supabase) | Same as reference project |
| Job Queue | pg-boss | Already available in reference project |
| Styling | Tailwind CSS 4 | Same as reference project |
| Movie Metadata | TMDB API | Official, free, Malayalam language filter |
| Collection Data | Sacnilk.com scraper | Most reliable Malayalam BO source |
| HTML Parsing | node-html-parser | Lightweight, no browser dependency |

---

## 2. External APIs & Data Sources

### 2.1 TMDB API (Movie Discovery)

- **Base URL:** `https://api.themoviedb.org/3`
- **Endpoint:** `GET /discover/movie?with_original_language=ml&sort_by=release_date.desc&region=IN`
- **Key fields returned:** `id`, `title`, `original_title`, `release_date`, `poster_path`, `backdrop_path`, `overview`
- **Image base:** `https://image.tmdb.org/t/p/w500{poster_path}`
- **Requires:** `TMDB_API_KEY` env var (Bearer token from themoviedb.org)

### 2.2 Sacnilk Scraper (Box Office Collections)

- **URL pattern:** `https://sacnilk.com/news/{sacnilkSlug}`
- **Example:** `https://sacnilk.com/news/drishyam_3_malayalam_2026_Box_Office_Collection_Day_Wise_Worldwide`
- **Slug format:** `{title_underscored}_{language}_{year}_Box_Office_Collection_Day_Wise_Worldwide`
  - e.g. "Drishyam 3" (Malayalam, 2026) → `drishyam_3_malayalam_2026_Box_Office_Collection_Day_Wise_Worldwide`
- **Data sources on page (two separate):**
  1. **Embedded JS chart arrays** (`grossData`, `netData`, `labels`) — India Gross + Net per day. Most reliable.
  2. **State-wise `<table>`** — columns: Day, APTG, Tamil Nadu, Karnataka, Kerala, Rest of India, Total. Kerala column index resolved dynamically from `<th>` text.
- **Day-wise worldwide NOT available** — only a cumulative total is shown in the article text. The `worldwide` field on `DailyCollection` will remain null unless populated from another source.
- **Dates not in the table** — calculate as `releaseDate + (dayNumber − 1) days` inside the job, not the scraper.
- **Old `/movies/box-office/` URLs return 410 Gone** — do not use.

> **Note for implementer:** Sacnilk's HTML structure may change. The scraper validates that both the JS chart arrays and the `<table>` are found, and throws with a clear message if either is missing. The `sacnilkSlug` field on Movie can also be set manually by an admin if the auto-generated slug is wrong. A test script lives at `src/scripts/test-sacnilk-scraper.ts` — run it against any live movie before wiring into jobs.

---

## 3. Environment Variables

```env
# Database
DATABASE_URL=postgresql://...

# TMDB
TMDB_API_KEY=Bearer eyJ...

# pg-boss (if separate from DATABASE_URL)
POSTGRES_HOST=
POSTGRES_PORT=
POSTGRES_USER=
POSTGRES_PASSWORD=
POSTGRES_DATABASE=

# App
ORIGIN=https://your-domain.com
```

---

## 4. Prisma Schema

Add these models to the existing `schema.prisma` / `schema.zmodel`.

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
  source     String   @default("sacnilk")  // "sacnilk" | "manual"
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  movie      Movie    @relation(fields: [movieID], references: [id], onDelete: Cascade)

  @@unique([movieID, date])
  @@index([movieID])
}
```

**Key conventions (matching reference project):**
- IDs: `String @id @default(cuid())`
- Foreign keys: uppercase model prefix — `movieID`, not `movie_id`
- Timestamps: `createdAt`, `updatedAt`
- Financial: `Decimal` type for all collection values

---

## 5. Scraper Service

### 5.1 `src/lib/services/sacnilk.ts`

This is the shared scraper used by all three jobs.

Two data sources on each Sacnilk page:
1. **Embedded JS chart arrays** — `grossData` (India Gross/day) and `netData` (India Net/day)
2. **State-wise `<table>`** — contains a Kerala column (index resolved from `<th>` headers)

Day-wise worldwide is not available from Sacnilk — the `worldwide` field on `DailyCollection` is left null.
Dates are not in the scraped data — the job calculates `releaseDate + (dayNumber − 1)` before writing to DB.

```typescript
import { parse } from 'node-html-parser';

export interface ScrapedCollection {
  dayNumber: number;
  indiaGross: number | null;
  indiaNet: number | null;
  kerala: number | null;
}

export interface ScrapeResult {
  confirmed: ScrapedCollection[];  // all days except today
  live: ScrapedCollection | null;  // today's partial estimate, null if not yet published
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

  // --- Extract chart data from embedded JS ---
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

  // --- Extract Kerala from state-wise table ---
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

  // --- Combine into collections ---
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

  // Determine today's day number relative to release
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

---

## 6. pg-boss Jobs

Follow the existing pattern: each job file exports `registerXWorker()` and `scheduleX()`. Both are called from the central `setup.ts`.

### 6.1 `src/lib/pgboss/discover-movies.job.ts`

Fetches new Malayalam releases from TMDB and upserts them into the DB.

```typescript
import { pgBoss } from './pgboss';
import { dangerousPrismaDoNotUse as prisma } from '$lib/server/db';

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
  // Fetch movies released within the last 60 days
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
  const release = new Date(releaseDate);
  const now = new Date();
  const daysSinceRelease = Math.floor((now.getTime() - release.getTime()) / 86400000);

  if (daysSinceRelease < 0) return 'UPCOMING';
  if (daysSinceRelease <= 42) return 'RUNNING'; // 6-week theatrical window
  return 'COMPLETED';
}
```

### 6.2 `src/lib/pgboss/sync-daily-collections.job.ts`

Runs nightly, scrapes the confirmed collection for yesterday (n-1) for all RUNNING movies.

```typescript
import { pgBoss } from './pgboss';
import { dangerousPrismaDoNotUse as prisma } from '$lib/server/db';
import { scrapeMovieCollections } from '$lib/services/sacnilk';

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
              india: day.indiaGross,
            }
          });
        }
      } catch (err) {
        console.error(`[${JOB_NAME}] Failed for movie ${movie.title}:`, err);
        // Continue to next movie — don't let one failure block others
      }
    }
  });
}

export async function scheduleSyncDailyCollections() {
  await pgBoss.createQueue(JOB_NAME);
  await pgBoss.schedule(JOB_NAME, CRON, {}, { tz: 'UTC', singletonKey: JOB_NAME });
}
```

### 6.3 `src/lib/pgboss/sync-live-collections.job.ts`

Runs every 30 minutes during box office hours. Upserts today's partial data directly into
`DailyCollection` — same table, same upsert pattern as the nightly job.

```typescript
import { pgBoss } from './pgboss';
import { dangerousPrismaDoNotUse as prisma } from '$lib/server/db';
import { scrapeMovieCollections } from '$lib/services/sacnilk';

const JOB_NAME = 'sync-live-collections';
// Every 30 min, 03:00–17:30 UTC (8:30 AM – 11:00 PM IST)
const CRON = '*/30 3-17 * * *';

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

### 6.4 Update `src/lib/pgboss/setup.ts`

```typescript
import { scheduleDiscoverMovies, registerDiscoverMoviesWorker } from './discover-movies.job';
import { scheduleSyncDailyCollections, registerSyncDailyCollectionsWorker } from './sync-daily-collections.job';
import { scheduleSyncLiveCollections, registerSyncLiveCollectionsWorker } from './sync-live-collections.job';
// ... existing imports

export async function initializePgBossJobs() {
  await schedulePgBossJobs();
  await registerPgBossJobs();
}

async function schedulePgBossJobs() {
  // ... existing schedules
  await scheduleDiscoverMovies();
  await scheduleSyncDailyCollections();
  await scheduleSyncLiveCollections();
}

async function registerPgBossJobs() {
  // ... existing workers
  await registerDiscoverMoviesWorker();
  await registerSyncDailyCollectionsWorker();
  await registerSyncLiveCollectionsWorker();
}
```

---

## 7. API Routes

All routes under `src/routes/api/box-office/` — public, no auth required.

### 7.1 `GET /api/box-office/movies` — Running movies list

```typescript
// src/routes/api/box-office/movies/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { db } }) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const movies = await db.movie.findMany({
    where: { status: { in: ['RUNNING', 'COMPLETED'] } },
    include: { collections: { orderBy: { date: 'asc' } } },
    orderBy: { releaseDate: 'desc' }
  });

  const enriched = movies.map((movie) => {
    const liveRow = movie.collections.find(
      (c) => c.date.getTime() === today.getTime()
    );
    const grandTotal = movie.collections.reduce(
      (sum, c) => sum + Number(c.india ?? 0),
      0
    );

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

### 7.2 `GET /api/box-office/movies/[id]` — Movie detail

```typescript
// src/routes/api/box-office/movies/[id]/+server.ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { db }, params }) => {
  const movie = await db.movie.findUnique({
    where: { id: params.id },
    include: { collections: { orderBy: { dayNumber: 'asc' } } }
  });

  if (!movie) return error(404, 'Movie not found');

  return json(movie);
};
```

### 7.3 `GET /api/box-office/movies/[id]/live` — Live collection only

Polled by the frontend every 5 minutes. Queries today's `DailyCollection` row.
`updatedAt` tells the frontend when data was last scraped — used for the "as of [time]" label.

```typescript
// src/routes/api/box-office/movies/[id]/live/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { db }, params }) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const live = await db.dailyCollection.findUnique({
    where: { movieID_date: { movieID: params.id, date: today } }
  });

  return json({ live: live ?? null });
};
```

### 7.4 `GET /api/box-office/leaderboard` — All-time top grossers

```typescript
// src/routes/api/box-office/leaderboard/+server.ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals: { db } }) => {
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

### 7.5 `PATCH /api/box-office/admin/movies/[id]` — Admin overrides

For correcting sacnilkSlug, budget, or manual collection entries.

```typescript
// src/routes/api/box-office/admin/movies/[id]/+server.ts
// Protect with a simple admin check (e.g., check user role from locals)
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals: { db, user }, request, params }) => {
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

---

## 8. Frontend Pages & Components

### 8.1 Route Structure

```
src/routes/
├── +layout.svelte          ← Top nav, global styles
├── +page.svelte            ← Home: running movies grid
├── movies/
│   └── [id]/
│       └── +page.svelte    ← Movie detail: chart + day table + live counter
└── leaderboard/
    └── +page.svelte        ← All-time top grossers
```

### 8.2 `src/lib/components/MovieCard.svelte`

Shown on the home page grid.

- Poster image (lazy loaded)
- Title + release date
- Total collection (confirmed + live) in large text
- Day number badge ("Day 12")
- Status indicator: pulsing green dot if RUNNING, grey if COMPLETED
- "Live today: ₹X cr" chip if it's a running movie and live data exists
- Tap → navigate to `/movies/[id]`

### 8.3 `src/lib/components/LiveCounter.svelte`

The key component on the movie detail page. Shows today's collection with:

- Large animated number (transitions smoothly from old value to new on each poll)
- "as of [time]" label in muted text (e.g., "as of 9:42 PM")
- "Next update ~[X] min" countdown
- Polls `/api/box-office/movies/[id]/live` every 5 minutes via `setInterval`
- Uses CSS `@keyframes` number transition for the smooth tick-up effect
- If today's data is not yet available (morning), shows "Awaiting today's data"

```svelte
<!-- LiveCounter.svelte sketch -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { tweened } from 'svelte/motion';
  import { cubicOut } from 'svelte/easing';

  export let movieID: string;
  export let metric: 'worldwide' | 'india' | 'kerala' = 'worldwide';

  let displayValue = tweened(0, { duration: 1200, easing: cubicOut });
  let lastFetchedAt: Date | null = null;
  let interval: ReturnType<typeof setInterval>;

  async function fetchLive() {
    const res = await fetch(`/api/box-office/movies/${movieID}/live`);
    const { live } = await res.json();
    if (live) {
      displayValue.set(Number(live[metric] ?? 0));
      lastFetchedAt = new Date(live.updatedAt);
    }
  }

  onMount(() => {
    fetchLive();
    interval = setInterval(fetchLive, 5 * 60 * 1000); // every 5 min
  });

  onDestroy(() => clearInterval(interval));
</script>

<div class="text-center">
  <p class="text-5xl font-bold tabular-nums">₹{$displayValue.toFixed(2)} Cr</p>
  {#if lastFetchedAt}
    <p class="text-xs text-slate-500 mt-1">
      as of {lastFetchedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
    </p>
  {/if}
</div>
```

### 8.4 `src/lib/components/CollectionChart.svelte`

Day-wise bar/line chart using Chart.js (already a dependency in the reference project).

- X axis: Day 1, Day 2, Day 3...
- Y axis: Collection in crores
- Each bar is a confirmed day (from `DailyCollection`)
- The final bar (today) is a different colour (amber) and uses the live value — clearly labelled "Live"
- Tooltip shows: day number, date, Kerala / India / Worldwide breakdown
- Toggle buttons: Kerala | India | Worldwide (switches the Y axis dataset)

### 8.5 `src/lib/components/DayTable.svelte`

Table below the chart showing all confirmed days.

| Day | Date | Kerala | India | Worldwide | vs Yesterday |
|---|---|---|---|---|---|
| Day 1 | 15 May | 2.5 Cr | 8.2 Cr | 10.1 Cr | — |
| Day 2 | 16 May | 1.8 Cr | 6.1 Cr | 7.5 Cr | ▼ 26% |

- "vs Yesterday" column with coloured up/down arrows and % change
- Running total row pinned at bottom
- Sortable by any column

### 8.6 `src/lib/components/HitFlopMeter.svelte`

If `movie.budget` is set, show a horizontal progress bar:

```
Budget: ₹20 Cr
[████████████████░░░░░░░░░░] 80%
₹16.2 Cr collected — ₹3.8 Cr to break even
```

Milestones on the bar:
- `1×` budget = Break even
- `1.5×` = Hit
- `2×` = Super Hit
- `3×` = Blockbuster

The bar fills with a smooth animated transition on page load.

### 8.7 `src/lib/components/MilestoneToast.svelte`

When the user is on the detail page and a poll returns a total that crosses a milestone (50cr, 100cr, 150cr...), show a brief celebratory overlay:

- Dark overlay fades in for 3 seconds
- Large text: "🎉 [Movie] crosses ₹100 Cr!"
- Confetti animation (CSS-only, no library)
- Auto-dismisses
- Only triggers once per milestone per session (stored in sessionStorage)

---

## 9. Home Page Layout (`/`)

```
┌─────────────────────────────┐
│  Malayalam Box Office        │  ← nav
├─────────────────────────────┤
│  NOW RUNNING                 │
│  ┌──────┐ ┌──────┐ ┌──────┐ │
│  │Poster│ │Poster│ │Poster│ │  ← MovieCard grid
│  │Title │ │Title │ │Title │ │
│  │₹X Cr │ │₹X Cr │ │₹X Cr │ │
│  │Day 5●│ │Day 3●│ │Day 1●│ │
│  └──────┘ └──────┘ └──────┘ │
│                              │
│  RECENTLY COMPLETED          │
│  ┌──────┐ ┌──────┐           │
│  │      │ │      │           │
│  └──────┘ └──────┘           │
└─────────────────────────────┘
```

## 10. Movie Detail Page Layout (`/movies/[id]`)

```
┌─────────────────────────────┐
│ ← Back                       │
├─────────────────────────────┤
│ [Poster]  Title              │
│           Released: 15 May   │
│           Day 12 • RUNNING   │
├─────────────────────────────┤
│  TODAY (LIVE)                │
│  ₹2.41 Cr  ← animated       │
│  as of 9:42 PM               │
│  [Kerala][India][Worldwide]  │
├─────────────────────────────┤
│  TOTAL COLLECTION            │
│  ₹82.6 Cr (confirmed)        │
│  + ₹2.4 Cr today = ₹85 Cr   │
├─────────────────────────────┤
│  [Hit/Flop meter if budget]  │
├─────────────────────────────┤
│  [Day-wise Chart]            │
├─────────────────────────────┤
│  [Day Table]                 │
└─────────────────────────────┘
```

---

## 11. UX & Addictive Feature Suggestions

These are small, deliberate details that make the app feel alive and keep users coming back.

### 11.1 Animated Number Transitions

Every time any collection number updates — whether from a live poll or page load — the number smoothly rolls from the previous value to the new one using `svelte/motion tweened`. This mimics an odometer and makes even small updates feel significant. Duration: ~1.2 seconds, `cubicOut` easing.

### 11.2 "Next Milestone" Nudge

Below the total collection, always show the next round number:

> "₹14.8 Cr away from ₹100 Cr"

This is a tiny line of text, but it makes users want to refresh. When the movie crosses the milestone, show the `MilestoneToast`. The nudge resets to the next milestone automatically.

### 11.3 Rank Badge

On each movie card and detail page, show its current rank among all running movies:

> "#1 this week"

If the movie is an all-time top-10 grosser, show:

> "#7 all-time Malayalam"

Users immediately understand status without reading numbers.

### 11.4 Day-over-Day Trend Arrow

On the day table and movie card, show a small coloured delta:

- `▲ 12%` in green — collection grew vs yesterday
- `▼ 26%` in red — collection dropped
- No arrow on Day 1

The drop percentage is actually the most-watched number in box office tracking — a movie dropping less than 20% on Day 2 is considered "holding well". This gives enthusiasts exactly the signal they care about.

### 11.5 "Holding Well" / "Fading Fast" Tag

Derive a simple label from the last 3 days' trend:

- Average drop < 15%: `Holding Well` (green)
- Average drop 15–35%: `Steady` (amber)
- Average drop > 35%: `Fading Fast` (red)

Show this tag on both the movie card and detail page. It's the kind of label people screenshot and share.

### 11.6 Weekend Surge Indicator

On Thursday/Friday, show a small badge on running movies:

> "⬆ Weekend ahead"

This primes users to check back over the weekend. On Monday, replace with:

> "Weekend: ₹X Cr"

### 11.7 Collection Velocity

On the live counter, add a secondary line showing pace:

> "Earning at ~₹0.18 Cr/hr based on today's trajectory"

Calculated as: `liveToday / hoursElapsedToday`. Shows only after 10 AM IST when meaningful data is available. This gives a sense of momentum that a static number doesn't.

### 11.8 "Still Running in X Screens" Chip

If screen count data is available in `DailyCollection`, show on the movie card:

> "450 screens"

And on the detail page, show the trend:

> Opening: 620 screens → Today: 380 screens (-39%)

Screen hold ratio is as watched by trade analysts as collection itself.

### 11.9 Share Card

A "Share" button on the detail page generates a stylised card (via `html2canvas`, already a dependency in the reference project):

```
┌──────────────────────────────┐
│  [Poster]  MOVIE TITLE       │
│            Day 12            │
│  Total: ₹85.2 Cr             │
│  Today: ₹2.4 Cr (Live)       │
│  ████████████░░░░  Hit       │
│  via Kerala Box Office       │
└──────────────────────────────┘
```

Users share these naturally on WhatsApp and Twitter. Each share is organic distribution.

### 11.10 Compare Mode

On the detail page, a "Compare with..." dropdown lists all movies in the DB. Selecting one overlays a ghost line on the day-wise chart — a translucent version of the selected movie's trajectory on the same X axis (Day 1, Day 2...).

This is the feature that turns the app into a reference tool. People compare every new release against `Manjummel Boys` or `Premalu`.

### 11.11 All-Time Records Page (`/leaderboard`)

A ranked list of every Malayalam movie in the DB by worldwide collection. Each row shows:

- Rank
- Poster thumbnail
- Title + year
- Total collection
- Whether it's currently running (live badge)

The leaderboard updates in real-time for running movies (same poll pattern). Seeing a current movie climb the all-time list in real time is genuinely exciting.

### 11.12 Freshness Indicator

Replace "as of [time]" with a more visual indicator: a small dot that is bright green when data is < 30 minutes old, amber when 30–90 minutes, and grey when stale. This sets honest expectations and makes users trust the live number.

### 11.13 Smooth Collection Bar on Movie Cards

On the movie card, add a thin progress bar at the bottom — a subtle fill that represents the movie's collection relative to the #1 movie of the season. No numbers needed; it's purely visual and immediately communicates scale.

### 11.14 First-Week Retention Chart

On the detail page, a small secondary chart showing collection as a % of Day 1, for Days 1–7. Industry benchmark: movies with > 50% Day 2 retention are considered strong. A dashed reference line shows the benchmark. This is a power-user feature that trade enthusiasts will love.

### 11.15 "Updated X minutes ago" in the Tab Title

Change the browser tab title to include freshness:

> `Identity (updated 3m ago) | Kerala Box Office`

This keeps users aware even when they've switched tabs.

---

## 12. File Tree

```
src/
├── lib/
│   ├── services/
│   │   └── sacnilk.ts              ← scraper
│   ├── pgboss/
│   │   ├── setup.ts                ← updated to include new jobs
│   │   ├── discover-movies.job.ts
│   │   ├── sync-daily-collections.job.ts
│   │   └── sync-live-collections.job.ts
│   └── components/
│       ├── MovieCard.svelte
│       ├── LiveCounter.svelte
│       ├── CollectionChart.svelte
│       ├── DayTable.svelte
│       ├── HitFlopMeter.svelte
│       └── MilestoneToast.svelte
├── routes/
│   ├── +layout.svelte
│   ├── +page.svelte                ← home: running movies grid
│   ├── movies/
│   │   └── [id]/
│   │       └── +page.svelte        ← movie detail
│   ├── leaderboard/
│   │   └── +page.svelte            ← all-time top grossers
│   └── api/
│       └── box-office/
│           ├── movies/
│           │   ├── +server.ts      ← GET /api/box-office/movies
│           │   └── [id]/
│           │       ├── +server.ts  ← GET /api/box-office/movies/[id]
│           │       └── live/
│           │           └── +server.ts ← GET live collection
│           ├── leaderboard/
│           │   └── +server.ts
│           └── admin/
│               └── movies/
│                   └── [id]/
│                       └── +server.ts ← PATCH admin overrides
└── prisma/
    └── schema.prisma               ← add Movie, DailyCollection, LiveCollection
```

---

## 13. Implementation Order

1. **Prisma schema** — Add the three models, run `prisma migrate dev`
2. **Sacnilk scraper** (`sacnilk.ts`) — Build and test independently against a real movie slug before wiring into jobs
3. **TMDB job** (`discover-movies.job.ts`) — Get movies into the DB first
4. **Daily collections job** (`sync-daily-collections.job.ts`) — Populate historical data
5. **Live collections job** (`sync-live-collections.job.ts`) — Wire up the polling
6. **API routes** — Straightforward data reads from DB
7. **Home page + MovieCard** — Basic list view
8. **Movie detail page + LiveCounter** — Core UX
9. **CollectionChart + DayTable** — Data visualization
10. **HitFlopMeter + MilestoneToast** — Polish layer
11. **Compare mode + Leaderboard** — Depth features
12. **Share card + UX micro-details** — Final pass

---

## 14. Known Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Sacnilk changes HTML structure | Log parse failures; admin can manually override via PATCH endpoint |
| Movie not on Sacnilk | Admin sets `sacnilkSlug = null`; jobs skip it gracefully |
| TMDB rate limits (40 req/10s) | One job run fetches one page of results; well within limits |
| Live data stale during site downtime | Show freshness indicator; "Awaiting update" state instead of error |
| Wrong sacnilkSlug auto-generated | Admin PATCH endpoint corrects it; job re-runs and fills data |
| pg-boss not initialized before routes | Call `initializePgBossJobs()` in SvelteKit's `hooks.server.ts` after DB is ready |
