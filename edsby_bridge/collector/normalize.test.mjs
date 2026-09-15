import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edsbyInstant, htmlToText, localDateOf, mergeAnnouncements, normalizeCapture, readAssessmentDates, readClassFolder, readLessonSections, readMyWork, readPost, stripLayout, supersedeSchedules } from './normalize.mjs';

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
  assert.equal(got.at(-1).label, 'Culminating Assessment', "the teacher's own words for it");
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

// ---- found on the second real capture, 14 September: every class, 45 posts ----

test("a line names its own thing: an ISA is not a test just because the heading says tests", () => {
  const got = readAssessmentDates(post([
    'Projected test dates:', 'dates subject to change',
    'ISA - September 29th', 'Test #1 - October 28th', 'Test #2 - December 9',
  ].join('\n')));
  assert.deepEqual(got.map((a) => a.label), ['ISA', 'Test #1', 'Test #2']);
  assert.deepEqual(got.map((a) => a.date), ['2026-09-29', '2026-10-28', '2026-12-09']);
  assert.ok(got.every((a) => a.tentative));
});

test('what a test covers is kept, and one promised date is not tentative', () => {
  const got = readAssessmentDates(post([
    'Hi all,', 'tentative test dates:', '3 Tests',
    'October 21 – the first unit, causes and effects', 'Jan 11 – the second unit',
    'Minor exam: May 19th', '*Note: all are subject to change except minor exam',
  ].join('\n'), '2026-09-04T12:00:00Z'));
  assert.equal(got.length, 3, 'the heading is found on the second line, after a greeting');
  assert.equal(got[0].topic, 'the first unit, causes and effects');
  assert.equal(got[1].topic, 'the second unit');
  const exam = got.find((a) => a.label === 'Minor exam');
  assert.equal(exam.date, '2027-05-19');
  assert.equal(exam.tentative, false, '"except minor exam"');
  assert.ok(got.filter((a) => a !== exam).every((a) => a.tentative));
});

test('a comma list of dates has no labels or topics borrowed from its neighbours', () => {
  const got = readAssessmentDates(post('Tentative Assessment Dates which can include tests:\nOct 15, Nov 3, Nov 24'));
  assert.deepEqual(got.map((a) => [a.date, a.label, a.topic]), [
    ['2026-10-15', 'Assessment', ''], ['2026-11-03', 'Assessment', ''], ['2026-11-24', 'Assessment', ''],
  ]);
});

test('a reposted schedule replaces the earlier one in the same class', () => {
  const heading = 'Tentative Assessment Dates which can include tests, unit tests and or assignments:';
  const older = { nid: 'old', classNid: 'f', className: 'Functions', postedAt: '2026-09-01T12:00:00Z', text: `${heading}\nOct 15, Nov 3, Nov 24` };
  const newer = { nid: 'new', classNid: 'f', className: 'Functions', postedAt: '2026-09-14T12:00:00Z', text: `${heading}\nweek of Oct 5, week of Nov 2` };
  const other = { nid: 'x', classNid: 'f', className: 'Functions', postedAt: '2026-09-02T12:00:00Z', text: 'Lab report due Thursday October 1st' };
  const all = [older, newer, other].flatMap(readAssessmentDates);
  const { current, superseded } = supersedeSchedules(all, [older, newer, other]);
  assert.deepEqual(current.map((a) => a.date).sort(), ['2026-10-01', '2026-10-05', '2026-11-02'], 'the new schedule and the unrelated due date');
  assert.equal(superseded.length, 3);
  assert.ok(superseded.every((a) => a.supersededBy === 'new'));
});

test('two different schedules in one class are both kept', () => {
  const a = { nid: 'a', classNid: 'c', className: 'Science', postedAt: '2026-09-01T00:00:00Z', text: 'Test Schedule:\nOctober 1st' };
  const b = { nid: 'b', classNid: 'c', className: 'Science', postedAt: '2026-09-05T00:00:00Z', text: 'Lab report due dates:\nOctober 8th' };
  const { current, superseded } = supersedeSchedules([a, b].flatMap(readAssessmentDates), [a, b]);
  assert.equal(current.length, 2);
  assert.equal(superseded.length, 0);
});

test('the same schedule heading in two different classes is two schedules', () => {
  const a = { nid: 'a', classNid: 'c1', className: 'A', postedAt: '2026-09-01T00:00:00Z', text: 'Test Schedule:\nOctober 1st' };
  const b = { nid: 'b', classNid: 'c2', className: 'B', postedAt: '2026-09-05T00:00:00Z', text: 'Test Schedule:\nOctober 8th' };
  assert.equal(supersedeSchedules([a, b].flatMap(readAssessmentDates), [a, b]).current.length, 2);
});

// ---- class libraries and My Work, from the third real capture ----

const folderBody = (items, title = 'MCR3U-05') => JSON.stringify({ slices: [{ data: { title, body: { table: { itemSource: { item: items } } } } }] });

test('a library level lists its folders and files, each knowing its parent', () => {
  const body = JSON.parse(folderBody({
    r1: { nid: 11, rfrom: 5, date: '2026-08-31 14:45:42', creatorname: 'Mr. A', name: 'Quadratic Functions', nodetype: 3, nodesubtype: 16, title: { name: 'Quadratic Functions' } },
    r2: { nid: 12, rfrom: 5, date: '2026-09-02 10:00:00', creatorname: 'Mr. A', nodetype: 4, nodesubtype: 0, Content: { ContentName: 'Unit 1 notes.pdf', ContentType: 'application/pdf', ContentSize: '2048' } },
  }));
  const got = readClassFolder(body, '5');
  assert.deepEqual(got.map((i) => [i.kind, i.name, i.parentNid]), [['folder', 'Quadratic Functions', '5'], ['file', 'Unit 1 notes.pdf', '5']]);
  assert.deepEqual(got[1].file, { name: 'Unit 1 notes.pdf', type: 'application/pdf', bytes: 2048 });
  assert.equal(got[0].addedAt, '2026-08-31T14:45:42Z');
});

test('a file three folders deep still belongs to its class', () => {
  const classes = JSON.stringify({ slices: [{ data: { classesContainer: { classes: { r: { nid: 5, class: { class: { core: { summary: { line1: { course: 'Functions' }, info: { code: 'MCR3U-05' } } } } } } } } } }] });
  const n = normalizeCapture([
    { status: 200, url: '/core/node.json/1?xds=BaseStudentClasses', body: classes },
    { status: 200, url: '/core/node.json/5?xds=ClassFolder', body: folderBody({ a: { nid: 11, rfrom: 5, nodesubtype: 16, name: 'Unit 1' } }) },
    { status: 200, url: '/core/node.json/11?xds=ClassFolder', body: folderBody({ b: { nid: 21, rfrom: 11, nodesubtype: 16, name: 'Lessons' } }, 'Unit 1') },
    { status: 200, url: '/core/node.json/21?xds=ClassFolder', body: folderBody({ c: { nid: 31, rfrom: 21, Content: { ContentName: 'lesson 3.pdf' } } }, 'Lessons') },
  ], { now: 0 });
  const file = n.library.find((i) => i.kind === 'file');
  assert.equal(file.name, 'lesson 3.pdf');
  assert.equal(file.classNid, '5');
  assert.ok(n.library.every((i) => i.classNid === '5'));
});

test('My Work separates units from work, and keeps grades as sent', () => {
  const body = { slices: [{ data: { nid: 5, courseTitle: 'ENG3U-11', loaddata: {
    grades: { g1: { anything: 'as Edsby sends it' } },
    gradebook: {
      CourseID: 'ENG3U',
      strands: [{ key: 'k', name: 'Knowledge' }],
      terms: {
        u: { nid: 70, name: 'Unit 1: Short Stories', nodesubtype: 4 },
        w: { nid: 71, name: 'Literary Paragraph', nodesubtype: 3, fraction: '70/1', cdate: '2026-09-03 17:26:07', sdate: '2026-10-05 20:00:00', duedate: '2026-10-16 20:00:00', columns: { 0: 100 }, weighting: { 0: 10 }, summative: '1', type: '2', esubmit: 0 },
      },
      learningstandards: {},
    },
  } } }] };
  const w = readMyWork(body, '5', { timeZone: 'America/Toronto' });
  assert.equal(w.courseCode, 'ENG3U');
  assert.deepEqual(w.units, [{ nid: '70', name: 'Unit 1: Short Stories' }]);
  assert.equal(w.work.length, 1);
  assert.deepEqual(
    { ...w.work[0] },
    { nid: '71', name: 'Literary Paragraph', category: 'Unit 1: Short Stories', type: '', assignedDate: '2026-10-05', dueDate: '2026-10-16', dueAt: '2026-10-16T20:00:00Z', dateSet: true, placeholder: false, ongoing: false, summative: true, outOf: 100, weight: 10, submitsOnline: false, submittedAt: null, grade: null }
  );
  assert.equal(w.gradedCount, 0, 'a record for an id that is not this work is not a mark');
  assert.deepEqual(w.grades, { g1: { anything: 'as Edsby sends it' } });
  assert.equal(w.curriculum, undefined, 'curriculum expectations are not sent');
  assert.ok(!stripLayout(JSON.stringify(body)).includes('learningstandards'));
});
test('a folder opened with xds=Folder lists its files, without the link back to the class', () => {
  const body = { slices: [{ data: { title: 'Algebraic Expressions', body: { table: { itemSource: { item: {
    a: { nid: 31, rfrom: 11, date: '2026-09-14 16:43:40', creatorname: 'Mr. A', name: 'Lesson notes.pdf', nodetype: 5, nodesubtype: 0,
         file: { ContentType: 'application/pdf', ContentName: 'Lesson notes.pdf', ContentSize: 371211 } },
    back: { nid: 5, rfrom: 5, name: 'MCR3U-05', nodetype: 3, nodesubtype: 2 },
  } } } } } }] };
  const got = readClassFolder(body, '11');
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].kind, got[0].name, got[0].parentNid], ['file', 'Lesson notes.pdf', '11']);
  assert.deepEqual(got[0].file, { name: 'Lesson notes.pdf', type: 'application/pdf', bytes: 371211 });
});

// ---- from the study app's report on the 0.4.0 data, 15 September ----

test('an item the teacher never dated is recognised by its date equalling its creation', () => {
  const term = (name, cdate, due) => ({ nid: name, name, nodesubtype: 3, cdate, date: due, columns: { 0: 1 }, weighting: { 0: 1 }, summative: '0' });
  const body = { slices: [{ data: { loaddata: { grades: {}, gradebook: { terms: {
    a: term('Exam Placeholder', '2026-09-10 19:32:54', '2026-09-10 19:32:20'),
    b: term('Test 2', '2026-09-10 16:39:50', '2026-09-10 16:39:08'),
    c: term('Test 1', '2026-09-10 16:37:52', '2026-11-03 18:25:00'),
    d: term('Participation', '2026-09-10 16:49:56', '2026-09-10 16:48:59'),
    e: term('Attendance', '2026-09-10 16:53:06', '2027-06-03 17:25:00'),
  } } } } }] };
  const work = Object.fromEntries(readMyWork(body, '9', { timeZone: 'America/Toronto' }).work.map((x) => [x.name, x]));
  assert.equal(work['Exam Placeholder'].dateSet, false);
  assert.equal(work['Exam Placeholder'].placeholder, true);
  assert.equal(work['Test 2'].dateSet, false, 'a real name, never dated');
  assert.equal(work['Test 2'].dueDate, null);
  assert.equal(work['Test 1'].dateSet, true);
  assert.equal(work['Test 1'].dueDate, '2026-11-03');
  assert.equal(work['Attendance'].ongoing, true);
});

test('dated gradebook work becomes an assessment; undated, placeholder and ongoing items do not', () => {
  const classes = JSON.stringify({ slices: [{ data: { classesContainer: { classes: { r: { nid: 9, class: { class: { core: { summary: { line1: { course: 'Explore Excellence' }, info: { code: 'HZJ3O-11' } } } } } } } } } }] });
  const t = (nid, name, cdate, due, extra = {}) => ({ nid, name, nodesubtype: 3, cdate, date: due, summative: '1', columns: { 0: 100 }, weighting: { 0: 100 }, ...extra });
  const mywork = JSON.stringify({ slices: [{ data: { loaddata: { grades: {}, gradebook: { terms: {
    a: t(1, 'Test 1', '2026-09-10 16:37:52', '2026-11-03 18:25:00'),
    b: t(2, 'Test 2', '2026-09-10 16:39:50', '2026-09-10 16:39:08'),
    c: t(3, 'Exam Placeholder', '2026-09-10 19:32:54', '2026-09-10 19:32:20'),
    d: t(4, 'Attendance', '2026-09-10 16:53:06', '2027-06-03 17:25:00'),
  } } } } }] });
  const n = normalizeCapture([
    { status: 200, url: '/core/node.json/1?xds=BaseStudentClasses', body: classes },
    { status: 200, url: '/core/node.json/9?xds=MyWork&MyWork_active=assessments', body: mywork },
  ], { now: 0, timeZone: 'America/Toronto' });
  assert.deepEqual(n.assessments.map((a) => [a.source, a.label, a.date, a.className]), [['edsby', 'Test 1', '2026-11-03', 'Explore Excellence']]);
  assert.equal(n.mywork[0].work.length, 4, 'every item is still visible to the tutor');
});

test('a gradebook date and the post announcing it are one assessment, keeping both sides', () => {
  const edsby = { source: 'edsby', classNid: 'p', date: '2026-09-29', label: 'ISA demo + notes due', topic: '', evidence: '', tentative: false, precision: 'day', weight: 100 };
  const post = { source: 'post', postNid: '77', classNid: 'p', date: '2026-09-29', label: 'ISA', topic: 'electricity', evidence: 'ISA - September 29th', tentative: true, precision: 'day' };
  const week = { source: 'post', postNid: '78', classNid: 'p', date: '2026-09-28', label: 'Test', precision: 'week' };
  const other = { source: 'post', postNid: '79', classNid: 'q', date: '2026-09-29', label: 'Test', precision: 'day' };
  const got = mergeAnnouncements([edsby, post, week, other]);
  assert.equal(got.length, 3);
  const merged = got.find((a) => a.source === 'edsby');
  assert.deepEqual([merged.label, merged.announcedIn, merged.topic, merged.evidence, merged.tentative, merged.weight], ['ISA demo + notes due', '77', 'electricity', 'ISA - September 29th', true, 100]);
});

test('Edsby due times become the local day they fall on', () => {
  assert.equal(localDateOf('2026-10-16T20:00:00Z', 'America/Toronto'), '2026-10-16');
  assert.equal(localDateOf('2026-10-17T01:30:00Z', 'America/Toronto'), '2026-10-16', '9:30 PM the evening before in Toronto');
  assert.equal(localDateOf('2027-03-04T14:31:00Z', 'America/Toronto'), '2027-03-04');
  assert.equal(localDateOf(null, 'America/Toronto'), null);
});

// ---- from the 0.5.0 data, 15 September: the first published assignment ----

test('published work due the same day it was set: one assessment, on its due date, with its submission', () => {
  const classes = JSON.stringify({ slices: [{ data: { classesContainer: { classes: { r: { nid: 689, class: { class: { core: { summary: { line1: { course: 'Computer Science' }, info: { code: 'ICS4UG-01' } } } } } } } } } }] });
  const term = { nid: 328, esubmit: 1, cdate: '2026-09-15 12:51:11', sdate: '2026-09-07 13:30:00', date: '2026-09-15 13:30:00', duedate: '2026-09-15 13:30:00', columns: { 0: 5 }, name: 'AverageDensity', thread: 793, weighting: { 0: 5 }, summative: '0', type: '15', nodetype: 6, nodesubtype: 3 };
  const mywork = JSON.stringify({ slices: [{ data: { nid: 689, loaddata: {
    grades: { 328: { e: '2026-09-15 13:08:19', la: 1, r: '1', cols: {}, g: {} } },
    gradebook: { CourseID: 'ICS4UG', terms: {
      u: { nid: 793, name: 'Unit 1', nodesubtype: 4 },
      w: term,
      p: { nid: 329, cdate: '2026-09-10 19:22:36', date: '2026-09-10 19:21:20', duedate: '2026-09-10 19:21:20', name: 'Exam Placeholder', thread: 793, nodesubtype: 3 },
    } },
  }, other: { x: { nid: 328, submitButton: { calc: { submitted: '2026-09-15 13:08:20', button: 2 } } } } } }] });
  const calItem = { nid: 328, type: 6, subtype: 3, pnid: 689, name: 'AverageDensity', sdate: '2026-09-07 13:30:00', duedate: '2026-09-15 13:30:00', completeddate: '2026-09-15 13:08:20', assessmentType: '15', assessmentESubmit: { submitted: '2026-09-15 13:08:20', button: 2 }, nodetype: 6, nodesubtype: 10 };
  const calendar = JSON.stringify({ slices: [{ data: { itemdata: { r1: calItem } } }] });
  const feed = JSON.stringify({ slices: [{ data: { item: { r1: { nid: 328, creatorType: 'Teacher', creator: { user: 'Mr. R' }, nodesubtype: 3, itembody: { content: {
    header: { details: { date: '2026-09-15 12:51:11', title: { attendancename: { place: 'Computer Science' } } } },
    bodycontent: { assessment: { type: { type: '15', name: 'AverageDensity', adate: '2026-09-15 13:30:00' }, onlinetestinfo: { testtimes: { sdate: '2026-09-07 13:30:00', duedate: '2026-09-15 13:30:00' } } } },
  } } } } } }] });
  const n = normalizeCapture([
    { status: 200, url: '/core/node.json/1?xds=BaseStudentClasses', body: classes },
    { status: 200, url: '/core/node.json/689?xds=MyWork&MyWork_active=assessments', body: mywork },
    { status: 200, url: '/core/node.json/689?xds=CalendarPanel_Class', body: calendar },
    { status: 200, url: '/core/node.json/170?xds=CalendarPanel', body: calendar },
    { status: 200, url: '/core/node.json/689?xds=CourseFeed', body: feed },
  ], { now: 0, timeZone: 'America/Toronto' });
  assert.deepEqual(
    n.assessments.map((a) => [a.source, a.workNid, a.label, a.date, a.dueAt, a.className, a.category, a.submittedAt]),
    [['edsby', '328', 'AverageDensity', '2026-09-15', '2026-09-15T13:30:00Z', 'Computer Science', 'Unit 1', '2026-09-15T13:08:20Z']]
  );
  const w = n.mywork[0].work.find((x) => x.nid === '328');
  assert.equal(w.dateSet, true, '39 minutes after it was set is still a real due time');
  assert.deepEqual(w.grade, { updatedAt: '2026-09-15T13:08:19Z', marked: false, marks: null, columns: null });
  assert.equal(n.mywork[0].gradedCount, 0, 'handed in, not yet marked');
  assert.equal(n.mywork[0].work.find((x) => x.nid === '329').dateSet, false);
  const post = n.posts.find((p) => p.nid === '328');
  assert.deepEqual([post.kind, post.title, post.dueAt], ['assessment', 'AverageDensity', '2026-09-15T13:30:00Z']);
  const undated = n.posts.find((p) => p.nid === '329');
  assert.equal(undated, undefined);
});

test('a mark, once entered, counts as graded and is passed on as sent', () => {
  const body = { slices: [{ data: { loaddata: {
    grades: { 5: { e: '2026-10-01 14:00:00', cols: { 0: '4' }, g: { k: '4' } } },
    gradebook: { terms: { a: { nid: 5, name: 'Quiz', nodesubtype: 3, cdate: '2026-09-01 12:00:00', duedate: '2026-09-20 12:00:00' } } },
  } } }] };
  const w = readMyWork(body, '9', { timeZone: 'America/Toronto' });
  assert.deepEqual(w.work[0].grade, { updatedAt: '2026-10-01T14:00:00Z', marked: true, marks: { k: '4' }, columns: { 0: '4' } });
  assert.equal(w.gradedCount, 1);
});
