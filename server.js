/**
 * Planix - AI Task Manager + Smart Routine & Habit System
 * ─────────────────────────────────────────────────────────
 * Features:
 *  • Tasks (one-time) + Routines (recurring)
 *  • Streak tracking per routine
 *  • AI routine parser from natural language (Claude + regex fallback)
 *  • Daily plan auto-generator
 *  • Smart auto-tagging
 *  • AI suggestions per task/routine
 *
 * Run: node server.js
 * Env: CLAUDE_API_KEY=sk-ant-... (optional, enables real AI)
 */

const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app        = express();
const PORT       = 3000;
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const API_KEY    = process.env.CLAUDE_API_KEY || '';

// ═══════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════════════════
// STORAGE HELPERS
// ═══════════════════════════════════════════════════════════
function getTasks() {
  try {
    if (!fs.existsSync(TASKS_FILE)) return [];
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')) || [];
  } catch { return []; }
}

function saveTasks(tasks) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2));
}

// ═══════════════════════════════════════════════════════════
// DATE HELPERS
// ═══════════════════════════════════════════════════════════
function todayStr() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

function yesterdayStr() {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

// ═══════════════════════════════════════════════════════════
// SMART AUTO-TAGGING
// Assigns one of: study | health | work | personal
// ═══════════════════════════════════════════════════════════
function autoTag(text) {
  const t = text.toLowerCase();
  if (/\b(study|learn|read|homework|course|class|lecture|exam|revision|assignment|college|university)\b/.test(t)) return 'study';
  if (/\b(exercise|gym|workout|run|jog|diet|meal|eat|sleep|meditat|yoga|health|walk|drink water|stretch)\b/.test(t)) return 'health';
  if (/\b(meeting|email|work|project|deadline|client|report|office|standup|sprint|interview|task|presentation)\b/.test(t)) return 'work';
  return 'personal';
}

// ═══════════════════════════════════════════════════════════
// STREAK LOGIC
// Call this AFTER flipping task.completed = true/false
// ═══════════════════════════════════════════════════════════
function updateStreak(task) {
  if (task.type !== 'routine') return task;

  const today     = todayStr();
  const yesterday = yesterdayStr();

  if (task.completed) {
    // Already counted today — idempotent
    if (task.lastCompletedDate === today) return task;

    if (!task.lastCompletedDate || task.lastCompletedDate === yesterday) {
      // Consecutive day → increment streak
      task.streak = (task.streak || 0) + 1;
    } else {
      // Gap detected → reset to 1
      task.streak = 1;
    }
    task.lastCompletedDate = today;
  } else {
    // Uncompleting: only undo today's streak if we counted it today
    if (task.lastCompletedDate === today) {
      task.streak = Math.max(0, (task.streak || 1) - 1);
      task.lastCompletedDate = task.streak === 0 ? null : yesterday;
    }
  }

  return task;
}

// ═══════════════════════════════════════════════════════════
// DAILY PLAN GENERATOR
// For every active routine, create one "scheduled" instance
// for today if it doesn't already exist.
// Keeps tasks.json as the single source of truth.
// ═══════════════════════════════════════════════════════════
function generateDailyPlan() {
  const tasks   = getTasks();
  const today   = todayStr();
  const todayDow = new Date()
    .toLocaleDateString('en-US', { weekday: 'long' })
    .toLowerCase(); // e.g. "monday"

  const routines  = tasks.filter(t => t.type === 'routine');
  const instances = tasks.filter(t => t.type === 'routine_instance');
  let   changed   = false;

  for (const routine of routines) {
    const { repeat = ['daily'] } = routine.routineConfig || {};

    // Check if routine applies today
    const appliesToday =
      repeat.includes('daily') || repeat.includes(todayDow);
    if (!appliesToday) continue;

    // Skip if today's instance already exists
    const exists = instances.some(
      i => i.routineParentId === routine.id && i.scheduledDate === today
    );
    if (exists) continue;

    // Create today's instance
    tasks.push({
      id:              `rinst_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      text:            routine.text,
      completed:       false,
      priority:        routine.priority || 'medium',
      category:        routine.category || 'personal',
      type:            'routine_instance',
      routineParentId: routine.id,
      scheduledDate:   today,
      routineConfig:   routine.routineConfig,
      suggestions:     routine.suggestions || [],
      createdAt:       new Date().toISOString(),
    });
    changed = true;
  }

  if (changed) saveTasks(tasks);
}

// ═══════════════════════════════════════════════════════════
// AI SUGGESTIONS  (Mock + Real Claude optional)
// ═══════════════════════════════════════════════════════════
async function getAISuggestions(taskText) {
  const mock = {
    buy:      ['🛒 Check grocery list first', '🛒 Compare prices online'],
    work:     ['💼 Break into smaller tasks', '💼 Block focused time on calendar'],
    exercise: ['🏃 Start with a 10-min warm-up', '🏃 Have water ready'],
    study:    ['📚 Create a quick outline first', '📚 Quiz yourself after'],
    college:  ['🎓 Prep the night before', '🎓 Review class notes after'],
    default:  ['✅ Break into smaller steps', '✅ Set a clear deadline'],
  };

  const t = taskText.toLowerCase();
  let suggestions = mock.default;
  for (const [kw, tips] of Object.entries(mock)) {
    if (kw !== 'default' && t.includes(kw)) { suggestions = tips; break; }
  }

  if (API_KEY && taskText.length > 3) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 5000);

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        signal:  ctrl.signal,
        headers: {
          'x-api-key':         API_KEY,
          'Content-Type':      'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{
            role:    'user',
            content: `Give exactly 2 short, practical tips for this task: "${taskText}". Each tip on one line. No intro, no numbering.`,
          }],
        }),
      });

      clearTimeout(tid);
      if (res.ok) {
        const data = await res.json();
        const tips = (data.content[0]?.text || '')
          .split('\n').map(s => s.trim()).filter(Boolean).slice(0, 2);
        if (tips.length > 0) return tips;
      }
    } catch {
      console.log('⚠️  AI suggestions: using mock (API unavailable)');
    }
  }

  return suggestions;
}

// ═══════════════════════════════════════════════════════════
// ROUTINE PARSER — Claude AI
// ═══════════════════════════════════════════════════════════
async function parseRoutineWithClaude(text) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 9000);

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      signal:  ctrl.signal,
      headers: {
        'x-api-key':         API_KEY,
        'Content-Type':      'application/json',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `You are a strict routine extraction engine.
Parse the user's text and return ONLY a raw JSON array — no markdown fences, no explanation, no keys outside the schema.

Schema per item:
{
  "text": "Short action phrase (title-case)",
  "type": "routine",
  "routineConfig": {
    "time": "HH:MM",          // 24-hour, omit if unknown
    "repeat": ["daily"],       // always ["daily"] unless a specific weekday is mentioned
    "autoGenerated": true
  }
}

Rules:
- Convert all times to 24-hour format
- If a time like "4:30" has no AM/PM and sounds like afternoon, use 16:30
- Extract only real activities, skip filler words
- Keep text concise (2–5 words)`,
        messages: [{ role: 'user', content: text }],
      }),
    });

    clearTimeout(tid);

    if (res.ok) {
      const data = await res.json();
      const raw  = (data.content[0]?.text || '').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err) {
    clearTimeout(tid);
    console.log('⚠️  Claude parse failed, falling back to regex:', err.message);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// ROUTINE PARSER — Regex Fallback
// ═══════════════════════════════════════════════════════════
function parseRoutineWithRegex(text) {
  // Split on natural separators
  const segments = text
    .split(/,\s*|(?:\s+then\s+)|(?:\s+after\s+that\s*)|(?:\s+and\s+then\s+)/i)
    .map(s => s.trim()).filter(Boolean);

  // Time regex: "7", "7am", "7:00", "4:30pm", "at 7", "16:30"
  const timeRx = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

  // Clean-up prefix words
  const prefixRx = /^(morning|evening|afternoon|night|at|i go|i come|i|the)\s+/gi;

  const routines = [];

  for (const seg of segments) {
    const m = seg.match(timeRx);
    let time24 = null;

    if (m) {
      let h = parseInt(m[1]);
      const min = parseInt(m[2] || '0');
      const mer = (m[3] || '').toLowerCase();

      if (mer === 'pm' && h < 12) h += 12;
      else if (mer === 'am' && h === 12) h = 0;
      // Heuristic: no AM/PM and hour ≤ 6 → assume PM (e.g. "4:30" → 16:30)
      else if (!mer && h <= 6) h += 12;

      time24 = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
    }

    // Strip time tokens + prefix filler
    let activity = seg
      .replace(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, '')
      .replace(prefixRx, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (activity.length < 2) continue;

    // Title-case
    activity = activity.charAt(0).toUpperCase() + activity.slice(1);

    const entry = {
      text: activity,
      type: 'routine',
      routineConfig: { repeat: ['daily'], autoGenerated: true },
    };
    if (time24) entry.routineConfig.time = time24;

    routines.push(entry);
  }

  return routines;
}

// ═══════════════════════════════════════════════════════════
// ░░░░░░░░░░░░░░░░░  API ROUTES  ░░░░░░░░░░░░░░░░░░░░░░░░░
// ═══════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────
// GET /api/tasks  → auto-generate daily plan, return all
// ──────────────────────────────────────────────────────────
app.get('/api/tasks', (req, res) => {
  try {
    generateDailyPlan();
    const tasks = getTasks();
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/tasks/:id
// ──────────────────────────────────────────────────────────
app.get('/api/tasks/:id', (req, res) => {
  try {
    const task = getTasks().find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/tasks  → create task or routine
// ──────────────────────────────────────────────────────────
app.post('/api/tasks', async (req, res) => {
  try {
    const { text, priority, category, type, routineConfig } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Task text is required' });
    }

    const isRoutine = type === 'routine';

    const task = {
      id:          `task_${Date.now()}`,
      text:        text.trim(),
      completed:   false,
      priority:    priority  || 'medium',
      category:    category  || autoTag(text),   // ← smart auto-tag
      type:        type      || 'task',
      createdAt:   new Date().toISOString(),
    };

    // Attach routine config + streak fields
    if (isRoutine) {
      task.routineConfig = {
        time:          routineConfig?.time   || null,
        repeat:        routineConfig?.repeat || ['daily'],
        duration:      routineConfig?.duration || 60,
        autoGenerated: routineConfig?.autoGenerated || false,
      };
      task.streak            = 0;
      task.lastCompletedDate = null;
    }

    task.suggestions = await getAISuggestions(text);

    const tasks = getTasks();
    tasks.unshift(task);
    saveTasks(tasks);

    res.status(201).json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// PUT /api/tasks/:id  → update + streak logic
// ──────────────────────────────────────────────────────────
app.put('/api/tasks/:id', (req, res) => {
  try {
    const tasks = getTasks();
    const idx   = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });

    Object.assign(tasks[idx], req.body);

    // ── Streak update for routines ──────────────────────
    if (tasks[idx].type === 'routine') {
      tasks[idx] = updateStreak(tasks[idx]);
    }

    // ── Routine instance → propagate streak to parent ──
    if (tasks[idx].type === 'routine_instance' && tasks[idx].routineParentId) {
      const pIdx = tasks.findIndex(t => t.id === tasks[idx].routineParentId);
      if (pIdx !== -1) {
        // Mirror completion state to parent for streak calc
        tasks[pIdx].completed = tasks[idx].completed;
        tasks[pIdx] = updateStreak(tasks[pIdx]);
        // Undo the temporary completed flag on parent
        tasks[pIdx].completed = false;
      }
    }

    saveTasks(tasks);
    res.json({ success: true, task: tasks[idx] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// DELETE /api/tasks/:id
// ──────────────────────────────────────────────────────────
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const tasks = getTasks();
    const idx   = tasks.findIndex(t => t.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, error: 'Not found' });

    const removed = tasks[idx];
    tasks.splice(idx, 1);

    // If deleting a parent routine, remove its instances too
    if (removed.type === 'routine') {
      const pruned = tasks.filter(t => t.routineParentId !== removed.id);
      saveTasks(pruned);
    } else {
      saveTasks(tasks);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/ai/parse-routine
// Parses natural-language schedule text into routine entries
// Input:  { "text": "Morning I go to college at 7, evening I study..." }
// Output: { success, routines: [...], source: "claude" | "regex" }
// ──────────────────────────────────────────────────────────
app.post('/api/ai/parse-routine', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'text is required' });
    }

    let routines = null;
    let source   = 'regex';

    if (API_KEY) {
      routines = await parseRoutineWithClaude(text);
      if (routines) source = 'claude';
    }

    if (!routines || routines.length === 0) {
      routines = parseRoutineWithRegex(text);
      source   = 'regex';
    }

    // Apply smart auto-tagging to each parsed routine
    routines = routines.map(r => ({
      ...r,
      category: autoTag(r.text),
    }));

    res.json({ success: true, routines, source });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// POST /api/ai/bulk-add-routines
// Takes parsed routines array and creates them all at once
// ──────────────────────────────────────────────────────────
app.post('/api/ai/bulk-add-routines', async (req, res) => {
  try {
    const { routines } = req.body;
    if (!Array.isArray(routines) || routines.length === 0) {
      return res.status(400).json({ success: false, error: 'routines array required' });
    }

    const tasks   = getTasks();
    const created = [];

    for (const r of routines) {
      if (!r.text || !r.text.trim()) continue;

      const task = {
        id:          `task_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
        text:        r.text.trim(),
        completed:   false,
        priority:    r.priority  || 'medium',
        category:    r.category  || autoTag(r.text),
        type:        'routine',
        routineConfig: {
          time:          r.routineConfig?.time   || null,
          repeat:        r.routineConfig?.repeat || ['daily'],
          duration:      r.routineConfig?.duration || 60,
          autoGenerated: true,
        },
        streak:            0,
        lastCompletedDate: null,
        suggestions:       await getAISuggestions(r.text),
        createdAt:         new Date().toISOString(),
      };

      tasks.unshift(task);
      created.push(task);
    }

    saveTasks(tasks);
    res.status(201).json({ success: true, created });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/streaks  → top streaks for active routines
// ──────────────────────────────────────────────────────────
app.get('/api/streaks', (req, res) => {
  try {
    const tasks = getTasks();

    const streaks = tasks
      .filter(t => t.type === 'routine')
      .map(t => ({
        id:                t.id,
        text:              t.text,
        category:          t.category,
        streak:            t.streak || 0,
        lastCompletedDate: t.lastCompletedDate || null,
      }))
      .sort((a, b) => b.streak - a.streak);

    res.json({ success: true, streaks });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ──────────────────────────────────────────────────────────
// GET /api/stats
// ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  try {
    const tasks = getTasks();
    res.json({
      success:      true,
      total:        tasks.length,
      completed:    tasks.filter(t => t.completed).length,
      pending:      tasks.filter(t => !t.completed).length,
      highPriority: tasks.filter(t => t.priority === 'high' && !t.completed).length,
      routines:     tasks.filter(t => t.type === 'routine').length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /health
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
);

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════
app.listen(PORT, () => {
  const aiMode = API_KEY ? '🤖 Real Claude AI enabled' : '🎭 Mock AI (set CLAUDE_API_KEY for real)';
  console.log(`
╔════════════════════════════════════════════════╗
║                                                ║
║  ✨ Planix — Smart Routine + Habit System      ║
║                                                ║
║  🚀 http://localhost:${PORT}                      ║
║  📁 Storage : tasks.json                       ║
║  ${aiMode.padEnd(46)}║
║                                                ║
║  New endpoints:                                ║
║  POST /api/ai/parse-routine                    ║
║  POST /api/ai/bulk-add-routines                ║
║  GET  /api/streaks                             ║
║                                                ║
╚════════════════════════════════════════════════╝
  `);
});

module.exports = app;
