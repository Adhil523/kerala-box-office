<script lang="ts">
	interface Movie {
		id: string;
		title: string;
		posterURL: string | null;
		releaseDate: string;
		status: 'RUNNING' | 'COMPLETED' | 'UPCOMING';
		grandTotal: number;
		liveToday: number;
		dayNumber: number;
	}

	let { movie }: { movie: Movie } = $props();

	const isRunning = $derived(movie.status === 'RUNNING');
	const displayTotal = $derived(movie.grandTotal.toFixed(2));
</script>

<a
	href="/box-office/movies/{movie.id}"
	class="block rounded-xl overflow-hidden shadow-md hover:shadow-lg transition-shadow bg-white"
>
	<div class="relative">
		{#if movie.posterURL}
			<img
				src={movie.posterURL}
				alt={movie.title}
				class="w-full aspect-[2/3] object-cover"
				loading="lazy"
			/>
		{:else}
			<div
				class="w-full aspect-[2/3] bg-gray-200 flex items-center justify-center text-gray-400 text-sm"
			>
				No poster
			</div>
		{/if}

		<div class="absolute top-2 right-2">
			{#if isRunning}
				<span
					class="flex items-center gap-1 bg-green-500 text-white text-xs font-semibold px-2 py-0.5 rounded-full"
				>
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
			<p class="text-xs text-green-600 font-medium mt-0.5">
				Live today: ₹{movie.liveToday.toFixed(2)} Cr
			</p>
		{/if}
	</div>
</a>
