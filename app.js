// ===== Macro Tracker — Phase 6B: per-account cloud data (Firestore) =====
// Data (meals/workouts/weight/targets/1RMs) lives in Firestore under the logged-in
// profile — profiles/{profileKey}, with a days/{YYYY-MM-DD} subcollection. Loaded
// into an in-memory cache (`cloud`) on login; writes update the cache immediately
// (so the UI stays instant/synchronous like before) and push to Firestore in the
// background. See CLAUDE.md "Phase 6 — Accounts" for the full design writeup.

const DEFAULT_TARGETS = { calories: 2000, carbs: 200, protein: 150, fat: 65 };
const DEFAULT_ACTIVITY_LEVEL = 24;

// In-memory mirror of the logged-in profile's Firestore data.
let cloud = { targets: { ...DEFAULT_TARGETS }, activityLevel: DEFAULT_ACTIVITY_LEVEL, oneRepMaxes: {}, theme: "classic", weeklySteps: {}, days: {} };
let profileDocRef = null;

function applyTheme() {
  document.body.setAttribute("data-vibe", cloud.theme || "classic");
  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.vibeValue === (cloud.theme || "classic"));
  });
}

document.getElementById("themePicker").addEventListener("click", (e) => {
  const btn = e.target.closest(".theme-swatch");
  if (!btn) return;
  saveSettings({ theme: btn.dataset.vibeValue });
  applyTheme();
});

const EXERCISE_LIBRARY = {
  Chest: ["Bench Press", "Incline Bench Press", "Dumbbell Press", "Push-up", "Chest Fly"],
  Back: ["Deadlift", "Barbell Row", "Lat Pulldown", "Pull-up", "Seated Cable Row"],
  Legs: ["Squat", "Leg Press", "Lunges", "Leg Extension", "Leg Curl", "Calf Raise"],
  Shoulders: ["Overhead Press", "Lateral Raise", "Front Raise", "Face Pull"],
  Arms: ["Bicep Curl", "Hammer Curl", "Tricep Pushdown", "Tricep Dip", "Skull Crusher"],
  Core: ["Plank", "Sit-up", "Hanging Leg Raise", "Russian Twist"],
  "Full Body / Conditioning": ["Kettlebell Swing", "Box Jump", "Burpee", "Clean and Jerk", "Snatch", "Farmer's Carry"],
};
const CUSTOM_OPTION_VALUE = "__custom__";

// Backend that holds the Gemini API key server-side (never in this public repo).
// Deployed to Vercel — see api-backend/ in this project. Verified live 2026-09-15.
const PHOTO_ANALYZE_URL = "https://macro-tracker-api-backend1.vercel.app/api/analyze-food";

const RING_R = 70, RING_CIRC = 2 * Math.PI * RING_R;
const MRING_R = 26, MRING_CIRC = 2 * Math.PI * MRING_R;

let currentDate = new Date();
let pendingPhoto = null; // data URL for the meal being added
let pendingWeightPhoto = null; // data URL for the weigh-in being added
let activeTab = "nutrition"; // "nutrition" | "workouts" | "weight"

// ---------- Helpers ----------
function dateKey(d) {
  // LOCAL calendar date, not UTC. toISOString() converts to UTC first, which
  // in Melbourne (UTC+10/+11) means anything logged between midnight and
  // ~10-11am local still reads as "yesterday" by the clock, and — the bug
  // Kevin actually hit — food logged the night before can still get counted
  // under "Today" for hours after his local calendar day has already rolled
  // over, since the app's own notion of "today" lags local midnight by the
  // UTC offset. Building the key from local Y/M/D fixes both directions.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatDateLabel(d) {
  const today = new Date();
  if (dateKey(d) === dateKey(today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(d) === dateKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

// Read-only peek at a day's bucket — never creates an entry, so scanning
// backward (e.g. computeStreak) doesn't bloat `cloud.days` with empties.
function peekDayBucket(d) {
  return cloud.days[dateKey(d)] || { meals: [], workouts: [], weights: [] };
}

// Pushes one day's bucket to Firestore in the background. Not awaited by
// callers — the in-memory `cloud` update already happened synchronously, so
// the UI is instant; this just syncs. Errors are logged, not surfaced (a
// dropped sync on a flaky connection shouldn't block using the app).
function persistDay(key) {
  if (!profileDocRef) return;
  profileDocRef.collection("days").doc(key).set(cloud.days[key])
    .catch((err) => console.error("Failed to sync day " + key, err));
}

function loadDay(d) { return peekDayBucket(d).meals; }
function saveDay(d, meals) {
  const key = dateKey(d);
  cloud.days[key] = { ...peekDayBucket(d), meals };
  persistDay(key);
}

function loadTargets() { return cloud.targets; }
function saveTargets(targets) {
  cloud.targets = targets;
  if (profileDocRef) profileDocRef.update({ targets }).catch((err) => console.error("Failed to sync targets", err));
}

function loadWorkoutDay(d) { return peekDayBucket(d).workouts; }
function saveWorkoutDay(d, entries) {
  const key = dateKey(d);
  cloud.days[key] = { ...peekDayBucket(d), workouts: entries };
  persistDay(key);
}

// Scans every day bucket in the in-memory cache — needed for progression,
// which is inherently cross-date, unlike the daily nutrition totals.
function getAllWorkoutEntriesByDate() {
  return Object.entries(cloud.days)
    .filter(([, bucket]) => bucket.workouts && bucket.workouts.length)
    .map(([date, bucket]) => ({ date, entries: bucket.workouts }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function getAllExerciseNames() {
  const names = new Set();
  for (const { entries } of getAllWorkoutEntriesByDate()) {
    entries.forEach((e) => names.add(e.exercise));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function loadOneRepMaxes() { return cloud.oneRepMaxes; }
function saveOneRepMax(exercise, kg) {
  if (kg <= 0) return;
  cloud.oneRepMaxes[exercise] = kg;
  if (profileDocRef) {
    profileDocRef.update({ oneRepMaxes: cloud.oneRepMaxes }).catch((err) => console.error("Failed to sync 1RM", err));
  }
}

function loadWeightDay(d) { return peekDayBucket(d).weights; }
function saveWeightDay(d, entries) {
  const key = dateKey(d);
  cloud.days[key] = { ...peekDayBucket(d), weights: entries };
  persistDay(key);
}

// Cross-date, like getAllWorkoutEntriesByDate — weight trend needs every day, not just "today".
function getAllWeightEntriesByDate() {
  return Object.entries(cloud.days)
    .filter(([, bucket]) => bucket.weights && bucket.weights.length)
    .map(([date, bucket]) => ({ date, entries: bucket.weights }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function loadSettings() { return { activityLevel: cloud.activityLevel }; }
function saveSettings(partial) {
  Object.assign(cloud, partial);
  if (profileDocRef) profileDocRef.update(partial).catch((err) => console.error("Failed to sync settings", err));
}

// Shared line-chart renderer — used by exercise progression, the regular
// Weight tab (both unbounded — can have 50+ points once real history is
// imported), and the dashboard's weight trend (always capped at <=20 points).
// `labelAll`: when true, every point gets its value + axis label (only safe
// for the capped dashboard case — Kevin explicitly asked for numbers there).
// Default stays sparse (first/last axis label, last value only) since
// labeling 50+ points would be unreadable, not a stylistic choice to skip.
function drawTrendChart(chartEl, points, unit, labelAll = false) {
  const w = 300, h = 120, pad = 18;
  const values = points.map((p) => p.value);
  const minV = Math.min(...values), maxV = Math.max(...values);
  const range = maxV - minV || 1;

  const coords = points.map((p, i) => ({
    x: pad + (i / (points.length - 1)) * (w - pad * 2),
    y: h - pad - ((p.value - minV) / range) * (h - pad * 2),
    ...p,
  }));

  const pathD = coords.map((c, i) => (i === 0 ? `M${c.x},${c.y}` : `L${c.x},${c.y}`)).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];

  let extraSvg = "";
  if (labelAll) {
    extraSvg = coords.map((c) => `
      <circle class="progression-dot" cx="${c.x}" cy="${c.y}" r="3"></circle>
      <text class="progression-value-label" x="${c.x}" y="${Math.max(10, c.y - 7)}" text-anchor="middle">${c.value}${unit}</text>
      <text class="progression-axis-label" x="${c.x}" y="${h - 4}" text-anchor="middle">${c.label}</text>
    `).join("");
  } else {
    extraSvg = `
      <circle class="progression-dot" cx="${last.x}" cy="${last.y}" r="4"></circle>
      <text class="progression-value-label" x="${last.x}" y="${Math.max(10, last.y - 8)}" text-anchor="end">${last.value}${unit}</text>
      <text class="progression-axis-label" x="${first.x}" y="${h - 4}" text-anchor="start">${first.label}</text>
      <text class="progression-axis-label" x="${last.x}" y="${h - 4}" text-anchor="end">${last.label}</text>
    `;
  }

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <path class="progression-line" d="${pathD}"></path>
      ${extraSvg}
    </svg>
  `;
}

// Populate the exercise <select> with: previously-logged custom exercises (if any,
// not already in the library) first, then the built-in library grouped by category,
// then a trailing "Custom exercise" option — reliable everywhere, unlike <datalist>
// which iOS Safari silently ignores.
function populateExerciseSelect() {
  const select = document.getElementById("exerciseSelect");
  const previousValue = select.value;
  select.innerHTML = "";

  const libraryNames = new Set(Object.values(EXERCISE_LIBRARY).flat());
  const loggedNames = getAllExerciseNames().filter((n) => !libraryNames.has(n));

  if (loggedNames.length) {
    const group = document.createElement("optgroup");
    group.label = "Your exercises";
    loggedNames.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      group.appendChild(opt);
    });
    select.appendChild(group);
  }

  for (const [category, exercises] of Object.entries(EXERCISE_LIBRARY)) {
    const group = document.createElement("optgroup");
    group.label = category;
    exercises.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      group.appendChild(opt);
    });
    select.appendChild(group);
  }

  const customOpt = document.createElement("option");
  customOpt.value = CUSTOM_OPTION_VALUE;
  customOpt.textContent = "+ Custom exercise…";
  select.appendChild(customOpt);

  if ([...select.options].some((o) => o.value === previousValue)) {
    select.value = previousValue;
  }

  const isCustom = select.value === CUSTOM_OPTION_VALUE;
  document.getElementById("exerciseCustomName").classList.toggle("hidden", !isCustom);
  document.getElementById("oneRepMaxInput").value = loadOneRepMaxes()[currentExerciseName()] || "";
  updatePctHint();
  updateWeightSuggestion();
}

function currentExerciseName() {
  const select = document.getElementById("exerciseSelect");
  if (select.value === CUSTOM_OPTION_VALUE) {
    return document.getElementById("exerciseCustomName").value.trim();
  }
  return select.value;
}

function updatePctHint() {
  const exercise = currentExerciseName();
  const oneRm = Number(document.getElementById("oneRepMaxInput").value) || loadOneRepMaxes()[exercise] || 0;
  const weight = Number(document.getElementById("exerciseWeight").value) || 0;
  const hintEl = document.getElementById("pctOneRm");

  if (oneRm > 0 && weight > 0) {
    hintEl.textContent = `≈ ${Math.round((weight / oneRm) * 100)}% of your ${oneRm}kg 1RM`;
  } else {
    hintEl.textContent = "";
  }
}

// Most recent logged set for this exact exercise, across every day loaded —
// used for the progressive-overload suggestion below.
function getLastExerciseEntry(exerciseName) {
  const byDate = getAllWorkoutEntriesByDate(); // ascending by date already
  for (let i = byDate.length - 1; i >= 0; i--) {
    const matches = byDate[i].entries.filter((e) => e.exercise === exerciseName);
    if (matches.length === 0) continue;
    const latest = matches.slice().sort((a, b) => new Date(b.time) - new Date(a.time))[0];
    return { ...latest, date: byDate[i].date };
  }
  return null;
}

// Simple progressive-overload nudge: ~2.5% up from last time, rounded to the
// nearest 2.5kg (standard plate increment) — a suggestion to react to, not a
// rule to follow blindly, hence "try", not "do".
function updateWeightSuggestion() {
  const exercise = currentExerciseName();
  const hintEl = document.getElementById("weightSuggestionHint");
  if (!exercise) { hintEl.textContent = ""; return; }

  const last = getLastExerciseEntry(exercise);
  if (!last) { hintEl.textContent = ""; return; }

  const suggested = Math.max(2.5, Math.round((last.weight * 1.025) / 2.5) * 2.5);
  hintEl.textContent =
    `Last time (${formatShortDate(last.date)}): ${last.weight}kg × ${last.reps} reps × ${last.sets} sets — try ${suggested}kg today`;
}

function computeStreak() {
  let count = 0;
  const d = new Date();
  // Grace period: if today has nothing logged yet, don't zero the streak mid-day.
  if (loadDay(d).length === 0) d.setDate(d.getDate() - 1);
  while (loadDay(d).length > 0) {
    count++;
    d.setDate(d.getDate() - 1);
  }
  return count;
}

function setRing(fillEl, circumference, pct, isOver) {
  fillEl.style.strokeDasharray = `${circumference}`;
  fillEl.style.strokeDashoffset = `${circumference * (1 - pct / 100)}`;
  fillEl.classList.toggle("over", isOver);
}

// ---------- Rendering ----------
function render() {
  document.getElementById("dateLabel").textContent = formatDateLabel(currentDate);
  document.getElementById("streakCount").textContent = computeStreak();

  const meals = loadDay(currentDate);
  const targets = loadTargets();

  const totals = meals.reduce(
    (acc, m) => {
      acc.calories += m.calories;
      acc.carbs += m.carbs;
      acc.protein += m.protein;
      acc.fat += m.fat;
      return acc;
    },
    { calories: 0, carbs: 0, protein: 0, fat: 0 }
  );

  document.getElementById("val-calories").textContent = totals.calories;
  document.getElementById("target-calories").textContent = targets.calories;
  const calPct = targets.calories > 0 ? Math.min(100, (totals.calories / targets.calories) * 100) : 0;
  setRing(document.getElementById("ring-calories"), RING_CIRC, calPct, totals.calories > targets.calories);

  for (const macro of ["carbs", "protein", "fat"]) {
    document.getElementById("val-" + macro).textContent = totals[macro];
    document.getElementById("target-" + macro).textContent = targets[macro];
    const pct = targets[macro] > 0 ? Math.min(100, (totals[macro] / targets[macro]) * 100) : 0;
    setRing(document.getElementById("ring-" + macro), MRING_CIRC, pct, totals[macro] > targets[macro]);
  }

  // "Nutrition to fill out the rest of my calories" — show what's actually
  // left to hit every target today, not just calories in isolation.
  const remainingEl = document.getElementById("remainingLabel");
  const remCal = targets.calories - totals.calories;
  const remCarbs = targets.carbs - totals.carbs;
  const remProtein = targets.protein - totals.protein;
  const remFat = targets.fat - totals.fat;
  if (remCal >= 0) {
    remainingEl.textContent = `${remCal} kcal left · ${Math.max(0, remProtein)}g protein · ${Math.max(0, remCarbs)}g carbs · ${Math.max(0, remFat)}g fat`;
    remainingEl.classList.remove("over-budget");
  } else {
    remainingEl.textContent = `${Math.abs(remCal)} kcal over today's target`;
    remainingEl.classList.add("over-budget");
  }

  const listEl = document.getElementById("mealList");
  const emptyEl = document.getElementById("emptyState");
  listEl.innerHTML = "";

  if (meals.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    meals.forEach((m) => {
      const li = document.createElement("li");
      li.className = "meal-item glass";
      li.setAttribute("data-id", m.id);
      li.innerHTML = `
        ${m.photo ? `<img class="meal-thumb" src="${m.photo}" alt="" />` : `<div class="meal-thumb"></div>`}
        <div class="meal-info">
          <div class="meal-name">${escapeHtml(m.name)}</div>
          <div class="meal-macros">${m.calories} cal · C ${m.carbs}g · P ${m.protein}g · F ${m.fat}g</div>
          ${notesHtml(m.notes)}
        </div>
        <button class="delete-btn" data-id="${m.id}" aria-label="Delete meal">✕</button>
      `;
      listEl.appendChild(li);
    });
  }

  renderWorkoutView();
  renderWeightView();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function notesHtml(notes) {
  return notes ? `<div class="entry-notes">"${escapeHtml(notes)}"</div>` : "";
}

function formatShortDate(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------- Workouts ----------
function renderWorkoutView() {
  const entries = loadWorkoutDay(currentDate);
  const listEl = document.getElementById("workoutList");
  const emptyEl = document.getElementById("workoutEmptyState");
  listEl.innerHTML = "";

  if (entries.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    entries.forEach((w) => {
      const li = document.createElement("li");
      li.className = "meal-item glass";
      const pctText = w.pct ? ` (${w.pct}% 1RM)` : "";
      li.innerHTML = `
        <div class="meal-thumb workout-thumb" aria-hidden="true"><svg class="inline-icon"><use href="#icon-dumbbell"/></svg></div>
        <div class="meal-info">
          <div class="meal-name">${escapeHtml(w.exercise)}</div>
          <div class="meal-macros">${w.weight}kg${pctText} × ${w.reps} reps × ${w.sets} sets</div>
          ${notesHtml(w.notes)}
        </div>
        <button class="delete-btn" data-id="${w.id}" aria-label="Delete exercise">✕</button>
      `;
      listEl.appendChild(li);
    });
  }

  const picker = document.getElementById("exercisePicker");
  const names = getAllExerciseNames();
  const previousSelection = picker.value;
  picker.innerHTML = "";

  if (names.length === 0) {
    const opt = document.createElement("option");
    opt.textContent = "No exercises logged yet";
    opt.disabled = true;
    picker.appendChild(opt);
  } else {
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      picker.appendChild(opt);
    });
    if (names.includes(previousSelection)) picker.value = previousSelection;
  }

  populateExerciseSelect();
  renderProgressionChart(picker.value);
}

function renderProgressionChart(exerciseName) {
  const chartEl = document.getElementById("progressionChart");

  if (!exerciseName) {
    chartEl.innerHTML = `<p class="empty-state">Log an exercise to see progression here.</p>`;
    return;
  }

  // One point per day: the heaviest weight logged that day for this exercise.
  const points = [];
  for (const { date, entries } of getAllWorkoutEntriesByDate()) {
    const matches = entries.filter((e) => e.exercise === exerciseName);
    if (matches.length === 0) continue;
    points.push({ label: formatShortDate(date), value: Math.max(...matches.map((e) => e.weight)) });
  }

  if (points.length < 2) {
    chartEl.innerHTML = `<p class="empty-state">Log this exercise a couple more times to see a trend.</p>`;
    return;
  }

  drawTrendChart(chartEl, points, "kg");
}

// ---------- Weight ----------
// Compares what your CURRENT calorie target predicts your weight trend should
// be against what it's actually doing, and suggests a correction — this is
// the "adjust as more information presents itself" piece, distinct from the
// one-time maintenance-minus-200 estimate above it.
//
// Method: ~7700 kcal per kg of body mass (standard approximation). Uses the
// last ~21 days of weigh-ins (falls back to full history if that's too
// sparse) so the trend reflects current habits, not the very first weigh-in
// months ago. Needs >=5 days of spread to trust a rate at all — a single
// day's noise (water weight, etc.) isn't a trend.
function computeAdaptiveSuggestion(allByDate, activityLevel, currentTarget) {
  if (allByDate.length < 2) return null;

  const latestDate = new Date(allByDate[allByDate.length - 1].date + "T00:00:00");
  const windowStart = new Date(latestDate);
  windowStart.setDate(windowStart.getDate() - 21);

  let windowed = allByDate.filter(({ date }) => new Date(date + "T00:00:00") >= windowStart);
  if (windowed.length < 2) windowed = allByDate;

  const first = windowed[0];
  const last = windowed[windowed.length - 1];
  const firstWeight = first.entries[0].weight;
  const lastWeight = last.entries[last.entries.length - 1].weight;
  const days = (new Date(last.date + "T00:00:00") - new Date(first.date + "T00:00:00")) / 86400000;
  if (days < 5) return null;

  const actualKgPerWeek = Math.round(((lastWeight - firstWeight) / days) * 7 * 100) / 100;
  const maintenance = lastWeight * activityLevel;
  const expectedKgPerWeek = Math.round((-((maintenance - currentTarget) * 7) / 7700) * 100) / 100;

  // Positive adjustment = eat more (actual loss outrunning the target's prediction);
  // negative = eat less (actual loss lagging what the target predicts).
  const adjustment = Math.round((((expectedKgPerWeek - actualKgPerWeek) * 7700) / 7 / 25)) * 25;
  const dayCount = Math.round(days);

  if (Math.abs(adjustment) < 75) {
    return {
      onTrack: true,
      reasoning: `Over the last ${dayCount} days you've trended ${actualKgPerWeek}kg/week — matches what ${currentTarget} kcal/day predicts (${expectedKgPerWeek}kg/week). No change needed.`,
    };
  }

  const direction = adjustment > 0 ? "faster" : "slower";
  return {
    onTrack: false,
    newTarget: Math.max(1000, currentTarget + adjustment),
    reasoning: `Over the last ${dayCount} days you've trended ${actualKgPerWeek}kg/week vs. an expected ${expectedKgPerWeek}kg/week — changing ${direction} than ${currentTarget} kcal/day predicts.`,
  };
}

// Turns imported weekly step totals into an activity-level suggestion for the
// same weight×multiplier maintenance formula used above — real behavior data
// instead of a guessed dropdown pick. Steps alone under-count anyone who
// trains (lifting racks up very few steps but real expenditure), so this
// cross-checks against actual logged workout days in the same window and
// bumps one tier if he's training regularly but steps alone would read
// "sedentary" — otherwise the suggestion would quietly punish him for lifting.
function computeStepBasedActivityLevel() {
  const weekKeys = Object.keys(cloud.weeklySteps || {}).sort();
  if (weekKeys.length < 2) return null;

  const recentWeeks = weekKeys.slice(-8);
  const avgWeekly = recentWeeks.reduce((sum, k) => sum + cloud.weeklySteps[k], 0) / recentWeeks.length;
  const avgDaily = Math.round(avgWeekly / 7);

  let level = avgDaily < 5000 ? 22 : avgDaily < 9000 ? 24 : 26;

  const windowStart = new Date(recentWeeks[0] + "T00:00:00");
  const workoutDaysInWindow = getAllWorkoutEntriesByDate()
    .filter(({ date }) => new Date(date + "T00:00:00") >= windowStart).length;

  let bumped = false;
  if (workoutDaysInWindow >= 4 && level < 26) {
    level += 2;
    bumped = true;
  }

  return { avgDaily, weeksUsed: recentWeeks.length, workoutDaysInWindow, level, bumped };
}

function renderWeightView() {
  const settings = loadSettings();
  document.getElementById("activityLevel").value = settings.activityLevel;

  // Doesn't depend on any weight data existing — must run before the
  // "no weigh-ins yet" early return below, or someone with step history but
  // no weigh-ins logged yet would never see it.
  const stepsBox = document.getElementById("stepsInsightBox");
  const stepsInsight = computeStepBasedActivityLevel();
  if (!stepsInsight) {
    stepsBox.classList.add("hidden");
  } else {
    stepsBox.classList.remove("hidden");
    const levelName = stepsInsight.level === 22 ? "Sedentary" : stepsInsight.level === 24 ? "Moderately active" : "Very active";
    const bumpNote = stepsInsight.bumped
      ? ` — bumped up from steps alone since you've logged ${stepsInsight.workoutDaysInWindow} workout days in that window (steps alone miss lifting).`
      : "";
    document.getElementById("stepsInsightReasoning").textContent =
      `Avg ${stepsInsight.avgDaily.toLocaleString()} steps/day over your last ${stepsInsight.weeksUsed} weeks of history → "${levelName}"${bumpNote}`;
    const applyStepsBtn = document.getElementById("applyStepsLevel");
    applyStepsBtn.dataset.value = stepsInsight.level;
    applyStepsBtn.classList.toggle("hidden", stepsInsight.level === settings.activityLevel);
  }

  const todaysEntries = loadWeightDay(currentDate);
  const listEl = document.getElementById("weightList");
  const emptyEl = document.getElementById("weightEmptyState");
  listEl.innerHTML = "";

  if (todaysEntries.length === 0) {
    emptyEl.style.display = "block";
  } else {
    emptyEl.style.display = "none";
    todaysEntries.forEach((wt) => {
      const li = document.createElement("li");
      li.className = "meal-item glass";
      li.innerHTML = `
        ${wt.photo ? `<img class="meal-thumb" src="${wt.photo}" alt="" />` : `<div class="meal-thumb"></div>`}
        <div class="meal-info">
          <div class="meal-name">${wt.weight}kg</div>
          ${notesHtml(wt.notes)}
        </div>
        <button class="delete-btn" data-id="${wt.id}" aria-label="Delete weigh-in">✕</button>
      `;
      listEl.appendChild(li);
    });
  }

  const allByDate = getAllWeightEntriesByDate();
  const chartEl = document.getElementById("weightChart");

  if (allByDate.length === 0) {
    document.getElementById("currentWeightVal").textContent = "—";
    document.getElementById("startingWeightVal").textContent = "—";
    document.getElementById("suggestedCalories").textContent = "—";
    document.getElementById("adaptiveBox").classList.add("hidden");
    chartEl.innerHTML = `<p class="empty-state">Log your weight a couple of times to see a trend.</p>`;
    return;
  }

  const startingWeight = allByDate[0].entries[0].weight;
  const lastGroup = allByDate[allByDate.length - 1];
  const currentWeight = lastGroup.entries[lastGroup.entries.length - 1].weight;

  document.getElementById("currentWeightVal").textContent = currentWeight;
  document.getElementById("startingWeightVal").textContent = startingWeight;

  const activityLevel = Number(document.getElementById("activityLevel").value) || DEFAULT_ACTIVITY_LEVEL;
  const maintenance = Math.round(currentWeight * activityLevel);
  document.getElementById("suggestedCalories").textContent = Math.max(0, maintenance - 200);

  // Re-evaluate the apply button's visibility now that we know the actual
  // numeric activityLevel in effect (the block above ran before the dropdown
  // necessarily reflected saved settings in every edge case).
  if (stepsInsight) {
    document.getElementById("applyStepsLevel").classList.toggle("hidden", stepsInsight.level === activityLevel);
  }

  const adaptiveBox = document.getElementById("adaptiveBox");
  const adaptive = computeAdaptiveSuggestion(allByDate, activityLevel, loadTargets().calories);
  if (!adaptive) {
    adaptiveBox.classList.add("hidden");
  } else {
    adaptiveBox.classList.remove("hidden");
    document.getElementById("adaptiveReasoning").textContent = adaptive.reasoning;
    const applyBtn = document.getElementById("applyAdaptive");
    if (adaptive.onTrack) {
      document.getElementById("adaptiveCalories").textContent = loadTargets().calories;
      applyBtn.classList.add("hidden");
    } else {
      document.getElementById("adaptiveCalories").textContent = adaptive.newTarget;
      applyBtn.classList.remove("hidden");
      applyBtn.dataset.value = adaptive.newTarget;
    }
  }

  const points = allByDate.map(({ date, entries }) => ({ label: formatShortDate(date), value: entries[entries.length - 1].weight }));
  if (points.length < 2) {
    chartEl.innerHTML = `<p class="empty-state">Log your weight a couple more times to see a trend.</p>`;
  } else {
    drawTrendChart(chartEl, points, "kg");
  }
}

// ---------- Dashboard (weekly/monthly/yearly trends) ----------
let dashboardPeriod = "weekly";
let dashboardOffset = 0; // 0 = most recent window; 1 = one window further back, etc.
const DASHBOARD_MAX_BUCKETS = { weekly: 8, monthly: 12, yearly: 20 };

// Groups a YYYY-MM-DD string into a period bucket key. Weekly buckets key on
// that week's Monday (ISO-ish, not calendar-locale-dependent); monthly on
// YYYY-MM; yearly on YYYY.
function bucketKeyForDate(dateStr, period) {
  const d = new Date(dateStr + "T00:00:00");
  if (period === "yearly") return String(d.getFullYear());
  if (period === "monthly") return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  const day = d.getDay(); // 0=Sun..6=Sat
  const diffToMonday = (day === 0 ? -6 : 1) - day;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  return dateKey(monday); // local-date key — see dateKey() note on why not toISOString()
}

// Short label for the per-bar/per-point x-axis (has to fit under up to 12
// bars in a 300px-wide chart — full "September 2026" on every bar would
// overlap badly). Full month/year context instead lives in the range-nav
// label above the chart (see bucketFullLabel), so nothing's actually lost.
function bucketLabel(key, period) {
  if (period === "yearly") return key;
  if (period === "monthly") {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "2-digit" });
  }
  return new Date(key + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Full, explicit label for the range-nav bar ("September 2026", "Sep 15, 2026").
function bucketFullLabel(key, period) {
  if (period === "yearly") return key;
  if (period === "monthly") {
    const [y, m] = key.split("-");
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  }
  return new Date(key + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// One pass over every loaded day, grouped into period buckets. `offset` pages
// backward in units of a full window (8 weeks / 12 months / 20 years) so
// older history is reachable via prev/next, not just the most recent slice.
function aggregateByPeriod(period, offset) {
  const buckets = {};
  for (const [dateStr, day] of Object.entries(cloud.days)) {
    const key = bucketKeyForDate(dateStr, period);
    if (!buckets[key]) buckets[key] = { calorieSum: 0, calorieDayCount: 0, weightVals: [], workoutDayCount: 0 };
    const b = buckets[key];
    if (day.meals && day.meals.length) {
      b.calorieSum += day.meals.reduce((s, m) => s + (m.calories || 0), 0);
      b.calorieDayCount += 1;
    }
    if (day.weights && day.weights.length) {
      b.weightVals.push(day.weights[day.weights.length - 1].weight);
    }
    if (day.workouts && day.workouts.length) {
      b.workoutDayCount += 1;
    }
  }

  const maxBuckets = DASHBOARD_MAX_BUCKETS[period];
  const allKeys = Object.keys(buckets).sort();
  const endIndex = allKeys.length - offset * maxBuckets;
  const startIndex = Math.max(0, endIndex - maxBuckets);
  const keys = allKeys.slice(Math.max(0, startIndex), Math.max(0, endIndex));
  const hasEarlier = startIndex > 0;
  const hasLater = offset > 0;

  const points = keys.map((key) => {
    const b = buckets[key];
    return {
      key,
      label: bucketLabel(key, period),
      avgCalories: b.calorieDayCount ? Math.round(b.calorieSum / b.calorieDayCount) : null,
      avgWeight: b.weightVals.length ? Math.round((b.weightVals.reduce((a, c) => a + c, 0) / b.weightVals.length) * 10) / 10 : null,
      workoutDays: b.workoutDayCount,
    };
  });

  return { points, hasEarlier, hasLater };
}

// Simple bar chart: thin bars off a single baseline, category labels under
// each bar. Every bar gets its value labeled above it (Kevin explicitly
// asked for numbers on the trends charts — overrides the usual "label
// sparingly" default deliberately, not by oversight).
function drawBarChart(chartEl, points, unit) {
  const w = 300, h = 140, pad = 18, baselineY = h - 30;
  const values = points.map((p) => p.value);
  const maxV = Math.max(...values, 1);
  const barWidth = Math.min(24, (w - pad * 2) / points.length - 6);
  const step = (w - pad * 2) / points.length;

  const bars = points.map((p, i) => {
    const barH = (p.value / maxV) * (baselineY - 20);
    const x = pad + i * step + (step - barWidth) / 2;
    const y = baselineY - barH;
    return { ...p, x, y, barH };
  });

  const barsSvg = bars.map((b) => `
    <rect class="bar-chart-bar" x="${b.x}" y="${b.y}" width="${barWidth}" height="${Math.max(1, b.barH)}"
          rx="4" fill="var(--series-1)"></rect>
    <text class="bar-chart-value" x="${b.x + barWidth / 2}" y="${Math.max(10, b.y - 5)}" text-anchor="middle">${b.value}${unit}</text>
    <text class="bar-chart-label" x="${b.x + barWidth / 2}" y="${h - 8}" text-anchor="middle">${b.label}</text>
  `).join("");

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <line class="bar-chart-baseline" x1="${pad}" y1="${baselineY}" x2="${w - pad}" y2="${baselineY}"></line>
      ${barsSvg}
    </svg>
  `;
}

function renderDashboard() {
  const { points: data, hasEarlier, hasLater } = aggregateByPeriod(dashboardPeriod, dashboardOffset);

  const rangeLabel = document.getElementById("dashRangeLabel");
  rangeLabel.textContent = data.length
    ? (data.length === 1
        ? bucketFullLabel(data[0].key, dashboardPeriod)
        : `${bucketFullLabel(data[0].key, dashboardPeriod)} – ${bucketFullLabel(data[data.length - 1].key, dashboardPeriod)}`)
    : "No data yet";
  document.getElementById("dashPrevRange").disabled = !hasEarlier;
  document.getElementById("dashNextRange").disabled = !hasLater;

  const calPoints = data.filter((d) => d.avgCalories !== null).map((d) => ({ label: d.label, value: d.avgCalories }));
  const calEl = document.getElementById("dashCaloriesChart");
  if (calPoints.length < 2) {
    calEl.innerHTML = `<p class="empty-state">Log meals across a few periods to see this.</p>`;
  } else {
    drawBarChart(calEl, calPoints, "");
  }

  const weightPoints = data.filter((d) => d.avgWeight !== null).map((d) => ({ label: d.label, value: d.avgWeight }));
  const weightEl = document.getElementById("dashWeightChart");
  if (weightPoints.length < 2) {
    weightEl.innerHTML = `<p class="empty-state">Log your weight across a few periods to see this.</p>`;
  } else {
    drawTrendChart(weightEl, weightPoints, "kg", true);
  }

  const workoutPoints = data.map((d) => ({ label: d.label, value: d.workoutDays }));
  const workoutEl = document.getElementById("dashWorkoutsChart");
  if (workoutPoints.filter((p) => p.value > 0).length < 2) {
    workoutEl.innerHTML = `<p class="empty-state">Log workouts across a few periods to see this.</p>`;
  } else {
    drawBarChart(workoutEl, workoutPoints, "");
  }
}

document.querySelectorAll(".period-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    dashboardPeriod = btn.dataset.period;
    dashboardOffset = 0;
    document.querySelectorAll(".period-btn").forEach((b) => b.classList.toggle("active", b === btn));
    renderDashboard();
  });
});

document.getElementById("dashPrevRange").addEventListener("click", () => {
  dashboardOffset += 1;
  renderDashboard();
});
document.getElementById("dashNextRange").addEventListener("click", () => {
  dashboardOffset = Math.max(0, dashboardOffset - 1);
  renderDashboard();
});

// ---------- Tabs ----------
const TAB_META = {
  nutrition: { fabIcon: '<svg class="inline-icon fab-icon"><use href="#icon-camera"/></svg>', fabLabel: "Add meal", hint: "Tap to log a meal" },
  workouts: { fabIcon: '<svg class="inline-icon fab-icon"><use href="#icon-dumbbell"/></svg>', fabLabel: "Add exercise", hint: "Tap to log an exercise" },
  weight: { fabIcon: '<svg class="inline-icon fab-icon"><use href="#icon-scale"/></svg>', fabLabel: "Add weigh-in", hint: "Tap to log your weight" },
  dashboard: { fabIcon: null, fabLabel: "", hint: "Nothing to log here — just trends" },
};
// tab key -> { view element id, tab button id } — not a simple string
// concatenation since "workouts" (tab key/button) maps to "workoutView" (singular).
const TAB_IDS = {
  nutrition: { view: "nutritionView", btn: "tabNutrition" },
  workouts: { view: "workoutView", btn: "tabWorkouts" },
  weight: { view: "weightView", btn: "tabWeight" },
  dashboard: { view: "dashboardView", btn: "tabDashboard" },
};

function switchTab(tab) {
  activeTab = tab;
  Object.entries(TAB_IDS).forEach(([t, ids]) => {
    document.getElementById(ids.view).classList.toggle("hidden", t !== tab);
    document.getElementById(ids.btn).classList.toggle("active", t === tab);
  });

  const meta = TAB_META[tab];
  const fab = document.getElementById("fabAdd");
  fab.classList.toggle("hidden", !meta.fabIcon);
  fab.innerHTML = meta.fabIcon || "";
  fab.setAttribute("aria-label", meta.fabLabel);
  document.getElementById("navHint").textContent = meta.hint;

  if (tab === "dashboard") renderDashboard();
}

document.getElementById("tabNutrition").addEventListener("click", () => switchTab("nutrition"));
document.getElementById("tabWorkouts").addEventListener("click", () => switchTab("workouts"));
document.getElementById("tabWeight").addEventListener("click", () => switchTab("weight"));
document.getElementById("tabDashboard").addEventListener("click", () => switchTab("dashboard"));
document.getElementById("exercisePicker").addEventListener("change", (e) => renderProgressionChart(e.target.value));
document.getElementById("activityLevel").addEventListener("change", (e) => {
  saveSettings({ activityLevel: Number(e.target.value) });
  renderWeightView();
});
document.getElementById("applySuggestion").addEventListener("click", () => {
  const suggested = Number(document.getElementById("suggestedCalories").textContent);
  if (!suggested) return;
  const targets = loadTargets();
  targets.calories = suggested;
  saveTargets(targets);
  render();
  switchTab("nutrition");
});

document.getElementById("applyAdaptive").addEventListener("click", (e) => {
  const value = Number(e.target.dataset.value);
  if (!value) return;
  const targets = loadTargets();
  targets.calories = value;
  saveTargets(targets);
  render();
  switchTab("nutrition");
});

document.getElementById("applyStepsLevel").addEventListener("click", (e) => {
  const value = Number(e.target.dataset.value);
  if (!value) return;
  document.getElementById("activityLevel").value = value;
  saveSettings({ activityLevel: value });
  renderWeightView();
});

// ---------- Sheets (bottom modals) ----------
function openSheet(el) { el.classList.add("open"); }
function closeSheet(el) { el.classList.remove("open"); }

const addSheet = document.getElementById("addSheet");
const addWorkoutSheet = document.getElementById("addWorkoutSheet");
const addWeightSheet = document.getElementById("addWeightSheet");
const settingsSheet = document.getElementById("settingsSheet");
const SHEET_BY_TAB = { nutrition: addSheet, workouts: addWorkoutSheet, weight: addWeightSheet };

document.getElementById("fabAdd").addEventListener("click", () => {
  if (activeTab === "nutrition") openAddMealSheet();
  else openSheet(SHEET_BY_TAB[activeTab]);
});
function cancelMealSheet() {
  editingMealId = null;
  document.getElementById("mealForm").reset();
  pendingPhoto = null;
  document.getElementById("photoPreview").innerHTML = '<svg class="inline-icon"><use href="#icon-camera"/></svg> Add photo — auto-fills macros';
  closeSheet(addSheet);
}
document.getElementById("sheetCancel").addEventListener("click", cancelMealSheet);
addSheet.addEventListener("click", (e) => { if (e.target === addSheet) cancelMealSheet(); });

document.getElementById("weightSheetCancel").addEventListener("click", () => closeSheet(addWeightSheet));
addWeightSheet.addEventListener("click", (e) => { if (e.target === addWeightSheet) closeSheet(addWeightSheet); });

document.getElementById("weightPhotoInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingWeightPhoto = reader.result;
    document.getElementById("weightPhotoPreview").innerHTML = `<img src="${pendingWeightPhoto}" alt="Progress photo" />`;
  };
  reader.readAsDataURL(file);
});

document.getElementById("weightForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const entry = {
    id: Date.now().toString(),
    weight: Number(document.getElementById("weightInput").value) || 0,
    photo: pendingWeightPhoto,
    notes: document.getElementById("weightNotes").value.trim(),
    time: new Date().toISOString(),
  };

  const entries = loadWeightDay(currentDate);
  entries.push(entry);
  saveWeightDay(currentDate, entries);

  e.target.reset();
  pendingWeightPhoto = null;
  document.getElementById("weightPhotoPreview").innerHTML = '<svg class="inline-icon"><use href="#icon-camera"/></svg> Add progress photo (optional)';
  closeSheet(addWeightSheet);
  render();
});

document.getElementById("weightList").addEventListener("click", (e) => {
  if (!e.target.classList.contains("delete-btn")) return;
  const id = e.target.getAttribute("data-id");
  const entries = loadWeightDay(currentDate).filter((wt) => wt.id !== id);
  saveWeightDay(currentDate, entries);
  render();
});

document.getElementById("workoutSheetCancel").addEventListener("click", () => closeSheet(addWorkoutSheet));
addWorkoutSheet.addEventListener("click", (e) => { if (e.target === addWorkoutSheet) closeSheet(addWorkoutSheet); });

document.getElementById("exerciseSelect").addEventListener("change", (e) => {
  const isCustom = e.target.value === CUSTOM_OPTION_VALUE;
  document.getElementById("exerciseCustomName").classList.toggle("hidden", !isCustom);
  const oneRm = loadOneRepMaxes()[currentExerciseName()] || "";
  document.getElementById("oneRepMaxInput").value = oneRm;
  updatePctHint();
  updateWeightSuggestion();
});
document.getElementById("exerciseCustomName").addEventListener("input", () => {
  updatePctHint();
  updateWeightSuggestion();
});
document.getElementById("oneRepMaxInput").addEventListener("input", updatePctHint);
document.getElementById("exerciseWeight").addEventListener("input", updatePctHint);

document.getElementById("workoutForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const exercise = currentExerciseName();
  if (!exercise) { document.getElementById("exerciseCustomName").focus(); return; }

  const weight = Number(document.getElementById("exerciseWeight").value) || 0;
  const oneRm = Number(document.getElementById("oneRepMaxInput").value) || 0;
  if (oneRm > 0) saveOneRepMax(exercise, oneRm);

  const entry = {
    id: Date.now().toString(),
    exercise,
    weight,
    sets: Number(document.getElementById("exerciseSets").value) || 0,
    reps: Number(document.getElementById("exerciseReps").value) || 0,
    pct: oneRm > 0 && weight > 0 ? Math.round((weight / oneRm) * 100) : null,
    notes: document.getElementById("workoutNotes").value.trim(),
    time: new Date().toISOString(),
  };

  const entries = loadWorkoutDay(currentDate);
  entries.push(entry);
  saveWorkoutDay(currentDate, entries);

  e.target.reset();
  document.getElementById("exerciseCustomName").classList.add("hidden");
  document.getElementById("pctOneRm").textContent = "";
  closeSheet(addWorkoutSheet);
  render();
});

document.getElementById("workoutList").addEventListener("click", (e) => {
  if (!e.target.classList.contains("delete-btn")) return;
  const id = e.target.getAttribute("data-id");
  const entries = loadWorkoutDay(currentDate).filter((w) => w.id !== id);
  saveWorkoutDay(currentDate, entries);
  render();
});

// Per-field sane ceilings for daily targets — a typo like an extra couple
// zeros (e.g. "10000000" instead of "100") previously saved straight through
// with no check at all, and quietly wrecked the remaining-macros math
// ("999995g carbs" left) and the ring percentages. `max` attributes in the
// HTML only affect form validation, not what you can actually type into a
// number field, so this clamps for real on every keystroke.
const TARGET_LIMITS = { targetCaloriesInput: 6000, targetCarbsInput: 800, targetProteinInput: 500, targetFatInput: 300 };

// Calories is the anchor (it's what the weight-tab suggestions and adaptive
// calorie feature set), Protein and Fat are the macros Kevin actively dials
// in (body-recomp targets: protein for muscle retention, fat for hormones).
// Carbs is the flexible one — it's calculated as whatever's left of the
// calorie budget once protein/fat are accounted for, same idea as classic
// "if it fits your macros" targets. This is the opposite direction from the
// per-meal fix (there, real food's calories ARE fixed by its macros, so
// Calories was the derived field); here, the calorie TARGET is the fixed
// thing and Carbs bends to fit it.
function recalcTargetCarbs() {
  const calories = Number(document.getElementById("targetCaloriesInput").value) || 0;
  const protein = Number(document.getElementById("targetProteinInput").value) || 0;
  const fat = Number(document.getElementById("targetFatInput").value) || 0;
  const carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
  const hintEl = document.getElementById("targetMathHint");
  if (carbs < 0) {
    document.getElementById("targetCarbsInput").value = 0;
    hintEl.textContent = `Protein + fat alone already add up to more than ${calories} kcal — raise the calorie target or lower protein/fat.`;
  } else {
    document.getElementById("targetCarbsInput").value = Math.min(TARGET_LIMITS.targetCarbsInput, carbs);
    hintEl.textContent = `Carbs set to ${document.getElementById("targetCarbsInput").value}g so protein + fat + carbs add up to your ${calories} kcal target.`;
  }
}
["targetCaloriesInput", "targetProteinInput", "targetFatInput"].forEach((id) => {
  document.getElementById(id).addEventListener("input", () => {
    const el = document.getElementById(id);
    const max = TARGET_LIMITS[id];
    if (Number(el.value) > max) el.value = max; // real clamp, not just the HTML max attribute
    recalcTargetCarbs();
  });
});

document.getElementById("settingsBtn").addEventListener("click", () => {
  const t = loadTargets();
  document.getElementById("targetCaloriesInput").value = t.calories;
  document.getElementById("targetProteinInput").value = t.protein;
  document.getElementById("targetFatInput").value = t.fat;
  // Recompute rather than trust the stored carbs value — keeps old/legacy
  // targets self-consistent the moment they're reopened, same pattern as
  // the meal-edit sheet's recalcMealCalories().
  recalcTargetCarbs();
  document.getElementById("loggedInAsName").textContent =
    localStorage.getItem(CURRENT_PROFILE_DISPLAY_KEY) || "(unknown)";
  openSheet(settingsSheet);
});
document.getElementById("settingsCancel").addEventListener("click", () => closeSheet(settingsSheet));
settingsSheet.addEventListener("click", (e) => { if (e.target === settingsSheet) closeSheet(settingsSheet); });

document.getElementById("settingsSave").addEventListener("click", () => {
  recalcTargetCarbs(); // final recompute as a backstop before saving
  const targets = {
    calories: Math.min(TARGET_LIMITS.targetCaloriesInput, Number(document.getElementById("targetCaloriesInput").value) || DEFAULT_TARGETS.calories),
    protein: Math.min(TARGET_LIMITS.targetProteinInput, Number(document.getElementById("targetProteinInput").value) || DEFAULT_TARGETS.protein),
    fat: Math.min(TARGET_LIMITS.targetFatInput, Number(document.getElementById("targetFatInput").value) || DEFAULT_TARGETS.fat),
    carbs: Number(document.getElementById("targetCarbsInput").value) || 0,
  };
  saveTargets(targets);
  closeSheet(settingsSheet);
  render();
});

// ---------- Events ----------
document.getElementById("prevDay").addEventListener("click", () => {
  currentDate.setDate(currentDate.getDate() - 1);
  render();
});

document.getElementById("nextDay").addEventListener("click", () => {
  currentDate.setDate(currentDate.getDate() + 1);
  render();
});

// Downscale + re-encode a photo before sending it anywhere: phone photos can be
// several MB, which is slow to upload and can exceed the backend's request-size
// limit. Also used for the full-size preview thumbnail stored with the meal.
function compressImage(file, maxDimension, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// `editingMealId` tracks whether the sheet is in "add" or "edit" mode.
// null = adding a new meal to currentDate; otherwise the id of the meal
// being edited in place (name/macros correctable after the fact — see
// re-estimateFromName below for why this exists).
let editingMealId = null;

// Calories must always equal what the macros actually add up to (4 kcal/g
// carbs, 4 kcal/g protein, 9 kcal/g fat) — the standard Atwater conversion.
// Kevin hit a real bug where editing carbs/protein/fat left the Calories
// field showing a stale, disconnected number (whatever the AI originally
// guessed). Fixed by making Calories a read-only, live-computed field: it
// recalculates on every macro-field input, and every place that fills macros
// programmatically (photo analysis, text re-estimate, opening the edit sheet)
// calls this instead of trusting a separately-returned calorie number.
function recalcMealCalories() {
  const carbs = Number(document.getElementById("mealCarbs").value) || 0;
  const protein = Number(document.getElementById("mealProtein").value) || 0;
  const fat = Number(document.getElementById("mealFat").value) || 0;
  document.getElementById("mealCalories").value = Math.round(carbs * 4 + protein * 4 + fat * 9);
}
["mealCarbs", "mealProtein", "mealFat"].forEach((id) => {
  document.getElementById(id).addEventListener("input", recalcMealCalories);
});

async function analyzeFoodPhoto(dataUrl) {
  const statusEl = document.getElementById("analyzeStatus");
  statusEl.textContent = "Analyzing photo…";

  try {
    const base64 = dataUrl.split(",")[1];
    const res = await fetch(PHOTO_ANALYZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageBase64: base64, mimeType: "image/jpeg" }),
    });

    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const result = await res.json();

    if (!document.getElementById("mealName").value) {
      document.getElementById("mealName").value = result.description || "";
    }
    document.getElementById("mealCarbs").value = Math.round(result.carbs_g || 0);
    document.getElementById("mealProtein").value = Math.round(result.protein_g || 0);
    document.getElementById("mealFat").value = Math.round(result.fat_g || 0);
    // Deliberately not using result.calories directly — recalculate from the
    // macros above so calories can never disagree with them (see recalcMealCalories).
    recalcMealCalories();
    // The photo call already priced this exact name — remember it so the
    // auto-re-estimate-on-blur below doesn't immediately re-ask for the same
    // thing the instant focus leaves the field.
    lastAnalyzedName = document.getElementById("mealName").value.trim();

    statusEl.textContent = "Estimated from photo — check the numbers before saving.";
  } catch (err) {
    statusEl.textContent = "Couldn't analyze the photo — enter macros manually.";
  }
}

// Text-only re-estimate: the photo AI sometimes misidentifies the dish, or
// there's no photo at all. This re-asks the same backend (text mode, no
// image) to price calories/macros off the meal name — fires automatically
// once Kevin finishes typing/correcting the name (blur), and can also be
// triggered manually via the button for an explicit retry.
let lastAnalyzedName = "";
let reestimateInFlight = false;
async function reestimateFromName(force = false) {
  const statusEl = document.getElementById("analyzeStatus");
  const name = document.getElementById("mealName").value.trim();
  if (!name) return; // nothing typed yet — nothing to estimate
  if (reestimateInFlight) return; // a call is already in flight (e.g. blur + button click racing) — don't double up
  if (!force && name === lastAnalyzedName) return; // unchanged since last check — don't re-spend an API call for nothing

  reestimateInFlight = true;
  lastAnalyzedName = name;
  statusEl.textContent = "Re-checking macros for “" + name + "”…";

  try {
    const res = await fetch(PHOTO_ANALYZE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ foodName: name }),
    });

    if (!res.ok) throw new Error(`Backend returned ${res.status}`);
    const result = await res.json();

    // The description may still have changed while this was in flight —
    // only apply the result if the name field still matches what we asked about.
    if (document.getElementById("mealName").value.trim() === name) {
      document.getElementById("mealCarbs").value = Math.round(result.carbs_g || 0);
      document.getElementById("mealProtein").value = Math.round(result.protein_g || 0);
      document.getElementById("mealFat").value = Math.round(result.fat_g || 0);
      recalcMealCalories();
      statusEl.textContent = "Updated from “" + name + "” — check the numbers before saving.";
    }
  } catch (err) {
    statusEl.textContent = "Couldn't re-check that name — enter macros manually.";
  } finally {
    reestimateInFlight = false;
  }
}

document.getElementById("reestimateBtn").addEventListener("click", () => reestimateFromName(true));
// Automatic: re-price macros as soon as the meal name is added/edited and the
// field loses focus — this is the actual "automatically adjust" behavior
// Kevin asked for, the button above just remains as a manual fallback/retry.
document.getElementById("mealName").addEventListener("blur", () => reestimateFromName(false));

document.getElementById("photoInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  // Full-size-ish version for the saved meal's thumbnail.
  pendingPhoto = await compressImage(file, 800, 0.8);
  document.getElementById("photoPreview").innerHTML = `<img src="${pendingPhoto}" alt="Meal photo" />`;

  // Smaller version for the AI call — plenty for food recognition, faster upload.
  const analysisImage = await compressImage(file, 512, 0.6);
  analyzeFoodPhoto(analysisImage);
});

function openAddMealSheet() {
  editingMealId = null;
  lastAnalyzedName = ""; // fresh sheet — any name typed here should trigger an auto re-check on blur
  document.getElementById("mealSheetTitle").textContent = "Log a meal";
  document.getElementById("mealSubmitBtn").textContent = "Save meal";
  recalcMealCalories(); // blank macro fields -> shows 0, not an empty field
  openSheet(addSheet);
}

function openEditMealSheet(meal) {
  editingMealId = meal.id;
  document.getElementById("mealSheetTitle").textContent = "Edit meal";
  document.getElementById("mealSubmitBtn").textContent = "Save changes";
  document.getElementById("mealName").value = meal.name;
  // Seed lastAnalyzedName to the meal's current name so simply opening/closing
  // this field without changing it doesn't fire a wasted auto re-check on blur.
  lastAnalyzedName = meal.name;
  document.getElementById("mealCarbs").value = meal.carbs;
  document.getElementById("mealProtein").value = meal.protein;
  document.getElementById("mealFat").value = meal.fat;
  // Recompute rather than trust the stored value — older entries (or
  // AI-filled ones from before this fix) may have a calories number that
  // doesn't actually match their macros. Editing always shows the true sum.
  recalcMealCalories();
  document.getElementById("mealNotes").value = meal.notes || "";
  pendingPhoto = meal.photo || null;
  document.getElementById("photoPreview").innerHTML = meal.photo
    ? `<img src="${meal.photo}" alt="Meal photo" />`
    : '<svg class="inline-icon"><use href="#icon-camera"/></svg> Add photo — auto-fills macros';
  document.getElementById("analyzeStatus").textContent = "";
  openSheet(addSheet);
}

document.getElementById("mealForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const mealFields = {
    name: document.getElementById("mealName").value.trim(),
    calories: Number(document.getElementById("mealCalories").value) || 0,
    carbs: Number(document.getElementById("mealCarbs").value) || 0,
    protein: Number(document.getElementById("mealProtein").value) || 0,
    fat: Number(document.getElementById("mealFat").value) || 0,
    photo: pendingPhoto,
    notes: document.getElementById("mealNotes").value.trim(),
  };

  const meals = loadDay(currentDate);
  if (editingMealId) {
    const idx = meals.findIndex((m) => m.id === editingMealId);
    if (idx !== -1) meals[idx] = { ...meals[idx], ...mealFields };
  } else {
    meals.push({ id: Date.now().toString(), time: new Date().toISOString(), ...mealFields });
  }
  saveDay(currentDate, meals);

  // reset form
  e.target.reset();
  pendingPhoto = null;
  editingMealId = null;
  document.getElementById("photoPreview").innerHTML = '<svg class="inline-icon"><use href="#icon-camera"/></svg> Add photo — auto-fills macros';
  closeSheet(addSheet);

  render();
});

document.getElementById("mealList").addEventListener("click", (e) => {
  if (e.target.classList.contains("delete-btn")) {
    const id = e.target.getAttribute("data-id");
    const meals = loadDay(currentDate).filter((m) => m.id !== id);
    saveDay(currentDate, meals);
    render();
    return;
  }
  const item = e.target.closest(".meal-item");
  if (!item) return;
  const id = item.getAttribute("data-id");
  const meal = loadDay(currentDate).find((m) => m.id === id);
  if (meal) openEditMealSheet(meal);
});

// ---------- Auth gate (Phase B: name + passcode, data now lives per-account) ----------
// No real security by design (see CLAUDE.md) — the passcode gates
// creating/switching profiles, not routine access (login persists via
// localStorage so it's not re-entered every visit).
const CURRENT_PROFILE_KEY = "macro-tracker-current-profile";
const CURRENT_PROFILE_DISPLAY_KEY = "macro-tracker-current-profile-display";

function sanitizeProfileKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function showApp() {
  document.getElementById("authGate").classList.add("hidden");
  document.getElementById("appRoot").classList.remove("hidden");
  applyTheme();
  render();
}

function setAuthBusy(busy) {
  document.getElementById("authLoading").classList.toggle("hidden", !busy);
  document.getElementById("authLoginBtn").disabled = busy;
  document.getElementById("authSignupBtn").disabled = busy;
}

// Pulls this profile's targets/activityLevel/1RMs/days into the in-memory
// `cloud` cache and points profileDocRef at their Firestore doc for future
// writes. Everything else (render, save*, load*) reads/writes `cloud` and
// assumes this has already run.
async function loadCloudData(key) {
  profileDocRef = db.collection("profiles").doc(key);
  const doc = await profileDocRef.get();
  const data = doc.data() || {};

  cloud.targets = data.targets || { ...DEFAULT_TARGETS };
  cloud.activityLevel = data.activityLevel || DEFAULT_ACTIVITY_LEVEL;
  cloud.oneRepMaxes = data.oneRepMaxes || {};
  cloud.theme = data.theme || "classic";
  cloud.weeklySteps = data.weeklySteps || {}; // { "YYYY-MM-DD" (week start): totalSteps } — imported history, no logging UI yet
  cloud.days = {};

  const daysSnap = await profileDocRef.collection("days").get();
  daysSnap.forEach((d) => {
    cloud.days[d.id] = { meals: [], workouts: [], weights: [], ...d.data() };
  });
}

// Shared by login and signup: fetch this profile's cloud data, remember it
// on this browser, then reveal the app. On failure, leaves the gate up with
// an error rather than entering a broken/empty state.
async function enterApp(key, displayName) {
  setAuthBusy(true);
  try {
    await loadCloudData(key);
    localStorage.setItem(CURRENT_PROFILE_KEY, key);
    localStorage.setItem(CURRENT_PROFILE_DISPLAY_KEY, displayName);
    showApp();
  } catch (err) {
    document.getElementById("authError").textContent = "Couldn't load your data — check your connection and try again.";
    console.error(err);
    setAuthBusy(false);
  }
}

async function attemptSignup() {
  const rawName = document.getElementById("authName").value;
  const passcode = document.getElementById("authPasscode").value;
  const errorEl = document.getElementById("authError");
  errorEl.textContent = "";

  const key = sanitizeProfileKey(rawName);
  if (!key || !passcode) {
    errorEl.textContent = "Enter a name and passcode.";
    return;
  }

  try {
    const docRef = db.collection("profiles").doc(key);
    const doc = await docRef.get();
    if (doc.exists) {
      errorEl.textContent = "That name is taken — log in instead, or pick another name.";
      return;
    }
    await docRef.set({
      displayName: rawName.trim(),
      passcode,
      createdAt: new Date().toISOString(),
      targets: { ...DEFAULT_TARGETS },
      activityLevel: DEFAULT_ACTIVITY_LEVEL,
      oneRepMaxes: {},
      theme: "classic",
    });
    await enterApp(key, rawName.trim());
  } catch (err) {
    errorEl.textContent = "Couldn't reach the server — try again.";
    console.error(err);
  }
}

async function attemptLogin() {
  const rawName = document.getElementById("authName").value;
  const passcode = document.getElementById("authPasscode").value;
  const errorEl = document.getElementById("authError");
  errorEl.textContent = "";

  const key = sanitizeProfileKey(rawName);
  if (!key || !passcode) {
    errorEl.textContent = "Enter a name and passcode.";
    return;
  }

  try {
    const docRef = db.collection("profiles").doc(key);
    const doc = await docRef.get();
    if (!doc.exists) {
      errorEl.textContent = "No profile with that name — create one instead.";
      return;
    }
    if (doc.data().passcode !== passcode) {
      errorEl.textContent = "Wrong passcode.";
      return;
    }
    await enterApp(key, doc.data().displayName || rawName.trim());
  } catch (err) {
    errorEl.textContent = "Couldn't reach the server — try again.";
    console.error(err);
  }
}

document.getElementById("authLoginBtn").addEventListener("click", attemptLogin);
document.getElementById("authSignupBtn").addEventListener("click", attemptSignup);

document.getElementById("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem(CURRENT_PROFILE_KEY);
  localStorage.removeItem(CURRENT_PROFILE_DISPLAY_KEY);
  location.reload();
});

// ---------- Init ----------
// Auto-login if a profile was remembered on this browser — still has to
// fetch cloud data fresh (the point of Phase B), just skips re-entering the
// passcode. On failure, clears the stale remembered login and shows the gate
// instead of getting stuck.
(function initAuth() {
  const rememberedKey = localStorage.getItem(CURRENT_PROFILE_KEY);
  const rememberedDisplay = localStorage.getItem(CURRENT_PROFILE_DISPLAY_KEY);
  if (!rememberedKey) return;

  setAuthBusy(true);
  loadCloudData(rememberedKey)
    .then(() => showApp())
    .catch((err) => {
      console.error("Auto-login failed", err);
      localStorage.removeItem(CURRENT_PROFILE_KEY);
      localStorage.removeItem(CURRENT_PROFILE_DISPLAY_KEY);
      document.getElementById("authError").textContent = "Couldn't restore your session — log in again.";
      setAuthBusy(false);
    });
})();
