<script lang="ts">
	import '../app.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<nav class="bg-white border-b border-gray-200 px-4 py-3 flex items-center gap-6">
	<a href="/" class="font-bold text-gray-900 text-lg">Kerala Box Office</a>
	<a href="/box-office" class="text-sm text-gray-600 hover:text-blue-600 transition-colors">Box Office</a>
	<a href="/box-office/leaderboard" class="text-sm text-gray-600 hover:text-blue-600 transition-colors">Leaderboard</a>
</nav>

{@render children()}
