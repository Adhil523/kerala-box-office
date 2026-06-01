<script lang="ts">
	import { onMount } from 'svelte';

	let movies: any[] = $state([]);
	let loading = $state(true);

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
								<a
									href="/box-office/movies/{m.id}"
									class="font-medium text-gray-900 hover:text-blue-600"
								>
									{m.title}
								</a>
								<span class="text-xs text-gray-400 ml-2">
									{new Date(m.releaseDate).getFullYear()}
								</span>
								{#if m.status === 'RUNNING'}
									<span
										class="ml-2 inline-flex items-center gap-1 text-xs text-green-600 font-semibold"
									>
										<span class="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse"></span>Live
									</span>
								{/if}
							</td>
							<td class="px-4 py-3 text-right font-bold text-gray-900">
								₹{m.total.toFixed(2)} Cr
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if movies.length === 0}
				<p class="text-center text-gray-500 py-8">No data yet.</p>
			{/if}
		</div>
	{/if}
</main>
