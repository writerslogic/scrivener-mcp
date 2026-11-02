import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def fetch_json(url, headers=None):
    request = urllib.request.Request(url, headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def activity_label(iso_date, now):
    if not iso_date:
        return None
    date = datetime.fromisoformat(iso_date.replace('Z', '+00:00'))
    days = (now - date).days
    if days <= 14:
        return 'weekly'
    if days <= 60:
        return 'monthly'
    if days <= 365:
        return 'occasional'
    return 'stale'


def collect_stats(repos, now, fetch=fetch_json):
    headers = {'Accept': 'application/vnd.github+json'}
    token = os.environ.get('GH_TOKEN')
    if token:
        headers['Authorization'] = f'Bearer {token}'
    stats = {}
    for key, meta in repos.items():
        slug = meta.get('github')
        if not slug:
            stats[key] = {}
            continue
        data = fetch(f'https://api.github.com/repos/{slug}', headers)
        if data is None:
            stats[key] = {'unavailable': True}
            continue
        for field in ('stargazers_count', 'forks_count'):
            if type(data.get(field)) is not int or data[field] < 0:
                raise ValueError(f'Invalid repository count: {field}')
        releases = fetch(f'https://api.github.com/repos/{slug}/releases', headers)
        if releases is not None and not isinstance(releases, list):
            raise ValueError('Invalid repository releases')
        stats[key] = {
            'stars': data['stargazers_count'],
            'forks': data['forks_count'],
            'activity': activity_label(data.get('pushed_at'), now),
            'releases': len(releases) if releases is not None else None,
        }
    package = urllib.parse.quote(repos['scrivener-mcp']['npm'], safe='')
    published = fetch(f'https://registry.npmjs.org/{package}/latest')
    version = published.get('version') if published else None
    if version is not None and not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.+-]+)?', version):
        raise ValueError('Invalid published npm version')
    return stats, version


def render_table(spec, stats, version):
    repos = spec['repos']
    order = list(repos)
    headers = []
    for key, meta in repos.items():
        label = meta['display']
        if key != 'scrivener-mcp':
            if meta.get('github'):
                label = f"[{label}](https://github.com/{meta['github']})"
            elif meta.get('npm'):
                label = f"[{label}](https://www.npmjs.com/package/{meta['npm']})"
        headers.append(label)
    rows = ['| Feature | ' + ' | '.join(headers) + ' |', '|---------|' + ':-:|' * len(order)]
    for feature in spec['features']:
        rows.append(f"| {feature['label']} | " + ' | '.join(str(feature.get(key, '—')) for key in order) + ' |')
    status, community = [], []
    for key, meta in repos.items():
        entry = stats[key]
        if entry.get('unavailable'):
            status.append('repository unavailable')
            community.append('unavailable')
            continue
        note = meta.get('status_note')
        if note:
            status.append(note)
        else:
            activity = entry.get('activity')
            label = f'{activity} activity' if activity else 'activity unavailable'
            if key == 'scrivener-mcp':
                label += f'; npm `{version}`' if version else '; not published on npm'
            elif entry.get('releases') == 0:
                label += '; no releases'
            status.append(label)
        if not entry:
            community.append(meta.get('community_note', '—'))
        else:
            label = f"⭐ {entry['stars']}"
            if entry['forks']:
                label += f" · {entry['forks']} fork" + ('s' if entry['forks'] != 1 else '')
            community.append(label)
    rows.append('| Repository/package status | ' + ' | '.join(status) + ' |')
    rows.append('| Community | ' + ' | '.join(community) + ' |')
    return '\n'.join(rows)


def update_readme(readme, table, now):
    result, count = re.subn(r'<!-- comparison-start -->.*?<!-- comparison-end -->',
                            lambda _: f'<!-- comparison-start -->\n\n{table}\n\n<!-- comparison-end -->',
                            readme, flags=re.DOTALL)
    if count != 1:
        raise ValueError('Expected one comparison table')
    result, count = re.subn(r'(<!-- comparison-refreshed -->)[^<]*(<!-- /comparison-refreshed -->)',
                            lambda match: match[1] + now.strftime('%Y-%m-%d') + match[2], result)
    if count != 1:
        raise ValueError('Expected one comparison refresh date')
    return result


def main():
    import yaml

    root = Path(__file__).resolve().parent.parent
    spec = yaml.safe_load((root / 'docs/comparison.yml').read_text())
    now = datetime.now(timezone.utc)
    stats, version = collect_stats(spec['repos'], now)
    path = root / 'README.md'
    readme = path.read_text()
    updated = update_readme(readme, render_table(spec, stats, version), now)
    if updated != readme:
        path.write_text(updated)
    print('Comparison table refreshed from repository and published npm metadata.')


if __name__ == '__main__':
    main()
