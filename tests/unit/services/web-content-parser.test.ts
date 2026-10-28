import { expect, it } from '@jest/globals';
import { WebContentParser } from '../../../src/services/web-content-parser.js';

const quote = 'The winter ledger records every vessel that remained inside the harbor.';
const citation = 'Harbor Ledger, volume 4, page 19.';
const html = `<!doctype html>
<html>
	<head>
		<title>Archive browser title</title>
		<meta name="author" content="Mira Vale">
		<meta name="description" content="An account of a fictional harbor during winter.">
		<meta property="og:title" content="Harbor chronicle">
		<meta name="twitter:card" content="summary">
		<script type="application/ld+json">{
			"@type": "Article",
			"headline": "Harbor chronicle",
			"datePublished": "2020-03-14",
			"internalNote": "Excluded from extracted metadata"
		}</script>
	</head>
	<body>
		<nav><a href="/navigation">Navigation only</a></nav>
		<header>Outside article masthead</header>
		<article>
			<h1 id="winter">Harbor winter 🧭</h1>
			<time datetime="2020-03-14">March 14, 2020</time>
			<p>The winter records describe an imaginary harbor whose residents kept careful
			accounts of ships, weather and provisions. Deep <strong>snow</strong> covered the
			quay for several weeks, while the watch maintained a daily ledger and recorded
			the arrival of each supply vessel before the spring thaw.</p>
			<h2 id="records">Harbor records</h2>
			<p>Read the <a href="/archive">Town archive</a> and the
			<a href="https://sources.example/record">Harbor ledger</a>.</p>
			<img src="/images/harbor.png" alt="Harbor at dusk" title="Survey plate">
			<blockquote>${quote}</blockquote>
			<p class="citation">${citation}</p>
			<script>unwantedCode()</script>
		</article>
		<aside>Sidebar only</aside>
		<footer>Footer only</footer>
	</body>
</html>`;

it('extracts article structure, research evidence and metadata from an offline HTML document', () => {
	const parser = new WebContentParser();
	const parsed = parser.parseHtmlContent(html, 'https://story.example/chapter', {
		includeLinks: true,
		includeImages: true,
		includeHeadings: true,
	});
	expect(parsed).toMatchObject({
		title: 'Harbor winter 🧭',
		author: 'Mira Vale',
		publishDate: '2020-03-14',
		summary: 'An account of a fictional harbor during winter.',
		metadata: { paragraphCount: 3, imageCount: 1, linkCount: 2, headingCount: 2 },
	});
	expect(parsed.headings).toEqual([
		{ level: 1, text: 'Harbor winter 🧭', id: 'winter' },
		{ level: 2, text: 'Harbor records', id: 'records' },
	]);
	expect(parsed.links).toEqual([
		{ text: 'Town archive', url: 'https://story.example/archive', type: 'internal' },
		{ text: 'Harbor ledger', url: 'https://sources.example/record', type: 'external' },
	]);
	expect(parsed.images).toEqual([
		{
			alt: 'Harbor at dusk',
			src: 'https://story.example/images/harbor.png',
			title: 'Survey plate',
		},
	]);
	expect(parsed.content).toContain('The winter records describe an imaginary harbor');
	const excluded =
		/Navigation only|Outside article masthead|Sidebar only|Footer only|unwantedCode/;
	expect(parsed.content).not.toMatch(excluded);

	const research = parser.extractResearchData(parsed);
	expect(research.quotes).toEqual([quote]);
	expect(research.sources).toEqual(['Harbor ledger (https://sources.example/record)', citation]);

	const article = parser.extractArticleContent(html);
	expect(article.title).toBe(parsed.title);
	expect(article.content).toContain('# Harbor winter 🧭');
	expect(article.content).toContain('## Harbor records');
	expect(article.content).toContain('**snow**');
	expect(article.content).not.toMatch(excluded);
	expect(article.metadata).toEqual({
		'og:title': 'Harbor chronicle',
		'twitter:card': 'summary',
		jsonLd: {
			'@type': 'Article',
			headline: 'Harbor chronicle',
			datePublished: '2020-03-14',
		},
	});
});
