'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const DAY_MS = 86_400_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const API_BASE = 'https://gitlab.com/api/v4/';
const DEFAULTS = Object.freeze({
  projectId: '47888297',
  exactAuthorName: 'umar Awan',
  expectedUsername: 'Umarfarooq1122',
});

function validDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateWindow(snapshotDate) {
  if (!validDateOnly(snapshotDate)) throw new Error('snapshotDate must be a valid YYYY-MM-DD date.');
  const endMs = Date.parse(`${snapshotDate}T00:00:00.000Z`);
  return {
    start_date: new Date(endMs - 364 * DAY_MS).toISOString().slice(0, 10),
    end_date: snapshotDate,
    inclusive: true,
    days: 365,
  };
}

function authorDate(timestamp) {
  // Keep the author's calendar date in the recorded offset, without UTC conversion.
  if (typeof timestamp !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)
      || !validDateOnly(timestamp.slice(0, 10))
      || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error('GitLab returned an invalid author timestamp.');
  }
  return timestamp.slice(0, 10);
}

function aggregateCommits(records, exactAuthorName, snapshotDate) {
  const period = dateWindow(snapshotDate);
  const unique = new Map();
  for (const record of records) {
    if (record.author_name !== exactAuthorName) continue;
    if (typeof record.id !== 'string' || record.id.length === 0 || !Array.isArray(record.parent_ids)) {
      throw new Error('GitLab returned incomplete commit metadata.');
    }
    const item = {
      date: authorDate(record.authored_date),
      parentCount: record.parent_ids.length,
    };
    const prior = unique.get(record.id);
    if (prior && (prior.date !== item.date || prior.parentCount !== item.parentCount)) {
      throw new Error('GitLab returned inconsistent duplicate commit metadata.');
    }
    unique.set(record.id, item);
  }

  const dailyCounts = {};
  const startMs = Date.parse(`${period.start_date}T00:00:00.000Z`);
  for (let i = 0; i < period.days; i += 1) {
    dailyCounts[new Date(startMs + i * DAY_MS).toISOString().slice(0, 10)] = 0;
  }
  const nonMergeDates = [];
  for (const record of unique.values()) {
    if (record.parentCount >= 2) continue;
    nonMergeDates.push(record.date);
    if (Object.hasOwn(dailyCounts, record.date)) dailyCounts[record.date] += 1;
  }
  nonMergeDates.sort();
  const values = Object.values(dailyCounts);
  return {
    period,
    all_time_commits_including_merges: unique.size,
    all_time_non_merge_commits: nonMergeDates.length,
    period_non_merge_commits: values.reduce((total, count) => total + count, 0),
    active_dates_in_period: values.filter(count => count > 0).length,
    first_author_date_all_time: nonMergeDates[0] ?? null,
    last_author_date_all_time: nonMergeDates.at(-1) ?? null,
    daily_counts: dailyCounts,
  };
}

async function glabApi(endpoint) {
  // Credentials remain managed by glab. Capture all output and never propagate raw
  // CLI errors or API payloads, which can contain private metadata or headers.
  const childEnv = { ...process.env, NO_COLOR: '1' };
  for (const key of Object.keys(childEnv)) {
    if (/^(?:GLAB_(?:DEBUG|DEBUG_HTTP|TRACE)|DEBUG|GIT_(?:TRACE(?:_CURL|_PACKET|2(?:_EVENT|_PERF)?)?|CURL_VERBOSE))$/i.test(key)) {
      delete childEnv[key];
    }
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync('glab', [
      'api', '--hostname', 'gitlab.com', '--method', 'GET', endpoint,
    ], {
      env: childEnv,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    const reason = error.code === 'ENOENT' ? 'glab is unavailable'
      : error.killed ? 'the request timed out' : 'the authenticated request failed';
    throw new Error(`GitLab collection stopped: ${reason}.`);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('GitLab collection stopped: the CLI returned invalid JSON.');
  }
}

function safeApiUrl(endpoint) {
  let url;
  try {
    url = new URL(endpoint, API_BASE);
  } catch {
    throw new Error('GitLab collection stopped: invalid API endpoint.');
  }
  if (url.origin !== 'https://gitlab.com' || !url.pathname.startsWith('/api/v4/')
      || url.username || url.password || url.hash) {
    throw new Error('GitLab collection stopped: API requests must remain on https://gitlab.com/api/v4/.');
  }
  return url;
}

async function httpApi(endpoint, token, fetcher = globalThis.fetch) {
  // Validate the complete destination before attaching the runtime credential.
  // Never follow redirects, including redirects to another GitLab URL.
  const url = safeApiUrl(endpoint);
  let response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'PRIVATE-TOKEN': token },
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
  } catch (error) {
    const reason = ['AbortError', 'TimeoutError'].includes(error?.name)
      ? 'the request timed out' : 'the HTTPS request failed';
    throw new Error(`GitLab collection stopped: ${reason}.`);
  }
  if (!response.ok) {
    // Do not read or return an HTTP error body; it may contain private metadata.
    await response.body?.cancel().catch(() => {});
    const reason = response.status === 401 ? 'authentication failed'
      : response.status === 403 ? 'access was denied'
        : response.status === 429 ? 'the API rate limit was reached'
          : `the API returned HTTP ${Number(response.status)}`;
    throw new Error(`GitLab collection stopped: ${reason}.`);
  }
  try {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Response too large.');
    }
    if (!response.body) throw new Error('Empty response.');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => {});
          throw new Error('Response too large.');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch {
    throw new Error('GitLab collection stopped: invalid, interrupted or oversized API response.');
  }
}

function apiClient() {
  // Only use a credential explicitly supplied to this process at runtime.
  // Do not read, export or migrate the existing local glab credential.
  if (process.env.GITLAB_TOKEN !== undefined) {
    const token = process.env.GITLAB_TOKEN;
    if (!token || token !== token.trim() || /[\r\n]/.test(token)) {
      throw new Error('GitLab collection stopped: GITLAB_TOKEN is empty or malformed.');
    }
    return {
      get: endpoint => httpApi(endpoint, token),
      description: 'Live authenticated GitLab API through a runtime environment token',
      transport: 'https',
    };
  }
  return {
    get: glabApi,
    description: 'Live authenticated GitLab API through existing local glab login',
    transport: 'glab',
  };
}

async function collectGitlab({
  projectId = DEFAULTS.projectId,
  exactAuthorName = DEFAULTS.exactAuthorName,
  snapshotDate,
  expectedUsername = DEFAULTS.expectedUsername,
} = {}) {
  dateWindow(snapshotDate);
  if (!/^\d+$/.test(String(projectId)) || !exactAuthorName || !expectedUsername) {
    throw new Error('A numeric project ID, exact author name and expected username are required.');
  }
  const api = apiClient();
  const user = await api.get('user');
  if (!user || user.username !== expectedUsername) {
    throw new Error('GitLab collection stopped: authenticated identity does not match the expected account.');
  }
  const projectPath = `projects/${encodeURIComponent(String(projectId))}`;
  const project = await api.get(projectPath);
  if (!project || String(project.id) !== String(projectId)
      || typeof project.default_branch !== 'string' || !project.default_branch) {
    throw new Error('GitLab collection stopped: the project or default branch could not be verified.');
  }
  const branch = project.default_branch;
  const head = await api.get(`${projectPath}/repository/commits/${encodeURIComponent(branch)}?stats=false`);
  if (!head || typeof head.id !== 'string' || !/^[0-9a-f]{40,64}$/i.test(head.id)) {
    throw new Error('GitLab collection stopped: the default branch head could not be verified.');
  }
  authorDate(head.authored_date);
  authorDate(head.committed_date);

  const matchingRecords = [];
  let pagesRead = 0;
  let completed = false;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    // Pin the head so concurrent pushes cannot shift the pagination. Fetch every
    // matching commit: API since/until filters can use a different date basis.
    const query = new URLSearchParams({
      ref_name: head.id,
      author: exactAuthorName,
      per_page: String(PAGE_SIZE),
      page: String(page),
    });
    const records = await api.get(`${projectPath}/repository/commits?${query}`);
    if (!Array.isArray(records) || records.length > PAGE_SIZE) {
      throw new Error('GitLab collection stopped: unexpected commit pagination response.');
    }
    pagesRead += 1;
    for (const record of records) {
      if (!record || record.author_name !== exactAuthorName) continue;
      // Only these transient fields enter aggregation. No messages, emails,
      // diffs or source files are retained, written or returned.
      matchingRecords.push({
        id: record.id,
        author_name: record.author_name,
        authored_date: record.authored_date,
        parent_ids: record.parent_ids,
      });
    }
    if (records.length < PAGE_SIZE) {
      completed = true;
      break;
    }
  }
  if (!completed) {
    throw new Error('GitLab collection stopped: the 100-page safety limit was reached before history was complete.');
  }

  const aggregate = aggregateCommits(matchingRecords, exactAuthorName, snapshotDate);
  return {
    schema_version: 1,
    source: 'GitLab authenticated commits API',
    fetched_on: snapshotDate,
    repository_url: typeof project.web_url === 'string' ? project.web_url : null,
    default_branch: branch,
    exact_author_name: exactAuthorName,
    window_start: aggregate.period.start_date,
    window_end: aggregate.period.end_date,
    ...aggregate,
    counting_method: {
      unit: 'authored non-merge commits',
      date_basis: 'Author date as recorded in each commit, preserving its original timezone',
      author_match: 'Exact case-sensitive Git author name; aliases excluded',
      merges_excluded: true,
      unique_commits: 'Deduplicated API commit IDs, retained in memory only',
      pagination: `Explicit page loop; per_page=${PAGE_SIZE}; maximum ${MAX_PAGES} pages; ${pagesRead} pages read`,
      github_contributions: false,
    },
    source_snapshot: {
      type: api.description,
      transport: api.transport,
      verified_on: snapshotDate,
      default_branch: branch,
      default_branch_head_authored_date: head.authored_date,
      default_branch_head_committed_date: head.committed_date,
      project_last_activity_at: project.last_activity_at ?? null,
      head_pinned_during_pagination: true,
      endpoint: 'GET /projects/:id/repository/commits?ref_name=<pinned-default-head>&author=<exact-author>&per_page=100&page=<n>',
      documentation_url: 'https://docs.gitlab.com/api/commits/',
      remote_state_verified: true,
    },
    coverage_notes: [
      'Counts are authored non-merge commits reachable from the remote default branch head pinned when this collection began.',
      'This is a GitLab repository activity summary, not the GitHub contribution calendar.',
      'Other branches and author aliases are excluded. All history was read before filtering the calendar by author dates.',
      'The current day is partial; later remote changes can alter the counts.',
    ],
  };
}

async function selfTest() {
  const assert = require('node:assert/strict');
  const commit = (id, authoredDate, parentCount = 1, author = 'umar Awan') => ({
    id, authored_date: authoredDate, parent_ids: Array(parentCount).fill('parent'), author_name: author,
    committed_date: '2030-01-01T00:00:00Z',
  });
  const first = commit('first', '2025-10-21T00:15:00+14:00');
  const data = aggregateCommits([
    first, first,
    commit('last', '2026-10-20T23:50:00-12:00'),
    commit('old', '2025-10-20T12:00:00Z', 0),
    commit('future', '2026-10-21T00:00:00Z'),
    commit('merge', '2026-05-01T12:00:00Z', 2),
    commit('alias', '2026-05-01T12:00:00Z', 1, 'Umar Farooq'),
    commit('case', '2026-05-01T12:00:00Z', 1, 'Umar Awan'),
  ], 'umar Awan', '2026-10-20');
  assert.equal(data.period.start_date, '2025-10-21');
  assert.equal(Object.keys(data.daily_counts).length, 365);
  assert.equal(data.all_time_commits_including_merges, 5);
  assert.equal(data.all_time_non_merge_commits, 4);
  assert.equal(data.period_non_merge_commits, 2);
  assert.equal(data.active_dates_in_period, 2);
  assert.equal(data.daily_counts['2025-10-21'], 1);
  assert.equal(data.daily_counts['2026-10-20'], 1);
  assert.equal(data.first_author_date_all_time, '2025-10-20');
  assert.equal(data.last_author_date_all_time, '2026-10-21');
  const leap = dateWindow('2024-03-01');
  assert.equal(leap.start_date, '2023-03-03');
  assert.equal(aggregateCommits([], 'umar Awan', '2024-03-01').daily_counts['2024-02-29'], 0);
  assert.throws(() => dateWindow('2026-02-29'));
  assert.throws(() => authorDate('2026-02-30T00:00:00Z'));
  assert.throws(() => aggregateCommits([first, { ...first, parent_ids: [] }], 'umar Awan', '2026-10-20'));
  const unitToken = 'unit-test-token';
  let requests = 0;
  const httpResult = await httpApi('user', unitToken, async (url, options) => {
    requests += 1;
    assert.equal(url.origin, 'https://gitlab.com');
    assert.equal(url.pathname, '/api/v4/user');
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers['PRIVATE-TOKEN'], unitToken);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response('{"username":"test-user"}', { status: 200 });
  });
  assert.equal(httpResult.username, 'test-user');
  await assert.rejects(httpApi('https://example.invalid/steal', unitToken, async () => {
    requests += 1;
  }), /must remain on https:\/\/gitlab\.com/);
  await assert.rejects(httpApi('http://gitlab.com/api/v4/user', unitToken, async () => {
    requests += 1;
  }), /must remain on https:\/\/gitlab\.com/);
  assert.equal(requests, 1);
  await assert.rejects(httpApi('user', unitToken, async () => {
    throw new Error('private transport detail must not escape');
  }), /^Error: GitLab collection stopped: the HTTPS request failed\.$/);
  await assert.rejects(httpApi('user', unitToken, async () => {
    throw new DOMException('private timeout detail', 'TimeoutError');
  }), /^Error: GitLab collection stopped: the request timed out\.$/);
  await assert.rejects(httpApi('user', unitToken, async () => new Response('private denied body', { status: 403 })),
    /^Error: GitLab collection stopped: access was denied\.$/);
  await assert.rejects(httpApi('user', unitToken, async () => new Response('private non-JSON body')),
    /^Error: GitLab collection stopped: invalid, interrupted or oversized API response\.$/);
  await assert.rejects(httpApi('user', unitToken, async () => new Response('{}', {
    headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
  })), /^Error: GitLab collection stopped: invalid, interrupted or oversized API response\.$/);
  const previousFetch = globalThis.fetch;
  const previousToken = process.env.GITLAB_TOKEN;
  try {
    process.env.GITLAB_TOKEN = unitToken;
    const pinnedHead = 'a'.repeat(40);
    const pages = [];
    globalThis.fetch = async (url, options) => {
      assert.equal(url.origin, 'https://gitlab.com');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['PRIVATE-TOKEN'], unitToken);
      let payload;
      if (url.pathname === '/api/v4/user') {
        payload = { username: DEFAULTS.expectedUsername };
      } else if (url.pathname === '/api/v4/projects/47888297') {
        payload = { id: 47888297, default_branch: 'dev', web_url: 'https://gitlab.com/example/project' };
      } else if (url.pathname === '/api/v4/projects/47888297/repository/commits/dev') {
        payload = { id: pinnedHead, authored_date: '2026-10-20T01:00:00+05:00', committed_date: '2026-10-20T01:00:00+05:00' };
      } else {
        assert.equal(url.pathname, '/api/v4/projects/47888297/repository/commits');
        assert.equal(url.searchParams.get('ref_name'), pinnedHead);
        assert.equal(url.searchParams.get('author'), DEFAULTS.exactAuthorName);
        assert.equal(url.searchParams.has('since'), false);
        assert.equal(url.searchParams.has('until'), false);
        const page = Number(url.searchParams.get('page'));
        pages.push(page);
        payload = page === 1 ? Array.from({ length: 100 }, () => first) : [
          commit('second', '2026-10-20T23:00:00-12:00'),
          commit('excluded-merge', '2026-05-01T12:00:00Z', 2),
          commit('excluded-alias', '2026-05-01T12:00:00Z', 1, 'Umar Farooq'),
        ];
      }
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const collected = await collectGitlab({ snapshotDate: '2026-10-20' });
    assert.deepEqual(pages, [1, 2]);
    assert.equal(collected.period_non_merge_commits, 2);
    assert.equal(collected.all_time_commits_including_merges, 3);
    assert.equal(collected.active_dates_in_period, 2);
    assert.equal(collected.source_snapshot.transport, 'https');
    assert.equal(JSON.stringify(collected).includes(unitToken), false);
    assert.equal(JSON.stringify(collected).includes(pinnedHead), false);
    let identityCalls = 0;
    globalThis.fetch = async () => {
      identityCalls += 1;
      return new Response('{"username":"unexpected-user"}');
    };
    await assert.rejects(collectGitlab({ snapshotDate: '2026-10-20' }), /identity does not match/);
    assert.equal(identityCalls, 1);
    process.env.GITLAB_TOKEN = '';
    assert.throws(() => apiClient(), /empty or malformed/);
    delete process.env.GITLAB_TOKEN;
    assert.equal(apiClient().transport, 'glab');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousToken === undefined) delete process.env.GITLAB_TOKEN;
    else process.env.GITLAB_TOKEN = previousToken;
  }
  process.stdout.write('Passed focused collector tests: aggregation/date boundaries, exact authors, merges, deduplication, HTTPS restrictions, redirect refusal, timeouts, response limits, sanitized errors and mocked full cloud collection with identity/head/pagination checks.\n');
}

module.exports = { collectGitlab };

if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') {
    selfTest().catch(() => {
      process.stderr.write('Focused collector self-test failed.\n');
      process.exitCode = 1;
    });
  } else {
    process.stderr.write('Import collectGitlab(options), or run this module with --self-test.\n');
    process.exitCode = 2;
  }
}
