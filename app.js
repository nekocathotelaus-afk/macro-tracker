// ===== Macro Tracker — Phase 1 MVP (Bite-style: rings + camera-first FAB) =====
// All data lives in localStorage on this device/browser. Nothing is sent anywhere.

const STORAGE_KEY_PREFIX = "macro-tracker-day-"; // + YYYY-MM-DD
const WORKOUT_KEY_PREFIX = "macro-tracker-workout-day-"; // + YYYY-MM-DD
const WEIGHT_KEY_PREFIX = "macro-tracker-weight-day-"; // + YYYY-MM-DD
const TARGETS_KEY = "macro-tracker-targets";
const ONE_RM_KEY = "macro-tracker-one-rm"; // { [exerciseName]: kg }
const PROFILE_KEY = "macro-tracker-profile"; // { activityLevel }
const DEFAULT_TARGETS = { calories: 2000, carbs: 200, protein: 150, fat: 65 };
const DEFAULT_PROFILE = { activityLevel: 24 };

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
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (local-ish; fine for a personal single-user app)
}

function formatDateLabel(d) {
  const today = new Date();
  if (dateKey(d) === dateKey(today)) return "Today";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (dateKey(d) === dateKey(yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function loadDay(d) {
  const raw = localStorage.getItem(STORAGE_KEY_PREFIX + dateKey(d));
  return raw ? JSON.parse(raw) : [];
}

function saveDay(d, meals) {
  localStorage.setItem(STORAGE_KEY_PREFIX + dateKey(d), JSON.stringify(meals));
}

function loadTargets() {
  const raw = localStorage.getItem(TARGETS_KEY);
  return raw ? JSON.parse(raw) : { ...DEFAULT_TARGETS };
}

function saveTargets(targets) {
  localStorage.setItem(TARGETS_KEY, JSON.stringify(targets));
}

function loadWorkoutDay(d) {
  const raw = localStorage.getItem(WORKOUT_KEY_PREFIX + dateKey(d));
  return raw ? JSON.parse(raw) : [];
}

function saveWorkoutDay(d, entries) {
  localStorage.setItem(WORKOUT_KEY_PREFIX + dateKey(d), JSON.stringify(entries));
}

// Scans every stored workout day (across all dates) — needed for progression,
// which is inherently cross-date, unlike the daily nutrition totals.
function getAllWorkoutEntriesByDate() {
  const byDate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(WORKOUT_KEY_PREFIX)) continue;
    const date = key.slice(WORKOUT_KEY_PREFIX.length);
    const entries = JSON.parse(localStorage.getItem(key) || "[]");
    if (entries.length) byDate.push({ date, entries });
  }
  byDate.sort((a, b) => (a.date < b.date ? -1 : 1));
  return byDate;
}

function getAllExerciseNames() {
  const names = new Set();
  for (const { entries } of getAllWorkoutEntriesByDate()) {
    entries.forEach((e) => names.add(e.exercise));
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

function loadOneRepMaxes() {
  const raw = localStorage.getItem(ONE_RM_KEY);
  return raw ? JSON.parse(raw) : {};
}

function saveOneRepMax(exercise, kg) {
  const all = loadOneRepMaxes();
  if (kg > 0) all[exercise] = kg;
  localStorage.setItem(ONE_RM_KEY, JSON.stringify(all));
}

function loadWeightDay(d) {
  const raw = localStorage.getItem(WEIGHT_KEY_PREFIX + dateKey(d));
  return raw ? JSON.parse(raw) : [];
}

function saveWeightDay(d, entries) {
  localStorage.setItem(WEIGHT_KEY_PREFIX + dateKey(d), JSON.stringify(entries));
}

// Cross-date, like getAllWorkoutEntriesByDate — weight trend needs every day, not just "today".
function getAllWeightEntriesByDate() {
  const byDate = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(WEIGHT_KEY_PREFIX)) continue;
    const date = key.slice(WEIGHT_KEY_PREFIX.length);
    const entries = JSON.parse(localStorage.getItem(key) || "[]");
    if (entries.length) byDate.push({ date, entries });
  }
  byDate.sort((a, b) => (a.date < b.date ? -1 : 1));
  return byDate;
}

function loadProfile() {
  const raw = localStorage.getItem(PROFILE_KEY);
  return raw ? { ...DEFAULT_PROFILE, ...JSON.parse(raw) } : { ...DEFAULT_PROFILE };
}

function saveProfile(partial) {
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ ...loadProfile(), ...partial }));
}

// Shared line-chart renderer — used by both exercise progression and weight trend.
// Caller is responsible for the "not enough data yet" empty state; this assumes >=2 points.
function drawTrendChart(chartEl, points, unit) {
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

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <path class="progression-line" d="${pathD}"></path>
      <circle class="progression-dot" cx="${last.x}" cy="${last.y}" r="4"></circle>
      <text class="progression-value-label" x="${last.x}" y="${Math.max(10, last.y - 8)}" text-anchor="end">${last.value}${unit}</text>
      <text class="progression-axis-label" x="${first.x}" y="${h - 4}" text-anchor="start">${formatShortDate(first.date)}</text>
      <text class="progression-axis-label" x="${last.x}" y="${h - 4}" text-anchor="end">${formatShortDate(last.date)}</text>
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
      li.innerHTML = `
        ${m.photo ? `<img class="meal-thumb" src="${m.photo}" alt="" />` : `<div class="meal-thumb"></div>`}
        <div class="meal-info">
          <div class="meal-name">${escapeHtml(m.name)}</div>
          <div class="meal-macros">${m.calories} cal · C ${m.carbs}g · P ${m.protein}g · F ${m.fat}g</div>
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
        <div class="meal-thumb workout-thumb" aria-hidden="true">🏋️</div>
        <div class="meal-info">
          <div class="meal-name">${escapeHtml(w.exercise)}</div>
          <div class="meal-macros">${w.weight}kg${pctText} × ${w.reps} reps × ${w.sets} sets</div>
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
    points.push({ date, value: Math.max(...matches.map((e) => e.weight)) });
  }

  if (points.length < 2) {
    chartEl.innerHTML = `<p class="empty-state">Log this exercise a couple more times to see a trend.</p>`;
    return;
  }

  drawTrendChart(chartEl, points, "kg");
}

// ---------- Weight ----------
function renderWeightView() {
  const profile = loadProfile();
  document.getElementById("activityLevel").value = profile.activityLevel;

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
    chartEl.innerHTML = `<p class="empty-state">Log your weight a couple of times to see a trend.</p>`;
    return;
  }

  const startingWeight = allByDate[0].entries[0].weight;
  const lastGroup = allByDate[allByDate.length - 1];
  const currentWeight = lastGroup.entries[lastGroup.entries.length - 1].weight;

  document.getElementById("currentWeightVal").textContent = currentWeight;
  document.getElementById("startingWeightVal").textContent = startingWeight;

  const activityLevel = Number(document.getElementById("activityLevel").value) || DEFAULT_PROFILE.activityLevel;
  const maintenance = Math.round(currentWeight * activityLevel);
  document.getElementById("suggestedCalories").textContent = Math.max(0, maintenance - 200);

  const points = allByDate.map(({ date, entries }) => ({ date, value: entries[entries.length - 1].weight }));
  if (points.length < 2) {
    chartEl.innerHTML = `<p class="empty-state">Log your weight a couple more times to see a trend.</p>`;
  } else {
    drawTrendChart(chartEl, points, "kg");
  }
}

// ---------- Tabs ----------
const TAB_META = {
  nutrition: { fabIcon: "📷", fabLabel: "Add meal", hint: "Tap to log a meal" },
  workouts: { fabIcon: "🏋️", fabLabel: "Add exercise", hint: "Tap to log an exercise" },
  weight: { fabIcon: "⚖️", fabLabel: "Add weigh-in", hint: "Tap to log your weight" },
};

function switchTab(tab) {
  activeTab = tab;
  document.getElementById("nutritionView").classList.toggle("hidden", tab !== "nutrition");
  document.getElementById("workoutView").classList.toggle("hidden", tab !== "workouts");
  document.getElementById("weightView").classList.toggle("hidden", tab !== "weight");
  document.getElementById("tabNutrition").classList.toggle("active", tab === "nutrition");
  document.getElementById("tabWorkouts").classList.toggle("active", tab === "workouts");
  document.getElementById("tabWeight").classList.toggle("active", tab === "weight");

  const meta = TAB_META[tab];
  document.getElementById("fabAdd").textContent = meta.fabIcon;
  document.getElementById("fabAdd").setAttribute("aria-label", meta.fabLabel);
  document.getElementById("navHint").textContent = meta.hint;
}

document.getElementById("tabNutrition").addEventListener("click", () => switchTab("nutrition"));
document.getElementById("tabWorkouts").addEventListener("click", () => switchTab("workouts"));
document.getElementById("tabWeight").addEventListener("click", () => switchTab("weight"));
document.getElementById("exercisePicker").addEventListener("change", (e) => renderProgressionChart(e.target.value));
document.getElementById("activityLevel").addEventListener("change", (e) => {
  saveProfile({ activityLevel: Number(e.target.value) });
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

// ---------- Sheets (bottom modals) ----------
function openSheet(el) { el.classList.add("open"); }
function closeSheet(el) { el.classList.remove("open"); }

const addSheet = document.getElementById("addSheet");
const addWorkoutSheet = document.getElementById("addWorkoutSheet");
const addWeightSheet = document.getElementById("addWeightSheet");
const settingsSheet = document.getElementById("settingsSheet");
const SHEET_BY_TAB = { nutrition: addSheet, workouts: addWorkoutSheet, weight: addWeightSheet };

document.getElementById("fabAdd").addEventListener("click", () => openSheet(SHEET_BY_TAB[activeTab]));
document.getElementById("sheetCancel").addEventListener("click", () => closeSheet(addSheet));
addSheet.addEventListener("click", (e) => { if (e.target === addSheet) closeSheet(addSheet); });

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
    time: new Date().toISOString(),
  };

  const entries = loadWeightDay(currentDate);
  entries.push(entry);
  saveWeightDay(currentDate, entries);

  e.target.reset();
  pendingWeightPhoto = null;
  document.getElementById("weightPhotoPreview").innerHTML = "📷 Add progress photo (optional)";
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
});
document.getElementById("exerciseCustomName").addEventListener("input", updatePctHint);
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

document.getElementById("settingsBtn").addEventListener("click", () => {
  const t = loadTargets();
  document.getElementById("targetCaloriesInput").value = t.calories;
  document.getElementById("targetCarbsInput").value = t.carbs;
  document.getElementById("targetProteinInput").value = t.protein;
  document.getElementById("targetFatInput").value = t.fat;
  document.getElementById("loggedInAsName").textContent =
    localStorage.getItem(CURRENT_PROFILE_DISPLAY_KEY) || "(unknown)";
  openSheet(settingsSheet);
});
document.getElementById("settingsCancel").addEventListener("click", () => closeSheet(settingsSheet));
settingsSheet.addEventListener("click", (e) => { if (e.target === settingsSheet) closeSheet(settingsSheet); });

document.getElementById("settingsSave").addEventListener("click", () => {
  const targets = {
    calories: Number(document.getElementById("targetCaloriesInput").value) || DEFAULT_TARGETS.calories,
    carbs: Number(document.getElementById("targetCarbsInput").value) || DEFAULT_TARGETS.carbs,
    protein: Number(document.getElementById("targetProteinInput").value) || DEFAULT_TARGETS.protein,
    fat: Number(document.getElementById("targetFatInput").value) || DEFAULT_TARGETS.fat,
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
    document.getElementById("mealCalories").value = Math.round(result.calories || 0);
    document.getElementById("mealCarbs").value = Math.round(result.carbs_g || 0);
    document.getElementById("mealProtein").value = Math.round(result.protein_g || 0);
    document.getElementById("mealFat").value = Math.round(result.fat_g || 0);

    statusEl.textContent = "Estimated from photo — check the numbers before saving.";
  } catch (err) {
    statusEl.textContent = "Couldn't analyze the photo — enter macros manually.";
  }
}

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

document.getElementById("mealForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const meal = {
    id: Date.now().toString(),
    name: document.getElementById("mealName").value.trim(),
    calories: Number(document.getElementById("mealCalories").value) || 0,
    carbs: Number(document.getElementById("mealCarbs").value) || 0,
    protein: Number(document.getElementById("mealProtein").value) || 0,
    fat: Number(document.getElementById("mealFat").value) || 0,
    photo: pendingPhoto,
    time: new Date().toISOString(),
  };

  const meals = loadDay(currentDate);
  meals.push(meal);
  saveDay(currentDate, meals);

  // reset form
  e.target.reset();
  pendingPhoto = null;
  document.getElementById("photoPreview").innerHTML = "📷 Add photo";
  closeSheet(addSheet);

  render();
});

document.getElementById("mealList").addEventListener("click", (e) => {
  if (!e.target.classList.contains("delete-btn")) return;
  const id = e.target.getAttribute("data-id");
  const meals = loadDay(currentDate).filter((m) => m.id !== id);
  saveDay(currentDate, meals);
  render();
});

// ---------- Auth gate (Phase A: name + passcode only, no real security) ----------
// Data (meals/workouts/weight) still lives in localStorage for now, shared by
// whoever's logged in on this browser — per-profile data storage is Phase B,
// not built yet. This phase only proves login/signup works against Firestore.
const CURRENT_PROFILE_KEY = "macro-tracker-current-profile";
const CURRENT_PROFILE_DISPLAY_KEY = "macro-tracker-current-profile-display";

function sanitizeProfileKey(name) {
  return name.trim().toLowerCase().replace(/\s+/g, "-");
}

function showApp() {
  document.getElementById("authGate").classList.add("hidden");
  document.getElementById("appRoot").classList.remove("hidden");
  render();
}

function completeLogin(key, displayName) {
  localStorage.setItem(CURRENT_PROFILE_KEY, key);
  localStorage.setItem(CURRENT_PROFILE_DISPLAY_KEY, displayName);
  showApp();
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
    await docRef.set({ displayName: rawName.trim(), passcode, createdAt: new Date().toISOString() });
    completeLogin(key, rawName.trim());
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
    completeLogin(key, doc.data().displayName || rawName.trim());
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
// Auto-login if a profile was remembered on this browser (intentional — this
// phase has no real security, so re-typing the passcode every visit isn't the
// point; the passcode gate matters for *creating*/*switching* profiles).
if (localStorage.getItem(CURRENT_PROFILE_KEY)) {
  showApp();
}
