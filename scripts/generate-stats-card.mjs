/**
 * Generates the GitHub stats SVGs embedded in README.md.
 *
 * Run by .github/workflows/stats-card.yml on a schedule; the output is
 * committed to the repo so the README serves images from raw.githubusercontent
 * rather than a third-party service that can go down.
 *
 *   GITHUB_TOKEN=$(gh auth token) node scripts/generate-stats-card.mjs
 */

import { writeFileSync, mkdirSync } from 'node:fs';

const LOGIN = process.env.STATS_LOGIN || 'damusix';
const TOKEN = process.env.GITHUB_TOKEN;
const TODAY = process.env.TODAY || new Date().toISOString().slice(0, 10);
const OUT_DIR = 'assets';

if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

/**
 * Repos whose bytes are generated output rather than authored code. Without
 * this, a single TypeDoc site (193MB of HTML) buries every real language and
 * the card reports 88% HTML. Add to this list when a new docs site lands.
 */
const EXCLUDE_LANG_REPOS = new Set([
    'logosdx/typedoc.logosdx.dev',
    'logosdx/logosdx.dev',
    'riot-tools/riot-tools.github.io',
]);

/* ── Fetch ────────────────────────────────────────────── */

const gql = async (query, variables = {}) => {
    const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
            authorization: `bearer ${TOKEN}`,
            'content-type': 'application/json',
            'user-agent': `${LOGIN}-stats-card`,
        },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const body = await res.json();
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    return body.data;
};

const BASE_Q = `query($login:String!){
  user(login:$login){ createdAt contributionsCollection{ contributionYears } }
}`;

const YEAR_Q = `query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from,to:$to){
      totalCommitContributions totalPullRequestContributions
      totalIssueContributions totalPullRequestReviewContributions
      contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
    }
  }
}`;

const REPO_Q = `query($login:String!,$cursor:String){
  user(login:$login){
    repositories(first:100, after:$cursor, ownerAffiliations:[OWNER,ORGANIZATION_MEMBER], isFork:false, privacy:PUBLIC){
      pageInfo{ hasNextPage endCursor }
      nodes{
        nameWithOwner stargazerCount
        languages(first:12, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } }
      }
    }
  }
}`;

const base = await gql(BASE_Q, { login: LOGIN });
const accountCreated = base.user.createdAt.slice(0, 10);

const days = new Map();
const totals = { commits: 0, prs: 0, issues: 0, reviews: 0 };

for (const year of base.user.contributionsCollection.contributionYears) {
    const c = (await gql(YEAR_Q, {
        login: LOGIN,
        from: `${year}-01-01T00:00:00Z`,
        to: `${year}-12-31T23:59:59Z`,
    })).user.contributionsCollection;

    totals.commits += c.totalCommitContributions;
    totals.prs += c.totalPullRequestContributions;
    totals.issues += c.totalIssueContributions;
    totals.reviews += c.totalPullRequestReviewContributions;

    for (const w of c.contributionCalendar.weeks) {
        for (const d of w.contributionDays) days.set(d.date, d.contributionCount);
    }
}

/**
 * The calendar always returns a full trailing year, so days after today come
 * back as zeroes. Cutting them off is what keeps a live streak from reading
 * as broken the moment the year rolls over.
 */
const sorted = [...days.entries()]
    .filter(([date]) => date <= TODAY)
    .sort((a, b) => a[0].localeCompare(b[0]));

const contributions = sorted.reduce((sum, [, c]) => sum + c, 0);

let longest = 0, run = 0, runStart = null, longestStart = null, longestEnd = null;
for (const [date, count] of sorted) {
    if (count === 0) { run = 0; continue; }
    run += 1;
    if (run === 1) runStart = date;
    if (run > longest) { longest = run; longestStart = runStart; longestEnd = date; }
}

// A zero today doesn't end a streak — the day isn't over yet.
let current = 0, currentStart = null, currentEnd = null;
for (let i = sorted.length - 1; i >= 0; i--) {
    const [date, count] = sorted[i];
    if (count === 0) {
        if (date === TODAY) continue;
        break;
    }
    current += 1;
    currentStart = date;
    currentEnd ??= date;
}

/**
 * Owned and org-member repos are counted separately. Merging them would claim
 * hapijs/joi's 21k stars, which belong to joi, not to a TSC member.
 */
const langBytes = new Map(), langColor = new Map();
const owned = { count: 0, stars: 0 };
let cursor = null, hasNext = true;

while (hasNext) {
    const r = (await gql(REPO_Q, { login: LOGIN, cursor })).user.repositories;
    for (const repo of r.nodes) {
        if (repo.nameWithOwner.startsWith(`${LOGIN}/`)) {
            owned.count += 1;
            owned.stars += repo.stargazerCount;
        }
        if (EXCLUDE_LANG_REPOS.has(repo.nameWithOwner)) continue;
        for (const e of repo.languages.edges) {
            langBytes.set(e.node.name, (langBytes.get(e.node.name) || 0) + e.size);
            langColor.set(e.node.name, e.node.color);
        }
    }
    hasNext = r.pageInfo.hasNextPage;
    cursor = r.pageInfo.endCursor;
}

const totalBytes = [...langBytes.values()].reduce((a, b) => a + b, 0);
const languages = [...langBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name, size]) => ({
        name,
        color: langColor.get(name) || '#8b949e',
        pct: +((size / totalBytes) * 100).toFixed(1),
    }));

/* ── Render ───────────────────────────────────────────── */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const n = (x) => x.toLocaleString('en-US');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const monthYear = (iso) => `${MON[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;

const SANS = 'system-ui,-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
const W = 840, H = 232;

const THEMES = {
    dark: { bg: '#0d1117', border: '#21262d', fg: '#e6edf3', muted: '#7d8590', accent: '#58a6ff', rule: '#21262d' },
    light: { bg: '#ffffff', border: '#d1d9e0', fg: '#1f2328', muted: '#59636e', accent: '#0969da', rule: '#d1d9e0' },
};

const render = (t) => {
    const cells = [
        [n(contributions), 'contributions', `since ${monthYear(accountCreated)}`],
        [n(totals.commits), 'commits', `${n(totals.prs)} pull requests`],
        [String(current), current === 1 ? 'day streak' : 'day streak', `longest ${longest}`],
        [n(owned.stars), owned.stars === 1 ? 'star' : 'stars', `${owned.count} repos`],
    ];

    const colW = (W - 56) / 4;
    let body = `<text x="28" y="38" font-family="${SANS}" font-size="13" font-weight="600" fill="${t.muted}">By the Numbers</text>`;

    cells.forEach(([big, label, sub], i) => {
        const cx = 28 + colW * i + colW / 2;
        body +=
            `<text x="${cx}" y="88" text-anchor="middle" font-family="${SANS}" font-size="38" font-weight="700" fill="${t.fg}">${esc(big)}</text>` +
            `<text x="${cx}" y="112" text-anchor="middle" font-family="${SANS}" font-size="13" font-weight="600" fill="${t.accent}">${esc(label)}</text>` +
            `<text x="${cx}" y="132" text-anchor="middle" font-family="${SANS}" font-size="11" fill="${t.muted}">${esc(sub)}</text>`;
        if (i < 3) {
            const lx = 28 + colW * (i + 1);
            body += `<line x1="${lx}" y1="56" x2="${lx}" y2="140" stroke="${t.rule}"/>`;
        }
    });

    body += `<line x1="28" y1="164" x2="${W - 28}" y2="164" stroke="${t.rule}"/>`;

    // Stacked language bar plus legend.
    const barW = W - 56;
    const pctTotal = languages.reduce((s, l) => s + l.pct, 0);
    let cx = 28;
    for (const l of languages) {
        const seg = (l.pct / pctTotal) * barW;
        body += `<rect x="${cx.toFixed(1)}" y="180" width="${Math.max(seg - 1.5, 1).toFixed(1)}" height="8" rx="4" fill="${l.color}"/>`;
        cx += seg;
    }

    let lx = 28;
    for (const l of languages) {
        const label = `${l.name} ${l.pct}%`;
        body +=
            `<circle cx="${lx + 4}" cy="206" r="4" fill="${l.color}"/>` +
            `<text x="${lx + 14}" y="210" font-family="${SANS}" font-size="11" fill="${t.muted}">${esc(label)}</text>`;
        // 11px system-ui averages ~6.2px/char; 14px dot lead + 20px gutter
        // keeps the next dot clear of this label's tail.
        lx += 14 + label.length * 6.2 + 20;
    }

    const summary = `${n(contributions)} contributions since ${monthYear(accountCreated)}, ` +
        `${n(totals.commits)} commits, ${current} day current streak, ` +
        `${n(owned.stars)} stars across ${owned.count} repositories`;

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(summary)}">` +
        `<title>${esc(summary)}</title>` +
        `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="${t.bg}" stroke="${t.border}"/>` +
        body +
        '</svg>\n';
};

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, theme] of Object.entries(THEMES)) {
    writeFileSync(`${OUT_DIR}/stats-${name}.svg`, render(theme));
}

console.log(
    `${OUT_DIR}/stats-{dark,light}.svg — ${n(contributions)} contributions, ` +
    `${current}d streak (longest ${longest}), ${n(owned.stars)} stars / ${owned.count} repos, ` +
    `top language ${languages[0].name} ${languages[0].pct}%`,
);
