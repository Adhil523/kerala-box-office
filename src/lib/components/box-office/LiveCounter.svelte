<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { cubicOut } from 'svelte/easing';
	import { tweened } from 'svelte/motion';

	interface Props {
		movieID: string;
		metric?: 'india' | 'kerala';
	}

	let { movieID, metric = 'india' }: Props = $props();

	const displayValue = tweened(0, { duration: 1200, easing: cubicOut });
	let lastUpdatedAt = $state<Date | null>(null);
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

	const timeLabel = $derived(
		lastUpdatedAt
			? lastUpdatedAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
			: null
	);
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
