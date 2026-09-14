import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_PATH, cleanUrl, isSignedInUrl, looksLikeJson, redactBody } from './redact.mjs';

test('sign-in and session endpoints are never recorded', () => {
  for (const p of ['/core/login/LoginPage', '/logon', '/p/Logout', '/api/auth/refresh', '/oauth2/callback', '/saml/acs', '/sso/start', '/account/password', '/v1/session', '/token', '/sign-in', '/signin']) {
    assert.ok(SKIP_PATH.test(p), p);
  }
});

test('class content endpoints are recorded', () => {
  for (const p of ['/core/node.json/170594147', '/p/MyWork/assignments', '/core/feed/class/123', '/calendar/events']) {
    assert.ok(!SKIP_PATH.test(p), p);
  }
});

test('secret query parameters are replaced, ordinary ones kept', () => {
  const out = cleanUrl('https://tchat.edsby.com/iCalendar/170594147?ticket=abc%3D%3D&xds=Feed&token=zzz&page=2');
  assert.ok(!out.includes('abc'), out);
  assert.ok(!out.includes('zzz'), out);
  assert.ok(out.includes('xds=Feed') && out.includes('page=2'), out);
  assert.ok(out.includes('ticket=REDACTED'), out);
});

test('secret values are removed wherever they sit in a body', () => {
  const body = JSON.stringify({
    user: { name: 'Levi', sessionId: 'S1', password: 'hunter2' },
    auth: { token: 'T1', refresh_token: 'R1' },
    posts: [{ title: 'Unit 1 test Friday', body: 'Bring a calculator', csrf: 'C1' }],
    ticket: 'K1',
  });
  const out = redactBody(body);
  for (const secret of ['S1', 'hunter2', 'T1', 'R1', 'C1', 'K1']) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  assert.ok(out.includes('Unit 1 test Friday') && out.includes('Bring a calculator') && out.includes('Levi'), out);
});

test('a truncated body that no longer parses is still scrubbed', () => {
  const cut = '{"posts":[{"title":"Quiz"}],"password":"hunter2","sessionId":"S9","token":"T9","more":[{"x":';
  const out = redactBody(cut);
  for (const secret of ['hunter2', 'S9', 'T9']) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  assert.ok(out.includes('Quiz'));
});

test('words that merely contain a secret word are not over-redacted', () => {
  const out = JSON.parse(redactBody(JSON.stringify({ keyPoints: 'Newton', sessionTitle: 'Period 3', monkey: 'ok', stateOfMatter: 'solid' })));
  assert.equal(out.keyPoints, 'Newton');
  assert.equal(out.sessionTitle, 'Period 3');
  assert.equal(out.stateOfMatter, 'solid');
});

test('JSON is recognised by type or by shape, HTML is not', () => {
  assert.ok(looksLikeJson('application/json; charset=utf-8', 'x'));
  assert.ok(looksLikeJson('text/plain', '  {"a":1}'));
  assert.ok(looksLikeJson('text/plain', '[1,2]'));
  assert.ok(!looksLikeJson('text/html', '<!doctype html>'));
});

test('signed-in is judged from where the browser is', () => {
  const host = 'tchat.edsby.com';
  assert.ok(isSignedInUrl('https://tchat.edsby.com/p/BasePublic/', host));
  assert.ok(!isSignedInUrl('https://tchat.edsby.com/core/login/', host));
  assert.ok(!isSignedInUrl('https://accounts.google.com/o/oauth2/auth?x=1', host));
  assert.ok(!isSignedInUrl('https://login.microsoftonline.com/common/oauth2', host));
  assert.ok(!isSignedInUrl('about:blank', host));
});
