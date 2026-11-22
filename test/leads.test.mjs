// Brain Leads: opportunities created in range, grouped by pipeline and by city from the contact ZIP tag. No live calls.
import test from 'node:test';
import assert from 'node:assert/strict';

const { zipFromTags, zipCityMap, summarize, loadLeads } = await import('../netlify/functions/lib/leads.mjs');

test('ZIP tags: zip-labelled tags win, plain 5 digit tags count, other numbers do not', () => {
  assert.equal(zipFromTags(['hot', 'Zip: 90221', '90001']), '90221');
  assert.equal(zipFromTags(['list 2026', '90805-1234']), '90805');
  assert.equal(zipFromTags(['zip90744']), '90744');
  assert.equal(zipFromTags(['code violation', 'tax 2025', '123456']), null);
  assert.deepEqual(zipCityMap('{"90221":"Compton","bad":"x","90001":""}'), { 90221: 'Compton' });
});

test('summarize counts opportunities (not value) per pipeline and per city, reconciled by ZIP', () => {
  const opps = [
    { pipeline: 'ACQ Pipeline', stage: 'New', zip: '90221', value: 900000 },
    { pipeline: 'ACQ Pipeline', stage: 'Offer', zip: '90220', value: 1 },
    { pipeline: 'Retail Pipeline', stage: 'New', zip: '90805' },
    { pipeline: 'ACQ Pipeline', stage: 'New', zip: null },
  ];
  const r = summarize(opps, { zipOf: o => o.zip, cityOfZip: { 90221: 'Compton', 90220: 'Compton', 90805: 'Long Beach' } });
  assert.equal(r.total, 4);
  assert.deepEqual(r.pipelines.map(p => [p.name, p.count]), [['ACQ Pipeline', 3], ['Retail Pipeline', 1]]);
  assert.deepEqual(r.cities.map(c => [c.city, c.count]), [['Compton', 2], ['Long Beach', 1], ['No ZIP tag', 1]]);
  assert.deepEqual(r.cities[0].zips, ['90220', '90221']);
  assert.equal(r.noZip, 1);
});

test('loadLeads reads GHL opportunities in range, uses ZIP tags, falls back to the contact, and resolves cities', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { DATA_MODE: 'live', GHL_ACCESS_TOKEN: 'token', GHL_LOCATION_ID: 'loc1', ZIP_CITY_MAP: '{"90221":"Compton"}' });
  const calls = [];
  const fetchImpl = async url => {
    const href = String(url);
    calls.push(href);
    if (href.includes('/opportunities/pipelines')) return Response.json({ pipelines: [{ id: 'p1', name: 'ACQ Pipeline', stages: [{ id: 's1', name: 'New Lead' }] }, { id: 'p2', name: 'Retail Pipeline', stages: [] }] });
    if (href.includes('/users/')) return Response.json({ users: [{ id: 'u1', name: 'Gavin' }] });
    if (href.includes('/opportunities/search')) return Response.json({ opportunities: [
      { id: 'o1', createdAt: '2026-11-20T18:00:00Z', pipelineId: 'p1', pipelineStageId: 's1', assignedTo: 'u1', contact: { id: 'c1', tags: ['zip 90221'] }, monetaryValue: 500000 },
      { id: 'o2', createdAt: '2026-11-19T18:00:00Z', pipelineId: 'p2', assignedTo: 'u1', contact: { id: 'c2', tags: ['seller'] } },
      { id: 'o3', createdAt: '2026-11-18T18:00:00Z', pipelineId: 'p1', assignedTo: 'u1', contact: { id: 'c3', tags: ['90805'] } },
      { id: 'old', createdAt: '2026-10-01T18:00:00Z', pipelineId: 'p1', contact: { id: 'c9', tags: ['90221'] } },
    ] });
    if (href.includes('/contacts/c2')) return Response.json({ contact: { id: 'c2', tags: [], postalCode: '90221-0001', city: 'compton' } });
    if (href === 'https://api.zippopotam.us/us/90805') return Response.json({ places: [{ 'place name': 'long beach' }] });
    throw new Error('Unexpected fetch ' + href);
  };
  try {
    const r = await loadLeads({ from: '2026-11-15', to: '2026-11-21', fetchImpl });
    assert.equal(r.total, 3, 'the October opportunity is outside the range');
    assert.deepEqual(r.pipelines.map(p => [p.name, p.count]), [['ACQ Pipeline', 2], ['Retail Pipeline', 1]]);
    assert.deepEqual(r.cities.map(c => [c.city, c.count]), [['Compton', 2], ['Long Beach', 1]]);
    assert.deepEqual(r.cities[0].byPipeline, { 'ACQ Pipeline': 1, 'Retail Pipeline': 1 });
    assert.equal(calls.filter(u => u.includes('/contacts/')).length, 1, 'only the contact without a ZIP tag is read');
    assert.deepEqual(r.warnings, []);
    const repOnly = await loadLeads({ from: '2026-11-15', to: '2026-11-21', rep: 'Nobody', fetchImpl });
    assert.equal(repOnly.total, 0);
    await assert.rejects(loadLeads({ from: 'bad', to: '2026-11-21', fetchImpl }), /YYYY-MM-DD/);
  } finally { process.env = saved; }
});

test('sample mode returns cities and pipelines for the Brain', async () => {
  const saved = process.env.DATA_MODE;
  process.env.DATA_MODE = 'sample';
  try {
    const r = await loadLeads({ from: '2026-10-23', to: '2026-11-21' });
    assert.ok(r.total > 0 && r.pipelines.length > 0 && r.cities.length > 0);
  } finally { process.env.DATA_MODE = saved; }
});
