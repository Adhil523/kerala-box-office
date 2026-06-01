<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { tweened } from 'svelte/motion';
	import LiveCounter from '$lib/components/box-office/LiveCounter.svelte';

	let movie: any = $state(null);
	let loading = $state(true);
	let fetchError = $state('');

	const animatedTotal = tweened(0, { duration: 1000, easing: cubicOut });

	onMount(async () => {
		try {
			const res = await fetch(`/api/box-office/movies/${$page.params.id}`);
			if (!res.ok) {
				fetchError = 'Movie not found';
				return;
			}
			movie = await res.json();
		} catch {
			fetchError = 'Failed to load movie';
		} finally {
			loading = false;
		}
	});

	const confirmedCollections = $derived(
		movie?.collections?.filter(
			(c: any) => new Date(c.date).toDateString() !== new Date().toDateString()
		) ?? []
	);

	const confirmedTotal = $derived(
		confirmedCollections.reduce((sum: number, c: any) => sum + Number(c.india ?? 0), 0)
	);

	// Animate total when it changes
	$effect(() => {
		if (confirmedTotal > 0) animatedTotal.set(confirmedTotal);
	});

	const withTrend = $derived(
		confirmedCollections.map((c: any, i: number) => {
			if (i === 0) return { ...c, trend: null };
			const prev = Number(confirmedCollections[i - 1].india ?? 0);
			const curr = Number(c.india ?? 0);
			if (prev === 0) return { ...c, trend: null };
			return { ...c, trend: ((curr - prev) / prev) * 100 };
		})
	);

	const holdingTag = $derived(
		(() => {
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
		})()
	);
</script>

<svelte:head>
	{#if movie}<title>{movie.title} | Box Office</title>{/if}
</svelte:head>

<main class="max-w-3xl mx-auto px-4 py-8">
	<a href="/box-office" class="text-sm text-blue-600 hover:underline mb-6 block">← Back</a>

	{#if loading}
		<p class="text-gray-500">Loading...</p>
	{:else if fetchError}
		<p class="text-red-500">{fetchError}</p>
	{:else if movie}
		<!-- Header -->
		<div class="flex gap-4 mb-8">
			{#if movie.posterURL}
				<img src={movie.posterURL} alt={movie.title} class="w-24 rounded-lg shadow flex-shrink-0" />
			{/if}
			<div>
				<h1 class="text-2xl font-bold text-gray-900">{movie.title}</h1>
				<p class="text-sm text-gray-500 mt-1">
					Released {new Date(movie.releaseDate).toLocaleDateString('en-IN', {
						day: 'numeric',
						month: 'long',
						year: 'numeric'
					})}
				</p>
				<div class="flex items-center gap-2 mt-1 flex-wrap">
					<p
						class="text-sm font-semibold {movie.status === 'RUNNING'
							? 'text-green-600'
							: 'text-gray-500'}"
					>
						Day {movie.collections.length} · {movie.status}
					</p>
					{#if holdingTag && movie.status === 'RUNNING'}
						<span class="text-xs font-semibold px-2 py-0.5 rounded-full {holdingTag.color}">
							{holdingTag.label}
						</span>
					{/if}
				</div>
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
			<p class="text-xs font-bold text-gray-400 uppercase tracking-widest mb-1">
				Total Collection
			</p>
			<p class="text-3xl font-bold text-gray-900">
				₹{$animatedTotal.toFixed(2)} Cr
				<span class="text-sm font-normal text-gray-400">(confirmed)</span>
			</p>
		</section>

		<!-- Day table -->
		{#if withTrend.length > 0}
			<section class="bg-white rounded-xl border border-gray-200 overflow-hidden">
				<table class="w-full text-sm">
					<thead class="bg-gray-50 border-b border-gray-200">
						<tr>
							<th class="text-left px-4 py-3 font-semibold text-gray-600">Day</th>
							<th class="text-left px-4 py-3 font-semibold text-gray-600">Date</th>
							<th class="text-right px-4 py-3 font-semibold text-gray-600">Kerala</th>
							<th class="text-right px-4 py-3 font-semibold text-gray-600">India</th>
							<th class="text-right px-4 py-3 font-semibold text-gray-600">vs Prev</th>
						</tr>
					</thead>
					<tbody class="divide-y divide-gray-100">
						{#each withTrend as c}
							<tr class="hover:bg-gray-50">
								<td class="px-4 py-3 font-medium text-gray-800">Day {c.dayNumber}</td>
								<td class="px-4 py-3 text-gray-500">
									{new Date(c.date).toLocaleDateString('en-IN', {
										day: 'numeric',
										month: 'short'
									})}
								</td>
								<td class="px-4 py-3 text-right text-gray-700">
									{c.kerala ? `₹${Number(c.kerala).toFixed(2)} Cr` : '—'}
								</td>
								<td class="px-4 py-3 text-right font-semibold text-gray-900">
									{c.india ? `₹${Number(c.india).toFixed(2)} Cr` : '—'}
								</td>
								<td
									class="px-4 py-3 text-right text-xs font-semibold {c.trend !== null
										? c.trend > 0
											? 'text-green-600'
											: 'text-red-500'
										: 'text-gray-400'}"
								>
									{#if c.trend !== null}
										{c.trend > 0 ? '▲' : '▼'}
										{Math.abs(c.trend).toFixed(1)}%
									{:else}
										—
									{/if}
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</section>
		{/if}
	{/if}
</main>
