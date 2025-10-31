// Monolithic Node.js app serving API and frontend
const express = require('express');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('./json_store');
const MongoStore = require('./mongo_store');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Configure trusted proxy safely (avoid permissive setting)
const TRUST_PROXY = process.env.VERCEL ? 1 : false;
app.set('trust proxy', TRUST_PROXY);

// Admin Login (cookie-based)
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
function isAuthenticated(req){
  const cookie = req.headers['cookie'] || '';
  return cookie.split(';').some(c => c.trim().startsWith('admin_auth=1'));
}
function requireAdmin(req, res, next) {
  if (isAuthenticated(req)) return next();
  return res.redirect('/admin-login');
}

function formatProblems(statements) {
  return statements.map((ps) => {
    const technologies = Array.isArray(ps.technologies) ? ps.technologies : (ps.technologies ? ps.technologies : []);
    const selectedCount = Number.isFinite(ps.selected_count) ? ps.selected_count : (parseInt(ps.selected_count || '0', 10) || 0);
    const maxSelections = Math.max(1, (Number.isFinite(ps.max_selections) ? ps.max_selections : (parseInt(ps.max_selections || '0', 10) || 0)));
    const isAvailable = selectedCount < maxSelections;
    return {
      id: ps.id,
      title: ps.title,
      description: ps.description,
      category: ps.category || null,
      difficulty: ps.difficulty || null,
      technologies,
      selectedCount,
      maxSelections,
      isAvailable
    };
  });
}

// Ensure database is initialized before handling any requests on Vercel
let dbReadyPromise = null;
if (process.env.VERCEL) {
  dbReadyPromise = (async () => { try { await initializeDatabase(); } catch (e) { console.error('DB init failed:', e); } })();
  app.use(async (req, res, next) => {
    try { if (dbReadyPromise) await dbReadyPromise; } catch (_) {}
    next();
  });
}

// Add rate limiting (enabled in production only)
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
  trustProxy: true
});
if (process.env.NODE_ENV === 'production') {
  app.use('/api/', limiter);
}

// Initialize database
let db;
if (process.env.MONGODB_URI) {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'hackathon';
  const prefix = process.env.MONGODB_COLLECTION_PREFIX || '';
  db = new MongoStore(uri, dbName, prefix);
} else {
  db = new DatabaseManager();
}

// Teams CSV (optional auto-fill)
const TEAMS_CSV_PATH = path.join(__dirname, 'teams.csv');
let teamNumberToTeam = new Map();
function parseCSVLine(str) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === '"') {
      if (inQuotes && str[i + 1] === '"') { cur += '"'; i++; }
      else { inQuotes = !inQuotes; }
      continue;
    }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function loadTeamsCSV() {
  try {
    if (!fs.existsSync(TEAMS_CSV_PATH)) { teamNumberToTeam = new Map(); return; }
    const content = fs.readFileSync(TEAMS_CSV_PATH, 'utf8');
    const lines = content.split(/\r?\n/).filter(Boolean);
    const [header, ...rows] = lines;
    if (!header) { teamNumberToTeam = new Map(); return; }
    const colsRaw = parseCSVLine(header.replace(/^\uFEFF/, ''));
    const cols = colsRaw.map(c => String(c).trim());
    const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const names = cols.map(c => norm(c));
    const findIdx = (aliases) => {
      for (let i = 0; i < names.length; i++) {
        if (aliases.includes(names[i])) return i;
      }
      return -1;
    };
    // Support both legacy and new header formats
    // Legacy: teamNumber,teamName,teamLeader
    // New: Team_name, Name, Reg_no
    const idx = {
      teamNumber: findIdx(['teamnumber','regno','registrationno','regnumber','reg_no']),
      teamName: findIdx(['teamname','team_name','team']),
      teamLeader: findIdx(['teamleader','leader','name','studentname']),
      teamNo: findIdx(['teamno','team_no','teamnumberdisplay','team_id']),
      department: findIdx(['department','dept'])
    };
    if (idx.teamNumber === -1 || idx.teamName === -1 || idx.teamLeader === -1) { teamNumberToTeam = new Map(); return; }
    const map = new Map();
    rows.forEach((line) => {
      if (!line.trim()) return;
      const parts = parseCSVLine(line);
      if (parts.length < Math.max(idx.teamNumber, idx.teamName, idx.teamLeader) + 1) return;
      const teamNumber = String(parts[idx.teamNumber] ?? '').trim();
      const teamName = String(parts[idx.teamName] ?? '').trim();
      const teamLeader = String(parts[idx.teamLeader] ?? '').trim();
      const teamNo = idx.teamNo !== -1 ? String(parts[idx.teamNo] ?? '').trim() : '';
      const department = idx.department !== -1 ? String(parts[idx.department] ?? '').trim() : '';
      if (!teamNumber) return;
      map.set(teamNumber, { teamNumber, teamName, teamLeader, teamNo, department });
    });
    teamNumberToTeam = map;
  } catch (_) { teamNumberToTeam = new Map(); }
}
loadTeamsCSV();

// SSE for live updates
const connectedClients = new Set();
function broadcastUpdate(type, data) {
  const message = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
  connectedClients.forEach((client) => { try { client.write(message); } catch (_) { connectedClients.delete(client); } });
}

async function initializeDatabase() {
  try {
    await db.init();
    // Load release settings if available
    try {
      if (typeof db.getSettings === 'function') {
        const settings = await db.getSettings();
        if (settings && typeof settings.problemsReleased === 'boolean') {
          app.locals.problemsReleased = settings.problemsReleased;
        }
      }
    } catch (_) {}
    const DATA_FILE = path.join(__dirname, 'data.json');
    if (fs.existsSync(DATA_FILE)) {
      const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
      const existingProblems = await db.getAllProblemStatements();
      if (existingProblems.length === 0 && jsonData.problemStatements?.length > 0) {
        await db.importFromJSON(jsonData);
      }
    }
  } catch (error) {
    console.error('Error during database initialization:', error);
    // On Vercel, do NOT fallback to JSON (read-only filesystem). Require MongoDB to work.
    if (process.env.VERCEL) {
      throw error;
    }
    // Locally, fallback to JSON/Blob store if MongoDB fails
    try {
      db = new DatabaseManager();
      await db.init();
      console.warn('Fell back to JSON/Blob store after Mongo init failure (local only)');
    } catch (e) {
      console.error('Fallback store initialization failed:', e);
    }
  }
}

// API
app.get('/api/problem-statements', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    const includeUnreleased = String(req.query.includeUnreleased || '') === '1';
    const released = app.locals.problemsReleased === true;
    if (!released && !includeUnreleased) {
      return res.json([]);
    }
    const statements = await db.getAllProblemStatements();
    const formatted = formatProblems(statements).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    res.json(formatted);
  } catch (error) {
    console.error('Error fetching problem statements:', error);
    // Do NOT fallback to JSON on Vercel to avoid EROFS; require Mongo to be healthy
    if (!process.env.VERCEL) {
      // Locally, allow a one-time JSON fallback
      if (error && (error.name === 'MongoServerSelectionError' || String(error).includes('MongoServerSelectionError'))) {
        try {
          db = new DatabaseManager();
          await db.init();
        const statements = await db.getAllProblemStatements();
        const formatted = formatProblems(statements).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
          return res.json(formatted);
        } catch (e2) {
          console.error('Local fallback fetch failed:', e2);
        }
      }
    }
    res.status(500).json({ error: 'Failed to fetch problem statements' });
  }
});


app.get('/api/teams', (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    res.json(Array.from(teamNumberToTeam.values()));
  } catch (_) { res.status(500).json({ error: 'Failed to load teams' }); }
});

app.get('/api/teams/:teamNumber', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  const team = teamNumberToTeam.get(String(req.params.teamNumber).trim());
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json(team);
});

// Admin: reload teams.csv after upload
app.post('/api/admin/reload-teams', (req, res) => {
  try {
    loadTeamsCSV();
    res.json({ ok: true, total: teamNumberToTeam.size });
  } catch (e) {
    res.status(500).json({ error: 'Failed to reload teams.csv' });
  }
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Cache-Control' });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Real-time updates enabled' })}\n\n`);
  connectedClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`); } catch (_) { clearInterval(heartbeat); connectedClients.delete(res); } }, 30000);
  req.on('close', () => { clearInterval(heartbeat); connectedClients.delete(res); });
});

app.post('/api/register', async (req, res) => {
  try {
    const { teamNumber, teamName, teamLeader, problemStatementId } = req.body;
    if (!teamNumber || !teamName || !teamLeader || !problemStatementId) {
      return res.status(400).json({ error: 'Missing required fields: teamNumber, teamName, teamLeader, problemStatementId' });
    }
    
    // Check if team number is already taken
    const isTaken = await db.isTeamNumberTaken(teamNumber);
    if (isTaken) return res.status(409).json({ error: 'Team number already registered.' });
    
    // Check if problem statement exists
    const ps = await db.getProblemStatementById(problemStatementId);
    if (!ps) return res.status(404).json({ error: 'Problem statement not found.' });
    
    // Get current state of all problem statements for better error messages
    const allProblems = formatProblems(await db.getAllProblemStatements());
    const targetProblem = allProblems.find(p => p.id === problemStatementId);
    
    // Attempt atomic registration
    const registration = await db.createRegistrationAtomic({ teamNumber, teamName, teamLeader, problemStatementId });
    
    if (!registration) {
      // Registration failed - provide simple feedback
      if (targetProblem && !targetProblem.isAvailable) {
        // Problem statement is full
        return res.status(409).json({
          error: 'Registration failed - Problem statement is full',
          details: {
            selectedProblem: {
              id: targetProblem.id,
              title: targetProblem.title,
              status: `${targetProblem.selectedCount}/${targetProblem.maxSelections} slots filled`
            },
            message: 'This problem statement is full. Please try another problem statement.'
          }
        });
      } else {
        // Other registration failure (shouldn't happen with current logic, but safety net)
        return res.status(409).json({ 
          error: 'Registration failed', 
          details: 'Unable to complete registration. Please try again.' 
        });
      }
    }
    
    // Registration successful
    try {
      const updatedRegistrations = await db.getAllRegistrations();
      const enrichedRegs = updatedRegistrations.map(r => {
        const team = teamNumberToTeam.get(String(r.team_number || '').trim());
        return {
          ...r,
          team_display_number: (team && team.teamNo) ? team.teamNo : r.team_number,
          department: (team && team.department) ? team.department : r.department
        };
      });
      const updatedProblems = formatProblems(await db.getAllProblemStatements());
      broadcastUpdate('registration', { registrations: enrichedRegs, problems: updatedProblems, newRegistration: { ...registration, problemStatement: ps } });
    } catch (_) {}
    
    res.json({ 
      success: true,
      message: 'Registration successful!', 
      registration: { ...registration, problemStatement: ps },
      problemStatement: {
        id: targetProblem.id,
        title: targetProblem.title,
        category: targetProblem.category,
        difficulty: targetProblem.difficulty,
        newStatus: `${targetProblem.selectedCount + 1}/${targetProblem.maxSelections} slots filled`
      }
    });
  } catch (error) {
    console.error('Error during registration:', error);
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

app.delete('/api/registration/:teamNumber', async (req, res) => {
  try {
    const result = await db.deleteRegistration(req.params.teamNumber);
    if (result.changes === 0) return res.status(404).json({ error: 'Registration not found' });
    try {
      const updatedRegistrations = await db.getAllRegistrations();
      const enrichedRegs = updatedRegistrations.map(r => {
        const team = teamNumberToTeam.get(String(r.team_number || '').trim());
        return {
          ...r,
          team_display_number: (team && team.teamNo) ? team.teamNo : r.team_number,
          department: (team && team.department) ? team.department : r.department
        };
      });
      const updatedProblems = formatProblems(await db.getAllProblemStatements());
      broadcastUpdate('deletion', { registrations: enrichedRegs, problems: updatedProblems, deletedTeamNumber: String(req.params.teamNumber).trim() });
    } catch (_) {}
    res.json({ message: 'Registration deleted successfully' });
  } catch (error) {
    console.error('Error deleting registration:', error);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

// Admin: reset all data (re-seed defaults)
app.post('/api/reset', async (req, res) => {
  try {
    await db.resetAll();
    const registrations = await db.getAllRegistrations();
    const enrichedRegs = registrations.map(r => {
      const team = teamNumberToTeam.get(String(r.team_number || '').trim());
      return {
        ...r,
        team_display_number: (team && team.teamNo) ? team.teamNo : r.team_number,
        department: (team && team.department) ? team.department : r.department
      };
    });
    const problems = formatProblems(await db.getAllProblemStatements());
    broadcastUpdate('reset', { registrations: enrichedRegs, problems });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error during reset:', error);
    res.status(500).json({ error: 'Failed to reset data' });
  }
});

// Admin: replace problems with contents of data.json (keeps file as source of truth)
app.post('/api/admin/replace-with-data-file', async (req, res) => {
  try {
    const DATA_FILE = path.join(__dirname, 'data.json');
    if (!fs.existsSync(DATA_FILE)) {
      return res.status(404).json({ error: 'data.json not found on server' });
    }
    const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
    // Hard replace (overwrite) from data.json to avoid merging old defaults
    if (typeof db.replaceFromJSON === 'function') {
      await db.replaceFromJSON(jsonData);
    } else {
      // Fallback: reset and then import (may merge if IDs conflict)
      await db.resetAll();
      await db.importFromJSON(jsonData);
    }
    // Automatically release problems after replacement so they appear on public page
    app.locals.problemsReleased = true;
    try { 
      if (typeof db.setSettings === 'function') {
        await db.setSettings({ problemsReleased: true }); 
      }
    } catch (err) {
      console.error('Error setting release status:', err);
    }
    const registrations = await db.getAllRegistrations();
    const problems = formatProblems(await db.getAllProblemStatements());
    broadcastUpdate('reset', { registrations, problems });
    try { broadcastUpdate('release', { released: true }); } catch (_) {}
    res.json({ ok: true, importedProblems: problems.length });
  } catch (error) {
    console.error('Error replacing from data file:', error);
    res.status(500).json({ error: 'Failed to replace data from file' });
  }
});

// Admin: set all problem statement limits to 1 team
app.post('/api/admin/limit-one-all', async (req, res) => {
  try {
    const problems = await db.getAllProblemStatements();
    let updated = 0;
    for (const p of problems) {
      try {
        const result = await db.updateProblemStatement(p.id, { maxSelections: 1 });
        updated += (result && result.changes) ? result.changes : 0;
      } catch (_) {}
    }
    const registrations = await db.getAllRegistrations();
    const refreshed = formatProblems(await db.getAllProblemStatements());
    try { broadcastUpdate('reset', { registrations, problems: refreshed }); } catch (_) {}
    res.json({ ok: true, updated, total: refreshed.length });
  } catch (error) {
    console.error('Error setting limits to 1:', error);
    res.status(500).json({ error: 'Failed to set all limits to 1' });
  }
});

app.get('/api/registrations', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    let registrations;
    try {
      registrations = await db.getAllRegistrations();
    } catch (error) {
      // If there's a duplicate key error, try to fix it and retry
      if (error.code === 11000 || error.message?.includes('E11000') || error.message?.includes('duplicate key')) {
        console.warn('Duplicate key error in getAllRegistrations, attempting cleanup...');
        // The getAllRegistrations method should handle this, but if it doesn't, retry once
        try {
          registrations = await db.getAllRegistrations();
        } catch (retryError) {
          console.error('Error fetching registrations after retry:', retryError);
          return res.status(500).json({ error: 'Failed to fetch registrations due to database inconsistency. Please contact administrator.' });
        }
      } else {
        throw error;
      }
    }
    const enriched = registrations.map(r => {
      const team = teamNumberToTeam.get(String(r.team_number || '').trim());
      return {
        ...r,
        team_display_number: (team && team.teamNo) ? team.teamNo : r.team_number,
        department: (team && team.department) ? team.department : r.department
      };
    });
    res.json(enriched);
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

app.get('/api/evaluation-criteria', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    let criteria = null;
    try {
      if (typeof db.getEvaluationCriteria === 'function') {
        criteria = await db.getEvaluationCriteria();
      }
    } catch (_) {}

    // Fallback to data.json if not found in DB
    if (!criteria) {
      try {
        const DATA_FILE = path.join(__dirname, 'data.json');
        if (fs.existsSync(DATA_FILE)) {
          const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
          if (jsonData && jsonData.evaluationCriteria) {
            criteria = jsonData.evaluationCriteria;
          }
        }
      } catch (_) {}
    }

    if (!criteria) {
      return res.status(404).json({ error: 'Evaluation criteria not found' });
    }
    res.json(criteria);
  } catch (error) {
    console.error('Error fetching evaluation criteria:', error);
    res.status(500).json({ error: 'Failed to fetch evaluation criteria' });
  }
});

// Export endpoints (HTML-to-print)
app.get('/api/export/registrations/pdf', async (req, res) => {
  try {
    const registrations = await db.getAllRegistrations();
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Registrations</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}th{background:#c10016;color:#fff}</style></head><body><h1>Registrations</h1>${registrations.length?`<table><thead><tr><th>Team #</th><th>Team Name</th><th>Leader</th><th>Problem</th><th>Date</th></tr></thead><tbody>${registrations.map(r=>`<tr><td>${r.team_number}</td><td>${r.team_name}</td><td>${r.team_leader}</td><td>${r.problem_title}</td><td>${new Date(r.registration_date_time).toLocaleString('en-IN')}</td></tr>`).join('')}</tbody></table>`:`<p>No registrations.</p>`}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="registrations-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting registrations PDF:', error);
    res.status(500).json({ error: 'Failed to export registrations PDF' });
  }
});

app.get('/api/export/problem-statements/pdf', async (req, res) => {
  try {
    const problems = (await db.getAllProblemStatements()).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    const html = `<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Problem Statements</title><style>body{font-family:Arial;padding:20px}.card{border:1px solid #ddd;margin-bottom:10px;padding:10px;border-radius:4px}.status{font-weight:bold}.ok{color:#28a745}.full{color:#dc3545}</style></head><body><h1>Problem Statements</h1>${problems.map(p=>{const teams=`${(p.selected_count??p.selectedCount)}/${(p.max_selections??p.maxSelections)}`;const isOk=(p.is_available??p.isAvailable);const statusHtml=`<span class=\"status ${isOk?'ok':'full'}\">${isOk?'Available':'Full'}</span>`;return `<div class=\"card\"><h3>${p.title}</h3><div>ID: ${p.id} | Category: ${p.category||'N/A'} | Teams: ${teams} | Status: ${statusHtml}</div><div style=\"margin-top:6px;\">${p.description}</div></div>`;}).join('')}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="problem-statements-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting problem statements PDF:', error);
    res.status(500).json({ error: 'Failed to export problem statements PDF' });
  }
});

app.get('/api/export/all/pdf', async (req, res) => {
  try {
    const problems = (await db.getAllProblemStatements()).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    const registrations = await db.getAllRegistrations();
    const html = `<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Complete Report</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}th{background:#c10016;color:#fff}.card{border:1px solid #ddd;margin-bottom:10px;padding:10px;border-radius:4px}.status{font-weight:bold}.ok{color:#28a745}.full{color:#dc3545}</style></head><body><h1>Complete Report</h1><h2>Problem Statements</h2>${problems.map(p=>{const teams=`${(p.selected_count??p.selectedCount)}/${(p.max_selections??p.maxSelections)}`;const isOk=(p.is_available??p.isAvailable);const statusHtml=`<span class=\"status ${isOk?'ok':'full'}\">${isOk?'Available':'Full'}</span>`;return `<div class=\"card\"><strong>${p.title}</strong><div style=\"font-size:12px;color:#555;\">ID: ${p.id} | Category: ${p.category||'N/A'} | Teams: ${teams} | Status: ${statusHtml}</div><div style=\"margin-top:6px;\">${p.description}</div></div>`;}).join('')}<h2>Registrations</h2>${registrations.length?`<table><thead><tr><th>Team #</th><th>Team Name</th><th>Leader</th><th>Problem</th><th>Date</th></tr></thead><tbody>${registrations.map(r=>`<tr><td>${r.team_number}</td><td>${r.team_name}</td><td>${r.team_leader}</td><td>${r.problem_title}</td><td>${new Date(r.registration_date_time).toLocaleDateString('en-IN')}</td></tr>`).join('')}</tbody></table>`:`<p>No registrations.</p>`}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="hackathon-complete-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting complete PDF:', error);
    res.status(500).json({ error: 'Failed to export complete PDF' });
  }
});

// Lightweight login notification endpoint
app.post('/api/notify-login', express.json(), (req, res) => {
  try {
    const user = (req.body && req.body.user) ? String(req.body.user) : 'unknown';
    const role = (req.body && req.body.role) ? String(req.body.role) : 'unknown';
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip || '').toString();
    const when = new Date().toISOString();
    console.log(`[LOGIN_NOTIFY] user=${user} role=${role} ip=${ip} time=${when}`);
    res.json({ ok: true, user, role, ip, time: when });
  } catch (e) {
    res.status(200).json({ ok: true });
  }
});

// Frontend routes
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'home.html')); });
app.get('/problem', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'problem.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/admin-login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin-login.html')); });
app.post('/api/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const user = (req.body.username || '').trim();
  const pass = (req.body.password || '').trim();
  if (ADMIN_USER && ADMIN_PASS && user === ADMIN_USER && pass === ADMIN_PASS) {
    res.setHeader('Set-Cookie', 'admin_auth=1; Path=/; HttpOnly; SameSite=Lax');
    return res.redirect('/admin');
  }
  return res.status(401).send('<!DOCTYPE html><html><body style="font-family:Arial;padding:20px"><h3 style="color:#c10016">Access denied</h3><p>Admin credentials are not set or invalid. Please configure ADMIN_USER and ADMIN_PASS in environment variables.</p><a href="/admin-login">Back to login</a></body></html>');
});
app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_auth=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  return res.redirect('/admin-login');
});

// Release toggle endpoints
app.get('/api/release-status', async (req, res) => {
  try {
    const released = app.locals.problemsReleased === true;
    res.json({ released });
  } catch (e) {
    res.json({ released: false });
  }
});

app.post('/api/admin/release', async (req, res) => {
  try {
    const released = !!(req.body && (req.body.released === true || req.body.released === 'true' || req.body.released === 1 || req.body.released === '1'));
    app.locals.problemsReleased = released;
    try { if (typeof db.setSettings === 'function') await db.setSettings({ problemsReleased: released }); } catch (_) {}
    try { broadcastUpdate('release', { released }); } catch (_) {}
    res.json({ ok: true, released });
  } catch (e) {
    res.status(500).json({ error: 'Failed to set release status' });
  }
});

process.on('SIGINT', async () => { await db.close(); process.exit(0); });

async function startServer() {
  await initializeDatabase();
  // Optional: auto-reset on cold start to ensure clean slate
  if (process.env.AUTO_RESET === '1') {
    try {
      await db.resetAll();
      const registrations = await db.getAllRegistrations();
      const problems = formatProblems(await db.getAllProblemStatements());
      broadcastUpdate('reset', { registrations, problems });
    } catch (e) {
      console.error('Auto reset failed:', e);
    }
  }
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer().catch(console.error);
} else {
  // On Vercel, export the app for the serverless function runtime
  module.exports = app;
}


