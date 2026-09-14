// ===== Macro Tracker — Phase 1 MVP (Bite-style: rings + camera-first FAB) =====
// All data lives in localStorage on this device/browser. Nothing is sent anywhere.

const STORAGE_KEY_PREFIX = "macro-tracker-day-"; // + YYYY-MM-DD
const WORKOUT_KEY_PREFIX = "macro-tracker-workout-day-"; // + YYYY-MM-DD
const TARGETS_KEY = "macro-tracker-targets";
const DEFAULT_TARGETS = { calories: 2000, carbs: 200, protein: 150, fat: 65 };

const RING_R = 70, RING_CIRC = 2 * Math.PI * RING_R;
const MRING_R = 26, MRING_CIRC = 2 * Math.PI * MRING_R;

let currentDate = new Date();
let pendingPhoto = null; // data URL for the meal being added
let activeTab = "nutrition"; // "nutrition" | "workouts"

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
      li.innerHTML = `
        <div class="meal-thumb workout-thumb" aria-hidden="true">🏋️</div>
        <div class="meal-info">
          <div class="meal-name">${escapeHtml(w.exercise)}</div>
          <div class="meal-macros">${w.weight}kg × ${w.reps} reps × ${w.sets} sets</div>
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

  const datalist = document.getElementById("exerciseNames");
  datalist.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");

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
    points.push({ date, weight: Math.max(...matches.map((e) => e.weight)) });
  }

  if (points.length < 2) {
    chartEl.innerHTML = `<p class="empty-state">Log this exercise a couple more times to see a trend.</p>`;
    return;
  }

  const w = 300, h = 120, pad = 18;
  const weights = points.map((p) => p.weight);
  const minW = Math.min(...weights), maxW = Math.max(...weights);
  const range = maxW - minW || 1;

  const coords = points.map((p, i) => ({
    x: pad + (i / (points.length - 1)) * (w - pad * 2),
    y: h - pad - ((p.weight - minW) / range) * (h - pad * 2),
    ...p,
  }));

  const pathD = coords.map((c, i) => (i === 0 ? `M${c.x},${c.y}` : `L${c.x},${c.y}`)).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];

  chartEl.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet">
      <path class="progression-line" d="${pathD}"></path>
      <circle class="progression-dot" cx="${last.x}" cy="${last.y}" r="4"></circle>
      <text class="progression-value-label" x="${last.x}" y="${Math.max(10, last.y - 8)}" text-anchor="end">${last.weight}kg</text>
      <text class="progression-axis-label" x="${first.x}" y="${h - 4}" text-anchor="start">${formatShortDate(first.date)}</text>
      <text class="progression-axis-label" x="${last.x}" y="${h - 4}" text-anchor="end">${formatShortDate(last.date)}</text>
    </svg>
  `;
}

// ---------- Tabs ----------
function switchTab(tab) {
  activeTab = tab;
  document.getElementById("nutritionView").classList.toggle("hidden", tab !== "nutrition");
  document.getElementById("workoutView").classList.toggle("hidden", tab !== "workouts");
  document.getElementById("tabNutrition").classList.toggle("active", tab === "nutrition");
  document.getElementById("tabWorkouts").classList.toggle("active", tab === "workouts");
  document.getElementById("fabAdd").textContent = tab === "nutrition" ? "📷" : "🏋️";
  document.getElementById("fabAdd").setAttribute("aria-label", tab === "nutrition" ? "Add meal" : "Add exercise");
  document.getElementById("navHint").textContent = tab === "nutrition" ? "Tap to log a meal" : "Tap to log an exercise";
}

document.getElementById("tabNutrition").addEventListener("click", () => switchTab("nutrition"));
document.getElementById("tabWorkouts").addEventListener("click", () => switchTab("workouts"));
document.getElementById("exercisePicker").addEventListener("change", (e) => renderProgressionChart(e.target.value));

// ---------- Sheets (bottom modals) ----------
function openSheet(el) { el.classList.add("open"); }
function closeSheet(el) { el.classList.remove("open"); }

const addSheet = document.getElementById("addSheet");
const addWorkoutSheet = document.getElementById("addWorkoutSheet");
const settingsSheet = document.getElementById("settingsSheet");

document.getElementById("fabAdd").addEventListener("click", () => {
  openSheet(activeTab === "nutrition" ? addSheet : addWorkoutSheet);
});
document.getElementById("sheetCancel").addEventListener("click", () => closeSheet(addSheet));
addSheet.addEventListener("click", (e) => { if (e.target === addSheet) closeSheet(addSheet); });

document.getElementById("workoutSheetCancel").addEventListener("click", () => closeSheet(addWorkoutSheet));
addWorkoutSheet.addEventListener("click", (e) => { if (e.target === addWorkoutSheet) closeSheet(addWorkoutSheet); });

document.getElementById("workoutForm").addEventListener("submit", (e) => {
  e.preventDefault();

  const entry = {
    id: Date.now().toString(),
    exercise: document.getElementById("exerciseName").value.trim(),
    weight: Number(document.getElementById("exerciseWeight").value) || 0,
    sets: Number(document.getElementById("exerciseSets").value) || 0,
    reps: Number(document.getElementById("exerciseReps").value) || 0,
    time: new Date().toISOString(),
  };

  const entries = loadWorkoutDay(currentDate);
  entries.push(entry);
  saveWorkoutDay(currentDate, entries);

  e.target.reset();
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

document.getElementById("photoInput").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingPhoto = reader.result;
    document.getElementById("photoPreview").innerHTML = `<img src="${pendingPhoto}" alt="Meal photo" />`;
  };
  reader.readAsDataURL(file);
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

// ---------- Init ----------
render();
