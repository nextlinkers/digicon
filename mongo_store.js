const { MongoClient } = require('mongodb');

class MongoStore {
  constructor(uri, dbName, collectionPrefix = '') {
    this.uri = uri;
    this.dbName = dbName;
    this.collectionPrefix = collectionPrefix || '';
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 10000 });
    this.db = null;
    this.collections = null;
  }

  async init() {
    if (this.db) return;
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    const ps = this.db.collection(`${this.collectionPrefix}problem_statements`);
    const regs = this.db.collection(`${this.collectionPrefix}registrations`);
    this.collections = { ps, regs };
    // indexes
    await ps.createIndex({ id: 1 }, { unique: true });
    await regs.createIndex({ teamNumber: 1 }, { unique: true });
    await regs.createIndex({ problemStatementId: 1 });
    // seed defaults if empty
    const count = await ps.estimatedDocumentCount();
    if (count === 0) {
      const defaults = [
        { id: 'ps001', title: 'Secure Authentication System', description: 'Design and implement a multi-factor authentication system with biometric verification, OTP, and secure session management for a banking application.', maxSelections: 2, category: 'Cybersecurity', difficulty: 'Advanced', technologies: ['Node.js', 'React', 'JWT'] },
        { id: 'ps002', title: 'AI-Powered Code Review Assistant', description: 'Develop an intelligent code review tool that uses machine learning to detect bugs, security vulnerabilities, and suggest improvements in real-time.', maxSelections: 2, category: 'Artificial Intelligence', difficulty: 'Advanced', technologies: ['Python', 'TensorFlow'] },
        { id: 'ps003', title: 'Blockchain Supply Chain Tracker', description: 'Create a transparent supply chain management system using blockchain technology to track products from manufacturer to consumer.', maxSelections: 2, category: 'Blockchain', difficulty: 'Intermediate', technologies: ['Ethereum', 'Solidity'] }
      ];
      await ps.insertMany(defaults);
    }
  }

  async close() {
    try { await this.client.close(); } catch (_) {}
  }

  async getAllProblemStatements() {
    if (!this.collections) await this.init();
    const { ps, regs } = this.collections;
    const [problems, registrations] = await Promise.all([
      ps.find({}).toArray(),
      regs.find({}).toArray()
    ]);
    const idToCount = new Map();
    registrations.forEach(r => {
      idToCount.set(r.problemStatementId, (idToCount.get(r.problemStatementId) || 0) + 1);
    });
    return problems.map(p => {
      const parsedMax = typeof p.maxSelections === 'number' ? p.maxSelections : parseInt(p.maxSelections || '0', 10) || 0;
      const maxSel = Math.max(1, parsedMax);
      const selected = idToCount.get(p.id) || 0;
      return {
        id: p.id,
        title: p.title,
        description: p.description,
        max_selections: maxSel,
        category: p.category || null,
        difficulty: p.difficulty || null,
        technologies: Array.isArray(p.technologies) ? p.technologies : [],
        selected_count: selected,
        is_available: selected < maxSel
      };
    });
  }

  async getProblemStatementById(id) {
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    return await ps.findOne({ id })
  }

  async createProblemStatement(problemStatement) {
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    const parsedMax = typeof problemStatement.maxSelections === 'number' ? problemStatement.maxSelections : parseInt(problemStatement.maxSelections || '0', 10) || 0;
    const maxSel = Math.max(1, parsedMax);
    try {
      await ps.insertOne({
        id: problemStatement.id,
        title: problemStatement.title,
        description: problemStatement.description,
        maxSelections: maxSel,
        category: problemStatement.category || null,
        difficulty: problemStatement.difficulty || null,
        technologies: Array.isArray(problemStatement.technologies) ? problemStatement.technologies : []
      });
      return { id: problemStatement.id, changes: 1 };
    } catch (e) {
      return { id: problemStatement.id, changes: 0 };
    }
  }

  async updateProblemStatement(id, updates) {
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    const doc = {};
    if (updates.title !== undefined) doc.title = updates.title;
    if (updates.description !== undefined) doc.description = updates.description;
    if (updates.category !== undefined) doc.category = updates.category;
    if (updates.difficulty !== undefined) doc.difficulty = updates.difficulty;
    if (updates.technologies !== undefined) doc.technologies = Array.isArray(updates.technologies) ? updates.technologies : [];
    if (updates.max_selections !== undefined || updates.maxSelections !== undefined) {
      const val = updates.max_selections ?? updates.maxSelections;
      const parsed = typeof val === 'number' ? val : parseInt(val || '0', 10) || 0;
      doc.maxSelections = Math.max(1, parsed);
    }
    const res = await ps.updateOne({ id }, { $set: doc });
    return { id, changes: res.modifiedCount };
  }

  async deleteProblemStatement(id) {
    if (!this.collections) await this.init();
    const { ps, regs } = this.collections;
    const res = await ps.deleteOne({ id });
    await regs.deleteMany({ problemStatementId: id });
    return { id, changes: res.deletedCount };
  }

  async getEvaluationCriteria() {
    // For MongoDB, we'll store evaluation criteria in a separate collection
    if (!this.collections) await this.init();
    const criteriaCollection = this.db.collection(`${this.collectionPrefix}evaluation_criteria`);
    const criteria = await criteriaCollection.findOne({});
    return criteria || null;
  }

  // Settings (e.g., release toggle)
  async getSettings() {
    if (!this.collections) await this.init();
    const settings = this.db.collection(`${this.collectionPrefix}settings`);
    const doc = await settings.findOne({ _id: 'global' });
    return doc?.data || {};
  }

  async setSettings(partial) {
    if (!this.collections) await this.init();
    const settings = this.db.collection(`${this.collectionPrefix}settings`);
    const current = (await settings.findOne({ _id: 'global' }))?.data || {};
    const next = { ...current, ...(partial || {}) };
    await settings.updateOne({ _id: 'global' }, { $set: { data: next } }, { upsert: true });
    return next;
  }

  async getAllRegistrations() {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const [registrations, problems] = await Promise.all([
      regs.find({}).toArray(),
      ps.find({}).toArray()
    ]);
    const idToPs = new Map(problems.map(p => [p.id, p]));
    return registrations.map(r => ({
      team_number: r.teamNumber,
      team_name: r.teamName,
      team_leader: r.teamLeader,
      problem_title: idToPs.get(r.problemStatementId)?.title || '',
      problem_category: idToPs.get(r.problemStatementId)?.category || null,
      problem_difficulty: idToPs.get(r.problemStatementId)?.difficulty || null,
      registration_date_time: r.registrationDateTime,
      registration_date_time_ist: new Date(r.registrationDateTime).toLocaleString('en-IN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true, timeZone:'Asia/Kolkata' }) + ' IST'
    }));
  }

  async getRegistrationsByProblemStatement(problemStatementId) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const problem = await ps.findOne({ id: problemStatementId });
    const list = await regs.find({ problemStatementId }).toArray();
    return list.map(r => ({
      team_number: r.teamNumber,
      team_name: r.teamName,
      team_leader: r.teamLeader,
      problem_title: problem?.title || '',
      registration_date_time: r.registrationDateTime
    }));
  }

  async isTeamNumberTaken(teamNumber) {
    if (!this.collections) await this.init();
    const { regs } = this.collections;
    const target = String(teamNumber).trim();
    const found = await regs.findOne({ teamNumber: target });
    return Boolean(found);
  }

  async createRegistrationAtomic(registration) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const target = String(registration.teamNumber).trim();
    
    // Start a MongoDB session for transaction
    const session = this.client.startSession();
    
    try {
      let result = null;
      
      await session.withTransaction(async () => {
        // Check if team number is already taken (within transaction)
        const exists = await regs.findOne({ teamNumber: target }, { session });
        if (exists) {
          result = null;
          return;
        }
        // Sync selectedCount with actual registrations to avoid drift
        const problem = await ps.findOne({ id: registration.problemStatementId }, { session });
        if (!problem) { result = null; return; }
        const maxSel = Math.max(1, (typeof problem.maxSelections === 'number' ? problem.maxSelections : parseInt(problem.maxSelections || '0', 10) || 0));
        const actualCount = await regs.countDocuments({ problemStatementId: problem.id }, { session });
        const currentSelected = Number.isFinite(problem.selectedCount) ? problem.selectedCount : 0;
        if (currentSelected !== actualCount) {
          await ps.updateOne({ id: problem.id }, { $set: { selectedCount: actualCount } }, { session });
        }
        // Atomically reserve a slot by incrementing selectedCount only when below maxSelections
        const capacity = await ps.updateOne(
          {
            id: problem.id,
            $expr: {
              $lt: [ { $ifNull: ["$selectedCount", 0] }, { $literal: maxSel } ]
            }
          },
          { $inc: { selectedCount: 1 } },
          { session }
        );

        if (!capacity || capacity.modifiedCount === 0) {
          // No capacity available
          result = null;
          return;
        }

        // Create registration after capacity is reserved
        const record = {
          teamNumber: target,
          teamName: registration.teamName,
          teamLeader: registration.teamLeader,
          problemStatementId: registration.problemStatementId,
          registrationDateTime: new Date().toISOString()
        };
        
        try {
          await regs.insertOne(record, { session });
          result = { id: record.teamNumber, changes: 1 };
        } catch (e) {
          // Rollback capacity reservation on failure
          try { await ps.updateOne({ id: registration.problemStatementId }, { $inc: { selectedCount: -1 } }, { session }); } catch (_) {}
          throw e;
        }
      }, {
        readConcern: { level: 'majority' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary'
      });
      
      return result;
      
    } catch (error) {
      // Handle duplicate key error specifically
      if (error.code === 11000) {
        // Duplicate key error - team number already exists
        return null;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async deleteRegistration(teamNumber) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const target = String(teamNumber).trim();
    const reg = await regs.findOne({ teamNumber: target });
    const res = await regs.deleteOne({ teamNumber: target });
    if (res.deletedCount > 0 && reg && reg.problemStatementId) {
      try { await ps.updateOne({ id: reg.problemStatementId }, { $inc: { selectedCount: -1 } }); } catch (_) {}
    }
    return { changes: res.deletedCount };
  }

  async importFromJSON(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.problemStatements)) return;
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    const existing = await ps.find({}).project({ id: 1 }).toArray();
    const existingIds = new Set(existing.map(x => x.id));
    const toInsert = [];
    jsonData.problemStatements.forEach(psItem => {
      if (existingIds.has(psItem.id)) return;
      const parsedMax = typeof psItem.maxSelections === 'number' ? psItem.maxSelections : parseInt(psItem.maxSelections || '0', 10) || 0;
      const maxSel = Math.max(1, parsedMax);
      toInsert.push({
        id: psItem.id,
        title: psItem.title,
        description: psItem.description,
        maxSelections: maxSel,
        category: psItem.category || null,
        difficulty: psItem.difficulty || null,
        technologies: Array.isArray(psItem.technologies) ? psItem.technologies : []
      });
    });
    if (toInsert.length) await ps.insertMany(toInsert);
  }

  async replaceFromJSON(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.problemStatements)) return false;
    if (!this.collections) await this.init();
    const { ps, regs } = this.collections;
    // Overwrite: clear both collections, then insert provided problems
    await regs.deleteMany({});
    await ps.deleteMany({});
    const docs = jsonData.problemStatements.map(psItem => {
      const parsedMax = typeof psItem.maxSelections === 'number' ? psItem.maxSelections : parseInt(psItem.maxSelections || '0', 10) || 0;
      const maxSel = Math.max(1, parsedMax);
      return {
        id: psItem.id,
        title: psItem.title,
        description: psItem.description,
        maxSelections: maxSel,
        category: psItem.category || null,
        difficulty: psItem.difficulty || null,
        technologies: Array.isArray(psItem.technologies) ? psItem.technologies : []
      };
    });
    if (docs.length) await ps.insertMany(docs);
    return true;
  }

  async resetAll() {
    if (!this.collections) await this.init();
    const { ps, regs } = this.collections;
    await regs.deleteMany({});
    await ps.deleteMany({});
    await this.init();
    return true;
  }
}

module.exports = MongoStore;


