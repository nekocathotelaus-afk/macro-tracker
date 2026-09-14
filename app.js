// ===== Macro Tracker — Phase 1 MVP =====
// All data lives in localStorage on this device/browser. Nothing is sent anywhere.

const STORAGE_KEY_PREFIX = "macro-tracker-day-"; // + YYYY-MM-DD
const TARGETS_KEY = "macro-tracker-targets";
const DEFAULT_TARGETS = { calories: 2000, carbs: 200, protein: 150, fat: 65 };

let currentDate = new Date();
let pendingPhoto = null; // data URL for the meal being added

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

// ---------- Rendering ----------
function render() {
  document.getElementById("dateLabel").textContent = formatDateLabel(currentDate);

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

  for (const macro of ["calories", "carbs", "protein", "fat"]) {
    document.getElementById("val-" + macro).textContent = totals[macro];
    document.getElementById("target-" + macro).textContent = targets[macro];
    const pct = targets[macro] > 0 ? Math.min(100, (totals[macro] / targets[macro]) * 100) : 0;
    const fillEl = document.getElementById("meter-" + macro);
    fillEl.style.width = pct + "%";
    fillEl.classList.toggle("over", totals[macro] > targets[macro]);
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
      li.className = "meal-item";
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
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

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

  render();
});

document.getElementById("mealList").addEventListener("click", (e) => {
  if (!e.target.classList.contains("delete-btn")) return;
  const id = e.target.getAttribute("data-id");
  const meals = loadDay(currentDate).filter((m) => m.id !== id);
  saveDay(currentDate, meals);
  render();
});

// ---------- Settings modal ----------
const modal = document.getElementById("settingsModal");

document.getElementById("settingsBtn").addEventListener("click", () => {
  const t = loadTargets();
  document.getElementById("targetCaloriesInput").value = t.calories;
  document.getElementById("targetCarbsInput").value = t.carbs;
  document.getElementById("targetProteinInput").value = t.protein;
  document.getElementById("targetFatInput").value = t.fat;
  modal.showModal();
});

document.getElementById("settingsCancel").addEventListener("click", () => modal.close());

document.getElementById("settingsSave").addEventListener("click", () => {
  const targets = {
    calories: Number(document.getElementById("targetCaloriesInput").value) || DEFAULT_TARGETS.calories,
    carbs: Number(document.getElementById("targetCarbsInput").value) || DEFAULT_TARGETS.carbs,
    protein: Number(document.getElementById("targetProteinInput").value) || DEFAULT_TARGETS.protein,
    fat: Number(document.getElementById("targetFatInput").value) || DEFAULT_TARGETS.fat,
  };
  saveTargets(targets);
  modal.close();
  render();
});

// ---------- Init ----------
render();
