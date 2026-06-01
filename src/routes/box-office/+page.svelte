<script lang="ts">
	import { onMount } from 'svelte';
	import MovieCard from '$lib/components/box-office/MovieCard.svelte';

	let movies: any[] = $state([]);
	let loading = $state(true);
	let fetchError = $state('');

	onMount(async () => {
		try {
			const res = await fetch('/api/box-office/movies');
			movies = await res.json();
		} catch {
			fetchError = 'Failed to load movies';
		} finally {
			loading = false;
		}
	});

	const running = $derived(movies.filter((m) => m.status === 'RUNNING'));
	const completed = $derived(movies.filter((m) => m.status === 'COMPLETED'));
</script>

<svelte:head><title>Malayalam Box Office</title></svelte:head>

<main class="max-w-5xl mx-auto px-4 py-8">
	<div class="flex items-center justify-between mb-8">
		<h1 class="text-3xl font-bold text-gray-900">Malayalam Box Office</h1>
		<a href="/box-office/leaderboard" class="text-sm text-blue-600 hover:underline"
			>All-time records →</a
		>
	</div>

	{#if loading}
		<p class="text-gray-500">Loading...</p>
	{:else if fetchError}
		<p class="text-red-500">{fetchError}</p>
	{:else}
		{#if running.length > 0}
			<section class="mb-10">
				<h2 class="text-sm font-bold text-gray-500 uppercase tracking-widest mb-4">
					Now Running
				</h2>
				<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
					{#each running as movie (movie.id)}
						<MovieCard {movie} />
					{/each}
				</div>
			</section>
		{/if}

		{#if completed.length > 0}
			<section>
				<h2 class="text-sm font-bold text-gray-500 uppercase tracking-widest mb-4">
					Recently Completed
				</h2>
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
