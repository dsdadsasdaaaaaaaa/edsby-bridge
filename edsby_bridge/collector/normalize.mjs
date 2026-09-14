/**
 * Edsby's raw responses, turned into what a person means by them.
 *
 * Pure: no browser, no network, no clock except what it is handed. Every
 * consumer — the study app, DayFlow, an assistant — reads this shape instead
 * of reverse-engineering Edsby's, and a fix here reaches all of them.
 *
 * Nothing here calls a model. Classes, timetable, events and posts are read
 * straight from Edsby's own fields. Assessment dates are the one place text
 * is interpreted, because teachers announce tests in post prose rather than
 * as Edsby assessments; that is done by rule, and every date says how precise
 * it is and quotes the line it came from.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function parseBody(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sliceData(body) {
  return body?.slices?.[0]?.data ?? null;
}

/** Edsby writes timed moments as "2026-09-14 12:30:00" in UTC. */
export function edsbyInstant(value) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/.exec(String(value ?? '').trim());
  if (!m) return null;
  return `${m[1]}T${m[2].length === 5 ? `${m[2]}:00` : m[2]}Z`;
}

/** An all-day value is a bare date and stays one: it is not a moment in any timezone. */
export function edsbyDate(value) {
  const m = /^(\d{4}-\d{2}-\d{2})$/.exec(String(value ?? '').trim());
  return m ? m[1] : null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', hellip: '…', ndash: '–', mdash: '—' };

export function htmlToText(html) {
  return String(html ?? '')
    // Line breaks in HTML source are only whitespace; the tags say where lines end.
    .replace(/\r?\n/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (w, n) => ENTITIES[n.toLowerCase()] ?? w)
    .replace(/[ \t ]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function linksIn(html) {
  const out = new Set();
  for (const m of String(html ?? '').matchAll(/href="([^"]+)"/gi)) {
    if (/^https?:\/\//i.test(m[1])) out.add(m[1].replace(/&amp;/g, '&'));
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Classes, timetable, events
// ---------------------------------------------------------------------------

export function readClasses(body) {
  const data = sliceData(body);
  const classes = data?.classesContainer?.classes ?? {};
  return Object.values(classes)
    .map((c) => {
      // entry.class holds the unread count; entry.class.class holds the course.
      const wrapper = c.class ?? {};
      const core = (wrapper.class ?? wrapper).core ?? {};
      return {
        nid: String(c.nid ?? ''),
        name: core.summary?.line1?.course ?? '',
        code: core.summary?.info?.code ?? '',
        teacher: c.teacherNames ?? '',
        unreadWork: Number(wrapper.myworkunread ?? c.myworkunread ?? 0) || 0,
      };
    })
    .filter((c) => c.nid);
}

export function readCalendar(body) {
  const data = sliceData(body);
  const items = Object.values(data?.itemdata ?? {});
  const timetable = [];
  const events = [];
  const assessments = [];
  for (const it of items) {
    const type = `${it.nodetype}/${it.nodesubtype}`;
    if (type === '6/13') {
      timetable.push({
        classNid: String(it.nid ?? ''),
        code: it.name ?? '',
        title: it.Title ?? it.class ?? '',
        block: Array.isArray(it.periodName) ? it.periodName.join(', ') : it.periodName ?? '',
        room: it.roomName ?? '',
        teacher: it.teacher ?? '',
        start: edsbyInstant(it.sdate),
        end: edsbyInstant(it.edate),
      });
    } else if (type === '6/2') {
      const allDay = String(it.allday) === '1';
      events.push({
        nid: String(it.nid ?? ''),
        title: String(it.name ?? '').replace(/\s+/g, ' ').trim(),
        allDay,
        start: allDay ? edsbyDate(it.sdate) : edsbyInstant(it.sdate),
        end: allDay ? edsbyDate(it.edate) : edsbyInstant(it.edate),
      });
    }
    // An assessment Edsby itself knows about, when a teacher enters one.
    if (it.assessmentType != null && String(it.assessmentType) !== '0') {
      assessments.push({
        source: 'edsby',
        classNid: String(it.pnid ?? it.nid ?? ''),
        label: String(it.name ?? it.Title ?? 'Assessment').trim(),
        date: edsbyDate(String(it.sdate ?? '').slice(0, 10)),
        precision: 'day',
        tentative: false,
        evidence: '',
      });
    }
  }
  return { timetable, events, assessments };
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/** One post, from the activity stream or a class feed — Edsby uses one shape for both. */
export function readPost(item, feedClassNid = null) {
  const content = item?.itembody?.content ?? {};
  const details = content.header?.details ?? {};
  const title = details.title ?? {};
  const html =
    content.bodycontent?.normal?.body?.content ??
    content.bodycontent?.learningdestinationattainment?.attainmentBody?.attainmentbody ??
    '';
  const files = content.bodycontent?.fileWrapper?.files?.init?.files ?? [];
  const classNid = String(title.name?.message?.classnid ?? item?.pnid ?? feedClassNid ?? '');
  const text = htmlToText(html);
  return {
    nid: String(item?.nid ?? ''),
    classNid,
    className: title.name?.message?.place ?? title.attendancename?.place ?? '',
    author: item?.creator?.user ?? '',
    authorRole: item?.creatorType ?? '',
    postedAt: edsbyInstant(details.date),
    text,
    html,
    links: linksIn(html),
    files: files.map((f) => ({
      nid: String(f.nid ?? ''),
      name: f.Content?.ContentName ?? '',
      type: f.Content?.ContentType ?? '',
      bytes: Number(f.Content?.ContentSize ?? 0) || 0,
    })),
    ...readLesson(text, edsbyInstant(details.date)),
  };
}

const LESSON_HEADING = /^(class date|date|topics?|learning goals?|success criteria|preparation|homework|follow[ -]?up tasks?|agenda|today|materials|next class)$/i;

/**
 * Headings, and whether they amount to a lesson summary.
 *
 * "Label: value" lines are everywhere — "Class Code: 2u5jyoq6", "Test
 * Schedule: Block 2" — so having headings does not make a post a lesson. It
 * is one when it gives a class date, or at least two of the headings
 * teachers use for a lesson.
 */
function readLesson(text, postedAt) {
  const parsed = readLessonSections(text);
  const sections = parsed?.sections ?? [];
  const known = sections.filter((sec) => LESSON_HEADING.test(sec.heading));
  const dateSection = sections.find((sec) => /^class date|^date$/i.test(sec.heading));
  let lessonDate = null;
  if (dateSection) {
    const m = DATE_PATTERN.exec(dateSection.items.join(' '));
    DATE_PATTERN.lastIndex = 0;
    if (m) lessonDate = isoDate(yearFor(MONTHS[m.groups.month.toLowerCase()], postedAt), MONTHS[m.groups.month.toLowerCase()], Number(m.groups.day));
  }
  return {
    sections,
    isLessonSummary: Boolean(lessonDate) || known.length >= 2,
    lessonDate,
  };
}

/**
 * The shape many teachers post a lesson in: "Class Date: …", "Topic:",
 * "Preparation:", "Follow up Tasks:", "Success Criteria:". Returned as
 * headings with their items, and null when a post has no such structure.
 */
export function readLessonSections(text) {
  const sections = [];
  let current = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^([A-Z][A-Za-z][A-Za-z /&-]{1,38}):\s*(.*)$/.exec(line);
    if (heading && !/^https?$/i.test(heading[1])) {
      current = { heading: heading[1].trim(), items: [] };
      sections.push(current);
      if (heading[2]) current.items.push(cleanItem(heading[2]));
      continue;
    }
    if (current) current.items.push(cleanItem(line));
  }
  if (sections.length < 2) return null;
  return { sections };
}

function cleanItem(line) {
  // A bullet may sit right against its text ("-Plan out"); a letter or number
  // marker only counts when a space follows ("a.) 1.3 Variables"), or the
  // "3." of "3.1 Input with Scanner" would be eaten.
  return line.replace(/^(?:[-•❑☐▪*]\s*|\(?[a-z0-9]{1,2}[.)]\)?\s+)/iu, '').trim();
}

// ---------------------------------------------------------------------------
// Assessment dates announced in prose
// ---------------------------------------------------------------------------

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const WEEKDAYS = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };

const ASSESSMENT_WORD = /\b(tests?|unit tests?|quiz(?:zes)?|exams?|midterms?|assessments?|culminating|evaluations?|presentations?|projects? due|due)\b/i;
const TENTATIVE = /\b(tentative|not all .{0,30}(will|may) be used|subject to change|may change|adjustments? .{0,20}may occur)\b/i;
/** Lines that carry a date that is plainly not an assessment. */
const NOT_ASSESSMENT_LINE = /^(class date|date of class|posted|today|lesson date)\b/i;

const DATE_PATTERN = new RegExp(
  String.raw`(?<week>\bweek\s+of\s+)?` +
    String.raw`(?:(?<weekday>sun|mon|tues?|wed|thu(?:rs?)?|fri|sat)[a-z]*\.?,?\s+)?` +
    String.raw`(?<month>jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+` +
    String.raw`(?<day>\d{1,2})(?:st|nd|rd|th)?` +
    String.raw`(?:\s*(?:or|/|&)\s*(?<alt>\d{1,2})(?:st|nd|rd|th)?)?`,
  'gi'
);

/** The calendar year a month belongs to, within the school year the post was written in. */
function yearFor(month, postedAt) {
  const posted = postedAt ? new Date(postedAt) : new Date();
  const startYear = posted.getUTCMonth() + 1 >= 8 ? posted.getUTCFullYear() : posted.getUTCFullYear() - 1;
  return month >= 8 ? startYear : startYear + 1;
}

function isoDate(y, m, d) {
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
  return probe.toISOString().slice(0, 10);
}

function weekdayOf(iso) {
  return new Date(`${iso}T12:00:00Z`).getUTCDay();
}

const SINGULAR = { quizzes: 'quiz', 'unit tests': 'unit test', 'projects due': 'project due', due: 'due' };

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function headingLabel(line, heading) {
  if (/culminating/i.test(line)) return 'Culminating assessment';
  const own = ASSESSMENT_WORD.exec(line);
  const word = ((own ?? ASSESSMENT_WORD.exec(heading))?.[1] ?? 'assessment').toLowerCase();
  return capitalise(SINGULAR[word] ?? word.replace(/s$/, ''));
}

/**
 * The line's own name for what happens on the date, when it gives one.
 *
 * "ISA - September 29th", "Test #1 - October 28th", "Minor exam: May 19th":
 * the words before the date are the teacher naming the thing. Taking the
 * heading's word instead called an independent study assignment a test.
 */
function lineLabel(line, matchIndex) {
  const before = line
    .slice(0, matchIndex)
    .replace(/[\s:–—-]+$/u, '')
    .replace(/\s+(on|is|due|by|for|will be)$/i, '')
    .trim();
  if (!before || before.length > 40) return null;
  if (before.split(/\s+/).length > 5) return null;
  // Another date in front means this is a list, and the list has no label.
  if (new RegExp(DATE_PATTERN.source, 'i').test(before)) return null;
  if (/[,;]$/.test(before)) return null;
  return capitalise(before);
}

/** What the date is about, when the line says: "October 21 – reactions to emancipation". */
function lineTopic(line, matchEnd) {
  const after = line
    .slice(matchEnd)
    .replace(/\([^)]*\)/g, '')
    .replace(/^[\s,;:–—-]+/u, '')
    .replace(/[.\s]+$/, '')
    .trim();
  if (after.length < 2 || after.length > 120) return '';
  if (new RegExp(DATE_PATTERN.source, 'i').test(after)) return '';
  return after;
}

/** The line naming a post as a schedule, when one of its first three does. */
function scheduleHeading(lines) {
  if (/^class date/i.test(lines[0] ?? '')) return '';
  return (
    lines
      .slice(0, 3)
      .find((l) => l.length <= 110 && ASSESSMENT_WORD.test(l) && /(dates?|schedule|calendar|:\s*$)/i.test(l)) ?? ''
  );
}

/**
 * "all are subject to change except minor exam": the one thing the teacher
 * has promised. Returns that phrase, lower-cased, or ''.
 */
function exceptedFromTentative(text) {
  const m = /(?:subject to change|tentative|may change)[^.\n]{0,20}?\bexcept(?:\s+for)?(?:\s+the)?\s+([a-z][a-z #0-9]{1,30}?)\s*(?:[.,;)\n]|$)/i.exec(text);
  return m ? m[1].trim().toLowerCase() : '';
}

/**
 * Every assessment date a post announces.
 *
 * A post is read as a schedule when one of its first three lines names one
 * ("Test Schedule: Block 2", "Projected test dates:", "Hi all, / tentative
 * test dates:"); then every date in it counts. Otherwise only a line that
 * itself names a test, quiz, exam or due date counts — so "Class Date: Monday
 * September 14th" in a lesson post is never mistaken for a test.
 *
 * A stated weekday is checked against the date. A mismatch is kept and
 * flagged, never silently corrected: it usually means the teacher typed one
 * of them wrong, and only a person can tell which.
 */
export function readAssessmentDates(post) {
  const lines = String(post?.text ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  const heading = scheduleHeading(lines);
  const schedulePost = Boolean(heading);
  const tentativePost = TENTATIVE.test(post.text);
  const excepted = exceptedFromTentative(post.text);
  const out = [];

  for (const line of lines) {
    if (NOT_ASSESSMENT_LINE.test(line)) continue;
    if (line === heading && !new RegExp(DATE_PATTERN.source, 'i').test(line)) continue;
    if (!schedulePost && !ASSESSMENT_WORD.test(line)) continue;
    for (const m of line.matchAll(DATE_PATTERN)) {
      const g = m.groups;
      const month = MONTHS[g.month.toLowerCase()];
      const year = yearFor(month, post.postedAt);
      const date = isoDate(year, month, Number(g.day));
      if (!date) continue;
      const alternatives = g.alt ? [isoDate(year, month, Number(g.alt))].filter(Boolean) : [];
      let weekdayMismatch = false;
      if (g.weekday) {
        const said = WEEKDAYS[g.weekday.toLowerCase()];
        if (said != null && said !== weekdayOf(date)) weekdayMismatch = true;
      }
      const precision = g.week ? 'week' : alternatives.length ? 'either' : 'day';
      const end = m.index + m[0].length;
      const note = /\(([^)]{1,40})\)/.exec(line.slice(end, end + 45))?.[1] ?? '';
      const label = lineLabel(line, m.index) ?? headingLabel(line, heading || lines[0]);
      const promised = Boolean(excepted) && (line.toLowerCase().includes(excepted) || label.toLowerCase().includes(excepted));
      out.push({
        source: 'post',
        postNid: post.nid,
        classNid: post.classNid,
        className: post.className,
        label,
        topic: lineTopic(line, end),
        date,
        alternatives,
        precision,
        tentative: (tentativePost || TENTATIVE.test(line)) && !promised,
        weekdayMismatch,
        note,
        heading,
        evidence: line.slice(0, 200),
      });
    }
  }
  // The same date announced twice in one post is one assessment.
  const seen = new Set();
  return out.filter((a) => {
    const key = `${a.classNid}|${a.label}|${a.date}|${a.precision}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function headingWords(text) {
  return new Set(String(text).toLowerCase().match(/[a-z]{3,}/g) ?? []);
}

function sameSchedule(a, b) {
  if (!a || !b) return false;
  const wa = headingWords(a);
  const wb = headingWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / new Set([...wa, ...wb]).size >= 0.7;
}

/**
 * When a teacher reposts a schedule, the new one replaces the old.
 *
 * Mr. Abikzir posted "Tentative Assessment Dates…" on 1 September with eight
 * dates, then again on the 14th with a revised list of weeks. Kept together,
 * the class showed fifteen dates that contradicted each other. Posts in the
 * same class whose schedule headings match are one schedule; the newest wins
 * and the older dates are returned separately, marked with what replaced
 * them, rather than silently dropped.
 */
export function supersedeSchedules(assessments, posts) {
  const postedAt = new Map(posts.map((p) => [p.nid, p.postedAt ?? '']));
  const byClass = new Map();
  for (const a of assessments) {
    if (a.source !== 'post' || !a.heading) continue;
    const list = byClass.get(a.classNid) ?? new Map();
    list.set(a.postNid, a.heading);
    byClass.set(a.classNid, list);
  }
  const replacedBy = new Map();
  for (const schedules of byClass.values()) {
    const entries = [...schedules.entries()].sort((x, y) => String(postedAt.get(y[0])).localeCompare(String(postedAt.get(x[0]))));
    entries.forEach(([nid, heading], i) => {
      if (replacedBy.has(nid)) return;
      for (const [olderNid, olderHeading] of entries.slice(i + 1)) {
        if (!replacedBy.has(olderNid) && sameSchedule(heading, olderHeading)) replacedBy.set(olderNid, nid);
      }
    });
  }
  const current = [];
  const superseded = [];
  for (const a of assessments) {
    const by = a.source === 'post' ? replacedBy.get(a.postNid) : undefined;
    if (by) superseded.push({ ...a, supersededBy: by });
    else current.push(a);
  }
  return { current, superseded };
}


// ---------------------------------------------------------------------------
// Class libraries and My Work
// ---------------------------------------------------------------------------

function fileOf(item) {
  // A folder lists a file as item.file = {ContentName, ContentType, ContentSize};
  // other views wrap it one level deeper.
  const c = item?.file?.ContentName ? item.file : item?.Content ?? item?.content ?? item?.file?.Content ?? null;
  if (!c || !(c.ContentName || c.contentName)) return null;
  return {
    name: c.ContentName ?? c.contentName ?? '',
    type: c.ContentType ?? c.contentType ?? '',
    bytes: Number(c.ContentSize ?? c.contentSize ?? 0) || 0,
  };
}

/**
 * One level of a class library: what a ClassFolder view lists.
 *
 * Edsby answers the same view for a class (its library's top level) and for a
 * folder inside it, and every entry names its parent in `rfrom`, which is how
 * a folder three levels down still knows its class.
 */
export function readClassFolder(body, containerNid) {
  const data = sliceData(body);
  const items = Object.values(data?.body?.table?.itemSource?.item ?? {});
  return items
    // A folder lists a way back up to its class (nodetype 3, subtype 2): a
    // link, not something in the folder.
    .filter((it) => !(String(it.nodetype) === '3' && String(it.nodesubtype) === '2'))
    .map((it) => {
      const file = fileOf(it);
      const subtype = String(it.nodesubtype ?? '');
      return {
        nid: String(it.nid ?? ''),
        parentNid: String(it.rfrom ?? containerNid ?? ''),
        name: String(it.title?.name ?? it.name ?? file?.name ?? '').trim(),
        kind: subtype === '16' ? 'folder' : file ? 'file' : 'item',
        addedAt: edsbyInstant(it.date),
        addedBy: it.creatorname ?? '',
        file,
      };
    })
    .filter((it) => it.nid);
}

function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * A class's My Work: its units, the curriculum expectations it covers, how it
 * is marked, and whatever has been graded.
 *
 * Grades are passed through as Edsby sends them, not interpreted: none had
 * been entered when this was written, so their shape has never been seen, and
 * guessing at a mark would be worse than handing it over untouched.
 */
export function readMyWork(body, classNid) {
  const data = sliceData(body);
  const load = data?.loaddata ?? {};
  const gb = load.gradebook ?? {};
  const grades = load.grades && typeof load.grades === 'object' ? load.grades : {};
  return {
    classNid: String(classNid ?? data?.nid ?? ''),
    courseCode: gb.CourseID ?? data?.courseTitle ?? '',
    units: Object.values(gb.terms ?? {})
      .map((t) => ({ nid: String(t.nid ?? ''), name: oneLine(t.name), start: edsbyInstant(t.sdate) }))
      .sort((a, b) => String(a.start).localeCompare(String(b.start))),
    strands: (gb.strands ?? []).map((st) => ({ key: st.key ?? '', name: st.name ?? '' })),
    curriculum: Object.values(gb.learningstandards ?? {})
      .map((ls) => ({ code: ls.fullcode ?? ls.name ?? '', title: oneLine(ls.title), level: ls.type === 'Destination' ? 'overall' : 'specific' }))
      .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
    gradedCount: Object.keys(grades).length,
    grades,
  };
}

// ---------------------------------------------------------------------------
// The whole capture
// ---------------------------------------------------------------------------

function viewOf(url) {
  return /[?&]xds=([A-Za-z_]+)/.exec(url)?.[1] ?? '';
}

function nidOf(url) {
  return /\/node\.json\/(\d+)/.exec(url)?.[1] ?? null;
}

export function normalizeCapture(responses, { host = '', now = Date.now(), storedFiles = new Set() } = {}) {
  const classes = new Map();
  const timetable = [];
  const events = new Map();
  const posts = new Map();
  const edsbyAssessments = [];
  const libraryItems = new Map();
  const mywork = new Map();

  for (const r of responses) {
    if (r.status !== 200) continue;
    const view = viewOf(r.url);
    const body = parseBody(r.body);
    if (!body) continue;

    if (view === 'BaseStudentClasses') {
      for (const c of readClasses(body)) classes.set(c.nid, c);
    } else if (view === 'CalendarPanel' || view === 'CalendarPanel_Class') {
      const cal = readCalendar(body);
      for (const t of cal.timetable) {
        // A class's own calendar names its period with a placeholder id
        // (-102); the home calendar uses the real one. Same course, same
        // start: one period, keeping the id that points at something.
        const twin = timetable.find((x) => x.code === t.code && x.start === t.start);
        if (!twin) timetable.push(t);
        else if (Number(twin.classNid) < 0 && Number(t.classNid) > 0) twin.classNid = t.classNid;
      }
      for (const ev of cal.events) events.set(ev.nid || `${ev.title}|${ev.start}`, ev);
      edsbyAssessments.push(...cal.assessments);
    } else if (view === 'BaseActivity') {
      for (const item of Object.values(sliceData(body)?.body?.messages?.item ?? {})) {
        const p = readPost(item);
        if (p.nid) posts.set(p.nid, p);
      }
    } else if (view === 'ClassFolder' || view === 'Folder') {
      for (const it of readClassFolder(body, nidOf(r.url))) libraryItems.set(it.nid, it);
    } else if (view === 'MyWork') {
      const work = readMyWork(body, nidOf(r.url));
      if (work.classNid) mywork.set(work.classNid, work);
    } else if (view === 'CourseFeed') {
      const feedNid = nidOf(r.url);
      for (const item of Object.values(sliceData(body)?.item ?? {})) {
        const p = readPost(item, feedNid);
        // The activity stream names the class; a feed's copy may not.
        if (p.nid) posts.set(p.nid, { ...posts.get(p.nid), ...p, className: p.className || posts.get(p.nid)?.className || '' });
      }
    }
  }

  // Placeholder ids the home calendar never corrected: resolve by course code.
  const byCode = new Map([...classes.values()].map((c) => [c.code, c.nid]));
  for (const t of timetable) if (Number(t.classNid) < 0 && byCode.has(t.code)) t.classNid = byCode.get(t.code);

  const postList = [...posts.values()]
    .map((p) => ({
      ...p,
      className: p.className || classes.get(p.classNid)?.name || '',
      files: p.files.map((f) => ({ ...f, stored: storedFiles.has(f.nid) })),
    }))
    .sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)));
  const byDate = (a, b) => String(a.date).localeCompare(String(b.date));
  const { current, superseded } = supersedeSchedules([...edsbyAssessments, ...postList.flatMap(readAssessmentDates)], postList);

  // Each library entry learns its class by walking up through its parents.
  const classOf = (nid, depth = 0) => {
    if (classes.has(nid)) return nid;
    const parent = libraryItems.get(nid)?.parentNid;
    return parent && depth < 12 ? classOf(parent, depth + 1) : '';
  };
  const library = [...libraryItems.values()]
    .map((it) => ({ ...it, classNid: classOf(it.parentNid) || it.parentNid, stored: it.kind === 'file' && storedFiles.has(it.nid) }))
    .sort((a, b) => a.classNid.localeCompare(b.classNid) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  return {
    schema: 1,
    host,
    normalizedAt: new Date(now).toISOString(),
    classes: [...classes.values()].sort((a, b) => a.name.localeCompare(b.name)),
    timetable: timetable.sort((a, b) => String(a.start).localeCompare(String(b.start))),
    events: [...events.values()].sort((a, b) => String(a.start).localeCompare(String(b.start))),
    posts: postList,
    assessments: current.sort(byDate),
    supersededAssessments: superseded.sort(byDate),
    library,
    mywork: [...mywork.values()],
  };
}

/** Edsby's screen layout travels beside the data in every response and is most of its size. */
export function stripLayout(text) {
  const body = parseBody(text);
  if (!body || !Array.isArray(body.slices)) return text;
  for (const slice of body.slices) if (slice && typeof slice === 'object') delete slice.xds;
  return JSON.stringify(body);
}
