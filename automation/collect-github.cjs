'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');

const runFile = promisify(execFile);
const DAY_MS = 86400000;
const REQUEST_TIMEOUT_MS = 25000;
const MAX_PAGES = 100;
// Display colors do not affect measured byte totals. Unknown languages use the
// renderer's neutral fallback; no additional service or credential is required.
const LANGUAGE_COLORS = Object.freeze({
  JavaScript: '#f1e05a', 'Jupyter Notebook': '#DA5B0B', PHP: '#4F5D95',
  CSS: '#663399', HTML: '#e34c26', Vue: '#41b883', Hack: '#878787',
  TypeScript: '#3178c6', Python: '#3572A5', EJS: '#a91e50', Dockerfile: '#384d54',
});
const LANGUAGE_FIELDS = `totalSize pageInfo { hasNextPage endCursor }
  edges { size node { name color } }`;
const CONTRIBUTION_FIELDS = {
  issueContributions: 'issue { repository { visibility } }',
  pullRequestContributions: 'pullRequest { repository { visibility } }',
  pullRequestReviewContributions: 'pullRequestReview { repository { visibility } }',
  repositoryContributions: 'repository { visibility }',
};

function dateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Expected a YYYY-MM-DD date.');
  }
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid calendar date.');
  }
  return timestamp;
}

function getRollingWindow(snapshotDate) {
  const end = dateValue(snapshotDate);
  const startDate = new Date(end - 364 * DAY_MS).toISOString().slice(0, 10);
  return {
    from: `${startDate}T00:00:00+05:00`,
    to: `${snapshotDate}T23:59:59+05:00`,
    startDate,
    endDate: snapshotDate,
    timeZone: 'Asia/Karachi',
  };
}

function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function decodeHtml(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => {
    if (name[0] !== '#') return entities[name.toLowerCase()] ?? match;
    const number = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
  });
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
  return match ? decodeHtml(match[2]) : null;
}

function parseCalendarYear(html, year) {
  if (typeof html !== 'string' || !Number.isInteger(year) || year < 2008 || year > 9998) {
    throw new Error('Invalid public calendar input.');
  }
  const tooltips = new Map();
  for (const match of html.matchAll(/<tool-tip\b([^>]*)>([\s\S]*?)<\/tool-tip>/gi)) {
    const id = attribute(match[1], 'for');
    if (!id) continue;
    const text = decodeHtml(match[2].replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    const countMatch = text.match(/^(No|[\d,]+) contributions? on\s+.+?\.?$/i);
    if (!countMatch) continue;
    const count = countMatch[1].toLowerCase() === 'no' ? 0 : Number(countMatch[1].replace(/,/g, ''));
    integer(count, 'public calendar tooltip count');
    if (tooltips.has(id) && tooltips.get(id) !== count) throw new Error('Conflicting public calendar tooltips.');
    tooltips.set(id, count);
  }
  const byDate = new Map();
  for (const match of html.matchAll(/<td\b[^>]*>/gi)) {
    const tag = match[0];
    const date = attribute(tag, 'data-date');
    if (!date || !date.startsWith(`${year}-`)) continue;
    dateValue(date);
    const id = attribute(tag, 'id');
    const rawCount = attribute(tag, 'data-count');
    const tooltipCount = tooltips.get(id);
    if (rawCount !== null && !/^\d+$/.test(rawCount)) throw new Error('Invalid public calendar data-count.');
    const count = rawCount === null ? tooltipCount : Number(rawCount);
    integer(count, 'public calendar day count');
    if (tooltipCount !== undefined && tooltipCount !== count) throw new Error('Public calendar counts disagree.');
    const rawLevel = attribute(tag, 'data-level');
    if (rawLevel === null || !/^[0-4]$/.test(rawLevel)) throw new Error('Missing public calendar intensity level.');
    if (byDate.has(date)) throw new Error('Duplicate public calendar date.');
    byDate.set(date, { date, count, level: Number(rawLevel) });
  }
  const start = dateValue(`${year}-01-01`);
  const end = dateValue(`${year + 1}-01-01`);
  const expectedDays = (end - start) / DAY_MS;
  if (byDate.size !== expectedDays) throw new Error(`Incomplete public calendar for ${year}.`);
  const days = [];
  for (let timestamp = start; timestamp < end; timestamp += DAY_MS) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (!byDate.has(date)) throw new Error(`Missing public calendar date for ${year}.`);
    days.push(byDate.get(date));
  }
  return days;
}

async function paginateConnection(fetchPage, { itemsKey = 'nodes', maxPages = MAX_PAGES } = {}) {
  const items = [];
  const cursors = new Set();
  let after;
  let expectedTotal;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const connection = await fetchPage(after);
    if (!connection || !Array.isArray(connection[itemsKey]) || typeof connection.pageInfo?.hasNextPage !== 'boolean') {
      throw new Error('Invalid GitHub pagination response.');
    }
    if (connection.totalCount !== undefined) {
      integer(connection.totalCount, 'connection total');
      if (expectedTotal !== undefined && expectedTotal !== connection.totalCount) throw new Error('GitHub collection changed during pagination.');
      expectedTotal = connection.totalCount;
    }
    items.push(...connection[itemsKey]);
    if (!connection.pageInfo.hasNextPage) {
      if (expectedTotal !== undefined && items.length !== expectedTotal) throw new Error('Incomplete GitHub pagination.');
      return items;
    }
    const cursor = connection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('Invalid GitHub pagination cursor.');
    cursors.add(cursor);
    after = cursor;
  }
  throw new Error('GitHub pagination safety limit reached.');
}

async function paginateRest(fetchPage, { pageSize = 100, maxPages = MAX_PAGES } = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 ||
      !Number.isInteger(maxPages) || maxPages < 1) throw new Error('Invalid REST pagination options.');
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchPage(page, pageSize);
    if (!Array.isArray(response) || response.length > pageSize) throw new Error('Invalid GitHub REST pagination response.');
    items.push(...response);
    if (response.length < pageSize) return items;
  }
  throw new Error('GitHub REST pagination safety limit reached.');
}

async function retry(operation, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return await operation(); }
    catch {
      // Never propagate command stderr or authenticated response payloads.
      if (attempt === 1) throw new Error(`${label} failed after two attempts.`);
      await delay(500);
    }
  }
}

async function ghJson(args) {
  return retry(async () => {
    const childEnv = { ...process.env, GH_PROMPT_DISABLED: '1' };
    for (const name of Object.keys(childEnv)) {
      if (name.toUpperCase() === 'GH_DEBUG') delete childEnv[name];
    }
    const { stdout } = await runFile('gh', args, {
      encoding: 'utf8', timeout: REQUEST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, env: childEnv,
    });
    return JSON.parse(stdout);
  }, 'GitHub API request');
}

async function graphql(query, variables) {
  const args = ['api', 'graphql', '--hostname', 'github.com', '--raw-field', `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== undefined && value !== null) args.push('--raw-field', `${key}=${value}`);
  }
  const response = await ghJson(args);
  if (response.errors || !response.data) throw new Error('GitHub GraphQL rejected the request.');
  return response.data;
}

async function publicRestJson(endpoint) {
  // /users/:username/repos and repository languages expose public metadata.
  // gh uses Actions' short-lived GH_TOKEN when present; no owner PAT is needed.
  return ghJson(['api', endpoint, '--hostname', 'github.com', '--method', 'GET',
    '--header', 'Accept: application/vnd.github+json', '--header', 'X-GitHub-Api-Version: 2022-11-28']);
}

async function publicCalendarHtml(url) {
  return retry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        signal: controller.signal, credentials: 'omit', cache: 'no-store',
        headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'GitHub-Profile-Statistics', 'Cache-Control': 'no-cache' },
      });
      if (!response.ok || new URL(response.url).hostname !== 'github.com') throw new Error('Public calendar unavailable.');
      const html = await response.text();
      if (Buffer.byteLength(html, 'utf8') > 10 * 1024 * 1024) throw new Error('Public calendar response is unexpectedly large.');
      return html;
    } finally { clearTimeout(timer); }
  }, 'Anonymous public calendar request');
}

async function collectPublicRepositories(username) {
  const query = `query($login:String!,$after:String) {
    user(login:$login) { repositories(first:100,after:$after,ownerAffiliations:OWNER,privacy:PUBLIC,isFork:false) {
      totalCount pageInfo { hasNextPage endCursor }
      nodes { id name visibility isFork owner { login } stargazerCount languages(first:100) { ${LANGUAGE_FIELDS} } }
    } }
  }`;
  const repositories = await paginateConnection(async after => {
    const response = await graphql(query, { login: username, after });
    return response.user?.repositories;
  });
  const ids = new Set();
  for (const repository of repositories) {
    if (!repository || repository.visibility !== 'PUBLIC' || repository.isFork !== false ||
        repository.owner?.login?.toLowerCase() !== username.toLowerCase() || ids.has(repository.id)) {
      throw new Error('Unexpected repository returned by the public repository query.');
    }
    ids.add(repository.id);
    integer(repository.stargazerCount, 'repository star count');
  }
  return repositories;
}

async function collectRestRepositories(username) {
  const records = await paginateRest((page, pageSize) => publicRestJson(
    `users/${encodeURIComponent(username)}/repos?type=owner&per_page=${pageSize}&page=${page}`,
  ));
  const ids = new Set();
  const repositories = [];
  for (const record of records) {
    if (!record || record.private !== false || record.visibility !== 'public' ||
        record.owner?.login?.toLowerCase() !== username.toLowerCase() ||
        !Number.isSafeInteger(record.id) || ids.has(record.id) ||
        typeof record.name !== 'string' || !record.name || typeof record.fork !== 'boolean') {
      throw new Error('Unexpected repository returned by the public REST endpoint.');
    }
    ids.add(record.id);
    if (record.fork) continue;
    repositories.push({
      id: record.id, name: record.name, visibility: 'PUBLIC', isFork: false,
      owner: { login: record.owner.login },
      stargazerCount: integer(record.stargazers_count, 'repository star count'),
      restLanguagesEndpoint: `repos/${encodeURIComponent(record.owner.login)}/${encodeURIComponent(record.name)}/languages`,
    });
  }
  return repositories;
}

async function repositoryLanguages(repository) {
  if (repository.restLanguagesEndpoint) {
    const response = await publicRestJson(repository.restLanguagesEndpoint);
    if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Invalid public REST language response.');
    return Object.entries(response).map(([name, bytes]) => ({
      size: integer(bytes, 'language byte count'),
      node: { name, color: Object.hasOwn(LANGUAGE_COLORS, name) ? LANGUAGE_COLORS[name] : null },
    }));
  }
  const initial = repository.languages;
  const edges = await paginateConnection(async after => {
    if (after === undefined) return initial;
    const response = await graphql(`query($id:ID!,$after:String) {
      node(id:$id) { ... on Repository { visibility isFork languages(first:100,after:$after) { ${LANGUAGE_FIELDS} } } }
    }`, { id: repository.id, after });
    if (response.node?.visibility !== 'PUBLIC' || response.node?.isFork !== false) throw new Error('Repository visibility changed during collection.');
    return response.node.languages;
  }, { itemsKey: 'edges' });
  integer(initial.totalSize, 'repository language size');
  const total = edges.reduce((sum, edge) => sum + integer(edge.size, 'language byte count'), 0);
  if (total !== initial.totalSize) throw new Error('Repository language byte totals do not reconcile.');
  return edges;
}

async function collectPublicContributionTypes(username, window) {
  const connections = Object.entries(CONTRIBUTION_FIELDS).map(([name, fields]) =>
    `${name}(first:100) { totalCount pageInfo { hasNextPage endCursor } nodes { ${fields} } }`).join('\n');
  const query = `query($login:String!,$from:DateTime!,$to:DateTime!) {
    user(login:$login) { contributionsCollection(from:$from,to:$to) {
      commitContributionsByRepository(maxRepositories:100) { repository { visibility } contributions { totalCount } }
      ${connections}
    } }
  }`;
  const variables = { login: username, from: window.from, to: window.to };
  const initial = (await graphql(query, variables)).user?.contributionsCollection;
  if (!Array.isArray(initial?.commitContributionsByRepository)) throw new Error('Missing contribution data.');
  if (initial.commitContributionsByRepository.length >= 100) throw new Error('Commit contribution repository cap reached; refusing a potentially partial total.');
  const result = { commits: 0 };
  for (const contribution of initial.commitContributionsByRepository) {
    if (!['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(contribution.repository?.visibility)) throw new Error('Missing contribution visibility.');
    if (contribution.repository.visibility === 'PUBLIC') result.commits += integer(contribution.contributions?.totalCount, 'public commit count');
  }
  const names = { issueContributions: 'issues', pullRequestContributions: 'pullRequests',
    pullRequestReviewContributions: 'reviews', repositoryContributions: 'repositoryCreations' };
  const repositoryKeys = { issueContributions: 'issue', pullRequestContributions: 'pullRequest',
    pullRequestReviewContributions: 'pullRequestReview' };
  for (const [connectionName, fields] of Object.entries(CONTRIBUTION_FIELDS)) {
    const records = await paginateConnection(async after => {
      if (after === undefined) return initial[connectionName];
      const response = await graphql(`query($login:String!,$from:DateTime!,$to:DateTime!,$after:String) {
        user(login:$login) { contributionsCollection(from:$from,to:$to) {
          ${connectionName}(first:100,after:$after) { totalCount pageInfo { hasNextPage endCursor } nodes { ${fields} } }
        } }
      }`, { ...variables, after });
      return response.user?.contributionsCollection?.[connectionName];
    });
    result[names[connectionName]] = records.filter(record => {
      const repository = connectionName === 'repositoryContributions' ? record.repository : record[repositoryKeys[connectionName]]?.repository;
      if (!['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(repository?.visibility)) throw new Error('Missing contribution visibility.');
      return repository.visibility === 'PUBLIC';
    }).length;
  }
  return { commits: result.commits, pullRequests: result.pullRequests, issues: result.issues,
    reviews: result.reviews, repositoryCreations: result.repositoryCreations,
    scope: 'PUBLIC repository contribution records only, queried via GitHub GraphQL and filtered before serialization. These exclude anonymous private activity and may not equal the public calendar total.' };
}

async function collectGithub({ username, snapshotDate, publicRest = process.env.GITHUB_ACTIONS === 'true' } = {}) {
  if (typeof username !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)) {
    throw new Error('Invalid GitHub username.');
  }
  if (typeof publicRest !== 'boolean') throw new Error('publicRest must be a boolean.');
  const window = getRollingWindow(snapshotDate);
  const years = [...new Set([Number(window.startDate.slice(0, 4)), Number(snapshotDate.slice(0, 4))])];
  const sourceYears = [];
  const allDays = [];
  // Independent requests are joined before processing; no authenticated payload is logged or saved.
  const [repositories, publicContributionTypes, htmlYears] = await Promise.all([
    publicRest ? collectRestRepositories(username) : collectPublicRepositories(username),
    publicRest ? Promise.resolve({
      commits: null, pullRequests: null, issues: null, reviews: null, repositoryCreations: null,
      scope: 'Per-type contribution totals are not collected in public REST mode. The calendar remains the complete activity already displayed on the public profile, including any anonymously displayed private activity.',
    }) : collectPublicContributionTypes(username, window),
    Promise.all(years.map(async year => {
      const source = `https://github.com/users/${encodeURIComponent(username)}/contributions?from=${year}-01-01&to=${year}-12-31`;
      return { year, source, html: await publicCalendarHtml(source) };
    })),
  ]);
  for (const { year, source, html } of htmlYears) {
    const days = parseCalendarYear(html, year);
    sourceYears.push({ year, source, totalContributions: days.reduce((sum, day) => sum + day.count, 0) });
    allDays.push(...days.filter(day => day.date >= window.startDate && day.date <= window.endDate));
  }
  const days = allDays.sort((a, b) => a.date.localeCompare(b.date));
  if (days.length !== 365 || new Set(days.map(day => day.date)).size !== 365) throw new Error('Rolling public calendar is incomplete.');
  const languageRepositories = repositories.filter(repository => repository.name.toLowerCase() !== username.toLowerCase());
  const languageTotals = new Map();
  for (const repository of languageRepositories) {
    for (const edge of await repositoryLanguages(repository)) {
      if (typeof edge.node?.name !== 'string' || !edge.node.name) throw new Error('Missing GitHub language name.');
      const current = languageTotals.get(edge.node.name) || { name: edge.node.name, bytes: 0, color: edge.node.color ?? null };
      current.bytes += edge.size;
      languageTotals.set(current.name, current);
    }
  }
  const totalBytes = [...languageTotals.values()].reduce((sum, language) => sum + language.bytes, 0);
  const languages = [...languageTotals.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
    .map(language => ({ name: language.name, bytes: language.bytes,
      percent: totalBytes === 0 ? 0 : Number((100 * language.bytes / totalBytes).toFixed(2)), color: language.color }));
  return {
    schemaVersion: 1, username, snapshotDate, window,
    calendar: {
      scope: 'Counts already visible on the public GitHub profile, including any anonymously displayed private activity. No private repository names are requested or stored.',
      totalContributions: days.reduce((sum, day) => sum + day.count, 0),
      activeDays: days.filter(day => day.count > 0).length,
      maximumDailyContributions: Math.max(...days.map(day => day.count)),
      days, sourceYears,
      method: 'Fetched public calendar-year grids without authentication, then filtered dates to the requested rolling window.',
    },
    publicContributionTypes,
    restrictedContributionsCount: null,
    restrictedContributionsNote: 'The public HTML calendar does not expose a separate restricted contribution count. Owner-authenticated totals were not used for this field.',
    repositories: {
      publicNonForkCount: repositories.length,
      languageRepositoryCount: languageRepositories.length,
      profileRepositoryExcludedFromLanguages: username,
      starsReceived: languageRepositories.reduce((sum, repository) => sum + repository.stargazerCount, 0),
    },
    languageStatistics: {
      totalBytes,
      scope: 'All owned PUBLIC non-fork repositories, excluding the profile repository.',
      method: 'GitHub repository language byte totals summed across repositories. This measures code distribution, not proficiency. Languages detected in notebooks, templates, and generated code are retained.',
      source: publicRest ? 'GitHub REST API repository languages byte totals' : 'GitHub GraphQL repository.languages edges.size',
    },
    languages,
  };
}

module.exports = { collectGithub, getRollingWindow, parseCalendarYear, paginateConnection, paginateRest };
