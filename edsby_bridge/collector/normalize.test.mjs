import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edsbyInstant, htmlToText, normalizeCapture, readAssessmentDates, readLessonSections, readPost, stripLayout } from './normalize.mjs';

// Shapes copied from real Edsby responses; the words are made up.
const post = (text, postedAt = '2026-09-14T12:57:28Z', extra = {}) => ({ nid: 'p1', classNid: 'c1', className: 'Computer Science', postedAt, text, ...extra });

test('a test schedule post yields every date, exactly', () => {
  const got = readAssessmentDates(post([
    'Test Schedule: Block 2 (Not all test dates will be used)',
    'Tuesday September 29th', 'Tuesday October 20th', 'Thursday November 5th', 'Tuesday December 1st',
    'Thursday January 14th', 'Thursday February 4th (3:08 closing)', 'Tuesday March 2nd', 'Thursday April 1st',
    'Culminating Assessment: Monday May 31st',
  ].join('\n')));
  assert.deepEqual(got.map((a) => a.date), ['2026-09-29', '2026-10-20', '2026-11-05', '2026-12-01', '2027-01-14', '2027-02-04', '2027-03-02', '2027-04-01', '2027-05-31']);
  assert.ok(got.every((a) => a.precision === 'day' && !a.weekdayMismatch), 'every stated weekday matches its date');
  assert.ok(got.every((a) => a.tentative), '"not all test dates will be used" makes them tentative');
  assert.equal(got[0].label, 'Test');
  assert.equal(got.at(-1).label, 'Culminating assessment');
  assert.equal(got[5].note, '3:08 closing');
});

test('"week of" dates are weeks, and "8 or 15" keeps both', () => {
  const got = readAssessmentDates(post([
    'Tentative Assessment Dates which can include tests, unit tests and or assignments:',
    'week of Oct 5, week of Nov 2, week of Nov 9, week of Dec 14, Week of Feb 8 or 15,',
    'week of March 15, week of April 5',
    'Adjustments to these dates may occur and advance notice will be given.',
  ].join('\n')));
  assert.equal(got.length, 7);
  assert.ok(got.every((a) => a.precision === 'week' && a.tentative));
  const feb = got.find((a) => a.date === '2027-02-08');
  assert.deepEqual(feb.alternatives, ['2027-02-15']);
  assert.equal(got[0].label, 'Assessment');
});

test('a lesson post is not a test schedule', () => {
  const text = [
    'Class Date: Monday September 14th', 'Topic:', '-Plan out, and code "Average Density Calculator"',
    'Preparation:', 'a.) 1.3 Variables (posted in previous lesson)', 'b.) 3.1 Input with Scanner',
    'Follow up Tasks:', '-complete: Average Density Calculator',
  ].join('\n');
  assert.deepEqual(readAssessmentDates(post(text)), []);
  const lesson = readLessonSections(text);
  assert.deepEqual(lesson.sections.map((s) => s.heading), ['Class Date', 'Topic', 'Preparation', 'Follow up Tasks']);
  assert.deepEqual(lesson.sections[2].items, ['1.3 Variables (posted in previous lesson)', '3.1 Input with Scanner']);
  assert.equal(lesson.sections[1].items[0], 'Plan out, and code "Average Density Calculator"');
});

test('a single line in an ordinary post that names a test is picked up', () => {
  const got = readAssessmentDates(post('Great work today.\nUnit test on Thursday November 5th, chapters 1-3.'));
  assert.equal(got.length, 1);
  assert.equal(got[0].date, '2026-11-05');
  assert.equal(got[0].label, 'Unit test');
  assert.equal(got[0].tentative, false);
});

test('a weekday that does not match its date is flagged, not corrected', () => {
  const [a] = readAssessmentDates(post('Test Schedule\nWednesday September 29th'));
  assert.equal(a.date, '2026-09-29');
  assert.equal(a.weekdayMismatch, true);
});

test('the school year decides the year: posted in September, January is next year', () => {
  const [a] = readAssessmentDates(post('Quiz schedule\nJanuary 14th', '2026-09-20T10:00:00Z'));
  assert.equal(a.date, '2027-01-14');
  const [b] = readAssessmentDates(post('Quiz schedule\nMarch 2nd', '2027-02-01T10:00:00Z'));
  assert.equal(b.date, '2027-03-02');
});

test('Edsby times are UTC, and all-day dates stay dates', () => {
  assert.equal(edsbyInstant('2026-09-14 12:30:00'), '2026-09-14T12:30:00Z');
  assert.equal(edsbyInstant('2026-09-14'), null);
});

test('a post reads its text, links and files', () => {
  const item = {
    nid: 9, pnid: 5, creatorType: 'Teacher', creator: { user: 'Mr. A. Teacher' },
    itembody: { content: {
      header: { details: { date: '2026-09-14 01:44:51', title: { name: { message: { classnid: 5, place: 'Physics' } } } } },
      bodycontent: {
        normal: { body: { content: '<p>Join here:</p>\n<p><a href="https://classroom.google.com/c/X?cjc=1&amp;a=2">link</a></p><p>Due&nbsp;soon</p>' } },
        fileWrapper: { files: { init: { files: [{ nid: 77, Content: { ContentName: '2.1 - Notes.pdf', ContentType: 'application/pdf', ContentSize: '1024' } }] } } },
      },
    } },
  };
  const p = readPost(item);
  assert.equal(p.classNid, '5');
  assert.equal(p.className, 'Physics');
  assert.equal(p.postedAt, '2026-09-14T01:44:51Z');
  assert.equal(p.text, 'Join here:\nlink\nDue soon');
  assert.deepEqual(p.links, ['https://classroom.google.com/c/X?cjc=1&a=2']);
  assert.deepEqual(p.files, [{ nid: '77', name: '2.1 - Notes.pdf', type: 'application/pdf', bytes: 1024 }]);
});

test("Edsby's screen layout is removed and its data kept", () => {
  const out = JSON.parse(stripLayout(JSON.stringify({ slices: [{ data: { a: 1 }, xds: { fields: [1, 2, 3] } }], unid: 'x' })));
  assert.deepEqual(out, { slices: [{ data: { a: 1 } }], unid: 'x' });
  assert.equal(stripLayout('not json'), 'not json');
});

test('a lesson summary is recognised, and "Label: value" posts are not lessons', () => {
  const mk = (html) => readPost({ nid: 1, itembody: { content: { header: { details: { date: '2026-09-14 01:44:51', title: {} } }, bodycontent: { normal: { body: { content: html } } } } } });
  const lesson = mk('<p>Class Date: Monday September 14th</p><p>Topic:<br>-Variables</p><p>Follow up Tasks:<br>-finish lab</p>');
  assert.equal(lesson.isLessonSummary, true);
  assert.equal(lesson.lessonDate, '2026-09-14');
  const joinPage = mk('<p>Please take a moment to join our page:</p><p>Class Code: 2u5jyoq6</p>');
  assert.equal(joinPage.isLessonSummary, false);
  assert.equal(joinPage.lessonDate, null);
  const schedule = mk('<p>Test Schedule: Block 2</p><p>Culminating Assessment: Monday May 31st</p>');
  assert.equal(schedule.isLessonSummary, false);
});

test("the class list is read from the level Edsby actually puts it at", () => {
  const body = { slices: [{ data: { classesContainer: { classes: { r1: { nid: 9, teacherNames: 'Ms. C', class: { myworkunread: 2, class: { core: { summary: { line1: { course: 'Physics Grade 11' }, info: { code: 'SPH3U-06' } } } } } } } } } }] };
  const n = normalizeCapture([{ status: 200, url: '/core/node.json/1?xds=BaseStudentClasses', body: JSON.stringify(body) }], { now: 0 });
  assert.deepEqual(n.classes[0], { nid: '9', name: 'Physics Grade 11', code: 'SPH3U-06', teacher: 'Ms. C', unreadWork: 2 });
});

test('one period, even when a class calendar names it with a placeholder id', () => {
  const period = (nid) => ({ nodetype: 6, nodesubtype: 13, nid, name: 'RAB3MT-06', periodName: ['Block 12'], sdate: '2026-09-14 18:26:00', edate: '2026-09-14 19:25:00' });
  const cal = (items) => JSON.stringify({ slices: [{ data: { itemdata: items } }] });
  const n = normalizeCapture([
    { status: 200, url: '/core/node.json/221512202?xds=CalendarPanel_Class', body: cal({ a: period(-102) }) },
    { status: 200, url: '/core/node.json/170?xds=CalendarPanel', body: cal({ b: period(221512202) }) },
  ], { now: 0 });
  assert.equal(n.timetable.length, 1);
  assert.equal(n.timetable[0].classNid, '221512202');
});

test('a whole capture becomes classes, posts and assessments, with posts from two views merged', () => {
  const feedItem = { nid: 1, creator: { user: 'Mr. T' }, creatorType: 'Teacher', itembody: { content: { header: { details: { date: '2026-09-14 12:00:00', title: {} } }, bodycontent: { normal: { body: { content: '<p>Test Schedule</p><p>Tuesday September 29th</p>' } } } } } };
  const responses = [
    { status: 200, url: '/core/node.json/170?xds=BaseStudentClasses', body: JSON.stringify({ slices: [{ data: { classesContainer: { classes: { r1: { nid: 5, teacherNames: 'Mr. T', class: { class: { core: { summary: { line1: { course: 'Computer Science' }, info: { code: 'ICS4U' } } } } } } } } } }] }) },
    { status: 200, url: '/core/node.json/5?xds=CourseFeed', body: JSON.stringify({ slices: [{ data: { item: { r1: feedItem } } }] }) },
    { status: 403, url: '/core/node.json/6?xds=CourseFeed', body: '{"error":1}' },
  ];
  const n = normalizeCapture(responses, { host: 'tchat.edsby.com', now: 0 });
  assert.equal(n.classes[0].code, 'ICS4U');
  assert.equal(n.posts.length, 1);
  assert.equal(n.posts[0].className, 'Computer Science', 'a feed post takes its class name from the class list');
  assert.equal(n.assessments[0].date, '2026-09-29');
  assert.equal(n.assessments[0].className, 'Computer Science');
});
