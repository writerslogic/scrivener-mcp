import importlib.util
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('comparison', Path(__file__).parents[1] / 'update-comparison.py')
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)
NOW = datetime(2026, 11, 2, tzinfo=timezone.utc)


class ComparisonRefreshTest(unittest.TestCase):
    def test_activity_boundaries(self):
        for days, label in [(13, 'weekly'), (14, 'weekly'), (15, 'monthly'),
                            (59, 'monthly'), (60, 'monthly'), (61, 'occasional'),
                            (364, 'occasional'), (365, 'occasional'), (366, 'stale')]:
            with self.subTest(days=days):
                self.assertEqual(comparison.activity_label((NOW - timedelta(days=days)).isoformat(), NOW), label)
        self.assertIsNone(comparison.activity_label(None, NOW))

    def test_missing_repository_is_unavailable_not_stale(self):
        data = {'repos': {'scrivener-mcp': {'github': 'owner/repo', 'npm': 'pkg', 'display': 'Own'}}, 'features': []}
        calls = []
        def fetch(url, headers=None):
            calls.append((url, headers))
            return {'version': '0.12.0'} if 'registry.npmjs.org' in url else None
        stats, version = comparison.collect_stats(data['repos'], NOW, fetch)
        table = comparison.render_table(data, stats, version)
        self.assertIn('repository unavailable', table)
        self.assertNotIn('stale', table)
        self.assertNotIn('?', table)
        self.assertEqual(len(calls), 2)
        self.assertIsNone(calls[-1][1])

    def test_version_comes_from_npm_and_feature_claims_are_preserved(self):
        data = {'repos': {'scrivener-mcp': {'github': 'owner/repo', 'npm': 'pkg', 'display': 'Own'}},
                'features': [{'label': 'Public MCP tools', 'scrivener-mcp': '82'}]}
        def fetch(url, headers=None):
            if 'registry.npmjs.org' in url:
                self.assertIsNone(headers)
                return {'version': '0.12.0'}
            if url.endswith('/releases'):
                return []
            return {'stargazers_count': 70, 'forks_count': 24, 'pushed_at': NOW.isoformat()}
        stats, version = comparison.collect_stats(data['repos'], NOW, fetch)
        table = comparison.render_table(data, stats, version)
        self.assertIn('npm `0.12.0`', table)
        self.assertIn('| Public MCP tools | 82 |', table)
        self.assertIn('⭐ 70 · 24 forks', table)

    def test_only_not_found_is_expected_absence(self):
        for status in (403, 429, 500):
            with self.subTest(status=status), patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('https://example.com', status, 'failed', {}, None)):
                with self.assertRaises(urllib.error.HTTPError):
                    comparison.fetch_json('https://example.com')
        with patch('urllib.request.urlopen', side_effect=urllib.error.HTTPError('https://example.com', 404, 'missing', {}, None)):
            self.assertIsNone(comparison.fetch_json('https://example.com'))

    def test_refresh_preserves_human_review_date_and_is_idempotent(self):
        readme = 'Verified 2026-10-22\n<!-- comparison-refreshed -->old<!-- /comparison-refreshed -->\n<!-- comparison-start -->old<!-- comparison-end -->'
        updated = comparison.update_readme(readme, '| new |', NOW)
        self.assertIn('Verified 2026-10-22', updated)
        self.assertIn('<!-- comparison-refreshed -->2026-11-02', updated)
        self.assertEqual(comparison.update_readme(updated, '| new |', NOW), updated)
        for malformed in ('', readme + readme):
            with self.assertRaises(ValueError):
                comparison.update_readme(malformed, '| new |', NOW)


if __name__ == '__main__':
    unittest.main()
