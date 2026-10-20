'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderGithub, renderGitlab, updateReadme } = require('./render-graphs.cjs');
const { publishGraphs, changedEntries, blobSha, ALLOWED } = require('./refresh-profile.cjs');
const { paginateRest } = require('./collect-github.cjs');

const repository = 'repos/umarfarooq0011/umarfarooq0011';
const fixtureDays = Array.from({ length: 365 }, (_, index) => {
  const date = new Date(Date.UTC(2025, 9, 21) + index * 86400000).toISOString().slice(0, 10);
  const count = index === 0 ? 2 : index === 180 ? 3 : index === 364 ? 1 : 0;
  return { date, count, level: count > 0 ? 1 : 0 };
});
const github = {
  schemaVersion: 1, username: 'example-user', snapshotDate: '2026-10-20',
  calendar: { totalContributions: 6, activeDays: 3, days: fixtureDays },
  repositories: { publicNonForkCount: 4, languageRepositoryCount: 3 },
  languageStatistics: { totalBytes: 1000 },
  languages: [
    { name: 'JavaScript', bytes: 600, percent: 60, color: '#f1e05a' },
    { name: 'TypeScript', bytes: 300, percent: 30, color: '#3178c6' },
    { name: 'CSS', bytes: 100, percent: 10, color: '#663399' },
  ],
};
const gitlab = {
  default_branch: 'dev', fetched_on: '2026-10-20',
  period_non_merge_commits: 6, active_dates_in_period: 3,
  daily_counts: Object.fromEntries(fixtureDays.map(day => [day.date, day.count])),
};
const data = { github, gitlab };
const clone = value => JSON.parse(JSON.stringify(value));
const graphFiles = { ...renderGithub(github), ...renderGitlab(gitlab) };

function marked(name, value) {
  return `<!-- profile-stats:${name}:start -->\n${value}\n<!-- profile-stats:${name}:end -->`;
}

function readmeFixture() {
  return '# Umar Farooq\n\nManually maintained professional introduction.\n\n'
    + marked('languages', 'OLD LANGUAGES')
    + '\n\n## Current work\n\nRigRex dashboard — authored project description.\n\n'
    + marked('gitlab', 'OLD GITLAB')
    + '\n\nA manually maintained project link: [Project](https://example.test/project).\n\n'
    + marked('github', 'OLD GITHUB')
    + '\n\nFinal contact paragraph, kept by the profile owner.\n';
}

function outsideMarkers(readme) {
  return readme.replace(
    /(<!-- profile-stats:(languages|gitlab|github):start -->)[\s\S]*?(<!-- profile-stats:\2:end -->)/g,
    '$1<GENERATED CONTENT>$3',
  );
}

function block(readme, name) {
  const start = `<!-- profile-stats:${name}:start -->`;
  const end = `<!-- profile-stats:${name}:end -->`;
  return readme.slice(readme.indexOf(start), readme.indexOf(end) + end.length);
}

function readmeBlob(readme) {
  return { encoding: 'base64', content: Buffer.from(readme, 'utf8').toString('base64') };
}

function treeFor(files) {
  return Object.entries(files).map(([name, content]) => ({ path: name, type: 'blob', sha: blobSha(content) }));
}

async function withEnvironment(values, operation) {
  const previous = new Map(Object.keys(values).map(name => [name, process.env[name]]));
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try { return await operation(); }
  finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test('synthetic aggregate data renders deterministically without mutating inputs', () => {
  const beforeGithub = clone(github);
  const beforeGitlab = clone(gitlab);
  const first = { ...renderGithub(github), ...renderGitlab(gitlab) };
  const second = { ...renderGithub(clone(github)), ...renderGitlab(clone(gitlab)) };
  assert.deepEqual(first, second);
  assert.equal(Object.keys(first).length, 8);
  for (const [name, svg] of Object.entries(first)) {
    assert.ok(ALLOWED.has(name), `Rendered path must be allowed: ${name}`);
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg, /<\/svg>\n$/);
  }
  assert.match(first['assets/statistics/github-contributions-light.svg'], new RegExp(`${github.calendar.totalContributions} GitHub contributions`));
  assert.ok(first['assets/statistics/github-contributions-dark.svg'].includes(github.calendar.days[0].date));
  assert.ok(first['assets/statistics/github-contributions-dark.svg'].includes(github.calendar.days.at(-1).date));
  assert.deepEqual(github, beforeGithub);
  assert.deepEqual(gitlab, beforeGitlab);
});

test('public REST pagination follows every full page and stops on the final short page', async () => {
  const calls = [];
  const records = await paginateRest(async (page, pageSize) => {
    calls.push({ page, pageSize });
    return page === 1 ? ['first', 'second'] : ['last'];
  }, { pageSize: 2 });
  assert.deepEqual(records, ['first', 'second', 'last']);
  assert.deepEqual(calls, [{ page: 1, pageSize: 2 }, { page: 2, pageSize: 2 }]);
  await assert.rejects(() => paginateRest(async () => ({ message: 'Not a repository page' })), /pagination response/i);
  await assert.rejects(() => paginateRest(async () => ['full'], { pageSize: 1, maxPages: 1 }), /safety limit/i);
});

test('language graphics accept null or missing colors with a neutral fallback', () => {
  for (const missing of [false, true]) {
    const fixture = clone(github);
    if (missing) delete fixture.languages[0].color;
    else fixture.languages[0].color = null;
    const rendered = renderGithub(fixture);
    for (const [name, svg] of Object.entries(rendered).filter(([name]) => name.includes('repository-languages'))) {
      assert.ok(svg.includes('fill="#8b949e"'), `Neutral color is present in ${name}`);
    }
    assert.equal(fixture.languages[0].color, missing ? undefined : null);
  }
});

test('language graphics reject malformed non-null colors', () => {
  for (const color of ['', 'red', '#fff', '#abcdef" onload="alert(1)', 'url(https://example.test/color)']) {
    const fixture = clone(github);
    fixture.languages[0].color = color;
    assert.throws(() => renderGithub(fixture), /colour|color/i);
  }
});

test('README updates preserve every byte outside generated marker blocks', () => {
  for (const original of [readmeFixture(), readmeFixture().replace(/\n/g, '\r\n')]) {
    const updated = updateReadme(original, data);
    assert.equal(outsideMarkers(updated), outsideMarkers(original));
    assert.ok(!updated.includes('OLD LANGUAGES'));
    assert.ok(!updated.includes('OLD GITLAB'));
    assert.ok(!updated.includes('OLD GITHUB'));
    assert.match(updated, /RigRex dashboard — authored project description\./);
  }
});

test('a GitHub-only update preserves the GitLab block exactly', () => {
  const original = readmeFixture();
  const updated = updateReadme(original, { github });
  assert.equal(block(updated, 'gitlab'), block(original, 'gitlab'));
  assert.notEqual(block(updated, 'languages'), block(original, 'languages'));
  assert.notEqual(block(updated, 'github'), block(original, 'github'));
  assert.equal(outsideMarkers(updated), outsideMarkers(original));
});

test('a GitLab-only update preserves both GitHub-generated blocks exactly', () => {
  const original = readmeFixture();
  const updated = updateReadme(original, { gitlab });
  assert.equal(block(updated, 'languages'), block(original, 'languages'));
  assert.equal(block(updated, 'github'), block(original, 'github'));
  assert.notEqual(block(updated, 'gitlab'), block(original, 'gitlab'));
  assert.equal(outsideMarkers(updated), outsideMarkers(original));
});

test('missing, duplicate, or reversed README markers reject publication input', () => {
  for (const name of ['languages', 'github', 'gitlab']) {
    const start = `<!-- profile-stats:${name}:start -->`;
    const end = `<!-- profile-stats:${name}:end -->`;
    const original = readmeFixture();
    const invalid = [
      original.replace(start, ''),
      original.replace(end, ''),
      original.replace(start, start + start),
      original.replace(end, end + end),
      original.replace(start, '__TEMP_START__').replace(end, start).replace('__TEMP_START__', end),
    ];
    for (const readme of invalid) assert.throws(() => updateReadme(readme, data), /markers/i);
  }
});

test('publication allowlist rejects unrelated paths and executable or remote SVGs', () => {
  const allowedPath = 'assets/statistics/github-contributions-light.svg';
  const safeSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Safe local graph</text></svg>';
  assert.equal(changedEntries({ [allowedPath]: safeSvg }, []).length, 1);
  for (const name of ['unrelated.txt', '../README.md', 'assets/statistics/new-graph.svg']) {
    assert.throws(() => changedEntries({ [name]: safeSvg }, []), /allowlist/i);
  }
  for (const svg of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject>HTML</foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/image.svg" /></svg>',
    '<html>Not an SVG document</html>',
  ]) {
    assert.throws(() => changedEntries({ [allowedPath]: svg }, []), /unsafe svg/i);
  }
});

test('unchanged graphs are a publication no-op with no write API requests', async () => {
  const currentReadme = updateReadme(readmeFixture(), data);
  const files = { ...graphFiles, 'README.md': currentReadme };
  const readmeSha = blobSha(currentReadme);
  const calls = [];
  const api = async (endpoint, body) => {
    calls.push({ endpoint, body });
    assert.equal(body, undefined, 'No POST/PATCH payload is allowed for an unchanged profile');
    if (endpoint === 'user') return { login: 'umarfarooq0011' };
    if (endpoint === repository) return { full_name: 'umarfarooq0011/umarfarooq0011', permissions: { push: true } };
    if (endpoint === `${repository}/git/ref/heads/main`) return { object: { sha: 'same-head' } };
    if (endpoint === `${repository}/git/commits/same-head`) return { tree: { sha: 'same-tree' } };
    if (endpoint === `${repository}/git/trees/same-tree?recursive=1`) return { truncated: false, tree: treeFor(files) };
    if (endpoint === `${repository}/git/blobs/${readmeSha}`) return readmeBlob(currentReadme);
    throw new Error('Unexpected mocked read endpoint');
  };
  const result = await publishGraphs(graphFiles, data, api);
  assert.equal(result.published, false);
  assert.deepEqual(result.changedPaths, []);
  assert.equal(result.readme, currentReadme);
  assert.equal(calls.filter(call => call.body !== undefined).length, 0);
});

test('HTTP422 ref conflict retries against fresh HEAD and preserves a concurrent README edit', async () => {
  const originalReadme = readmeFixture();
  const concurrentReadme = originalReadme.replace(
    'Manually maintained professional introduction.',
    'New professional introduction written while the graph refresh was running.',
  ) + '\nAdditional project added by the profile owner.\n';
  const originals = { 'head-a': originalReadme, 'head-b': concurrentReadme };
  const treeNames = { 'head-a': 'tree-a', 'head-b': 'tree-b' };
  const treeRequests = [];
  const commitRequests = [];
  const refRequests = [];
  let head = 'head-a';
  let refReads = 0;
  const api = async (endpoint, body) => {
    if (endpoint === 'user') return { login: 'umarfarooq0011' };
    if (endpoint === repository) return { full_name: 'umarfarooq0011/umarfarooq0011', permissions: { push: true } };
    if (endpoint === `${repository}/git/ref/heads/main`) {
      assert.equal(body, undefined);
      refReads++;
      return { object: { sha: head } };
    }
    for (const [commit, readme] of Object.entries(originals)) {
      if (endpoint === `${repository}/git/commits/${commit}`) return { tree: { sha: treeNames[commit] } };
      if (endpoint === `${repository}/git/trees/${treeNames[commit]}?recursive=1`) {
        return { truncated: false, tree: [
          { path: 'README.md', type: 'blob', sha: blobSha(readme) },
          { path: 'hand-maintained-note.txt', type: 'blob', sha: 'unrelated-file-sha' },
        ] };
      }
      if (endpoint === `${repository}/git/blobs/${blobSha(readme)}`) return readmeBlob(readme);
    }
    if (endpoint === `${repository}/git/trees`) {
      treeRequests.push(clone(body));
      return { sha: `new-tree-${treeRequests.length}` };
    }
    if (endpoint === `${repository}/git/commits`) {
      commitRequests.push(clone(body));
      return { sha: `new-commit-${commitRequests.length}` };
    }
    if (endpoint === `${repository}/git/refs/heads/main`) {
      refRequests.push(clone(body));
      if (refRequests.length === 1) {
        head = 'head-b';
        const conflict = new Error('Simulated non-fast-forward conflict');
        conflict.httpStatus = 422;
        throw conflict;
      }
      head = body.sha;
      return { object: { sha: head } };
    }
    throw new Error('Unexpected mocked endpoint');
  };
  const result = await publishGraphs(graphFiles, data, api);
  assert.equal(result.published, true);
  assert.equal(result.commit, 'new-commit-2');
  assert.equal(refReads, 3);
  assert.deepEqual(treeRequests.map(request => request.base_tree), ['tree-a', 'tree-b']);
  assert.deepEqual(commitRequests.map(request => request.parents), [['head-a'], ['head-b']]);
  assert.deepEqual(refRequests, [{ sha: 'new-commit-1', force: false }, { sha: 'new-commit-2', force: false }]);
  const expectedReadme = updateReadme(concurrentReadme, data);
  assert.equal(result.readme, expectedReadme);
  assert.equal(outsideMarkers(result.readme), outsideMarkers(concurrentReadme));
  assert.equal(treeRequests[1].tree.find(entry => entry.path === 'README.md').content, expectedReadme);
  for (const request of treeRequests) {
    assert.ok(request.tree.every(entry => ALLOWED.has(entry.path)));
    assert.ok(!request.tree.some(entry => entry.path === 'hand-maintained-note.txt'));
  }
  const identity = { name: 'Profile Graphs Automation', email: 'profile-graphs-automation@users.noreply.github.com' };
  for (const request of commitRequests) {
    assert.deepEqual(request.author, identity);
    assert.deepEqual(request.committer, identity);
    assert.equal(Object.hasOwn(request.author, 'date'), false);
    assert.equal(Object.hasOwn(request.committer, 'date'), false);
  }
});

test('publication stops for an unexpected authenticated account before repository access', async () => {
  const calls = [];
  await withEnvironment({ GITHUB_ACTIONS: 'false' }, () =>
    assert.rejects(() => publishGraphs(graphFiles, data, async (endpoint, body) => {
      calls.push({ endpoint, body });
      assert.equal(endpoint, 'user');
      assert.equal(body, undefined);
      return { login: 'another-account' };
    }), /wrong github account/i));
  assert.equal(calls.length, 1);
});

test('Actions publication rejects an unrelated repository without making API requests', async () => {
  let requests = 0;
  await withEnvironment({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'someone/another-repository' }, () =>
    assert.rejects(() => publishGraphs(graphFiles, data, async () => { requests++; }), /unexpected actions repository/i));
  assert.equal(requests, 0);
});

test('Actions publication requires repository push permission and never requests user identity', async () => {
  const calls = [];
  await withEnvironment({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'umarfarooq0011/umarfarooq0011' }, () =>
    assert.rejects(() => publishGraphs(graphFiles, data, async (endpoint, body) => {
      calls.push(endpoint);
      assert.equal(endpoint, repository);
      assert.equal(body, undefined);
      return { full_name: 'umarfarooq0011/umarfarooq0011', permissions: { push: false } };
    }), /cannot publish/i));
  assert.deepEqual(calls, [repository]);
});
