const Tournament = require("../models/Tournament");
const Registration = require("../models/Registration");
const User = require("../models/User");
const { createNotification } = require("./notificationController");
const { getSignedUrlFromAny, mirrorImageUrlToGCS } = require("../utils/gcs");
const { cache } = require("../utils/cache");
const PlayerRanking = require("../models/Rankings");
const { computeIncremental } = require("../services/standingsService");
const bracketQueue = require("../services/bracketQueue");
const { parsePagination, buildPaginationMeta } = require("../utils/pagination");
const {
  verifyPayMongoCheckoutSessionPaid,
  sendTournamentPaymentReceipt,
  sendTournamentRegistrationConfirmation,
} = require("../services/tournaments/paymentRegistration.service");
const {
  pickLatestDatedEntry,
  deriveScheduledStatus,
} = require("../utils/tournaments/scheduleStatus.utils");
const {
  buildWeakEtag,
  invalidateTournamentGetCache,
} = require("../services/tournaments/cacheEtag.service");

const TEAM_GAME_PLAYER_FIELDS = [
  "game1Team1Player",
  "game1Team1Player2",
  "game1Team2Player",
  "game1Team2Player2",
  "game2Team1Player",
  "game2Team1Player2",
  "game2Team2Player",
  "game2Team2Player2",
  "game3Team1Player",
  "game3Team1Player2",
  "game3Team2Player",
  "game3Team2Player2",
];

const pickTeamGamePlayers = (src) => {
  const out = {};
  if (!src || typeof src !== "object") return out;
  TEAM_GAME_PLAYER_FIELDS.forEach((k) => {
    if (src[k] !== undefined && src[k] !== null) {
      out[k] = String(src[k] || "").trim();
    }
  });
  return out;
};

// Helper function to check if user has access to tournament
const hasAccessToTournament = (tournament, user) => {
  const userId = user?._id || user?.id;
  const userIdString = userId?.toString?.() || String(userId || "");
  
  // Check if user is superadmin or has organizer role
  const roles = Array.isArray(user?.roles) ? user.roles : [];
  const isSuperAdmin = roles.includes("superadmin");
  const isOrganizer = roles.includes("organizer");
  
  if (isSuperAdmin || isOrganizer) {
    return true;
  }
  
  const hasCreator = !!tournament?.createdBy;
  const isCreator = hasCreator && tournament.createdBy.toString() === userIdString;
  const coHosts = Array.isArray(tournament?.coHosts) ? tournament.coHosts : [];
  const isCoHost = coHosts.some((coHostId) => coHostId?.toString?.() === userIdString);
  return isCreator || isCoHost;
};

// Invalidate cached GET responses for the specific tournament
function invalidateTournamentGetCacheLocal(tournamentId) {
  try {
    const keys = cache.keys();
    // Invalidate specific tournament details and any list endpoints that may include it
    const targetSubstrings = [
      `GET:/api/tournaments/${tournamentId}`, // specific tournament details
      `GET:/api/tournaments`,                 // tournaments list (with or without query)
      `GET:/api/tournaments/my-tournaments`,  // user-scoped lists
    ];
    keys.forEach((k) => {
      if (targetSubstrings.some((sub) => k.includes(sub))) {
        cache.del(k);
      }
    });
  } catch (e) {
    // Ignore cache errors to avoid impacting main flow
  }
}
// ✅ Get tournament sponsors (public)
exports.getTournamentSponsors = async (req, res) => {
  try {
    const { id } = req.params;
    const tournament = await Tournament.findById(id).lean();
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }
    res.json({
      sponsors: tournament.sponsors || [],
      sponsorCategories: (Array.isArray(tournament.sponsorCategories) ? tournament.sponsorCategories : []).map((c) => {
        if (typeof c === "string") return { name: c, size: "" };
        const name = String(c?.name || c?.label || c || "").trim();
        const size = String(c?.size || "").trim();
        return { name, size };
      }),
    });
  } catch (error) {
    console.error("Error getting tournament sponsors:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.buildTeamsFromRegistrations = async (req, res) => {
  try {
    const id = String(req.params.id || req.body?.tournamentId || req.query?.tournamentId || "").trim();
    const categoryId = String(req.body?.categoryId || req.query?.categoryId || "").trim();
    if (!id) return res.status(400).json({ message: "tournamentId required" });
    const Registration = require("../models/Registration");
    const Team = require("../models/Team");
    const makeId = (v) => {
      const s = String(v || "").trim();
      return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
    };
    const query = { tournamentId: id, status: "approved", teamName: { $exists: true, $ne: "" } };
    if (categoryId) query.categoryId = categoryId;
    const regs = await Registration.find(query).select("categoryId teamName playerId partnerId teamMembers").lean();
    const groups = new Map();
    for (const r of regs) {
      const cat = String(r.categoryId || "");
      const name = String(r.teamName || "").trim();
      if (!cat || !name) continue;
      const key = `${cat}::${name.toLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { categoryId: cat, teamName: name, ids: [] });
      const g = groups.get(key);
      if (makeId(r.playerId)) g.ids.push(String(r.playerId));
      if (makeId(r.partnerId)) g.ids.push(String(r.partnerId));
      if (Array.isArray(r.teamMembers)) {
        for (const tm of r.teamMembers) {
          if (makeId(tm)) g.ids.push(String(tm));
        }
      }
    }
    let created = 0;
    let existing = 0;
    for (const [, g] of groups) {
      const ids = Array.from(new Set(g.ids));
      const found = await Team.findOne({ tournamentId: id, categoryId: g.categoryId, teamName: g.teamName }).lean();
      if (found && found._id) {
        existing += 1;
        continue;
      }
      const doc = await Team.create({ tournamentId: id, categoryId: g.categoryId, playerIds: ids, teamName: g.teamName });
      if (doc && doc._id) created += 1;
    }
    return res.json({ ok: true, created, existing });
  } catch (e) {
    return res.status(500).json({ message: "Failed to build teams" });
  }
};

exports.syncTeamsForTournament = async (req, res) => {
  try {
    const id = String(req.params.id || req.body?.tournamentId || req.query?.tournamentId || "").trim();
    const targetCategoryId = String(req.body?.categoryId || req.query?.categoryId || "").trim();
    if (!id) return res.status(400).json({ message: "tournamentId required" });
    const Team = require("../models/Team");
    const Match = require("../models/Match");
    const Standing = require("../models/Standing");
    const makeId = (v) => {
      const s = String(v || "").trim();
      return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
    };
    await exports.buildTeamsFromRegistrations(req, { status: () => ({ json: () => {} }) });
    const teamDocs = await Team.find({ tournamentId: id }).select("_id categoryId teamName playerIds").lean();
    const teamByCatName = new Map();
    for (const t of teamDocs) {
      const key = `${String(t.categoryId)}::${String(t.teamName || "").toLowerCase()}`;
      teamByCatName.set(key, t);
    }
    const matchQuery = { tournamentId: id };
    if (targetCategoryId) matchQuery.categoryId = targetCategoryId;
    const matches = await Match.find(matchQuery).select("_id categoryId player1Name player2Name team1Id team2Id meta").lean();
    let matchUpdates = 0;
    for (const m of matches) {
      const n1 = String(m.player1Name || "").trim();
      const n2 = String(m.player2Name || "").trim();
      const cat = String(m.categoryId || "");
      const t1 = n1 ? teamByCatName.get(`${cat}::${n1.toLowerCase()}`) : null;
      const t2 = n2 ? teamByCatName.get(`${cat}::${n2.toLowerCase()}`) : null;
      const upd = {};
      const meta = { ...(m.meta || {}) };
      if (t1 && !makeId(m.team1Id)) {
        upd.team1Id = String(t1._id);
        meta.teamMemberIdsTeam1 = Array.isArray(t1.playerIds) ? t1.playerIds.map((x) => String(x)) : undefined;
      }
      if (t2 && !makeId(m.team2Id)) {
        upd.team2Id = String(t2._id);
        meta.teamMemberIdsTeam2 = Array.isArray(t2.playerIds) ? t2.playerIds.map((x) => String(x)) : undefined;
      }
      if (Object.keys(upd).length || meta.teamMemberIdsTeam1 || meta.teamMemberIdsTeam2) {
        upd.meta = meta;
        await Match.updateOne({ _id: m._id }, { $set: upd });
        matchUpdates += 1;
      }
    }
    const standingQuery = { tournamentId: id };
    if (targetCategoryId) standingQuery.categoryId = targetCategoryId;
    const standings = await Standing.find(standingQuery).select("_id categoryId displayName teamName teamId meta").lean();
    let standingUpdates = 0;
    for (const s of standings) {
      const name = String(s.teamName || s.displayName || "").trim();
      const cat = String(s.categoryId || "");
      const t = name ? teamByCatName.get(`${cat}::${name.toLowerCase()}`) : null;
      if (t && !makeId(s.teamId)) {
        const meta = { ...(s.meta || {}) };
        meta.teamMemberIds = Array.isArray(t.playerIds) ? t.playerIds.map((x) => String(x)) : undefined;
        await Standing.updateOne({ _id: s._id }, { $set: { teamId: String(t._id), teamName: t.teamName, meta } });
        standingUpdates += 1;
      }
    }
    return res.json({ ok: true, matchesUpdated: matchUpdates, standingsUpdated: standingUpdates, teams: teamDocs.length });
  } catch (e) {
    return res.status(500).json({ message: "Failed to sync teams" });
  }
};
// ✅ Maintenance: Get normalized stats (counts) for Matches and Standings for a tournament
exports.getNormalizedStatsForTournament = async (req, res) => {
  try {
    const { id } = req.params;
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isPrivileged) {
      return res.status(403).json({ message: "Access denied" });
    }
    const Match = require("../models/Match");
    const Standing = require("../models/Standing");
    const mongoose = require("mongoose");
    const tId = mongoose.Types.ObjectId.isValid(String(id)) ? new mongoose.Types.ObjectId(String(id)) : id;

    const [matchTotal, standingTotal] = await Promise.all([
      Match.countDocuments({ tournamentId: tId }),
      Standing.countDocuments({ tournamentId: tId }),
    ]);

    const matchByCategory = await Match.aggregate([
      { $match: { tournamentId: tId } },
      { $group: { _id: "$categoryId", count: { $sum: 1 } } },
      { $project: { categoryId: "$_id", count: 1, _id: 0 } },
    ]);

    const standingByCategory = await Standing.aggregate([
      { $match: { tournamentId: tId } },
      { $group: { _id: "$categoryId", count: { $sum: 1 } } },
      { $project: { categoryId: "$_id", count: 1, _id: 0 } },
    ]);

    const samples = await Match.find({ tournamentId: tId })
      .select("_id categoryId round status player1Name player2Name team1Id team2Id meta")
      .sort({ createdAt: -1 })
      .limit(3)
      .lean();

    return res.json({
      ok: true,
      matches: { total: matchTotal, byCategory: matchByCategory, samples },
      standings: { total: standingTotal, byCategory: standingByCategory },
    });
  } catch (e) {
    return res.status(500).json({ message: "Server error" });
  }
};

// ✅ Club Admin: Tournament statistics for dashboard Details
// Used by `src/pages/TournamentDashboard/Details.jsx`
exports.getTournamentStats = async (req, res) => {
  try {
    const { id } = req.params;
    const Tournament = require("../models/Tournament");

    const t = await Tournament.findById(id).select("tournamentCategories registrations").lean();
    if (!t) return res.status(404).json({ message: "Tournament not found" });

    const cats = Array.isArray(t.tournamentCategories) ? t.tournamentCategories : [];
    const regs = Array.isArray(t.registrations) ? t.registrations : [];

    const normDiv = (cat) => String(cat?.division || cat?.name || "").toLowerCase();
    const isTeamCat = (cat) => normDiv(cat).includes("team");
    const isSinglesCat = (cat) => normDiv(cat).includes("single") && !normDiv(cat).includes("double");

    const getCategoryLabel = (cat) => {
      const division = String(cat?.division || cat?.name || "").trim();
      const skillLevel =
        String(cat?.skillLevel || "").trim() === "Open" && cat?.tier
          ? `Open Tier ${cat.tier}`
          : String(cat?.skillLevel || "").trim();
      const ageCategory = String(cat?.ageCategory || "").trim();
      const parts = [division, skillLevel, ageCategory].filter((p) => p && p.trim());
      return parts.length ? parts.join(" | ") : "Tournament Category";
    };

    const resolvePlayerKey = (v) => {
      if (!v) return null;
      if (typeof v === "string") {
        const s = String(v).trim();
        return s ? s : null;
      }
      if (typeof v === "object") {
        const key = v?._id || v?.id || v?.pplId || v?.duprId || v?.dupr?.duprId;
        const s = key ? String(key).trim() : "";
        return s ? s : null;
      }
      return null;
    };

    const approvedRegs = regs.filter((r) => String(r?.status || "").toLowerCase() === "approved");

    // Tournament-wide unique players across all approved registrations
    const totalUniquePlayersSet = new Set();
    const addUnique = (set, v) => {
      const k = resolvePlayerKey(v);
      if (k) set.add(k);
    };

    approvedRegs.forEach((r) => {
      addUnique(totalUniquePlayersSet, r?.player);
      addUnique(totalUniquePlayersSet, r?.partner);
      if (Array.isArray(r?.teamMembers)) {
        r.teamMembers.forEach((m) => addUnique(totalUniquePlayersSet, m));
      }
    });

    // Slots total: sum of maxParticipants
    const totalSlots = cats.reduce((sum, c) => sum + (Number(c?.maxParticipants) || 0), 0);
    const overallEntries = regs.length;

    const slotsPerCategory = cats.map((cat) => {
      const categoryId = String(cat?._id || cat?.id || "");
      const categoryDivision = String(cat?.division || cat?.name || "").trim();
      const categoryName = getCategoryLabel(cat);

      const approvedForCat = approvedRegs.filter((r) => {
        const rc = r?.categoryId || r?.category;
        const rcStr = rc !== undefined ? String(rc) : "";
        return rcStr === categoryId || (categoryDivision && rcStr === categoryDivision);
      });

      let slotsUsed = 0;
      if (isTeamCat(cat)) {
        // Each approved team registration counts as 1 slot.
        slotsUsed = approvedForCat.filter((r) => (Array.isArray(r?.teamMembers) && r.teamMembers.length > 0) || r?.teamName).length;
      } else if (isSinglesCat(cat)) {
        // Each approved singles registration counts as 1 slot.
        slotsUsed = approvedForCat.length;
      } else {
        // Doubles/mixed: each approved pair counts as 1 slot; leftover solo registrations count as half-pairs.
        const pairRegs = approvedForCat.filter((r) => !!(r?.partner || r?.partnerId));
        const soloRegs = approvedForCat.filter((r) => !(r?.partner || r?.partnerId));
        slotsUsed = pairRegs.length + Math.ceil(soloRegs.length / 2);
      }

      return {
        categoryId,
        categoryName,
        slotsUsed,
        slotsTotal: Number(cat?.maxParticipants) || 0,
      };
    });

    const playersPerCategory = cats.map((cat) => {
      const categoryId = String(cat?._id || cat?.id || "");
      const categoryDivision = String(cat?.division || cat?.name || "").trim();
      const categoryName = getCategoryLabel(cat);

      const approvedForCat = approvedRegs.filter((r) => {
        const rc = r?.categoryId || r?.category;
        const rcStr = rc !== undefined ? String(rc) : "";
        return rcStr === categoryId || (categoryDivision && rcStr === categoryDivision);
      });

      const uniquePlayers = new Set();

      if (isTeamCat(cat)) {
        approvedForCat.forEach((r) => {
          addUnique(uniquePlayers, r?.player);
          addUnique(uniquePlayers, r?.partner);
          if (Array.isArray(r?.teamMembers)) r.teamMembers.forEach((m) => addUnique(uniquePlayers, m));
        });
      } else if (isSinglesCat(cat)) {
        approvedForCat.forEach((r) => addUnique(uniquePlayers, r?.player));
      } else {
        // Doubles/mixed
        approvedForCat.forEach((r) => {
          addUnique(uniquePlayers, r?.player);
          addUnique(uniquePlayers, r?.partner);
        });
      }

      return {
        categoryId,
        categoryName,
        uniquePlayers: uniquePlayers.size,
      };
    });

    return res.json({
      totalSlots,
      overallEntries,
      totalUniquePlayers: totalUniquePlayersSet.size,
      slotsPerCategory,
      playersPerCategory,
    });
  } catch (e) {
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getNormalizedGroupMatches = async (req, res) => {
  try {
    const { id, categoryId, groupId } = req.params || {};
    if (!id || !categoryId || !groupId) {
      return res.status(400).json({ message: "Missing id, categoryId, or groupId" });
    }
    const Match = require("../models/Match");
    const roundTag = `G${String(groupId)}`;
    const docs = await Match.find({
      tournamentId: id,
      categoryId,
      round: roundTag,
    })
      .select("player1Id player2Id player1Name player2Name team1Id team2Id team1Members team2Members stage groupId matchKey gamesPerMatch scores status date time court meta refereeNote signatureData gameSignatures refereeNumber")
      .lean();
    return res.json({ matches: Array.isArray(docs) ? docs : [] });
  } catch (e) {
    return res.status(500).json({ message: "Failed to fetch normalized group matches" });
  }
};

exports.unlockGroupMatchResult = async (req, res) => {
  try {
    const { id, categoryId, groupId, matchKey } = req.params || {};
    const reason = String(req.body?.reason || req.body?.correctionReason || "").trim();
    if (!id || !categoryId || !groupId || !matchKey) {
      return res.status(400).json({ message: "Missing id, categoryId, groupId, or matchKey" });
    }
    if (!reason) {
      return res.status(400).json({ message: "Missing reason for unlock" });
    }
    const Tournament = require("../models/Tournament");
    const tournament = await Tournament.findById(id);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isAdmin = roles.includes("superadmin") || roles.includes("clubadmin");
    const isTournamentStaff = (() => {
      try {
        if (isAdmin) return true;
        return hasAccessToTournament(tournament, req.user);
      } catch {
        return false;
      }
    })();
    if (!isTournamentStaff) return res.status(403).json({ message: "Access denied" });

    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const catIndex = categories.findIndex((c) => String(c?._id) === String(categoryId));
    if (catIndex < 0) return res.status(404).json({ message: "Category not found" });
    const cat = tournament.tournamentCategories[catIndex];
    const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
    const groupIndex = groups.findIndex((g) => String(g?.id) === String(groupId));
    if (groupIndex < 0) return res.status(404).json({ message: "Group not found" });
    const group = cat.groupStage.groups[groupIndex];
    const mm = group?.matches && typeof group.matches === "object" ? group.matches : {};
    const base = mm[String(matchKey)] || null;
    if (!base) return res.status(404).json({ message: "Match not found" });

    const dateOut = String(base?.date ?? base?.mdDate ?? "").trim();
    const timeOut = String(base?.time ?? base?.mdTime ?? "").trim();
    const courtOut = String(base?.court ?? "").trim();
    const hasSchedule = Boolean(dateOut && timeOut && courtOut);
    const statusOut = hasSchedule ? "Scheduled" : "Unschedule";

    const gpmEff = Math.min(Math.max(Number(cat?.gamesPerMatch ?? 3), 1), 3);
    const cleared = {
      ...base,
      status: statusOut,
      game1Player1: 0,
      game1Player2: 0,
      game2Player1: 0,
      game2Player2: 0,
      game3Player1: 0,
      game3Player2: 0,
      finalScorePlayer1: 0,
      finalScorePlayer2: 0,
      winner: null,
      signatureData: "",
      duprNeedsUpdate: false,
    };
    try { delete cleared.score1; delete cleared.score2; } catch {}
    try {
      if (Array.isArray(cleared.gameSignatures)) {
        cleared.gameSignatures = Array.from({ length: gpmEff }, () => null);
      } else {
        cleared.gameSignatures = Array.from({ length: gpmEff }, () => null);
      }
    } catch {}
    try {
      if (Array.isArray(cleared.refereeLocks)) {
        cleared.refereeLocks = Array.from({ length: gpmEff }, () => false);
      } else {
        cleared.refereeLocks = Array.from({ length: gpmEff }, () => false);
      }
    } catch {}
    try { delete cleared.mdScores; delete cleared.wdScores; delete cleared.xdScores; } catch {}

    const updatePath = `tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.matches.${String(matchKey)}`;
    await Tournament.updateOne({ _id: id }, { $set: { [updatePath]: cleared } });
    try { invalidateTournamentGetCache(id); } catch (_) {}

    try {
      const Match = require("../models/Match");
      const roundTag = `G${String(groupId)}`;
      const filter = { tournamentId: id, categoryId, round: roundTag, "meta.groupId": String(groupId), "meta.matchKey": String(matchKey) };
      const set = {
        status: hasSchedule ? "Scheduled" : "Unscheduled",
        scores: {
          game1: { team1: 0, team2: 0 },
          game2: { team1: 0, team2: 0 },
          game3: { team1: 0, team2: 0 },
          final: { team1: 0, team2: 0 },
        },
      };
      await Match.updateOne(filter, { $set: set }, { upsert: false });
    } catch (_) {}

    try {
      const TournamentAuditLog = require("../models/TournamentAuditLog");
      await TournamentAuditLog.create({
        tournamentId: tournament._id,
        entityType: "match",
        entityId: `group:${String(categoryId)}:${String(groupId)}:${String(matchKey)}`,
        action: "match_unlock_result",
        actorId: req.user?._id || req.user?.id,
        actorRoles: roles,
        reason,
        before: {
          status: base?.status,
          signatureData: base?.signatureData,
          game1Player1: base?.game1Player1,
          game1Player2: base?.game1Player2,
          game2Player1: base?.game2Player1,
          game2Player2: base?.game2Player2,
          game3Player1: base?.game3Player1,
          game3Player2: base?.game3Player2,
          finalScorePlayer1: base?.finalScorePlayer1,
          finalScorePlayer2: base?.finalScorePlayer2,
        },
        after: {
          status: cleared?.status,
          signatureData: cleared?.signatureData,
          game1Player1: cleared?.game1Player1,
          game1Player2: cleared?.game1Player2,
          game2Player1: cleared?.game2Player1,
          game2Player2: cleared?.game2Player2,
          game3Player1: cleared?.game3Player1,
          game3Player2: cleared?.game3Player2,
          finalScorePlayer1: cleared?.finalScorePlayer1,
          finalScorePlayer2: cleared?.finalScorePlayer2,
        },
        meta: { stage: "group", categoryId: String(categoryId), groupId: String(groupId), matchKey: String(matchKey) },
      });
    } catch (_) {}

    return res.json({ ok: true, unlocked: true, status: statusOut });
  } catch (e) {
    return res.status(500).json({ message: "Failed to unlock match result" });
  }
};

exports.getNormalizedEliminationMatches = async (req, res) => {
  try {
    const { id, categoryId } = req.params || {};
    if (!id || !categoryId) {
      return res.status(400).json({ message: "Missing id or categoryId" });
    }
    const Match = require("../models/Match");
    let docs = await Match.find({
      tournamentId: id,
      categoryId,
      round: { $not: /^G/ },
    })
      .sort({ "meta.roundOrder": 1, date: 1, time: 1, createdAt: 1 })
      .select("player1Id player2Id player1Name player2Name team1Id team2Id team1Members team2Members stage groupId matchKey gamesPerMatch scores status date time court round meta refereeNote signatureData gameSignatures refereeNumber")
      .lean();
    if (!Array.isArray(docs)) docs = [];
    const patched = docs.map((m) => {
      try {
        const hasSched = Boolean(
          (m?.date && String(m.date).trim() !== "") &&
          (m?.time && String(m.time).trim() !== "") &&
          (m?.court && String(m.court).trim() !== "")
        );
        const status = deriveScheduledStatus(m?.status, hasSched);
        const st = String(m?.status || "").trim();
        return status && status !== st ? { ...m, status } : m;
      } catch {
        return m;
      }
    });
    return res.json({ matches: patched });
  } catch (e) {
    return res.status(500).json({ message: "Failed to fetch normalized elimination matches" });
  }
};

exports.getLiveScoresByTournament = async (req, res) => {
  try {
    const { id } = req.params || {};
    if (!id) return res.status(400).json({ message: "Missing tournament id" });

    const Match = require("../models/Match");
    const dateParam = String(req.query.date || "").trim();
    const query = {
      tournamentId: id,
      status: { $in: ["Ongoing", "ongoing"] },
    };
    if (dateParam) {
      const d = new Date(`${dateParam}T00:00:00.000Z`);
      if (!Number.isNaN(d.getTime())) {
        const next = new Date(d.getTime() + 24 * 60 * 60 * 1000);
        query.date = { $gte: d, $lt: next };
      }
    }

    const docs = await Match.find(query)
      .sort({ updatedAt: -1 })
      .select("court round status player1Name player2Name scores game1Player1 game1Player2 game2Player1 game2Player2 game3Player1 game3Player2 finalScorePlayer1 finalScorePlayer2 date time updatedAt")
      .lean();

    const byCourt = new Map();
    for (const m of docs || []) {
      const courtRaw = String(m?.court || "").trim();
      const courtKey = courtRaw || "Unassigned";
      if (byCourt.has(courtKey)) continue;
      byCourt.set(courtKey, m);
    }

    const rows = Array.from(byCourt.entries()).map(([courtKey, m], idx) => {
      const g1a = Number(m?.scores?.game1?.team1 ?? m?.game1Player1 ?? 0);
      const g1b = Number(m?.scores?.game1?.team2 ?? m?.game1Player2 ?? 0);
      const g2a = Number(m?.scores?.game2?.team1 ?? m?.game2Player1 ?? 0);
      const g2b = Number(m?.scores?.game2?.team2 ?? m?.game2Player2 ?? 0);
      const g3a = Number(m?.scores?.game3?.team1 ?? m?.game3Player1 ?? 0);
      const g3b = Number(m?.scores?.game3?.team2 ?? m?.game3Player2 ?? 0);
      const fa = Number(m?.scores?.final?.team1 ?? m?.finalScorePlayer1 ?? 0);
      const fb = Number(m?.scores?.final?.team2 ?? m?.finalScorePlayer2 ?? 0);
      const pickLivePair = () => {
        if (g3a + g3b > 0) return { a: g3a, b: g3b };
        if (g2a + g2b > 0) return { a: g2a, b: g2b };
        if (g1a + g1b > 0) return { a: g1a, b: g1b };
        if (fa + fb > 0) return { a: fa, b: fb };
        return { a: 0, b: 0 };
      };
      const livePair = pickLivePair();
      return ({
      id: `${courtKey}-${String(m?._id || idx)}`,
      name: courtKey.startsWith("Court") ? courtKey : `Court ${courtKey}`,
      status: "live",
      round: String(m?.round || "Match"),
      category: String(m?.meta?.categoryLabel || ""),
      raceTo: 11,
      playerA: String(m?.player1Name || "TBD"),
      playerB: String(m?.player2Name || "TBD"),
      scoreA: livePair.a,
      scoreB: livePair.b,
      setsWonA: 0,
      setsWonB: 0,
      gameScore: `${g1a}-${g1b} | ${g2a}-${g2b} | ${g3a}-${g3b}`,
      date: m?.date || null,
      time: m?.time || "",
      updatedAt: m?.updatedAt || null,
      });
    });

    const toCourtSortKey = (name) => {
      const s = String(name || "").trim().toLowerCase();
      const m = s.match(/court\s*(\d+)/i) || s.match(/(\d+)/);
      if (!m) return Number.MAX_SAFE_INTEGER;
      return Number(m[1] || Number.MAX_SAFE_INTEGER);
    };
    rows.sort((a, b) => {
      const ka = toCourtSortKey(a?.name);
      const kb = toCourtSortKey(b?.name);
      if (ka !== kb) return ka - kb;
      return String(a?.name || "").localeCompare(String(b?.name || ""));
    });
    const latestUpdatedAt = rows.reduce((max, r) => {
      const t = new Date(r.updatedAt || 0).getTime();
      return t > max ? t : max;
    }, 0);
    const etag = buildWeakEtag([id, dateParam || "all", rows.length, latestUpdatedAt]);
    if (req.headers["if-none-match"] && req.headers["if-none-match"] === etag) {
      return res.status(304).end();
    }
    res.set("ETag", etag);
    res.set("Cache-Control", "private, no-cache");
    return res.json({ courts: rows, updatedAt: latestUpdatedAt ? new Date(latestUpdatedAt).toISOString() : null });
  } catch (e) {
    return res.status(500).json({ message: "Failed to fetch live scores" });
  }
};
exports.getNormalizedStandingsForCategory = async (req, res) => {
  try {
    const { id, categoryId } = req.params || {};
    if (!id || !categoryId) {
      return res.status(400).json({ message: "Missing id or categoryId" });
    }
    const Standing = require("../models/Standing");
    const docs = await Standing.find({
      tournamentId: id,
      categoryId,
    })
      .select("playerId teamId displayName teamName wins losses pointsFor pointsAgainst pointDifferential rankPoints meta")
      .lean();
    return res.json({ standings: Array.isArray(docs) ? docs : [] });
  } catch (e) {
    return res.status(500).json({ message: "Failed to fetch normalized standings" });
  }
};
// ✅ Recompute standings from saved matches (no matches payload required)
exports.recomputeGroupStandings = async (req, res) => {
  try {
    const { id, categoryId, groupId } = req.params;
    const tournament = await Tournament.findById(id).select("tournamentCategories createdBy coHosts");
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin") || roles.includes("referee");
    if (!isPrivileged && !hasAccessToTournament(tournament, req.user?.id)) {
      return res.status(403).json({ message: "Access denied" });
    }
    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const catIndex = categories.findIndex((c) => String(c._id) === String(categoryId));
    if (catIndex < 0) return res.status(404).json({ message: "Category not found" });
    const cat = tournament.tournamentCategories[catIndex];
    if (cat.locked || cat.pointsSubmitted) {
      return res.status(409).json({ message: "Category is locked or points already submitted" });
    }
    const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
    const groupIndex = groups.findIndex((g) => String(g.id) === String(groupId));
    if (groupIndex < 0) return res.status(404).json({ message: "Group not found" });
    const group = cat.groupStage.groups[groupIndex];
    const matches = group.matches || {};
    const basePlayers = (() => {
      const set = new Set();
      const keys = Object.keys(matches);
      for (const k of keys) {
        const m = matches[k] || {};
        const p1 = String(m.player1 || "").trim();
        const p2 = String(m.player2 || "").trim();
        const n1 = String(m.player1Name || "").trim();
        const n2 = String(m.player2Name || "").trim();
        if (p1 && p1.toLowerCase() !== "tbd") set.add(p1);
        else if (n1) set.add(n1);
        if (p2 && p2.toLowerCase() !== "tbd") set.add(p2);
        else if (n2) set.add(n2);
      }
      return Array.from(set);
    })();
    tournament.tournamentCategories[catIndex].groupStage.groups[groupIndex].originalPlayers = basePlayers;
    const keysChanged = Object.keys(matches || {});
    const computed = computeIncremental(
      tournament.tournamentCategories[catIndex].groupStage.groups[groupIndex],
      keysChanged
    );
    tournament.tournamentCategories[catIndex].groupStage.groups[groupIndex].standings = computed;
    try {
      tournament.markModified(`tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.standings`);
      tournament.markModified(`tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.originalPlayers`);
    } catch (_) {
      tournament.markModified('tournamentCategories');
    }
    await tournament.save();
    invalidateTournamentGetCache(id);
    try {
      const Match = require("../models/Match");
      const makeId = (val) => {
        const s = String(val || "").trim();
        return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
      };
      const roundTag = `G${groupId}`;
      const finalMatchesObj = matches || {};
      const keys = Array.isArray(finalMatchesObj) ? finalMatchesObj.map((_, idx) => String(idx + 1)) : Object.keys(finalMatchesObj);
      for (const key of keys) {
        const m = Array.isArray(finalMatchesObj) ? finalMatchesObj[parseInt(key) - 1] || {} : (finalMatchesObj[key] || {});
        const isTeam = !!(m.team1Id && m.team2Id);
        if (isTeam) {
          const t1 = makeId(m.team1Id);
          const t2 = makeId(m.team2Id);
          if (!t1 || !t2) {
            const Registration = require("../models/Registration");
            const Team = require("../models/Team");
            const normIds = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || "")).filter((s) => /^[a-f0-9]{24}$/i.test(s))));
            const getMembers = async (teamNameRaw) => {
              const tn = String(teamNameRaw || "").trim();
              if (!tn) return [];
              const regs = await Registration.find({ tournamentId: id, categoryId, status: "approved", teamName: tn })
                .select("playerId partnerId teamMembers")
                .lean();
              const ids = [];
              for (const r of regs) {
                if (r.playerId) ids.push(String(r.playerId));
                if (r.partnerId) ids.push(String(r.partnerId));
                if (Array.isArray(r.teamMembers)) ids.push(...r.teamMembers.map((x) => String(x)));
              }
              return normIds(ids);
            };
            const team1Members = await getMembers(m.team1Name || m.player1Name);
            const team2Members = await getMembers(m.team2Name || m.player2Name);
            const doc = {
              tournamentId: id,
              categoryId,
              round: roundTag,
              status: String(m.status || "").trim() || "Unscheduled",
              scores: {
                game1: { team1: 0, team2: 0 },
                game2: { team1: 0, team2: 0 },
                game3: { team1: 0, team2: 0 },
                final: { team1: 0, team2: 0 },
              },
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              refereeNote: m.refereeNote || undefined,
              signatureData: m.signatureData || undefined,
              gameSignatures: m.gameSignatures || undefined,
              refereeNumber: m.refereeNumber || undefined,
              meta: {
                matchId: String(m.matchId || `G${key}`),
                groupId: groupId,
                matchKey: key,
                mdPairTeam1: Array.isArray(m?.mdPairTeam1) ? m.mdPairTeam1 : undefined,
                mdPairTeam2: Array.isArray(m?.mdPairTeam2) ? m.mdPairTeam2 : undefined,
                wdPairTeam1: Array.isArray(m?.wdPairTeam1) ? m.wdPairTeam1 : undefined,
                wdPairTeam2: Array.isArray(m?.wdPairTeam2) ? m.wdPairTeam2 : undefined,
                mxdPairTeam1: Array.isArray(m?.mxdPairTeam1) ? m.mxdPairTeam1 : undefined,
                mxdPairTeam2: Array.isArray(m?.mxdPairTeam2) ? m.mxdPairTeam2 : undefined,
                teamMemberIdsTeam1: team1Members.length ? team1Members : undefined,
                teamMemberIdsTeam2: team2Members.length ? team2Members : undefined,
              },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
            continue;
          }
          const finals = [m.mdScores?.final, m.wdScores?.final, m.xdScores?.final].filter(Boolean);
          let sum1 = 0, sum2 = 0;
          for (const f of finals) {
            sum1 += Number(f?.team1 || 0);
            sum2 += Number(f?.team2 || 0);
          }
          const filter = { tournamentId: id, categoryId, round: roundTag, team1Id: t1, team2Id: t2 };
          const doc = {
            tournamentId: id,
            categoryId,
            round: roundTag,
            team1Id: t1,
            team2Id: t2,
            status: String(m.status || "").trim() || "Unscheduled",
            scores: {
              game1: { team1: 0, team2: 0 },
              game2: { team1: 0, team2: 0 },
              game3: { team1: 0, team2: 0 },
              final: { team1: sum1, team2: sum2 },
            },
            date: m.date || undefined,
            time: m.time || undefined,
            court: m.court || undefined,
            refereeNote: m.refereeNote || undefined,
            signatureData: m.signatureData || undefined,
            gameSignatures: m.gameSignatures || undefined,
            refereeNumber: m.refereeNumber || undefined,
            meta: {
              matchId: String(m.matchId || `G${key}`),
              groupId: groupId,
              matchKey: key,
              mdPairTeam1: Array.isArray(m?.mdPairTeam1) ? m.mdPairTeam1 : undefined,
              mdPairTeam2: Array.isArray(m?.mdPairTeam2) ? m.mdPairTeam2 : undefined,
              wdPairTeam1: Array.isArray(m?.wdPairTeam1) ? m.wdPairTeam1 : undefined,
              wdPairTeam2: Array.isArray(m?.wdPairTeam2) ? m.wdPairTeam2 : undefined,
              mxdPairTeam1: Array.isArray(m?.mxdPairTeam1) ? m.mxdPairTeam1 : undefined,
              mxdPairTeam2: Array.isArray(m?.mxdPairTeam2) ? m.mxdPairTeam2 : undefined,
              teamMemberIdsTeam1: undefined,
              teamMemberIdsTeam2: undefined,
            },
          };
          await Match.updateOne(filter, { $set: doc }, { upsert: true });
        } else {
          const p1 = makeId(m.player1Id || m.player1);
          const p2 = makeId(m.player2Id || m.player2);
          if (!p1 || !p2) {
            const filter = { tournamentId: id, categoryId, round: roundTag, "meta.groupId": groupId, "meta.matchKey": key };
            const doc = {
              tournamentId: id,
              categoryId,
              round: roundTag,
              player1Name: String(m.player1Name || "").trim() || undefined,
              player2Name: String(m.player2Name || "").trim() || undefined,
              status: String(m.status || "").trim() || "Unscheduled",
              scores: {
                game1: { team1: Number(m.game1Player1 || 0), team2: Number(m.game1Player2 || 0) },
                game2: { team1: Number(m.game2Player1 || 0), team2: Number(m.game2Player2 || 0) },
                game3: { team1: Number(m.game3Player1 || 0), team2: Number(m.game3Player2 || 0) },
                final: { team1: Number(m.finalScorePlayer1 || 0), team2: Number(m.finalScorePlayer2 || 0) },
              },
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              refereeNote: m.refereeNote || undefined,
              signatureData: m.signatureData || undefined,
              gameSignatures: m.gameSignatures || undefined,
              refereeNumber: m.refereeNumber || undefined,
              meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
          } else {
            const filter = { tournamentId: id, categoryId, round: roundTag, player1Id: p1, player2Id: p2 };
            const doc = {
              tournamentId: id,
              categoryId,
              round: roundTag,
              player1Id: p1,
              player2Id: p2,
              player1Name: String(m.player1Name || "").trim() || undefined,
              player2Name: String(m.player2Name || "").trim() || undefined,
              status: String(m.status || "").trim() || "Unscheduled",
              scores: {
                game1: { team1: Number(m.game1Player1 || 0), team2: Number(m.game1Player2 || 0) },
                game2: { team1: Number(m.game2Player1 || 0), team2: Number(m.game2Player2 || 0) },
                game3: { team1: Number(m.game3Player1 || 0), team2: Number(m.game3Player2 || 0) },
                final: { team1: Number(m.finalScorePlayer1 || 0), team2: Number(m.finalScorePlayer2 || 0) },
              },
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              refereeNote: m.refereeNote || undefined,
              signatureData: m.signatureData || undefined,
              gameSignatures: m.gameSignatures || undefined,
              refereeNumber: m.refereeNumber || undefined,
              meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
          }
        }
      }
    } catch (_) {}
    try {
      const Standing = require("../models/Standing");
      const Team = require("../models/Team");
      const arr = Array.isArray(computed) ? computed : [];
      for (const s of arr) {
        const maybeTeam = await Team.findById(s.player).lean();
        const useTeam = !!maybeTeam;
        const filter = useTeam
          ? { tournamentId: id, categoryId, teamId: s.player }
          : { tournamentId: id, categoryId, playerId: s.player };
        const doc = useTeam
          ? {
              tournamentId: id,
              categoryId,
              teamId: s.player,
              wins: s.wins,
              losses: s.losses,
              pointsFor: s.pointsFor,
              pointsAgainst: s.pointsAgainst,
              pointDifferential: s.pointDifferential,
              rankPoints: s.rankPoints,
            }
          : {
              tournamentId: id,
              categoryId,
              playerId: s.player,
              wins: s.wins,
              losses: s.losses,
              pointsFor: s.pointsFor,
              pointsAgainst: s.pointsAgainst,
              pointDifferential: s.pointDifferential,
              rankPoints: s.rankPoints,
            };
        await Standing.updateOne(filter, { $set: doc }, { upsert: true });
      }
    } catch (_) {}
    try {
      if (global.emitTournamentEvent) {
        global.emitTournamentEvent(id, "standings:update", { categoryId, groupId, standings: computed });
      }
    } catch (_) {}
    return res.json({ ok: true, standings: computed, basePlayers });
  } catch (e) {
    console.error('Error recomputing standings:', e);
    return res.status(500).json({ message: 'Server error' });
  }
};
// ✅ Update tournament sponsors (creator or co-host only)
exports.updateTournamentSponsors = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    const { sponsors, sponsorCategories } = req.body;

    if (sponsors !== undefined && !Array.isArray(sponsors)) {
      return res.status(400).json({ message: "Sponsors must be an array" });
    }

    // Basic validation and normalization
    const normalized = Array.isArray(sponsors)
      ? await Promise.all(
          sponsors
            .filter((s) => s && s.name)
            .map(async (s, idx) => {
              const name = String(s.name).trim();
              const rawLogo = (s.logoUrl || s.image || "").toString();
              let logoUrl = rawLogo;
              try {
                if (rawLogo && (rawLogo.startsWith('http://') || rawLogo.startsWith('https://') || rawLogo.startsWith('data:image/'))) {
                  const destPrefix = `tournaments/sponsors/${id}`;
                  logoUrl = await mirrorImageUrlToGCS(rawLogo, destPrefix, `${name}-${idx}`, { stablePath: true });
                }
              } catch (_) {}
              return {
                name,
                logoUrl,
                link: (s.link || "").toString(),
                description: (s.description || "").toString(),
                categoryIndex: s.categoryIndex !== undefined ? Number(s.categoryIndex) : 0,
                position: s.position !== undefined ? Number(s.position) : 1,
              };
            })
        )
      : undefined;

    const tournament = await Tournament.findById(id).select("tournamentCategories createdBy coHosts");
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // Allow superadmins, organizers, or tournament owners/co-hosts
    if (!hasAccessToTournament(tournament, req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    if (normalized !== undefined) {
      tournament.sponsors = normalized;
    }

    if (Array.isArray(sponsorCategories)) {
      tournament.sponsorCategories = sponsorCategories.map((c) => {
        if (typeof c === "string") {
          return { name: String(c).trim(), size: "" };
        }
        const name = String(c?.name || "").trim();
        const size = String(c?.size || "").trim();
        return { name, size };
      });
    }
    await tournament.save();
    // Invalidate cached GET responses for this tournament (details and sponsors)
    invalidateTournamentGetCache(id);

    res.json({
      message: "Sponsors updated",
      sponsors: tournament.sponsors,
      sponsorCategories: tournament.sponsorCategories || [],
    });
  } catch (error) {
    console.error("Error updating tournament sponsors:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Maintenance: Move top-level timeSlots/assignments into venues per day (for existing docs)
exports.normalizeCourtAssignmentVenues = async (req, res) => {
  try {
    const { id } = req.params;
    const dryRun = String(req.query?.dryRun ?? req.body?.dryRun ?? "true") === "true";
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isPrivileged) {
      return res.status(403).json({ message: "Access denied" });
    }
    const tournament = await Tournament.findById(id).select("_id");
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const CourtAssignmentDay = require("../models/CourtAssignmentDay");
    const days = await CourtAssignmentDay.find({ tournamentId: tournament._id }).lean();
    let updated = 0;
    let skipped = 0;
    for (const day of days) {
      const topTs = Array.isArray(day.timeSlots) ? day.timeSlots : [];
      const topAsg = Array.isArray(day.assignments) ? day.assignments : [];
      const venues = Array.isArray(day.venues) ? day.venues.slice() : [];
      const anyVenueHasData = venues.some((v) => (Array.isArray(v.timeSlots) && v.timeSlots.length) || (Array.isArray(v.assignments) && v.assignments.length));
      if (topTs.length === 0 && topAsg.length === 0) {
        skipped += 1;
        continue;
      }
      if (!venues.length) {
        venues.push({
          name: "Venue 1",
          courtCount: Number(day.courtCount || 0),
          timeSlots: topTs,
          assignments: topAsg,
        });
      } else if (!anyVenueHasData) {
        venues[0] = {
          name: String(venues[0]?.name || "Venue 1"),
          courtCount: Number(venues[0]?.courtCount || day.courtCount || 0),
          timeSlots: topTs,
          assignments: topAsg,
        };
      } else {
        if (!dryRun) {
          await CourtAssignmentDay.updateOne(
            { _id: day._id },
            { $unset: { timeSlots: "", assignments: "" } },
          );
        }
        updated += 1;
        continue;
      }
      if (!dryRun) {
        await CourtAssignmentDay.updateOne(
          { _id: day._id },
          { $set: { venues }, $unset: { timeSlots: "", assignments: "" } },
        );
      }
      updated += 1;
    }
    return res.json({ ok: true, dryRun, updated, skipped, total: days.length });
  } catch (e) {
    console.error("Error normalizing court assignments:", e);
    return res.status(500).json({ message: "Server error" });
  }
};
// ✅ Get all tournaments
exports.getTournaments = async (req, res) => {
  try {
    const __start = process.hrtime.bigint();
    const includeRegistrations = String(req.query.includeRegistrations || "false").toLowerCase() === "true";
    const includeAssets = req.query.includeAssets !== 'false';
    const { page, limit, skip } = parsePagination(req.query, { limit: 20, maxLimit: 100 });
    const [total, latestTournament] = await Promise.all([
      Tournament.countDocuments(),
      Tournament.findOne().sort({ updatedAt: -1 }).select("updatedAt").lean(),
    ]);
    const responseEtag = buildWeakEtag([
      "tournaments",
      total,
      latestTournament?.updatedAt ? new Date(latestTournament.updatedAt).getTime() : 0,
      includeRegistrations ? "1" : "0",
      includeAssets ? "1" : "0",
      page,
      limit,
    ]);
    res.setHeader("ETag", responseEtag);
    if (String(req.headers["if-none-match"] || "").trim() === responseEtag) {
      return res.status(304).end();
    }
    const query = Tournament.find().sort({ createdAt: -1 }).skip(skip).limit(limit);
    if (!includeRegistrations) {
      query.select("-registrations");
    }
    if (!includeAssets) {
      query.select("-guidelinePictures -schedulePictures");
    }
    const tournaments = await query
      .populate({
        path: "coHosts",
        select: "firstName lastName email",
        options: { lean: true },
      })
      .lean();

    if (includeRegistrations) {
      for (const t of tournaments) {
        if (t.migratedRegistrations) {
          const regs = await Registration.find({ tournamentId: t._id })
            .populate({
              path: "playerId",
              select: "firstName lastName birthDate gender duprRatings pplId duprId",
              options: { lean: true },
            })
            .populate({
              path: "partnerId",
              select: "firstName lastName birthDate gender duprRatings pplId duprId",
              options: { lean: true },
            })
            .populate({
              path: "teamMembers",
              select: "firstName lastName birthDate gender duprRatings pplId duprId",
              options: { lean: true },
            })
            .lean();
          const normalized = regs.map((r) => ({
            _id: r._id,
            player: r.playerId || null,
            partner: r.partnerId || null,
            teamMembers: Array.isArray(r.teamMembers) ? r.teamMembers : [],
            category: r.categoryId || r.category,
            proofOfPayment: r.proofOfPayment || [],
            contactNumber: r.contactNumber || null,
            email: r.email || null,
            playerName: r.playerName || null,
            playerEmail: r.playerEmail || null,
            playerPhone: r.playerPhone || null,
            emergencyContact: r.emergencyContact || null,
            emergencyPhone: r.emergencyPhone || null,
            shirtSize: r.shirtSize || null,
            teamName: r.teamName || null,
            notes: r.notes || null,
            registrationDate: r.registrationDate || null,
            status: r.status || "pending",
            waitlist: !!r.waitlist,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
          }));
          t.registrations = normalized.map((r) => {
            if (r.player && r.player.birthDate) {
              const today = new Date();
              const birth = new Date(r.player.birthDate);
              let age = today.getFullYear() - birth.getFullYear();
              const monthDiff = today.getMonth() - birth.getMonth();
              if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
                age--;
              }
              r.player.age = age;
            } else if (r.player) {
              r.player.age = null;
            }
            return r;
          });
          try {
            t.registrations = await Promise.all(
              t.registrations.map(async (r) => {
                if (r && r.proofOfPayment) {
                  try {
                    if (Array.isArray(r.proofOfPayment)) {
                      const arr = r.proofOfPayment.slice(0, 2);
                      r.proofOfPaymentSignedUrls = await Promise.all(
                        arr.map(async (u) => {
                          try {
                            return await getSignedUrlFromAny(u);
                          } catch (_) {
                            return u;
                          }
                        }),
                      );
                    } else if (typeof r.proofOfPayment === "string") {
                      r.proofOfPaymentSignedUrl = await getSignedUrlFromAny(r.proofOfPayment);
                    }
                  } catch (_) {}
                }
                return r;
              }),
            );
          } catch (_) {}
        } else {
          const regs = Array.isArray(t.registrations) ? t.registrations : [];
          t.registrations = regs.map((r) => {
            if (r.player && r.player.birthDate) {
              const today = new Date();
              const birth = new Date(r.player.birthDate);
              let age = today.getFullYear() - birth.getFullYear();
              const monthDiff = today.getMonth() - birth.getMonth();
              if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
                age--;
              }
              r.player.age = age;
            } else if (r.player) {
              r.player.age = null;
            }
            return r;
          });
        }
      }
    }

    // Always resolve/sign tournament picture so list views can render banners even when includeAssets=false.
    // Other heavy assets (guidelines/schedules/payment method QR) are still controlled by includeAssets.
    try {
      await Promise.all(
        tournaments.map(async (t) => {
          if (t.tournamentPicture) {
            try {
              // Prefer a longer-lived signed URL for banners to reduce broken images due to expiry.
              // Use v2 for >7 days (v4 has a shorter maximum validity window).
              const ttlSeconds = 365 * 24 * 60 * 60;
              t.tournamentPicture = await getSignedUrlFromAny(t.tournamentPicture, ttlSeconds, "v2");
            } catch (_) {}
          }
          return t;
        }),
      );
    } catch (_) {}

    if (includeAssets) {
      try {
        await Promise.all(
          tournaments.map(async (t) => {
            if (Array.isArray(t.guidelinePictures)) {
              try {
                t.guidelinePictures = await Promise.all(
                  t.guidelinePictures.map(async (url) => {
                    try {
                      return await getSignedUrlFromAny(url);
                    } catch (_) {
                      return url;
                    }
                  })
                );
              } catch (_) {}
            }
            if (Array.isArray(t.schedulePictures)) {
              try {
                t.schedulePictures = await Promise.all(
                  t.schedulePictures.map(async (url) => {
                    try {
                      return await getSignedUrlFromAny(url);
                    } catch (_) {
                      return url;
                    }
                  })
                );
              } catch (_) {}
            }
            if (Array.isArray(t.paymentMethods)) {
              await Promise.all(
                t.paymentMethods.map(async (pm) => {
                  if (pm && pm.qrCodeImage) {
                    try {
                      pm.qrCodeImage = await getSignedUrlFromAny(pm.qrCodeImage);
                    } catch (_) {}
                  }
                  return pm;
                }),
              );
            }
            return t;
          }),
        );
      } catch (_) {}
    }

    const __end = process.hrtime.bigint();
    const __durationMs = Number(__end - __start) / 1e6;
    const pagination = buildPaginationMeta({ page, limit, total });
    res.setHeader("X-Pagination-Page", String(pagination.page));
    res.setHeader("X-Pagination-Limit", String(pagination.limit));
    res.setHeader("X-Pagination-Total", String(pagination.totalItems));
    if (String(req.query.withMeta || "").trim() === "1") {
      return res.json({ tournaments, pagination });
    }
    res.json(tournaments);
  } catch (error) {
    console.error("Error fetching tournaments:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

exports.syncMatchesAndStandingsForTournament = async (req, res) => {
  try {
    const { id } = req.params;
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isPrivileged) {
      return res.status(403).json({ message: "Access denied" });
    }
    const tournament = await Tournament.findById(id).select("tournamentCategories");
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const Standing = require("../models/Standing");
    const Match = require("../models/Match");
    const Team = require("../models/Team");
    let matchUpserts = 0;
    let standingUpserts = 0;
    const makeId = (val) => {
      const s = String(val || "").trim();
      return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
    };
    for (const cat of categories) {
      const catId = String(cat?._id || "");
      if (!catId) continue;
      const groups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
      for (const group of groups) {
        const groupId = String(group?.id || "");
        if (!groupId) continue;
        const matchesObj = (group && typeof group.matches === "object") ? group.matches : {};
        const keys = Array.isArray(matchesObj) ? matchesObj.map((_, idx) => String(idx + 1)) : Object.keys(matchesObj);
        const roundTag = (() => {
          const nm = String(group?.name || '').trim();
          if (nm) return nm;
          try {
            const letter = String(groupId || '').split('-').pop().toUpperCase();
            if (letter) return `Group ${letter}`;
          } catch {}
          return `G${groupId}`;
        })();
        for (const key of keys) {
          const m = Array.isArray(matchesObj) ? matchesObj[parseInt(key) - 1] || {} : (matchesObj[key] || {});
          const isTeam = !!(m.team1Id && m.team2Id);
          if (isTeam) {
            const t1 = makeId(m.team1Id);
            const t2 = makeId(m.team2Id);
            if (!t1 || !t2) {
          const filter = { tournamentId: id, categoryId: catId, round: roundTag, "meta.groupId": groupId, "meta.matchKey": key };
              const doc = {
                tournamentId: id,
                categoryId: catId,
                round: roundTag,
            stage: "group",
            groupId: groupId,
            matchKey: key,
            gamesPerMatch: Number(cat?.gamesPerMatch || 1),
                status: String(m.status || "").trim() || "Unscheduled",
                scores: {
                  game1: { team1: 0, team2: 0 },
                  game2: { team1: 0, team2: 0 },
                  game3: { team1: 0, team2: 0 },
                  final: { team1: 0, team2: 0 },
                },
                date: m.date || undefined,
                time: m.time || undefined,
                court: m.court || undefined,
                refereeNote: m.refereeNote || undefined,
                signatureData: m.signatureData || undefined,
                gameSignatures: m.gameSignatures || undefined,
                refereeNumber: m.refereeNumber || undefined,
                meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
              };
              await Match.updateOne(filter, { $set: doc }, { upsert: true });
              matchUpserts += 1;
              continue;
            }
            const finals = [m.mdScores?.final, m.wdScores?.final, m.xdScores?.final].filter(Boolean);
            let sum1 = 0, sum2 = 0;
            for (const f of finals) {
              sum1 += Number(f?.team1 || 0);
              sum2 += Number(f?.team2 || 0);
            }
        const filter = { tournamentId: id, categoryId: catId, round: roundTag, team1Id: t1, team2Id: t2 };
        let team1Members = [];
        let team2Members = [];
        try {
          const tdoc1 = await Team.findById(t1).select("playerIds").lean();
          const tdoc2 = await Team.findById(t2).select("playerIds").lean();
          team1Members = Array.isArray(tdoc1?.playerIds) ? tdoc1.playerIds.map(String) : [];
          team2Members = Array.isArray(tdoc2?.playerIds) ? tdoc2.playerIds.map(String) : [];
        } catch (_) {}
            const doc = {
              tournamentId: id,
              categoryId: catId,
              round: roundTag,
          stage: "group",
          groupId: groupId,
          matchKey: key,
          gamesPerMatch: Number(cat?.gamesPerMatch || 1),
              team1Id: t1,
              team2Id: t2,
          team1Members: team1Members.length ? team1Members : undefined,
          team2Members: team2Members.length ? team2Members : undefined,
              status: String(m.status || "").trim() || "Unscheduled",
              scores: {
                game1: { team1: 0, team2: 0 },
                game2: { team1: 0, team2: 0 },
                game3: { team1: 0, team2: 0 },
                final: { team1: sum1, team2: sum2 },
              },
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              refereeNote: m.refereeNote || undefined,
              signatureData: m.signatureData || undefined,
              gameSignatures: m.gameSignatures || undefined,
              refereeNumber: m.refereeNumber || undefined,
              meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
            matchUpserts += 1;
          } else {
            const p1 = makeId(m.player1Id || m.player1);
            const p2 = makeId(m.player2Id || m.player2);
            if (!p1 || !p2) {
              const filter = { tournamentId: id, categoryId: catId, round: roundTag, "meta.groupId": groupId, "meta.matchKey": key };
              const doc = {
                tournamentId: id,
                categoryId: catId,
                round: roundTag,
            stage: "group",
            groupId: groupId,
            matchKey: key,
            gamesPerMatch: Number(cat?.gamesPerMatch || 1),
                player1Name: String(m.player1Name || "").trim() || undefined,
                player2Name: String(m.player2Name || "").trim() || undefined,
                status: String(m.status || "").trim() || "Unscheduled",
                scores: {
                  game1: { team1: Number(m.game1Player1 || 0), team2: Number(m.game1Player2 || 0) },
                  game2: { team1: Number(m.game2Player1 || 0), team2: Number(m.game2Player2 || 0) },
                  game3: { team1: Number(m.game3Player1 || 0), team2: Number(m.game3Player2 || 0) },
                  final: { team1: Number(m.finalScorePlayer1 || 0), team2: Number(m.finalScorePlayer2 || 0) },
                },
                date: m.date || undefined,
                time: m.time || undefined,
                court: m.court || undefined,
                refereeNote: m.refereeNote || undefined,
                signatureData: m.signatureData || undefined,
                gameSignatures: m.gameSignatures || undefined,
                refereeNumber: m.refereeNumber || undefined,
                meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
              };
              await Match.updateOne(filter, { $set: doc }, { upsert: true });
              matchUpserts += 1;
            } else {
              const filter = { tournamentId: id, categoryId: catId, round: roundTag, player1Id: p1, player2Id: p2 };
              const doc = {
                tournamentId: id,
                categoryId: catId,
                round: roundTag,
            stage: "group",
            groupId: groupId,
            matchKey: key,
            gamesPerMatch: Number(cat?.gamesPerMatch || 1),
                player1Id: p1,
                player2Id: p2,
                player1Name: String(m.player1Name || "").trim() || undefined,
                player2Name: String(m.player2Name || "").trim() || undefined,
                status: String(m.status || "").trim() || "Unscheduled",
                scores: {
                  game1: { team1: Number(m.game1Player1 || 0), team2: Number(m.game1Player2 || 0) },
                  game2: { team1: Number(m.game2Player1 || 0), team2: Number(m.game2Player2 || 0) },
                  game3: { team1: Number(m.game3Player1 || 0), team2: Number(m.game3Player2 || 0) },
                  final: { team1: Number(m.finalScorePlayer1 || 0), team2: Number(m.finalScorePlayer2 || 0) },
                },
                date: m.date || undefined,
                time: m.time || undefined,
                court: m.court || undefined,
                refereeNote: m.refereeNote || undefined,
                signatureData: m.signatureData || undefined,
                gameSignatures: m.gameSignatures || undefined,
                refereeNumber: m.refereeNumber || undefined,
                meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
              };
              await Match.updateOne(filter, { $set: doc }, { upsert: true });
              matchUpserts += 1;
            }
          }
        }
        const keysChanged = Array.isArray(keys) ? keys : [];
        const computed = computeIncremental(group, keysChanged);
        const arr = Array.isArray(computed) ? computed : [];
        for (const s of arr) {
          const pid = makeId(s.player);
          let filter;
          let doc;
          if (pid) {
            filter = { tournamentId: id, categoryId: catId, playerId: pid };
            doc = {
              tournamentId: id,
              categoryId: catId,
              playerId: pid,
              wins: s.wins,
              losses: s.losses,
              pointsFor: s.pointsFor,
              pointsAgainst: s.pointsAgainst,
              pointDifferential: s.pointDifferential,
              rankPoints: s.rankPoints,
              meta: { playerKey: String(s.player) },
            };
          } else {
            let maybeTeam = null;
            try { maybeTeam = await Team.findById(s.player).lean(); } catch (_) {}
            if (maybeTeam && maybeTeam._id) {
              filter = { tournamentId: id, categoryId: catId, teamId: String(maybeTeam._id) };
              doc = {
                tournamentId: id,
                categoryId: catId,
                teamId: String(maybeTeam._id),
                teamName: maybeTeam.name || undefined,
                wins: s.wins,
                losses: s.losses,
                pointsFor: s.pointsFor,
                pointsAgainst: s.pointsAgainst,
                pointDifferential: s.pointDifferential,
                rankPoints: s.rankPoints,
                meta: { playerKey: String(s.player) },
              };
            } else {
              filter = { tournamentId: id, categoryId: catId, "meta.playerKey": String(s.player) };
              doc = {
                tournamentId: id,
                categoryId: catId,
                displayName: String(s.player),
                wins: s.wins,
                losses: s.losses,
                pointsFor: s.pointsFor,
                pointsAgainst: s.pointsAgainst,
                pointDifferential: s.pointDifferential,
                rankPoints: s.rankPoints,
                meta: { playerKey: String(s.player) },
              };
            }
          }
          await Standing.updateOne(filter, { $set: doc }, { upsert: true });
          standingUpserts += 1;
        }
      }
      // Process elimination matches
      const eliminationMatches = Array.isArray(cat?.eliminationMatches?.matches) ? cat.eliminationMatches.matches : [];
      for (let i = 0; i < eliminationMatches.length; i++) {
        const m = eliminationMatches[i] || {};
        const matchKey = `e-${i}`;
        // Get round info
        const round = String(m.round || m.meta?.round || `Elimination ${i+1}`).trim();
        const isTeam = !!(m.team1Id && m.team2Id);
        if (isTeam) {
          const t1 = makeId(m.team1Id);
          const t2 = makeId(m.team2Id);
          let team1Members = [];
          let team2Members = [];
          try {
            const tdoc1 = t1 ? await Team.findById(t1).select("playerIds").lean() : null;
            const tdoc2 = t2 ? await Team.findById(t2).select("playerIds").lean() : null;
            team1Members = Array.isArray(tdoc1?.playerIds) ? tdoc1.playerIds.map(String) : [];
            team2Members = Array.isArray(tdoc2?.playerIds) ? tdoc2.playerIds.map(String) : [];
          } catch (_) {}
          const filter = t1 && t2 
            ? { tournamentId: id, categoryId: catId, round: round, team1Id: t1, team2Id: t2 } 
            : { tournamentId: id, categoryId: catId, round: round, "meta.matchKey": matchKey };
          const doc = {
            tournamentId: id,
            categoryId: catId,
            round: round,
            stage: "elimination",
            matchKey: matchKey,
            gamesPerMatch: Number(m.gamesPerMatch || cat?.eliminationGpm?.[i] || cat?.gamesPerMatch || 1),
            team1Id: t1 || undefined,
            team2Id: t2 || undefined,
            team1Name: String(m.team1Name || m.player1Name || "").trim() || undefined,
            team2Name: String(m.team2Name || m.player2Name || "").trim() || undefined,
            team1Members: team1Members.length ? team1Members : undefined,
            team2Members: team2Members.length ? team2Members : undefined,
            player1Name: String(m.player1Name || "").trim() || undefined,
            player2Name: String(m.player2Name || "").trim() || undefined,
            player1Id: makeId(m.player1Id || m.player1) || undefined,
            player2Id: makeId(m.player2Id || m.player2) || undefined,
            status: String(m.status || "").trim() || "Unscheduled",
            scores: {
              game1: { team1: Number(m.game1Player1 || m.mdScores?.game1?.team1 || 0), team2: Number(m.game1Player2 || m.mdScores?.game1?.team2 || 0) },
              game2: { team1: Number(m.game2Player1 || m.mdScores?.game2?.team1 || 0), team2: Number(m.game2Player2 || m.mdScores?.game2?.team2 || 0) },
              game3: { team1: Number(m.game3Player1 || m.mdScores?.game3?.team1 || 0), team2: Number(m.game3Player2 || m.mdScores?.game3?.team2 || 0) },
              final: { team1: Number(m.finalScorePlayer1 || m.mdScores?.final?.team1 || 0), team2: Number(m.finalScorePlayer2 || m.mdScores?.final?.team2 || 0) },
            },
            date: m.date || undefined,
            time: m.time || undefined,
            court: m.court || undefined,
            refereeNote: m.refereeNote || undefined,
            signatureData: m.signatureData || undefined,
            gameSignatures: m.gameSignatures || undefined,
            refereeNumber: m.refereeNumber || undefined,
            meta: { matchId: String(m.matchId || matchKey), matchKey: matchKey },
          };
          await Match.updateOne(filter, { $set: doc }, { upsert: true });
          matchUpserts += 1;
        } else {
          const p1 = makeId(m.player1Id || m.player1);
          const p2 = makeId(m.player2Id || m.player2);
          const filter = p1 && p2 
            ? { tournamentId: id, categoryId: catId, round: round, player1Id: p1, player2Id: p2 } 
            : { tournamentId: id, categoryId: catId, round: round, "meta.matchKey": matchKey };
          const doc = {
            tournamentId: id,
            categoryId: catId,
            round: round,
            stage: "elimination",
            matchKey: matchKey,
            gamesPerMatch: Number(m.gamesPerMatch || cat?.eliminationGpm?.[i] || cat?.gamesPerMatch || 1),
            player1Name: String(m.player1Name || "").trim() || undefined,
            player2Name: String(m.player2Name || "").trim() || undefined,
            player1Id: p1 || undefined,
            player2Id: p2 || undefined,
            team1Name: String(m.team1Name || "").trim() || undefined,
            team2Name: String(m.team2Name || "").trim() || undefined,
            status: String(m.status || "").trim() || "Unscheduled",
            scores: {
              game1: { team1: Number(m.game1Player1 || m.mdScores?.game1?.team1 || 0), team2: Number(m.game1Player2 || m.mdScores?.game1?.team2 || 0) },
              game2: { team1: Number(m.game2Player1 || m.mdScores?.game2?.team1 || 0), team2: Number(m.game2Player2 || m.mdScores?.game2?.team2 || 0) },
              game3: { team1: Number(m.game3Player1 || m.mdScores?.game3?.team1 || 0), team2: Number(m.game3Player2 || m.mdScores?.game3?.team2 || 0) },
              final: { team1: Number(m.finalScorePlayer1 || m.mdScores?.final?.team1 || 0), team2: Number(m.finalScorePlayer2 || m.mdScores?.final?.team2 || 0) },
            },
            date: m.date || undefined,
            time: m.time || undefined,
            court: m.court || undefined,
            refereeNote: m.refereeNote || undefined,
            signatureData: m.signatureData || undefined,
            gameSignatures: m.gameSignatures || undefined,
            refereeNumber: m.refereeNumber || undefined,
            meta: { matchId: String(m.matchId || matchKey), matchKey: matchKey },
          };
          await Match.updateOne(filter, { $set: doc }, { upsert: true });
          matchUpserts += 1;
        }
      }
    }
    return res.json({ ok: true, matches: matchUpserts, standings: standingUpserts });
  } catch (e) {
    return res.status(500).json({ message: "Server error" });
  }
};
// ✅ Get user's registrations for a specific tournament
exports.getUserRegistrationsForTournament = async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const userId = req.user.id;

    const flagDoc = await Tournament.findById(tournamentId).select("migratedRegistrations").lean();
    if (!flagDoc) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    if (flagDoc.migratedRegistrations) {
      const regs = await Registration.find({
        tournamentId,
        $or: [{ playerId: userId }, { partnerId: userId }, { teamMembers: userId }],
      })
        .populate({
          path: "playerId",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .populate({
          path: "partnerId",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .populate({
          path: "teamMembers",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .lean();

      const normalized = regs.map((r) => ({
        _id: r._id,
        player: r.playerId || null,
        partner: r.partnerId || null,
        teamMembers: Array.isArray(r.teamMembers) ? r.teamMembers : [],
        category: r.categoryId || r.category,
        proofOfPayment: r.proofOfPayment || [],
        contactNumber: r.contactNumber || null,
        email: r.email || null,
        playerName: r.playerName || null,
        playerEmail: r.playerEmail || null,
        playerPhone: r.playerPhone || null,
        emergencyContact: r.emergencyContact || null,
        emergencyPhone: r.emergencyPhone || null,
        shirtSize: r.shirtSize || null,
        teamName: r.teamName || null,
        notes: r.notes || null,
        registrationDate: r.registrationDate || null,
        status: r.status || "pending",
        waitlist: !!r.waitlist,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

      const withAge = normalized.map((r) => {
        if (r.player && r.player.birthDate) {
          const today = new Date();
          const birth = new Date(r.player.birthDate);
          let age = today.getFullYear() - birth.getFullYear();
          const monthDiff = today.getMonth() - birth.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
            age--;
          }
          r.player.age = age;
        } else if (r.player) {
          r.player.age = null;
        }
        return r;
      });

      let signed = withAge;
      try {
        signed = await Promise.all(
          withAge.map(async (r) => {
            if (r && r.proofOfPayment) {
              try {
                if (Array.isArray(r.proofOfPayment)) {
                  const arr = r.proofOfPayment.slice(0, 2);
                  r.proofOfPaymentSignedUrls = await Promise.all(
                    arr.map(async (u) => {
                      try {
                        return await getSignedUrlFromAny(u);
                      } catch (_) {
                        return u;
                      }
                    }),
                  );
                } else if (typeof r.proofOfPayment === "string") {
                  r.proofOfPaymentSignedUrl = await getSignedUrlFromAny(r.proofOfPayment);
                }
              } catch (_) {}
            }
            return r;
          }),
        );
      } catch (_) {}

      return res.json({ registrations: signed });
    }

    const tournament = await Tournament.findById(tournamentId).select("registrations").lean();
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }
    const userRegistrations = (tournament.registrations || []).filter(
      (registration) =>
        String(registration.player) === String(userId) ||
        (registration.partner && String(registration.partner) === String(userId)) ||
        (registration.teamMembers &&
          Array.isArray(registration.teamMembers) &&
          registration.teamMembers.some((memberId) => String(memberId) === String(userId))),
    );
    res.json({ registrations: userRegistrations });
  } catch (error) {
    console.error("❌ Error getting user registrations:", error.message);
    console.error("❌ Full error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.dedupNormalizedForTournament = async (req, res) => {
  try {
    const { id } = req.params;
    const dryRun = String(req.query.dry || req.body?.dryRun || "false").toLowerCase() === "true";
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isPrivileged) {
      return res.status(403).json({ message: "Access denied" });
    }
    const Tournament = require("../models/Tournament");
    const Match = require("../models/Match");
    const Standing = require("../models/Standing");
    const Registration = require("../models/Registration");
    const Team = require("../models/Team");
    const t = await Tournament.findById(id).select("_id");
    if (!t) return res.status(404).json({ message: "Tournament not found" });
    const toStr = (v) => (v ? String(v) : "");
    const matchKey = (m) => {
      const base = `${toStr(m.categoryId)}:${toStr(m.round)}`;
      if (m.team1Id && m.team2Id) return `${base}:${toStr(m.team1Id)}:${toStr(m.team2Id)}`;
      if (m.player1Id && m.player2Id) return `${base}:${toStr(m.player1Id)}:${toStr(m.player2Id)}`;
      const p1 = toStr(m.player1Name).toLowerCase().trim();
      const p2 = toStr(m.player2Name).toLowerCase().trim();
      return `${base}:${p1}:${p2}`;
    };
    const nameKey = (s) => String(s.displayName || s.teamName || "").toLowerCase().trim();
    const standingKey = (s) => {
      const cid = toStr(s.categoryId);
      const tid = toStr(s.teamId);
      const nk = nameKey(s);
      return tid ? `${cid}:${tid}` : `${cid}:name:${nk}`;
    };
    const groupByKey = (arr, keyFn) => {
      const map = new Map();
      for (const x of arr) {
        const k = keyFn(x);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(x);
      }
      return map;
    };
    const dedupMatches = async (tid, dry) => {
      const docs = await Match.find({ tournamentId: tid }).lean();
      const groups = groupByKey(docs, matchKey);
      let removeIds = [];
      for (const [, list] of groups.entries()) {
        if (list.length <= 1) continue;
        const sorted = list.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        const rm = sorted.slice(1).map((x) => x._id).filter(Boolean);
        removeIds = removeIds.concat(rm);
      }
      for (const m of docs) {
        const sameTeam = m.team1Id && m.team2Id && String(m.team1Id) === String(m.team2Id);
        const samePlayer = m.player1Id && m.player2Id && String(m.player1Id) === String(m.player2Id);
        const sameNameOnly =
          !m.team1Id &&
          !m.team2Id &&
          (!m.player1Id || !m.player2Id) &&
          (String(m.player1Name || "").toLowerCase().trim() === String(m.player2Name || "").toLowerCase().trim()) &&
          String(m.player1Name || m.player2Name || "").trim() !== "";
        if (sameTeam || samePlayer || sameNameOnly) removeIds.push(m._id);
      }
      if (!dry && removeIds.length) await Match.deleteMany({ _id: { $in: removeIds } });
      return { scanned: docs.length, groups: groups.size, duplicates: removeIds.length, removed: dry ? 0 : removeIds.length };
    };
    const dedupStandings = async (tid, dry) => {
      const docs = await Standing.find({ tournamentId: tid }).lean();
      const groups = groupByKey(docs, standingKey);
      let removeIds = [];
      for (const [, list] of groups.entries()) {
        if (list.length <= 1) continue;
        const sorted = list.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        const rm = sorted.slice(1).map((x) => x._id).filter(Boolean);
        removeIds = removeIds.concat(rm);
      }
      const keyScore = (s) =>
        `${String(s.wins || 0)}:${String(s.losses || 0)}:${String(s.pointsFor || 0)}:${String(s.pointsAgainst || 0)}:${String(s.rankPoints || 0)}`;
      const byCombo = groupByKey(docs, (s) => `${standingKey(s)}:${keyScore(s)}`);
      for (const [, list] of byCombo.entries()) {
        if (list.length > 1) {
          const sorted = list.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
          const rm = sorted.slice(1).map((x) => x._id).filter(Boolean);
          removeIds = removeIds.concat(rm);
        }
      }
      const byName = groupByKey(docs, (s) => `${toStr(s.categoryId)}:name:${nameKey(s)}`);
      for (const [, list] of byName.entries()) {
        const valid = list.filter((x) => nameKey(x));
        if (valid.length > 1) {
          const sorted = valid.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
          const rm = sorted.slice(1).map((x) => x._id).filter(Boolean);
          removeIds = removeIds.concat(rm);
        }
      }
      if (!dry && removeIds.length) await Standing.deleteMany({ _id: { $in: removeIds } });
      return { scanned: docs.length, groups: groups.size, duplicates: removeIds.length, removed: dry ? 0 : removeIds.length };
    };
    const regKey = (r) => {
      const members = Array.isArray(r.teamMembers) ? r.teamMembers.map(String).sort().join(",") : "";
      return `${toStr(r.categoryId)}:${toStr(r.playerId)}:${toStr(r.partnerId)}:${members}`;
    };
    const dedupRegistrations = async (tid, dry) => {
      const docs = await Registration.find({ tournamentId: tid }).lean();
      const groups = groupByKey(docs, regKey);
      let removeIds = [];
      for (const [, list] of groups.entries()) {
        if (list.length <= 1) continue;
        const sorted = list.slice().sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
        const rm = sorted.slice(1).map((x) => x._id).filter(Boolean);
        removeIds = removeIds.concat(rm);
      }
      if (!dry && removeIds.length) await Registration.deleteMany({ _id: { $in: removeIds } });
      return { scanned: docs.length, groups: groups.size, duplicates: removeIds.length, removed: dry ? 0 : removeIds.length };
    };
    const dedupTeams = async (tid, dry) => {
      const teams = await Team.find({ tournamentId: tid }).lean();
      const refsM = await Match.find({ tournamentId: tid }, { team1Id: 1, team2Id: 1 }).lean();
      const refsS = await Standing.find({ tournamentId: tid }, { teamId: 1 }).lean();
      const refSet = new Set();
      for (const m of refsM) {
        if (m.team1Id) refSet.add(String(m.team1Id));
        if (m.team2Id) refSet.add(String(m.team2Id));
      }
      for (const s of refsS) {
        if (s.teamId) refSet.add(String(s.teamId));
      }
      const keyFor = (t) => `${toStr(t.categoryId)}:${(Array.isArray(t.playerIds) ? t.playerIds.map(String).sort().join(",") : "")}`;
      const groups = groupByKey(teams, keyFor);
      let removed = 0;
      for (const [, list] of groups.entries()) {
        if (list.length <= 1) continue;
        const sorted = list.slice().sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
        const keeper = sorted[0];
        const rest = sorted.slice(1);
        for (const dup of rest) {
          const idStr = String(dup._id);
          if (!dry) {
            if (refSet.has(idStr)) {
              await Match.updateMany({ tournamentId: tid, team1Id: dup._id }, { $set: { team1Id: keeper._id } });
              await Match.updateMany({ tournamentId: tid, team2Id: dup._id }, { $set: { team2Id: keeper._id } });
              await Standing.updateMany({ tournamentId: tid, teamId: dup._id }, { $set: { teamId: keeper._id } });
            }
            await Team.deleteOne({ _id: dup._id });
          }
          removed += 1;
        }
      }
      return { scanned: teams.length, groups: groups.size, duplicates: removed, removed: dry ? 0 : removed };
    };
    const result = {
      matches: await dedupMatches(String(id), dryRun),
      standings: await dedupStandings(String(id), dryRun),
      registrations: await dedupRegistrations(String(id), dryRun),
      teams: await dedupTeams(String(id), dryRun),
      dryRun,
    };
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ message: "Server error" });
  }
};

// ✅ Get single tournament by ID
exports.getTournamentById = async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const includeRegistrations = req.query.includeRegistrations !== "false";
    const includeAssets = req.query.includeAssets !== "false";
    const includeComputed = req.query.includeComputed !== "false";
    const regPageRaw = Number(req.query.regPage || req.query.page || 1);
    const regLimitRaw = Number(req.query.regLimit || req.query.pageSize || 100);
    const regPage = Number.isFinite(regPageRaw) && regPageRaw > 0 ? Math.floor(regPageRaw) : 1;
    const regLimit = Number.isFinite(regLimitRaw) && regLimitRaw > 0 ? Math.min(Math.floor(regLimitRaw), 200) : 100;

    // ✅ Fallback for dummy tournament data (PPL MMC doesn't use database)
    // Check if tournament ID starts with "dummy-" to avoid ObjectId casting error
    if (tournamentId && tournamentId.startsWith("dummy-")) {
      return res.status(404).json({ 
        message: "Tournament not found",
        isDummy: true,
        note: "This is a dummy tournament. Please use the tournament data from the frontend."
      });
    }

    const flagDoc = await Tournament.findById(tournamentId)
      .select("migratedRegistrations updatedAt")
      .lean();
    if (!flagDoc) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    let latestMatchUpdatedAtMs = 0;
    if (includeComputed) {
      try {
        const latestMatch = await Match.findOne({ tournamentId })
          .sort({ updatedAt: -1 })
          .select("updatedAt")
          .lean();
        latestMatchUpdatedAtMs = latestMatch?.updatedAt
          ? new Date(latestMatch.updatedAt).getTime()
          : 0;
      } catch (_) {}
    }
    const responseEtag = buildWeakEtag([
      tournamentId,
      flagDoc.updatedAt ? new Date(flagDoc.updatedAt).getTime() : 0,
      latestMatchUpdatedAtMs,
      includeRegistrations ? "1" : "0",
      includeAssets ? "1" : "0",
      includeComputed ? "1" : "0",
      regPage,
      regLimit,
      String(req.query.scheduleDate || ""),
    ]);
    res.setHeader("ETag", responseEtag);
    if (String(req.headers["if-none-match"] || "").trim() === responseEtag) {
      return res.status(304).end();
    }

    let tournament;
    if (flagDoc.migratedRegistrations) {
      const query = Tournament.findById(tournamentId)
        .select(includeRegistrations ? undefined : "-registrations")
        .populate({
          path: "coHosts",
          select: "firstName lastName email",
          options: { lean: true },
        });
      if (!includeAssets) query.select("-guidelinePictures -schedulePictures -paymentMethods");
      tournament = await query.lean();
    } else {
      const query = Tournament.findById(tournamentId).populate({
        path: "coHosts",
        select: "firstName lastName email",
        options: { lean: true },
      });
      if (includeRegistrations) {
        query
          .populate({
            path: "registrations.player",
            select: "firstName lastName birthDate gender duprRatings pplId duprId",
            options: { lean: true },
          })
          .populate({
            path: "registrations.partner",
            select: "firstName lastName birthDate gender duprRatings pplId duprId",
            options: { lean: true },
          })
          .populate({
            path: "registrations.teamMembers",
            select: "firstName lastName birthDate gender duprRatings pplId duprId",
            options: { lean: true },
          });
      } else {
        query.select("-registrations");
      }
      if (!includeAssets) query.select("-guidelinePictures -schedulePictures -paymentMethods");
      tournament = await query.lean();
    }

    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // removed debug fetch log

    if (includeRegistrations && flagDoc.migratedRegistrations) {
      const registrationFilter = { tournamentId: tournament._id };
      const [regs, totalRegs] = await Promise.all([
        Registration.find(registrationFilter)
          .sort({ createdAt: -1 })
          .skip((regPage - 1) * regLimit)
          .limit(regLimit)
          .populate({
            path: "playerId",
            select: "firstName lastName birthDate gender duprRatings pplId duprId",
            options: { lean: true },
          })
          .populate({
            path: "partnerId",
            select: "firstName lastName birthDate gender duprRatings pplId duprId",
            options: { lean: true },
          })
          .populate({
            path: "teamMembers",
            select: "firstName lastName birthDate gender duprRatings pplId duprId",
            options: { lean: true },
          })
          .lean(),
        Registration.countDocuments(registrationFilter),
      ]);
      const normalized = regs.map((r) => ({
        _id: r._id,
        player: r.playerId || null,
        partner: r.partnerId || null,
        teamMembers: Array.isArray(r.teamMembers) ? r.teamMembers : [],
        category: r.categoryId || r.category,
        proofOfPayment: r.proofOfPayment || [],
        contactNumber: r.contactNumber || null,
        email: r.email || null,
        playerName: r.playerName || null,
        playerEmail: r.playerEmail || null,
        playerPhone: r.playerPhone || null,
        emergencyContact: r.emergencyContact || null,
        emergencyPhone: r.emergencyPhone || null,
        shirtSize: r.shirtSize || null,
        teamName: r.teamName || null,
        notes: r.notes || null,
        registrationDate: r.registrationDate || null,
        status: r.status || "pending",
        waitlist: !!r.waitlist,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
      tournament.registrations = normalized.map((r) => {
        if (r.player && r.player.birthDate) {
          const today = new Date();
          const birth = new Date(r.player.birthDate);
          let age = today.getFullYear() - birth.getFullYear();
          const monthDiff = today.getMonth() - birth.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
            age--;
          }
          r.player.age = age;
        } else if (r.player) {
          r.player.age = null;
        }
        return r;
      });
      tournament.registrationPagination = buildPaginationMeta({
        page: regPage,
        limit: regLimit,
        total: totalRegs,
      });
    } else if (includeRegistrations) {
      const allRegistrations = Array.isArray(tournament.registrations)
        ? tournament.registrations
        : [];
      const totalRegs = allRegistrations.length;
      const pagedRegistrations = allRegistrations.slice(
        (regPage - 1) * regLimit,
        (regPage - 1) * regLimit + regLimit,
      );
      tournament.registrations = pagedRegistrations.map((r) => {
        if (r.player && r.player.birthDate) {
          const today = new Date();
          const birth = new Date(r.player.birthDate);
          let age = today.getFullYear() - birth.getFullYear();
          const monthDiff = today.getMonth() - birth.getMonth();
          if (
            monthDiff < 0 ||
            (monthDiff === 0 && today.getDate() < birth.getDate())
          ) {
            age--;
          }
          r.player.age = age;
        } else if (r.player) {
          r.player.age = null;
        }
        return r;
      });
      tournament.registrationPagination = buildPaginationMeta({
        page: regPage,
        limit: regLimit,
        total: totalRegs,
      });
    }

    // ✅ Sign proofOfPayment(s) while preserving originals
    if (includeRegistrations) try {
      const signed = await Promise.all(
        (tournament.registrations || []).map(async (r) => {
          if (r && r.proofOfPayment) {
            try {
              if (Array.isArray(r.proofOfPayment)) {
                const arr = r.proofOfPayment.slice(0, 2);
                r.proofOfPaymentSignedUrls = await Promise.all(
                  arr.map(async (u) => {
                    try {
                      return await getSignedUrlFromAny(u);
                    } catch (_) {
                      return u;
                    }
                  })
                );
              } else if (typeof r.proofOfPayment === "string") {
                r.proofOfPaymentSignedUrl = await getSignedUrlFromAny(r.proofOfPayment);
              }
            } catch (_) {}
          }
          return r;
        })
      );
      tournament.registrations = signed;
    } catch (_) {}

    // ✅ Sign tournament-level resources (QR codes, tournament picture)
    if (includeAssets) try {
      if (Array.isArray(tournament.paymentMethods)) {
        await Promise.all(
          tournament.paymentMethods.map(async (pm) => {
            if (pm && pm.qrCodeImage) {
              try {
                pm.qrCodeImage = await getSignedUrlFromAny(pm.qrCodeImage);
              } catch (_) {}
            }
            return pm;
          }),
        );
      }
      // Sign guideline pictures if present
      if (Array.isArray(tournament.guidelinePictures)) {
        try {
          tournament.guidelinePictures = await Promise.all(
            tournament.guidelinePictures.map(async (url) => {
              try {
                return await getSignedUrlFromAny(url);
              } catch (_) {
                return url;
              }
            })
          );
        } catch (_) {}
      }
      // Sign schedule pictures if present
      if (Array.isArray(tournament.schedulePictures)) {
        try {
          tournament.schedulePictures = await Promise.all(
            tournament.schedulePictures.map(async (url) => {
              try {
                return await getSignedUrlFromAny(url);
              } catch (_) {
                return url;
              }
            })
          );
        } catch (_) {}
      }
      if (tournament.tournamentPicture) {
        try {
          tournament.tournamentPicture = await getSignedUrlFromAny(
            tournament.tournamentPicture,
          );
        } catch (_) {}
      }
    } catch (_) {}

    // removed debug timing
    if (includeComputed) try {
      const pickLatest = (obj) => {
        const keys = Object.keys(obj || {});
        if (keys.length === 0) return null;
        const sorted = keys
          .map((k) => ({ k, d: new Date(k) }))
          .filter((x) => x.d && !isNaN(x.d.getTime()))
          .sort((a, b) => b.d - a.d);
        const chosen = (sorted[0] && sorted[0].k) || keys[0];
        return obj[chosen] || null;
      };
      const wantDate = String(req.query.scheduleDate || "").trim();
      let effective = null;
      if (tournament.migratedCourtAssignments) {
        try {
          const CourtAssignmentDay = require("../models/CourtAssignmentDay");
          if (wantDate) {
            const day = await CourtAssignmentDay.findOne({ tournamentId: tournament._id, date: wantDate }).lean();
            if (day) {
              effective = {
                courtCount: Number(day.courtCount || 0),
                scheduleDate: String(day.date || ""),
                timeSlots: [],
                assignments: [],
                venues: Array.isArray(day.venues)
                  ? day.venues.map((v, idx) => ({
                      name: String((v && v.name) || (v && v.venueName) || `Venue ${idx + 1}`),
                      courtCount: Number((v && v.courtCount) || (v && v.courts) || 0),
                      timeSlots: Array.isArray(v && v.timeSlots) ? (v.timeSlots || []) : [],
                      assignments: Array.isArray(v && v.assignments) ? (v.assignments || []) : [],
                    }))
                  : [],
              };
            }
          }
          if (!effective) {
            const day = await CourtAssignmentDay.findOne({ tournamentId: tournament._id }).sort({ date: -1 }).lean();
            if (day) {
              effective = {
                courtCount: Number(day.courtCount || 0),
                scheduleDate: String(day.date || ""),
                timeSlots: [],
                assignments: [],
                venues: Array.isArray(day.venues)
                  ? day.venues.map((v, idx) => ({
                      name: String((v && v.name) || (v && v.venueName) || `Venue ${idx + 1}`),
                      courtCount: Number((v && v.courtCount) || (v && v.courts) || 0),
                      timeSlots: Array.isArray(v && v.timeSlots) ? (v.timeSlots || []) : [],
                      assignments: Array.isArray(v && v.assignments) ? (v.assignments || []) : [],
                    }))
                  : [],
              };
            }
          }
        } catch {}
      }
      if (!effective) {
        if (wantDate && tournament.courtAssignmentsByDate && tournament.courtAssignmentsByDate[wantDate]) {
          effective = tournament.courtAssignmentsByDate[wantDate];
        } else if (tournament.courtAssignmentsByDate && Object.keys(tournament.courtAssignmentsByDate).length) {
          effective = pickLatestDatedEntry(tournament.courtAssignmentsByDate);
        } else if (tournament.courtAssignments) {
          effective = tournament.courtAssignments;
        }
      }
      if (effective) {
        tournament.courtAssignments = effective;
      }
    } catch (_) {}
    if (includeComputed) try {
      const Standing = require("../models/Standing");
      const docs = await Standing.find({ tournamentId: tournament._id }).lean();
      const groupsByCat = new Map();
      for (const s of docs) {
        const cid = String(s.categoryId || "");
        if (!cid) continue;
        if (!groupsByCat.has(cid)) groupsByCat.set(cid, []);
        groupsByCat.get(cid).push({
          player: String(s.displayName || s.teamName || "").trim(),
          teamId: s.teamId ? String(s.teamId) : "",
          wins: Number(s.wins || 0),
          losses: Number(s.losses || 0),
          pointsFor: Number(s.pointsFor || 0),
          pointsAgainst: Number(s.pointsAgainst || 0),
          pointDifferential: Number(
            s.pointDifferential !== undefined
              ? s.pointDifferential
              : (s.pointsFor || 0) - (s.pointsAgainst || 0)
          ),
          rankPoints: Number(s.rankPoints || 0),
          _id: s._id,
        });
      }
      const cats = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
      for (const cat of cats) {
        const cid = String(cat._id || cat.id || "");
        if (!cid) continue;
        const arr = groupsByCat.get(cid) || [];
        if (cat.groupStage && typeof cat.groupStage === "object") {
          cat.groupStage.standings = arr;
        } else {
          cat.groupStage = { groups: [], standings: arr };
        }
      }
    } catch (_) {}
    if (includeComputed) try {
      const normMatches = await Match.find({ tournamentId: tournament._id })
        .select("categoryId stage groupId matchKey round status meta")
        .lean();
      const toNorm = (v) => String(v || "").trim().toLowerCase();
      const statusByGroupKey = new Map();
      const statusByElimKey = new Map();
      const addElimStatus = (catId, rawId, status) => {
        const c = toNorm(catId);
        const base = toNorm(rawId);
        const st = String(status || "").trim();
        if (!c || !base || !st) return;
        const ids = new Set();
        const push = (x) => {
          const s = toNorm(x);
          if (!s) return;
          ids.add(s);
          ids.add(s.replace(/[-_]/g, ""));
          if (s.startsWith("qf")) ids.add(`quarter${s.replace("qf", "")}`);
          if (s.startsWith("quarter")) ids.add(`qf${s.replace("quarter", "")}`);
          if (s.startsWith("sf")) ids.add(`semi${s.replace("sf", "")}`);
          if (s.startsWith("semi")) ids.add(`sf${s.replace("semi", "")}`);
          if (s.startsWith("r16-")) ids.add(`round16_${s.replace("r16-", "")}`);
          if (s.startsWith("round16_")) ids.add(`r16-${s.replace("round16_", "")}`);
          if (s === "finals") ids.add("final");
        };
        push(base);
        Array.from(ids).forEach((id) => {
          statusByElimKey.set(`${c}|${id}`, st);
        });
      };
      for (const m of normMatches) {
        const catId = toNorm(m?.categoryId);
        const st = String(m?.status || "").trim();
        if (!catId || !st) continue;
        const stage = toNorm(m?.stage);
        if (stage === "group") {
          const gidRaw = String(m?.groupId || m?.meta?.groupId || "").trim();
          const gid = toNorm(gidRaw.startsWith("group-") ? gidRaw : `group-${gidRaw}`);
          const mk = toNorm(m?.matchKey || m?.meta?.matchKey);
          if (gid && mk) statusByGroupKey.set(`${catId}|${gid}|${mk}`, st);
          continue;
        }
        if (stage === "elimination") {
          const elimId = String(m?.matchKey || m?.meta?.matchId || m?.round || "").trim();
          if (elimId) addElimStatus(catId, elimId, st);
        }
      }
      const cats = Array.isArray(tournament?.tournamentCategories)
        ? tournament.tournamentCategories
        : [];
      for (const cat of cats) {
        const catId = toNorm(cat?._id || cat?.id);
        if (!catId) continue;
        const groups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
        for (const g of groups) {
          const gid = toNorm(g?.id || "");
          const matches = g?.matches && typeof g.matches === "object" ? g.matches : null;
          if (!gid || !matches) continue;
          for (const mkRaw of Object.keys(matches)) {
            const mk = toNorm(mkRaw);
            const nextStatus = statusByGroupKey.get(`${catId}|${gid}|${mk}`);
            if (nextStatus && matches[mkRaw] && typeof matches[mkRaw] === "object") {
              matches[mkRaw].status = nextStatus;
            }
          }
        }
        const elim = Array.isArray(cat?.eliminationMatches?.matches)
          ? cat.eliminationMatches.matches
          : [];
        for (const m of elim) {
          const mid = toNorm(m?.id || "");
          if (!mid || !m || typeof m !== "object") continue;
          const nextStatus = statusByElimKey.get(`${catId}|${mid}`)
            || statusByElimKey.get(`${catId}|${mid.replace(/[-_]/g, "")}`);
          if (nextStatus) m.status = nextStatus;
        }
      }
    } catch (_) {}
    res.json(tournament);
  } catch (error) {
    console.error("Error fetching tournament:", error.message);
    // Additional check for ObjectId casting errors
    if (error.message && error.message.includes("Cast to ObjectId failed")) {
      const tournamentId = req.params.id;
      if (tournamentId && tournamentId.startsWith("dummy-")) {
        return res.status(404).json({ 
          message: "Tournament not found",
          isDummy: true,
          note: "This is a dummy tournament. Please use the tournament data from the frontend."
        });
      }
    }
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Get registrations for a tournament (club admins)
exports.getTournamentRegistrations = async (req, res) => {
  try {
    const tournamentId = req.params.id;

    const flagDoc = await Tournament.findById(tournamentId).select("migratedRegistrations").lean();
    if (!flagDoc) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    if (flagDoc.migratedRegistrations) {
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(200, Math.max(0, Number(req.query.pageSize || 0)));
      const status = String(req.query.status || "").trim();
      const categoryId = String(req.query.categoryId || "").trim();
      const q = String(req.query.q || "").trim();

      const filter = { tournamentId };
      if (status) filter.status = status;
      if (categoryId) {
        filter.$or = [{ categoryId: categoryId }, { category: categoryId }];
      }
      if (q) {
        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        filter.$or = [
          ...(filter.$or || []),
          { playerName: regex },
          { playerEmail: regex },
          { playerPhone: regex },
          { teamName: regex },
          { email: regex },
          { contactNumber: regex },
          { paymongoCheckoutSessionId: regex },
          { paymongoPaymentIntentId: regex },
          { paymongoPaymentId: regex },
        ];
      }

      const baseQuery = Registration.find(filter)
        .populate({
          path: "playerId",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .populate({
          path: "partnerId",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .populate({
          path: "teamMembers",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .lean();
      const regs = pageSize > 0
        ? await baseQuery.skip((page - 1) * pageSize).limit(pageSize)
        : await baseQuery;
      const total = pageSize > 0 ? await Registration.countDocuments(filter) : regs.length;

      const normalized = regs.map((r) => {
        const x = {
          _id: r._id,
          player: r.playerId || null,
          partner: r.partnerId || null,
          teamMembers: Array.isArray(r.teamMembers) ? r.teamMembers : [],
          category: r.categoryId || r.category,
          proofOfPayment: r.proofOfPayment || [],
          contactNumber: r.contactNumber || null,
          email: r.email || null,
          playerName: r.playerName || null,
          playerEmail: r.playerEmail || null,
          playerPhone: r.playerPhone || null,
          emergencyContact: r.emergencyContact || null,
          emergencyPhone: r.emergencyPhone || null,
          shirtSize: r.shirtSize || null,
          teamName: r.teamName || null,
          notes: r.notes || null,
          paymentMode: r.paymentMode || "manual",
          paymentStatus: r.paymentStatus || "pending",
          paidAmount: Number(r.paidAmount || 0),
          paymongoCheckoutSessionId: r.paymongoCheckoutSessionId || "",
          paymongoPaymentIntentId: r.paymongoPaymentIntentId || "",
          paymongoPaymentId: r.paymongoPaymentId || "",
          registrationDate: r.registrationDate || null,
          status: r.status || "pending",
          waitlist: !!r.waitlist,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        };
        return x;
      });

      const withAge = normalized.map((r) => {
        if (r.player && r.player.birthDate) {
          const today = new Date();
          const birth = new Date(r.player.birthDate);
          let age = today.getFullYear() - birth.getFullYear();
          const monthDiff = today.getMonth() - birth.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
            age--;
          }
          r.player.age = age;
        } else if (r.player) {
          r.player.age = null;
        }
        return r;
      });

      let signed = withAge;
      try {
        signed = await Promise.all(
          withAge.map(async (r) => {
            if (r && r.proofOfPayment) {
              try {
                if (Array.isArray(r.proofOfPayment)) {
                  const arr = r.proofOfPayment.slice(0, 2);
                  r.proofOfPaymentSignedUrls = await Promise.all(
                    arr.map(async (u) => {
                      try {
                        return await getSignedUrlFromAny(u);
                      } catch (_) {
                        return u;
                      }
                    }),
                  );
                } else if (typeof r.proofOfPayment === "string") {
                  r.proofOfPaymentSignedUrl = await getSignedUrlFromAny(r.proofOfPayment);
                }
              } catch (_) {}
            }
            return r;
          }),
        );
      } catch (_) {}

      if (pageSize > 0) {
        return res.json({
          registrations: signed,
          meta: { page, pageSize, total, pages: Math.ceil(total / pageSize) },
        });
      }
      return res.json({ registrations: signed });
    }

    const tournament = await Tournament.findById(tournamentId)
      .populate({
        path: "registrations.player",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.partner",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.teamMembers",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .select("registrations")
      .lean();

    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // ✅ Compute age for each registered player; preserve all registration fields (including proofOfPayment)
    const registrationsWithAge = (tournament.registrations || []).map((r) => {
      if (r.player && r.player.birthDate) {
        const today = new Date();
        const birth = new Date(r.player.birthDate);
        let age = today.getFullYear() - birth.getFullYear();
        const monthDiff = today.getMonth() - birth.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
          age--;
        }
        r.player.age = age;
      } else if (r.player) {
        r.player.age = null;
      }
      return r;
    });

    // ✅ Sign proofOfPayment(s); preserve originals
    let signedRegistrations = registrationsWithAge;
    try {
      signedRegistrations = await Promise.all(
        registrationsWithAge.map(async (r) => {
          if (r && r.proofOfPayment) {
            try {
              if (Array.isArray(r.proofOfPayment)) {
                const arr = r.proofOfPayment.slice(0, 2);
                r.proofOfPaymentSignedUrls = await Promise.all(
                  arr.map(async (u) => {
                    try {
                      return await getSignedUrlFromAny(u);
                    } catch (_) {
                      return u;
                    }
                  })
                );
              } else if (typeof r.proofOfPayment === "string") {
                r.proofOfPaymentSignedUrl = await getSignedUrlFromAny(r.proofOfPayment);
              }
            } catch (_) {}
          }
          return r;
        })
      );
    } catch (_) {}

    return res.json({ registrations: signedRegistrations });
  } catch (error) {
    console.error("Error fetching tournament registrations:", error.message);
    return res.status(500).json({ message: "Server error" });
  }
};

// ✅ Get tournaments created by logged-in user
exports.getUserTournaments = async (req, res) => {
  try {
    const userId = req.user._id;
    // Find tournaments where user is either creator or co-host
    const tournaments = await Tournament.find({
      $or: [
        { createdBy: userId },
        { coHosts: userId }
      ]
    })
      .sort({ createdAt: -1 })
      .populate({
        path: "createdBy",
        select: "_id firstName lastName email",
        options: { lean: true },
      })
      .populate({
        path: "registrations.player",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.partner",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.teamMembers",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "coHosts",
        select: "firstName lastName email",
        options: { lean: true },
      })
      .lean();

    // ✅ Compute age for each registered player
    tournaments.forEach((tournament) => {
      tournament.registrations = tournament.registrations.map((r) => {
        if (r.player && r.player.birthDate) {
          const today = new Date();
          const birth = new Date(r.player.birthDate);
          let age = today.getFullYear() - birth.getFullYear();
          const monthDiff = today.getMonth() - birth.getMonth();
          if (
            monthDiff < 0 ||
            (monthDiff === 0 && today.getDate() < birth.getDate())
          ) {
            age--;
          }
          r.player.age = age;
        } else if (r.player) {
          r.player.age = null;
        }
        return r;
      });
    });

    // ✅ Sign private GCS resources (payment method QR images, tournament picture)
    try {
      await Promise.all(
        tournaments.map(async (t) => {
          // Sign tournament picture if present
          if (t.tournamentPicture) {
            try {
              t.tournamentPicture = await getSignedUrlFromAny(t.tournamentPicture);
            } catch (_) {}
          }
          // Also sign proof-of-payment(s) for registrations but keep originals
          if (Array.isArray(t.registrations)) {
            try {
              t.registrations = await Promise.all(
                t.registrations.map(async (r) => {
                  if (r && r.proofOfPayment) {
                    try {
                      if (Array.isArray(r.proofOfPayment)) {
                        const arr = r.proofOfPayment.slice(0, 2);
                        r.proofOfPaymentSignedUrls = await Promise.all(
                          arr.map(async (u) => {
                            try {
                              return await getSignedUrlFromAny(u);
                            } catch (_) {
                              return u;
                            }
                          })
                        );
                      } else if (typeof r.proofOfPayment === "string") {
                        r.proofOfPaymentSignedUrl = await getSignedUrlFromAny(r.proofOfPayment);
                      }
                    } catch (_) {}
                  }
                  return r;
                })
              );
            } catch (_) {}
          }
          // Sign payment method QR codes
          if (Array.isArray(t.paymentMethods)) {
            await Promise.all(
              t.paymentMethods.map(async (pm) => {
                if (pm && pm.qrCodeImage) {
                  try {
                    pm.qrCodeImage = await getSignedUrlFromAny(pm.qrCodeImage);
                  } catch (_) {}
                }
                return pm;
              }),
            );
          }
          return t;
        }),
      );
    } catch (_) {}

    // removed debug timing
    res.json(tournaments);
  } catch (error) {
    console.error("Error fetching user tournaments:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Create Tournament
exports.createTournament = async (req, res) => {
  try {
    let {
      tournamentName,
      poweredBy,
      host,
      description,
      registrationInstructions,
      registrationDeadline,
      registrationOpensAt,
      registrationClosesAt,
      tournamentDates,
      category,
      skillLevel,
      duprRequirement,
      entryFeeMin,
      entryFeeMax,
      prizePool,
      venueName,
      venueAddress,
      venueCity,
      venueState,
      venueZip,
      contactEmail,
      contactPhone,
      rules,
      events,
      paymentMethods,
      additionalInfo,
      tournamentCategories,
    } = req.body;

    // Parse JSON fields
    tournamentDates = tournamentDates
      ? JSON.parse(tournamentDates).map((d) => new Date(d))
      : [];
    tournamentCategories = tournamentCategories
      ? JSON.parse(tournamentCategories)
      : [];
    paymentMethods = paymentMethods ? JSON.parse(paymentMethods) : [];

    // Normalize category extras (withShirt, fee)
    try {
      if (Array.isArray(tournamentCategories)) {
        tournamentCategories = tournamentCategories.map((cat) => ({
          ...cat,
          withShirt: cat?.withShirt === true,
          setPartner: cat?.setPartner === true,
          fee:
            cat?.fee === null || cat?.fee === undefined || cat?.fee === ''
              ? null
              : Number(cat.fee),
        }));
      }
    } catch (_) {}

    // Map uploaded QR files to payment methods (upload to GCS)
    if (req.files?.paymentMethodsFiles) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      await Promise.all(
        req.files.paymentMethodsFiles.map(async (file, i) => {
          if (paymentMethods[i]) {
            const dest = `tournaments/payment_methods/${file.filename}`;
            const url = await uploadToGCS(file.path, dest);
            paymentMethods[i].qrCodeImage = url;
            // Cleanup local temp
            fs.promises.unlink(file.path).catch(() => {});
          }
        })
      );
    }

    // Tournament picture (upload to GCS)
    let tournamentPicture = null;
    if (req.files?.tournamentPicture?.[0]) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      const tournamentPicFile = req.files.tournamentPicture[0];
      const dest = `tournaments/pictures/${tournamentPicFile.filename}`;
      tournamentPicture = await uploadToGCS(tournamentPicFile.path, dest);
      fs.promises.unlink(tournamentPicFile.path).catch(() => {});
    }

    // Guideline & Events pictures (optional multiple uploads to GCS)
    let guidelinePictures = [];
    try {
      if (body.guidelinePictures) {
        guidelinePictures = Array.isArray(body.guidelinePictures)
          ? body.guidelinePictures
          : JSON.parse(body.guidelinePictures || '[]');
      }
    } catch (_) {
      guidelinePictures = [];
    }
    if (Array.isArray(req.files?.guidelinePictures) && req.files.guidelinePictures.length > 0) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      const uploaded = await Promise.all(
        req.files.guidelinePictures.map(async (file) => {
          const dest = `tournaments/guidelines/${file.filename}`;
          const url = await uploadToGCS(file.path, dest);
          fs.promises.unlink(file.path).catch(() => {});
          return url;
        })
      );
      guidelinePictures = [...guidelinePictures, ...uploaded];
    }

    // Schedule pictures (optional multiple uploads to GCS)
    let schedulePictures = [];
    try {
      if (body?.schedulePictures) {
        schedulePictures = Array.isArray(body.schedulePictures)
          ? body.schedulePictures
          : JSON.parse(body.schedulePictures || '[]');
      }
    } catch (_) {
      schedulePictures = [];
    }
    if (Array.isArray(req.files?.schedulePictures) && req.files.schedulePictures.length > 0) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      const uploadedSched = await Promise.all(
        req.files.schedulePictures.map(async (file) => {
          const dest = `tournaments/schedule/${file.filename}`;
          const url = await uploadToGCS(file.path, dest);
          fs.promises.unlink(file.path).catch(() => {});
          return url;
        })
      );
      schedulePictures = [...schedulePictures, ...uploadedSched];
    }

    // Set primary category & skillLevel if missing
    if (tournamentCategories.length > 0) {
      category = tournamentCategories[0].division;
      skillLevel = tournamentCategories[0].skillLevel;
    }

    // removed backend debug logs

    const newTournament = new Tournament({
      tournamentName,
      poweredBy,
      host,
      description,
      registrationInstructions,
      registrationDeadline: new Date(registrationDeadline),
      ...(registrationOpensAt ? { registrationOpensAt: new Date(registrationOpensAt) } : {}),
      ...(registrationClosesAt ? { registrationClosesAt: new Date(registrationClosesAt) } : {}),
      tournamentDates,
      category,
      skillLevel,
      duprRequirement: (typeof duprRequirement === 'string' && duprRequirement) ? String(duprRequirement).toUpperCase() : "OPEN",
      entryFeeMin: entryFeeMin ? Number(entryFeeMin) : null,
      entryFeeMax: entryFeeMax ? Number(entryFeeMax) : null,
      prizePool,
      venueName,
      venueAddress,
      venueCity,
      venueState,
      venueZip,
      contactEmail,
      contactPhone,
      rules,
      events,
      paymentMethods,
      additionalInfo,
      tournamentCategories,
      tournamentPicture,
      guidelinePictures,
      schedulePictures,
      migratedRegistrations: true,
      createdBy: req.user._id,
    });

    await newTournament.save();
    try {
      const TournamentCategory = require("../models/TournamentCategories");
      const { Types } = require("mongoose");
      const cats = Array.isArray(newTournament.tournamentCategories) ? newTournament.tournamentCategories : [];
      let assignedIds = false;
      for (const cat of cats) {
        const catId = cat?._id || new Types.ObjectId();
        if (!cat?._id) {
          cat._id = catId;
          assignedIds = true;
        }
        const groupStageSummary = cat.groupStage
          ? {
              groups: Array.isArray(cat.groupStage.groups)
                ? cat.groupStage.groups.map((g) => ({ id: g.id, name: g.name }))
                : [],
            }
          : null;
        const eliminationSummary = cat.eliminationMatches
          ? {
              status: cat.eliminationMatches.status || undefined,
              fee: cat.eliminationMatches.fee ?? 0,
              gamesPerMatch: cat.eliminationMatches.gamesPerMatch ?? cat.gamesPerMatch,
            }
          : null;
        const doc = {
          _id: catId,
          tournamentId: newTournament._id,
          division: cat.division,
          ageCategory: cat.ageCategory,
          skillLevel: cat.skillLevel,
          maxParticipants: cat.maxParticipants,
          reservedSlots: cat.reservedSlots,
          setPartner: !!cat.setPartner,
          bracketMode: cat.bracketMode,
          gamesPerMatch: cat.gamesPerMatch,
          groupStage: groupStageSummary,
          eliminationMatches: eliminationSummary,
          withShirt: !!cat.withShirt,
          fee: cat.fee ?? 0,
          pairOverrides: cat.pairOverrides || null,
          pointsSubmitted: !!cat.pointsSubmitted,
          pointsSubmittedAt: cat.pointsSubmittedAt || null,
          locked: !!cat.locked,
          status: cat.status || "Open",
        };
        await TournamentCategory.updateOne({ _id: catId }, { $set: doc }, { upsert: true });
      }
      if (assignedIds) {
        try {
          newTournament.markModified("tournamentCategories");
        } catch (_) {}
        await newTournament.save();
      }
    } catch (_) {}
    try {
      const Match = require("../models/Match");
      const docs = await Match.find({ tournamentId: tournament._id }).lean();
      const matchesByCat = new Map();
      for (const m of docs) {
        const cid = String(m.categoryId || "");
        if (!cid) continue;
        if (!matchesByCat.has(cid)) matchesByCat.set(cid, []);
        const s = m.scores || {};
        const isTeam = !!(m.team1Id || m.team2Id);
        const mapped = isTeam
          ? {
              team1Id: m.team1Id ? String(m.team1Id) : undefined,
              team2Id: m.team2Id ? String(m.team2Id) : undefined,
              status: String(m.status || "").trim() || "Unscheduled",
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              matchId: (m.meta && m.meta.matchId) || undefined,
              finalScorePlayer1: Number(s?.final?.team1 || 0),
              finalScorePlayer2: Number(s?.final?.team2 || 0),
            }
          : {
              player1Id: m.player1Id ? String(m.player1Id) : undefined,
              player2Id: m.player2Id ? String(m.player2Id) : undefined,
              player1Name: String(m.player1Name || "").trim() || undefined,
              player2Name: String(m.player2Name || "").trim() || undefined,
              status: String(m.status || "").trim() || "Unscheduled",
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              matchId: (m.meta && m.meta.matchId) || undefined,
              game1Player1: Number(s?.game1?.team1 || 0),
              game1Player2: Number(s?.game1?.team2 || 0),
              game2Player1: Number(s?.game2?.team1 || 0),
              game2Player2: Number(s?.game2?.team2 || 0),
              game3Player1: Number(s?.game3?.team1 || 0),
              game3Player2: Number(s?.game3?.team2 || 0),
              finalScorePlayer1: Number(s?.final?.team1 || 0),
              finalScorePlayer2: Number(s?.final?.team2 || 0),
            };
        matchesByCat.get(cid).push(mapped);
      }
      const cats2 = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
      for (const cat of cats2) {
        const cid = String(cat._id || cat.id || "");
        if (!cid) continue;
        const arr = matchesByCat.get(cid) || [];
        if (cat.eliminationMatches && typeof cat.eliminationMatches === "object") {
          cat.eliminationMatches.matches = arr;
        } else {
          cat.eliminationMatches = { matches: arr, status: "Unscheduled" };
        }
      }
    } catch (_) {}
    res
      .status(201)
      .json({
        message: "Tournament created successfully",
        tournament: newTournament,
      });
  } catch (error) {
    console.error("Error creating tournament:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ✅ Admin: Sync embedded tournamentCategories -> normalized TournamentCategory
exports.syncCategoriesNormalized = async (req, res) => {
  try {
    const id = req.body?.tournamentId || req.params?.id || req.query?.tournamentId;
    if (!id) {
      return res.status(400).json({ message: "tournamentId is required" });
    }
    const tournament = await Tournament.findById(id).select("tournamentCategories");
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }
    const TournamentCategory = require("../models/TournamentCategories");
    const { Types } = require("mongoose");
    const cats = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    let assignedIds = false;
    for (const cat of cats) {
      const catId = cat?._id || new Types.ObjectId();
      if (!cat?._id) {
        cat._id = catId;
        assignedIds = true;
      }
      const groupStageSummary = cat.groupStage
        ? {
            groups: Array.isArray(cat.groupStage.groups)
              ? cat.groupStage.groups.map((g) => ({ id: g.id, name: g.name }))
              : [],
          }
        : null;
      const eliminationSummary = cat.eliminationMatches
        ? {
            status: cat.eliminationMatches.status || undefined,
            fee: cat.eliminationMatches.fee ?? 0,
            gamesPerMatch: cat.eliminationMatches.gamesPerMatch ?? cat.gamesPerMatch,
          }
        : null;
      const doc = {
        _id: catId,
        tournamentId: tournament._id,
        division: cat.division,
        ageCategory: cat.ageCategory,
        skillLevel: cat.skillLevel,
        maxParticipants: cat.maxParticipants,
        reservedSlots: cat.reservedSlots,
        setPartner: !!cat.setPartner,
        bracketMode: cat.bracketMode,
        gamesPerMatch: cat.gamesPerMatch,
        groupStage: groupStageSummary,
        eliminationMatches: eliminationSummary,
        withShirt: !!cat.withShirt,
        fee: cat.fee ?? 0,
        pairOverrides: cat.pairOverrides || null,
        pointsSubmitted: !!cat.pointsSubmitted,
        pointsSubmittedAt: cat.pointsSubmittedAt || null,
        locked: !!cat.locked,
        status: cat.status || "Open",
      };
      await TournamentCategory.updateOne({ _id: catId }, { $set: doc }, { upsert: true });
    }
    if (assignedIds) {
      try { tournament.markModified("tournamentCategories"); } catch (_) {}
      await tournament.save();
    }
    const existing = await TournamentCategory.find({ tournamentId: tournament._id }).select("_id").lean();
    const currentIds = cats.map((c) => c && c._id).filter(Boolean);
    const toRemove = existing
      .map((x) => x && x._id)
      .filter((id) => id && !currentIds.some((cid) => String(cid) === String(id)));
    if (toRemove.length) {
      await TournamentCategory.deleteMany({ _id: { $in: toRemove } });
      try {
        await Registration.deleteMany({
          tournamentId: tournament._id,
          $or: [
            { categoryId: { $in: toRemove } },
            { category: { $in: toRemove.map(String) } },
          ],
        });
      } catch (_) {}
    }
    return res.json({ ok: true, normalizedCount: cats.length, removed: toRemove.length });
  } catch (error) {
    console.error("Error syncing categories:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
// ✅ Update Tournament (only author)
// ✅ Update Tournament (only author)
exports.updateTournament = async (req, res) => {
  try {

    let body = { ...req.body };

    // Parse fields if stringified
    if (body.tournamentDates && typeof body.tournamentDates === "string") {
      try {
        const parsed = JSON.parse(body.tournamentDates);
        body.tournamentDates = Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        body.tournamentDates = [];
      }
    }
    if (
      body.tournamentCategories &&
      typeof body.tournamentCategories === "string"
    ) {
      body.tournamentCategories = JSON.parse(body.tournamentCategories);
    }
    if (body.paymentMethods && typeof body.paymentMethods === "string") {
      body.paymentMethods = JSON.parse(body.paymentMethods);
    }
    if (body.guidelinePictures && typeof body.guidelinePictures === "string") {
      try {
        body.guidelinePictures = JSON.parse(body.guidelinePictures);
      } catch (_) {
        body.guidelinePictures = [];
      }
    }
    if (body.schedulePictures && typeof body.schedulePictures === "string") {
      try {
        body.schedulePictures = JSON.parse(body.schedulePictures);
      } catch (_) {
        body.schedulePictures = [];
      }
    }

    // Normalize incoming date values to local date objects
    const isYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const toLocalDate = (s) => {
      try {
        if (isYMD(s)) {
          const [y, m, d] = s.split('-').map(Number);
          return new Date(y, m - 1, d);
        }
        // Handle datetime-local strings (YYYY-MM-DDTHH:mm) from the frontend explicitly in Asia/Manila (UTC+8)
        if (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) {
          const [datePart, timePart] = s.split('T');
          const [y, m, d] = datePart.split('-').map(Number);
          const [hh, mm] = timePart.split(':').map(Number);
          // Convert Manila local time to an absolute UTC instant (Philippines has UTC+8, no DST)
          return new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
        }
        const dt = new Date(s);
        return isNaN(dt.getTime()) ? null : dt;
      } catch { return null; }
    };
    const normalizeDatesArray = (arr) => {
      try {
        const list = Array.isArray(arr) ? arr : [];
        const out = list.map((v) => (v instanceof Date ? v : toLocalDate(v))).filter((d) => d && !isNaN(d.getTime()));
        return out;
      } catch { return []; }
    };
    const normalizeSingleDate = (val) => {
      if (!val) return null;
      if (val instanceof Date) return val;
      const d = toLocalDate(val);
      return d;
    };
    const toYMD = (dateObj) => {
      try {
        if (!(dateObj instanceof Date)) return '';
        if (isNaN(dateObj.getTime())) return '';
        const y = dateObj.getFullYear();
        const m = String(dateObj.getMonth() + 1).padStart(2, '0');
        const dd = String(dateObj.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
      } catch { return ''; }
    };

    const normalizeDriveViewLink = (link) => {
      try {
        const u = new URL(String(link || ""));
        const host = u.hostname;
        let fileId = "";
        const pathMatch = u.pathname.match(/\/file\/d\/([^/]+)\//);
        if (pathMatch && pathMatch[1]) {
          fileId = pathMatch[1];
        } else if (u.searchParams.get("id")) {
          fileId = u.searchParams.get("id");
        }
        if (host.includes("drive.google.com") && fileId) {
          return `https://drive.google.com/file/d/${fileId}/view`;
        }
        return String(link || "");
      } catch {
        return String(link || "");
      }
    };

    const flattenGuidelines = (input) => {
      const out = [];
      const push = (v) => {
        if (!v) return;
        if (typeof v === 'string') {
          const s = v.trim();
          if (!s) return;
          if (s.startsWith('[')) {
            try {
              const arr = JSON.parse(s);
              if (Array.isArray(arr)) arr.forEach(push);
              else if (typeof arr === 'object' && arr) push(arr.url || arr.path || '');
              else out.push(s);
            } catch { out.push(s); }
            return;
          }
          if (s.startsWith('{')) {
            try {
              const obj = JSON.parse(s);
              push(obj && (obj.url || obj.path || ''));
            } catch { out.push(s); }
            return;
          }
          out.push(s);
          return;
        }
        if (typeof v === 'object') {
          const url = v?.url || v?.path || '';
          if (url) push(String(url));
          return;
        }
      };
      if (Array.isArray(input)) input.forEach(push);
      else if (typeof input === 'string') push(input);
      const dedup = Array.from(new Set(out.map(normalizeDriveViewLink)));
      return dedup;
    };

    if (body.guidelinePictures) {
      body.guidelinePictures = flattenGuidelines(body.guidelinePictures).filter((s) => {
        const v = String(s || '').trim();
        return v !== '' && v !== '[]';
      });
    }

    const isValidImageUrl = (u) => {
      try {
        const s = String(u || '').trim();
        if (!s) return false;
        if (s === '[]') return false;
        if (s === 'null' || s === 'undefined') return false;
        if (s.startsWith('http://') || s.startsWith('https://')) return true;
        if (s.startsWith('gs://')) return true;
        if (s.startsWith('/uploads/')) return true;
        if (s.startsWith('/')) return true;
        return false;
      } catch { return false; }
    };

    const stripWrap = (s) => {
      const t = String(s || '').trim();
      if (!t) return '';
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`"))) {
        return t.slice(1, -1).trim();
      }
      return t;
    };

    const canonicalizeStorageUrl = (u) => {
      try {
        const s = stripWrap(u);
        if (!s) return '';
        if (s.startsWith('gs://')) return s;
        let url = s;
        if (url.includes('storage.cloud.google.com/')) {
          url = url.replace('storage.cloud.google.com', 'storage.googleapis.com');
        }
        if (url.startsWith('http://') || url.startsWith('https://')) {
          const q = url.indexOf('?');
          return q >= 0 ? url.slice(0, q) : url;
        }
        return url;
      } catch { return String(u || ''); }
    };

    const flattenSchedulePictures = (input) => {
      const out = [];
      const push = (v) => {
        if (!v) return;
        if (typeof v === 'string') {
          const s = canonicalizeStorageUrl(v);
          if (!s) return;
          if (s.startsWith('[')) {
            try {
              const arr = JSON.parse(s);
              if (Array.isArray(arr)) arr.forEach(push);
              else if (typeof arr === 'object' && arr) push(canonicalizeStorageUrl(arr.url || arr.path || ''));
              else out.push(s);
            } catch { out.push(s); }
            return;
          }
          if (s.startsWith('{')) {
            try {
              const obj = JSON.parse(s);
              push(obj && canonicalizeStorageUrl(obj.url || obj.path || ''));
            } catch { out.push(s); }
            return;
          }
          out.push(stripWrap(s));
          return;
        }
        if (typeof v === 'object') {
          const url = canonicalizeStorageUrl(v?.url || v?.path || '');
          if (url) push(String(url));
          return;
        }
      };
      if (Array.isArray(input)) input.forEach(push);
      else if (typeof input === 'string') push(input);
      const dedup = Array.from(new Set(out));
      return dedup.filter(isValidImageUrl);
    };

    if (body.schedulePictures) {
      body.schedulePictures = flattenSchedulePictures(body.schedulePictures);
    }

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });

    // Allow creator or co-host to edit tournament (brackets and operational data)
    // Previously only the creator was allowed which blocked co-hosts from saving bracket mode.
    if (!hasAccessToTournament(tournament, req.user)) {
      return res
        .status(403)
        .json({ message: "Access denied: only the creator or co-host can edit this tournament" });
    }

    let parsedCourtAssignments = body.courtAssignments;
    if (typeof parsedCourtAssignments === "string") {
      try { parsedCourtAssignments = JSON.parse(parsedCourtAssignments); } catch { parsedCourtAssignments = null; }
    }
    body.courtAssignments = parsedCourtAssignments;

    let scheduleLockUpdate = body.scheduleLockUpdate;
    if (typeof scheduleLockUpdate === "string") {
      try { scheduleLockUpdate = JSON.parse(scheduleLockUpdate); } catch { scheduleLockUpdate = null; }
    }
    body.scheduleLockUpdate = scheduleLockUpdate;

    const requestedScheduleDate = String(
      parsedCourtAssignments?.scheduleDate ||
      scheduleLockUpdate?.date ||
      ""
    ).trim();
    const existingScheduleByDate =
      tournament.courtAssignmentsByDate && typeof tournament.courtAssignmentsByDate === "object"
        ? tournament.courtAssignmentsByDate
        : {};
    const existingScheduleDay = requestedScheduleDate
      ? existingScheduleByDate[requestedScheduleDate]
      : null;
    const isScheduleUnlockRequest = Boolean(
      scheduleLockUpdate &&
      typeof scheduleLockUpdate === "object" &&
      String(scheduleLockUpdate?.date || "").trim() === requestedScheduleDate &&
      scheduleLockUpdate?.locked === false
    );
    if (
      parsedCourtAssignments &&
      typeof parsedCourtAssignments === "object" &&
      existingScheduleDay &&
      existingScheduleDay.locked === true &&
      !isScheduleUnlockRequest
    ) {
      return res.status(423).json({
        message: "This schedule date is locked. Unlock it first before editing.",
        lockType: "schedule_date",
        scheduleDate: requestedScheduleDate,
      });
    }

    if (
      scheduleLockUpdate &&
      typeof scheduleLockUpdate === "object" &&
      String(scheduleLockUpdate?.date || "").trim()
    ) {
      const lockDate = String(scheduleLockUpdate.date || "").trim();
      const nextLocked = scheduleLockUpdate.locked === true;
      if (!tournament.courtAssignmentsByDate || typeof tournament.courtAssignmentsByDate !== "object") {
        tournament.courtAssignmentsByDate = {};
      }
      const prevDay = tournament.courtAssignmentsByDate[lockDate] && typeof tournament.courtAssignmentsByDate[lockDate] === "object"
        ? tournament.courtAssignmentsByDate[lockDate]
        : {};
      tournament.courtAssignmentsByDate[lockDate] = {
        ...prevDay,
        scheduleDate: lockDate,
        locked: nextLocked,
        lockedAt: nextLocked ? new Date() : null,
        lockedById: nextLocked ? String(req.user?._id || "") : "",
        unlockedAt: nextLocked ? null : new Date(),
        unlockedById: nextLocked ? "" : String(req.user?._id || ""),
      };
      try { tournament.markModified("courtAssignmentsByDate"); } catch (_) {}
      try {
        if (String(tournament?.courtAssignments?.scheduleDate || "").trim() === lockDate) {
          tournament.courtAssignments = {
            ...(tournament.courtAssignments || {}),
            locked: nextLocked,
            lockedAt: nextLocked ? new Date() : null,
            lockedById: nextLocked ? String(req.user?._id || "") : "",
            unlockedAt: nextLocked ? null : new Date(),
            unlockedById: nextLocked ? "" : String(req.user?._id || ""),
          };
          tournament.markModified("courtAssignments");
        }
      } catch (_) {}
    }

    const prevGuidelines = Array.isArray(tournament.guidelinePictures) ? [...tournament.guidelinePictures] : [];
    const prevSchedule = Array.isArray(tournament.schedulePictures) ? [...tournament.schedulePictures] : [];

    // ✅ Apply updates safely
    const hasNewScheduleUploads = Array.isArray(req.files?.schedulePictures) && req.files.schedulePictures.length > 0;
    const wantsClearSchedule = body.clearSchedulePictures === 'true' || body.clearSchedulePictures === true;
    const validIncomingSchedule = Array.isArray(body.schedulePictures) && body.schedulePictures.length > 0;
    const nextSchedulePictures = (() => {
      if (wantsClearSchedule && !hasNewScheduleUploads) {
        return [];
      }
      if (Array.isArray(body.schedulePictures)) {
        if (body.schedulePictures.length === 0 && !hasNewScheduleUploads) {
          return prevSchedule;
        }
        return body.schedulePictures;
      }
      return Array.isArray(tournament.schedulePictures) ? tournament.schedulePictures : [];
    })();

    // ✅ Apply courtAssignments (grid: courts, time slots, placements)
    try {
      let courtAssignments = body.courtAssignments;
      if (courtAssignments && typeof courtAssignments === "object") {
        const normalizeTs = (ts) => {
          if (typeof ts === "string") {
            return { id: "", startTime: ts, duration: "", endTime: "" };
          }
          return {
            id: String(ts?.id || ""),
            startTime: String(ts?.startTime || ""),
            duration: String(ts?.duration || ""),
            endTime: String(ts?.endTime || ""),
          };
        };
        const topTimeSlots = Array.isArray(courtAssignments.timeSlots)
          ? courtAssignments.timeSlots.map(normalizeTs)
          : [];
        const topAssignments = Array.isArray(courtAssignments.assignments)
          ? courtAssignments.assignments
          : [];
        const venuesIn = Array.isArray(courtAssignments.venues) ? courtAssignments.venues : [];
        const prevDayMeta = (() => {
          const byDate = tournament.courtAssignmentsByDate && typeof tournament.courtAssignmentsByDate === "object"
            ? tournament.courtAssignmentsByDate
            : {};
          const found = byDate[String(courtAssignments.scheduleDate || "").trim()];
          return found && typeof found === "object" ? found : {};
        })();
        const embeddedCourtAssignments = {
          ...prevDayMeta,
          courtCount: Number(courtAssignments.courtCount || 0),
          scheduleDate: String(courtAssignments.scheduleDate || ""),
          timeSlots: topTimeSlots,
          assignments: topAssignments,
          venues: venuesIn.map((v, idx) => ({
            name: String(v?.name || v?.venueName || `Venue ${idx + 1}`),
            courtCount: Number(v?.courtCount || 0),
            timeSlots: Array.isArray(v?.timeSlots) ? v.timeSlots.map(normalizeTs) : [],
            assignments: Array.isArray(v?.assignments) ? v.assignments : [],
          })),
        };
        const dkey = String(embeddedCourtAssignments.scheduleDate || "").trim();
        if (dkey) {
          if (!tournament.courtAssignmentsByDate || typeof tournament.courtAssignmentsByDate !== "object") {
            tournament.courtAssignmentsByDate = {};
          }
          tournament.courtAssignmentsByDate[dkey] = embeddedCourtAssignments;
          try { tournament.markModified("courtAssignmentsByDate"); } catch (_) {}
          try {
            const CourtAssignmentDay = require("../models/CourtAssignmentDay");
            const venuesNorm = (() => {
              const mapped = venuesIn.map((v, idx) => ({
                name: String(v?.name || v?.venueName || `Venue ${idx + 1}`),
                courtCount: Number(v?.courtCount || 0),
                timeSlots: Array.isArray(v?.timeSlots) ? v.timeSlots.map(normalizeTs) : [],
                assignments: Array.isArray(v?.assignments) ? v.assignments : [],
              }));
              const normalized = mapped.map((vv) => {
                const ts = Array.isArray(vv.timeSlots) ? vv.timeSlots : [];
                const asg = Array.isArray(vv.assignments) ? vv.assignments : [];
                const fixed = asg.map((row, r) => {
                  const rowTs = ts[r];
                  return (Array.isArray(row) ? row : []).map((cell, c) => {
                    if (!cell || typeof cell !== "object") return cell;
                    const hasSched = Boolean(
                      (rowTs && String(rowTs.startTime || "").trim() !== "") ||
                      (c >= 0)
                    );
                    const sRaw = String(cell.status || "").trim();
                    const sLow = sRaw.toLowerCase();
                    const sEff = (sLow === "unschedule" || sLow === "unscheduled") && hasSched
                      ? "Scheduled"
                      : (sRaw || (hasSched ? "Scheduled" : ""));
                    return sEff && sEff !== sRaw ? { ...cell, status: sEff } : cell;
                  });
                });
                return { ...vv, assignments: fixed };
              });
              const anyVenueData = mapped.some((vv) => (Array.isArray(vv.timeSlots) && vv.timeSlots.length) || (Array.isArray(vv.assignments) && vv.assignments.length));
              if (mapped.length === 0 && (topTimeSlots.length || topAssignments.length)) {
                return [{
                  name: "Venue 1",
                  courtCount: Number(courtAssignments.courtCount || 0),
                  timeSlots: topTimeSlots,
                  assignments: topAssignments,
                }];
              }
              if (!anyVenueData && (topTimeSlots.length || topAssignments.length)) {
                if (mapped.length > 0) {
                  mapped[0].timeSlots = topTimeSlots;
                  mapped[0].assignments = topAssignments;
                }
              }
              return normalized;
            })();
            await CourtAssignmentDay.updateOne(
              { tournamentId: tournament._id, date: dkey },
              {
                $set: {
                  tournamentId: tournament._id,
                  date: dkey,
                  courtCount: embeddedCourtAssignments.courtCount,
                  venues: venuesNorm,
                },
                $unset: { timeSlots: "", assignments: "" },
              },
              { upsert: true }
            );
            tournament.migratedCourtAssignments = true;
          } catch (_) {}

          try {
            const Match = require("../models/Match");
              const mongoose = require("mongoose");
            const canonAlias = (s) => {
              const raw = String(s || "").trim().toLowerCase();
              if (!raw) return "";
              if (raw === "finals") return "final";
              if (raw.startsWith("round16_")) return `r16-${raw.slice(8)}`;
              if (raw.startsWith("round-of-16")) return "r16-1";
              if (raw.startsWith("quarter")) return raw.replace("quarter", "qf").replace(/[^a-z0-9-]/g, "");
              if (raw.startsWith("semi")) return raw.replace("semi", "sf").replace(/[^a-z0-9-]/g, "");
              return raw;
            };
            const aliasToRound = (a) => {
              if (!a) return "";
              if (a === "final") return "Final";
              if (a === "bronze") return "Bronze";
              if (a.startsWith("sf")) return "SF";
              if (a.startsWith("qf")) return "QF";
              if (a.startsWith("r16")) return "Round of 16";
              return "";
            };
            const toISO = (ymd) => {
              const s = String(ymd || "").trim();
              if (!s) return undefined;
              try { return new Date(`${s}T00:00:00.000Z`); } catch { return undefined; }
            };
            const dayDateISO = toISO(dkey);
            const presentByCat = new Map();
            if (Array.isArray(venuesNorm) && venuesNorm.length) {
              for (const venue of venuesNorm) {
                const courts = Number(venue?.courtCount || 0);
                const ts = Array.isArray(venue?.timeSlots) ? venue.timeSlots : [];
                const ass = Array.isArray(venue?.assignments) ? venue.assignments : [];
                for (let r = 0; r < ts.length; r++) {
                  const row = Array.isArray(ass[r]) ? ass[r] : [];
                  for (let c = 0; c < Math.max(courts, row.length); c++) {
                    const cell = row[c];
                    const id = String(cell?.id || "").trim();
                    if (!id.toLowerCase().startsWith("elim-")) continue;
                    const parts = id.split("-");
                    if (parts.length < 3) continue;
                    const catIdStr = parts[1];
                    let catIdObj = null;
                    try { catIdObj = new mongoose.Types.ObjectId(catIdStr); } catch { catIdObj = null; }
                    const matchPart = parts.slice(2).join("-");
                    const matchKeyRaw = matchPart.replace(/-g\d+$/i, "");
                    const alias = canonAlias(matchKeyRaw);
                    const round = aliasToRound(alias);
                    if (!round) continue;
                    if (!presentByCat.has(catIdStr)) presentByCat.set(catIdStr, { scheduled: new Set() });
                    const sRaw = String(cell?.status || "").trim();
                    const sLow = sRaw.toLowerCase();
                    const effectiveTime = String(ts[r]?.startTime || "").trim();
                    const effectiveCourt = String(cell?.court || (c + 1) || "").trim();
                    const hasSched = sLow === "scheduled";
                    const payload = {
                      date: dayDateISO,
                      time: hasSched ? effectiveTime : "",
                      court: hasSched ? String(effectiveCourt) : "",
                      status: hasSched ? "Scheduled" : "Unscheduled",
                    };
                    try {
                      const orFilters = [];
                      if (alias) orFilters.push({ "meta.matchId": alias });
                      if (round) {
                        orFilters.push({ round });
                        const rx = (() => {
                          if (alias === "final") return /final/i;
                          if (alias === "bronze") return /bronze/i;
                          if (alias.startsWith("sf")) return /semi/i;
                          if (alias.startsWith("qf")) return /quarter/i;
                          if (alias.startsWith("r16")) return /round.*16/i;
                          return null;
                        })();
                        if (rx) orFilters.push({ round: rx });
                      }
                    if (orFilters.length > 0) {
                        await Match.updateMany(
                          {
                            tournamentId: tournament._id,
                            categoryId: catIdObj || catIdStr,
                            stage: "elimination",
                            $or: orFilters,
                          },
                          {
                            $set: {
                              date: payload.date,
                              time: payload.time,
                              court: payload.court,
                            },
                          },
                          { upsert: false }
                        );
                        await Match.updateMany(
                          {
                            tournamentId: tournament._id,
                            categoryId: catIdObj || catIdStr,
                            stage: "elimination",
                            $and: [
                              { $or: orFilters },
                              { status: { $nin: ["Ongoing", "Completed"] } },
                            ],
                          },
                          { $set: { status: payload.status } },
                          { upsert: false }
                        );
                        await Match.updateMany(
                          {
                            tournamentId: tournament._id,
                             categoryId: catIdObj || catIdStr,
                            stage: "elimination",
                            $and: [
                              { $or: orFilters },
                              { $or: [{ "meta.matchId": { $exists: false } }, { "meta.matchId": "" }] },
                            ],
                          },
                          { $set: { "meta.matchId": alias } },
                          { upsert: false }
                        );
                        if (hasSched && alias) {
                          try {
                            presentByCat.get(catIdStr).scheduled.add(alias);
                          } catch {}
                        }
                      }
                    } catch {}
                  }
                }
              }
              // Unschedule elimination matches on this date that are no longer present on the grid
              if (presentByCat.size === 0) {
                // No elimination cells at all for this date: unschedule all elimination matches on this day (safe for non-ongoing/completed)
                try {
                  await Match.updateMany(
                    {
                      tournamentId: tournament._id,
                      stage: "elimination",
                      date: dayDateISO,
                      status: { $nin: ["Ongoing", "Completed"] },
                    },
                    { $set: { status: "Unscheduled", time: "", court: "" } },
                    { upsert: false }
                  );
                } catch {}
              } else {
                for (const [catIdStr, sets] of presentByCat.entries()) {
                  const aliases = Array.from(sets.scheduled || new Set());
                  let catIdObj = null;
                  try { catIdObj = new mongoose.Types.ObjectId(catIdStr); } catch { catIdObj = null; }
                  try {
                    // Final safeguard: for all elimination matches on this date with populated time+court,
                    // flip to Scheduled unless already Ongoing/Completed
                    await Match.updateMany(
                      {
                        tournamentId: tournament._id,
                        categoryId: catIdObj || catIdStr,
                        stage: "elimination",
                        date: dayDateISO,
                        time: { $nin: [null, "", "TBD", "tbd"] },
                        court: { $nin: [null, "", "TBD", "tbd"] },
                        status: { $nin: ["Ongoing", "Completed"] },
                      },
                      { $set: { status: "Scheduled" } },
                      { upsert: false }
                    );
                    // Unschedule those not present by alias (or lacking alias), regardless of round
                    await Match.updateMany(
                      {
                        tournamentId: tournament._id,
                        categoryId: catIdObj || catIdStr,
                        stage: "elimination",
                        date: dayDateISO,
                        status: { $nin: ["Ongoing", "Completed"] },
                        $or: [
                          { "meta.matchId": { $exists: false } },
                          { "meta.matchId": "" },
                          { "meta.matchId": { $nin: aliases } },
                        ],
                      },
                      { $set: { status: "Unscheduled", time: "", court: "" } },
                      { upsert: false }
                    );
                  } catch {}
                }
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}

    // ✅ Fallback: apply group (round robin) schedule directly from courtAssignments grid
    try {
      let courtAssignments = body.courtAssignments;
      if (courtAssignments && typeof courtAssignments === "object") {
        const normalizeTs = (ts) => {
          if (typeof ts === "string") return { startTime: ts };
          return { startTime: String(ts?.startTime || "") };
        };
        const venuesIn = Array.isArray(courtAssignments.venues) ? courtAssignments.venues : [];
        const topTimeSlots = Array.isArray(courtAssignments.timeSlots) ? courtAssignments.timeSlots.map(normalizeTs) : [];
        const topAssignments = Array.isArray(courtAssignments.assignments) ? courtAssignments.assignments : [];
        const venuesNorm = (() => {
          if (venuesIn.length > 0) return venuesIn;
          return [{ name: "Venue 1", timeSlots: topTimeSlots, assignments: topAssignments }];
        })();
        const toISO = (ymd) => {
          const s = String(ymd || "").trim();
          if (!s) return undefined;
          try { return new Date(`${s}T00:00:00.000Z`); } catch { return undefined; }
        };
        const dayDateISO = toISO(String(courtAssignments.scheduleDate || "").trim());
        const Match = require("../models/Match");
        for (const ven of venuesNorm) {
          const rows = Array.isArray(ven?.assignments) ? ven.assignments : [];
          const ts = Array.isArray(ven?.timeSlots) ? ven.timeSlots : [];
          for (let r = 0; r < rows.length; r++) {
            const row = Array.isArray(rows[r]) ? rows[r] : [];
            const t = ts[r] && typeof ts[r] === "object" ? String(ts[r].startTime || "").trim() : (typeof ts[r] === "string" ? ts[r] : "");
            for (let c = 0; c < row.length; c++) {
              const cell = row[c];
              const idRaw = String(cell?.id || "").trim();
              const m = idRaw.match(/^rr-([a-f0-9]{24})-group-([a-z])-(.+?)-g\d+$/i);
              if (!m) continue;
              const catIdStr = m[1];
              const letter = m[2].toLowerCase();
              const mk = m[3];
              const groupId = `group-${letter}`;
              const sRaw = String(cell?.status || "").trim().toLowerCase();
              const isSched = sRaw === "scheduled" || sRaw === "ongoing" || sRaw === "completed";
              const dateVal = isSched ? dayDateISO : null;
              const timeVal = isSched ? String(cell?.time || t || "").trim() : "";
              const courtVal = isSched ? String(cell?.court || String(c + 1)).trim() : "";
              const statusVal = isSched ? (sRaw === "ongoing" ? "Ongoing" : (sRaw === "completed" ? "Completed" : "Scheduled")) : "Unscheduled";
              try {
                await Match.updateMany(
                  {
                    tournamentId: tournament._id,
                    categoryId: catIdStr,
                    stage: "group",
                    groupId,
                    matchKey: String(mk || ""),
                    $or: [
                      { date: { $ne: dateVal } },
                      { time: { $ne: String(timeVal || "") } },
                      { court: { $ne: String(courtVal || "") } },
                      { status: { $ne: String(statusVal || "") } },
                    ],
                  },
                  {
                    $set: {
                      date: dateVal,
                      time: timeVal,
                      court: courtVal,
                      status: statusVal,
                    },
                  },
                  { upsert: false }
                );
              } catch {}
            }
          }
        }
      }
    } catch (_) {}

    // ✅ Apply bracketUpdates (time/date/court) coming from Schedule Assignments
    try {
      let bracketUpdates = body.bracketUpdates;
      let eliminationUpdates = body.eliminationUpdates;
      if (typeof bracketUpdates === "string") {
        try { bracketUpdates = JSON.parse(bracketUpdates); } catch { bracketUpdates = {}; }
      }
      if (typeof eliminationUpdates === "string") {
        try { eliminationUpdates = JSON.parse(eliminationUpdates); } catch { eliminationUpdates = {}; }
      }
      if (bracketUpdates && typeof bracketUpdates === "object") {
        const Match = require("../models/Match");
        const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
        const hasDupr = (m) => {
          try {
            const mm = (m && typeof m === "object") ? m : {};
            if (Boolean(mm.duprMatchCode) && !Boolean(mm.duprDeletedUpstream)) return true;
            const g = mm.duprGames && typeof mm.duprGames === "object" ? mm.duprGames : {};
            return Object.keys(g).some((k) => {
              const info = g[k] || {};
              const code = String(info?.matchCode || "").trim();
              const deleted = Boolean(info?.deletedUpstream || mm.duprDeletedUpstream);
              return Boolean(code) && !deleted;
            });
          } catch {
            return false;
          }
        };
        const hasScores = (m) => {
          try {
            const mm = (m && typeof m === "object") ? m : {};
            const nums = [
              mm.game1Player1, mm.game1Player2,
              mm.game2Player1, mm.game2Player2,
              mm.game3Player1, mm.game3Player2,
              mm.finalScorePlayer1, mm.finalScorePlayer2,
            ].map((x) => Number(x) || 0);
            if (nums.some((n) => n > 0)) return true;
            const s = mm.scores || {};
            const games = [s.game1, s.game2, s.game3, s.final].filter(Boolean);
            if (games.some((g) => (Number(g?.team1) || 0) > 0 || (Number(g?.team2) || 0) > 0)) return true;
            const md = Array.isArray(mm.mdScores) ? mm.mdScores : null;
            const wd = Array.isArray(mm.wdScores) ? mm.wdScores : null;
            const xd = Array.isArray(mm.xdScores) ? mm.xdScores : null;
            const anyArr = [md, wd, xd].filter(Boolean).flat();
            if (anyArr.some((x) => Number(x) > 0)) return true;
            return false;
          } catch {
            return false;
          }
        };
        const scheduleLocked = (m) => {
          const statusLow = String(m?.status || "").trim().toLowerCase();
          if (statusLow === "ongoing" || statusLow === "completed") return true;
          if (hasScores(m)) return true;
          if (hasDupr(m)) return true;
          return false;
        };
        for (const catIdStr of Object.keys(bracketUpdates || {})) {
          const catIndex = categories.findIndex((c) => String(c._id) === String(catIdStr));
          if (catIndex < 0) continue;
          const cat = categories[catIndex];
          const groups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
          const updatesForCat = bracketUpdates[catIdStr] || {};
          
          console.log(`[UPDATE-TOURNAMENT] Processing bracketUpdates for category ${catIdStr}`);
          for (const groupId of Object.keys(updatesForCat)) {
            const groupIndex = groups.findIndex((g) => String(g?.id || "") === String(groupId));
            if (groupIndex < 0) continue;
            const group = groups[groupIndex];
            const matches = (group.matches && typeof group.matches === "object") ? group.matches : {};
            const updatesForGroup = updatesForCat[groupId] || {};
            
            const matchCountBefore = Object.keys(matches).length;
            const matchKeysBefore = Object.keys(matches);
            
            // CRITICAL: If group has very few matches, this might indicate data loss
            // Log a warning if match count seems too low (less than 3 for a typical group)
            if (matchCountBefore < 3 && matchCountBefore > 0) {
              console.warn(`[UPDATE-TOURNAMENT] WARNING: Group ${groupId} has only ${matchCountBefore} matches. This might indicate data loss.`, {
                matchKeys: matchKeysBefore,
                groupId: group.id,
                hasOriginalPlayers: !!group.originalPlayers,
                originalPlayerCount: Array.isArray(group.originalPlayers) ? group.originalPlayers.length : 0
              });
            }
            
            console.log(`[UPDATE-TOURNAMENT] Group ${groupId}: ${matchCountBefore} matches before update`);
            for (const matchKey of Object.keys(updatesForGroup)) {
              const upd = updatesForGroup[matchKey] || {};
              const current = matches[matchKey] || {};
              const hasDate = Object.prototype.hasOwnProperty.call(upd, 'date');
              const hasTime = Object.prototype.hasOwnProperty.call(upd, 'time');
              const hasCourt = Object.prototype.hasOwnProperty.call(upd, 'court');
              const hasVenue = Object.prototype.hasOwnProperty.call(upd, 'venue');
              const hasStatus = Object.prototype.hasOwnProperty.call(upd, 'status');
              
              // CRITICAL: Only update fields that are explicitly provided AND have meaningful values
              // If a field is not in the update, preserve the existing value
              // If a field is empty string, only clear it if status is being set to "Unschedule"
              const dateVal = hasDate ? String(upd.date || '').trim() : undefined;
              const timeVal = hasTime ? String(upd.time || '').trim() : undefined;
              const courtVal = hasCourt ? String(upd.court || '').trim() : undefined;
              const venueVal = hasVenue ? String(upd.venue || '').trim() : undefined;
              const statusVal = hasStatus ? String(upd.status || '').trim() : undefined;
              
              // Only update if value is provided AND meaningful (not empty)
              // OR if explicitly clearing (empty string) AND status is "Unschedule"
              const isUnschedule = statusVal === 'Unschedule' || statusVal === 'unschedule';
              const shouldClearSchedule = isUnschedule && (hasDate || hasTime || hasCourt);
              
              const finalDate = hasDate 
                ? (dateVal !== '' ? dateVal : (shouldClearSchedule ? '' : (current.date || current.mdDate || undefined)))
                : (current.date || current.mdDate || undefined);
              const finalTime = hasTime 
                ? (timeVal !== '' ? timeVal : (shouldClearSchedule ? '' : (current.time || current.mdTime || undefined)))
                : (current.time || current.mdTime || undefined);
              const finalCourt = hasCourt 
                ? (courtVal !== '' ? courtVal : (shouldClearSchedule ? '' : current.court))
                : current.court;
              const finalVenue = hasVenue 
                ? (venueVal !== '' ? venueVal : (shouldClearSchedule ? '' : current.venue))
                : current.venue;
              // CRITICAL: If date, time, and court are all provided, automatically set status to "Scheduled"
              // This ensures matches in the schedule grid are marked as scheduled
              const hasAllScheduleInfo = finalDate && finalTime && finalCourt && 
                                         String(finalDate).trim() !== '' && 
                                         String(finalTime).trim() !== '' && 
                                         String(finalCourt).trim() !== '';
              
              // Determine final status:
              // 1. If status is explicitly provided in web scheduler save, USE IT as ground truth
              // 2. If all schedule info is provided and status omitted, auto-set to "Scheduled" (but don't override Ongoing/Completed)
              // 3. Otherwise, preserve existing status
              const norm = (v) => String(v || '').trim();
              const low = (v) => norm(v).toLowerCase();
              const existingNorm = norm(current.status);
              const existingLow = low(current.status);
              let finalStatus;
              if (hasStatus && statusVal !== '') {
                // Web scheduler explicitly changed status; accept it
                finalStatus = norm(statusVal);
              } else if (hasAllScheduleInfo) {
                if (existingLow !== 'ongoing' && existingLow !== 'completed') {
                  finalStatus = 'Scheduled';
                  console.log(`[UPDATE-TOURNAMENT] Auto-setting match ${matchKey} to "Scheduled" - has date, time, and court`);
                } else {
                  finalStatus = existingNorm;
                }
              } else {
                finalStatus = existingNorm;
              }

              try {
                const curDate0 = String(current?.date || current?.mdDate || "").trim();
                const curTime0 = String(current?.time || current?.mdTime || "").trim();
                const curCourt0 = String(current?.court || "").trim();
                const curVenue0 = String(current?.venue || "").trim();
                const curStatus0 = String(current?.status || "").trim();
                const nextDate0 = String(finalDate || "").trim();
                const nextTime0 = String(finalTime || "").trim();
                const nextCourt0 = String(finalCourt || "").trim();
                const nextVenue0 = String(finalVenue || "").trim();
                const nextStatus0 = String(finalStatus || "").trim();
                const changed =
                  curDate0 !== nextDate0 ||
                  curTime0 !== nextTime0 ||
                  curCourt0 !== nextCourt0 ||
                  curVenue0 !== nextVenue0 ||
                  curStatus0 !== nextStatus0;
                if (changed && scheduleLocked(current)) {
                  const reason = hasDupr(current)
                    ? "DUPR Lock"
                    : (hasScores(current) ? "Score/Participant Lock" : "Schedule Lock");
                  return res.status(409).json({
                    message: `Schedule is locked for this match (${reason}).`,
                    lockType: "schedule",
                    reason,
                    categoryId: String(catIdStr),
                    groupId: String(groupId),
                    matchKey: String(matchKey),
                  });
                }
              } catch (_) {}
              
              console.log(`[UPDATE-TOURNAMENT] Match ${matchKey} status update:`, {
                hasStatus,
                statusVal,
                hasAllScheduleInfo,
                finalDate: finalDate ? 'yes' : 'no',
                finalTime: finalTime ? 'yes' : 'no',
                finalCourt: finalCourt ? 'yes' : 'no',
                currentStatus: current.status,
                finalStatus
              });
              
              // CRITICAL: Preserve ALL existing fields, only update what's being changed
              // IMPORTANT: If current match doesn't exist, we're creating a new match
              // But we should preserve ALL fields from the existing match if it exists
              if (!current || Object.keys(current).length === 0) {
                console.warn(`[UPDATE-TOURNAMENT] WARNING: Creating new match ${matchKey} in group ${groupId}. This might indicate data loss.`);
              }
              
              matches[matchKey] = {
                ...current,  // Preserve all existing fields (scores, signatures, game data, etc.)
                // Only set fields if they have values or are being explicitly cleared
                ...(finalDate !== undefined ? { date: finalDate } : {}),
                ...(finalDate !== undefined ? { mdDate: finalDate } : {}),
                ...(finalTime !== undefined ? { time: finalTime } : {}),
                ...(finalTime !== undefined ? { mdTime: finalTime } : {}),
                ...(finalCourt !== undefined ? { court: finalCourt } : {}),
                ...(finalVenue !== undefined ? { venue: finalVenue } : {}),
                ...(finalStatus !== undefined ? { status: finalStatus } : {}),
              };
              
              // CRITICAL: Verify the match still has all its data after update
              const updatedMatch = matches[matchKey];
              if (current && Object.keys(current).length > 0 && !shouldClearSchedule && !isUnschedule) {
                // If original match had schedule data, verify it's still there
                if (current.date && !updatedMatch.date) {
                  console.error(`[UPDATE-TOURNAMENT] CRITICAL: Match ${matchKey} lost date! Restoring...`);
                  updatedMatch.date = current.date;
                  if (current.mdDate) updatedMatch.mdDate = current.mdDate;
                }
                if (current.time && !updatedMatch.time) {
                  console.error(`[UPDATE-TOURNAMENT] CRITICAL: Match ${matchKey} lost time! Restoring...`);
                  updatedMatch.time = current.time;
                  if (current.mdTime) updatedMatch.mdTime = current.mdTime;
                }
                if (current.court && !updatedMatch.court) {
                  console.error(`[UPDATE-TOURNAMENT] CRITICAL: Match ${matchKey} lost court! Restoring...`);
                  updatedMatch.court = current.court;
                }
              }
              
              console.log(`[UPDATE-TOURNAMENT] Updated match ${matchKey}:`, {
                hasDate, hasTime, hasCourt, hasStatus,
                dateVal, timeVal, courtVal, statusVal,
                finalDate, finalTime, finalCourt, finalStatus,
                currentStatus: current.status,
                isUnschedule,
                shouldClearSchedule
              });
              
              // Also update the normalized Match collection for group-stage matches
              try {
                const findMatch = {
                  tournamentId: tournament._id,
                  categoryId: cat._id || catIdStr,
                  stage: "group",
                  groupId: String(group?.id || ""),
                  matchKey: String(matchKey || ""),
                };
                const statusForFields = String(finalStatus || "").trim();
                // When unscheduling, clear schedule fields
                const clearSchedule = /^(unschedule|unscheduled)$/i.test(statusForFields) || (!finalDate && !finalTime && !finalCourt);
                const nextDate = clearSchedule ? null : (finalDate || null);
                const nextTime = clearSchedule ? "" : (finalTime || "");
                const nextCourt = clearSchedule ? "" : (finalCourt || "");
                const nextStatus = statusForFields || "";
                await Match.updateMany(
                  { 
                    ...findMatch,
                    $or: [
                      { date: { $ne: nextDate } },
                      { time: { $ne: nextTime } },
                      { court: { $ne: nextCourt } },
                      { status: { $ne: nextStatus } },
                    ]
                  },
                  {
                    $set: {
                      date: nextDate,
                      time: nextTime,
                      court: nextCourt,
                      status: nextStatus,
                    },
                  },
                  { upsert: false }
                );
                // Normalize legacy spelling and ensure status reflects fields for non-Ongoing/Completed
                await Match.updateMany(
                  { ...findMatch, status: "Unschedule" },
                  { $set: { status: "Unscheduled" } },
                  { upsert: false }
                );
                await Match.updateMany(
                  { 
                    ...findMatch, 
                    status: { $nin: ["Ongoing", "Completed"] },
                    date: { $ne: null }, 
                    time: { $ne: "" }, 
                    court: { $ne: "" } 
                  },
                  { $set: { status: "Scheduled" } },
                  { upsert: false }
                );
                await Match.updateMany(
                  { 
                    ...findMatch, 
                    status: { $nin: ["Ongoing", "Completed"] },
                    $or: [ { date: null }, { time: "" }, { court: "" } ] 
                  },
                  { $set: { status: "Unscheduled" } },
                  { upsert: false }
                );
              } catch (e) {
                console.error(`[UPDATE-TOURNAMENT] Failed to update Match collection for group match ${group?.id}/${matchKey}:`, e?.message || e);
              }
            }
            
            const matchCountAfter = Object.keys(matches).length;
            const matchKeysAfter = Object.keys(matches);
            console.log(`[UPDATE-TOURNAMENT] Group ${groupId}: ${matchCountAfter} matches after update`);
            
            // CRITICAL: If match count increased, we're creating new matches (this is OK from web scheduler)
            // But if match count decreased, we've lost matches (this is BAD)
            if (matchCountAfter < matchCountBefore) {
              console.error(`[UPDATE-TOURNAMENT] CRITICAL ERROR: Lost matches! Before: ${matchCountBefore}, After: ${matchCountAfter}`);
              console.error(`[UPDATE-TOURNAMENT] Before keys: ${matchKeysBefore.join(', ')}`);
              console.error(`[UPDATE-TOURNAMENT] After keys: ${matchKeysAfter.join(', ')}`);
              console.error(`[UPDATE-TOURNAMENT] Missing keys: ${matchKeysBefore.filter(k => !matchKeysAfter.includes(k)).join(', ')}`);
              // DON'T proceed if we've lost matches - abort the save
              return res.status(500).json({ 
                message: "Critical error: Matches were lost during update. Save aborted to prevent data loss.",
                groupId: groupId,
                beforeCount: matchCountBefore,
                afterCount: matchCountAfter,
                missingKeys: matchKeysBefore.filter(k => !matchKeysAfter.includes(k))
              });
            }
            
            // If match count increased, log it (this is expected when web scheduler creates new matches)
            if (matchCountAfter > matchCountBefore) {
              console.log(`[UPDATE-TOURNAMENT] Match count increased: Before: ${matchCountBefore}, After: ${matchCountAfter} (web scheduler creating new matches)`);
            }
            
            group.matches = matches;
            try {
              tournament.markModified(`tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.matches`);
            } catch (_) {}
          }
          try { tournament.markModified(`tournamentCategories.${catIndex}.groupStage.groups`); } catch (_) {}
        }
        try { tournament.markModified('tournamentCategories'); } catch (_) {}
      }
    } catch (_) {}

    // ✅ Apply eliminationUpdates directly to Match collection by alias
    try {
      let eliminationUpdates = body.eliminationUpdates;
      if (typeof eliminationUpdates === "string") {
        try { eliminationUpdates = JSON.parse(eliminationUpdates); } catch { eliminationUpdates = {}; }
      }
      if (eliminationUpdates && typeof eliminationUpdates === "object") {
        const Match = require("../models/Match");
        const hasDupr = (m) => {
          try {
            const mm = (m && typeof m === "object") ? m : {};
            if (Boolean(mm.duprMatchCode) && !Boolean(mm.duprDeletedUpstream)) return true;
            const g = mm.duprGames && typeof mm.duprGames === "object" ? mm.duprGames : {};
            return Object.keys(g).some((k) => {
              const info = g[k] || {};
              const code = String(info?.matchCode || "").trim();
              const deleted = Boolean(info?.deletedUpstream || mm.duprDeletedUpstream);
              return Boolean(code) && !deleted;
            });
          } catch {
            return false;
          }
        };
        const hasScores = (m) => {
          try {
            const mm = (m && typeof m === "object") ? m : {};
            const nums = [
              mm.game1Player1, mm.game1Player2,
              mm.game2Player1, mm.game2Player2,
              mm.game3Player1, mm.game3Player2,
              mm.finalScorePlayer1, mm.finalScorePlayer2,
            ].map((x) => Number(x) || 0);
            if (nums.some((n) => n > 0)) return true;
            const s = mm.scores || {};
            const games = [s.game1, s.game2, s.game3, s.final].filter(Boolean);
            if (games.some((g) => (Number(g?.team1) || 0) > 0 || (Number(g?.team2) || 0) > 0)) return true;
            return false;
          } catch {
            return false;
          }
        };
        const scheduleLocked = (m) => {
          const statusLow = String(m?.status || "").trim().toLowerCase();
          if (statusLow === "ongoing" || statusLow === "completed") return true;
          if (hasScores(m)) return true;
          if (hasDupr(m)) return true;
          return false;
        };
        for (const catIdStr of Object.keys(eliminationUpdates)) {
          const updatesForCat = eliminationUpdates[catIdStr] || {};
          let catIdObj = null;
          try { catIdObj = new mongoose.Types.ObjectId(catIdStr); } catch { catIdObj = null; }
          for (const aliasKey of Object.keys(updatesForCat)) {
            const upd = updatesForCat[aliasKey] || {};
            const alias = canonAlias(aliasKey);
            const round = aliasToRound(alias);
            if (!round) continue;
            const dateVal = String(upd?.date || "").trim();
            const timeVal = String(upd?.time || "").trim();
            const courtVal = String(upd?.court || "").trim();
            const statusValRaw = String(upd?.status || "").trim();
            const statusVal = statusValRaw === "Unschedule" ? "Unscheduled" : statusValRaw;
            const findBase = {
              tournamentId: tournament._id,
              categoryId: catIdObj || catIdStr,
              stage: "elimination",
            };
            // Primary: match by meta.matchId when present or set it
            const orFilters = [{ "meta.matchId": alias }];
            // Fallback by round name regex
            const rx = (() => {
              if (alias === "final") return /final/i;
              if (alias === "bronze") return /bronze/i;
              if (alias.startsWith("sf")) return /semi/i;
              if (alias.startsWith("qf")) return /quarter/i;
              if (alias.startsWith("r16")) return /round.*16/i;
              return null;
            })();
            if (rx) orFilters.push({ round: rx });
            try {
              const existing = await Match.findOne({ ...findBase, $or: orFilters }).lean();
              if (existing && scheduleLocked(existing)) {
                const reason = hasDupr(existing)
                  ? "DUPR Lock"
                  : (hasScores(existing) ? "Score/Participant Lock" : "Schedule Lock");
                return res.status(409).json({
                  message: `Schedule is locked for this elimination match (${reason}).`,
                  lockType: "schedule",
                  reason,
                  categoryId: String(catIdStr),
                  matchKey: alias,
                });
              }
            } catch (_) {}
            await Match.updateMany(
              { ...findBase, $or: orFilters },
              {
                $set: {
                  date: statusVal === "Unscheduled" ? null : (dateVal || null),
                  time: statusVal === "Unscheduled" ? "" : (timeVal || ""),
                  court: statusVal === "Unscheduled" ? "" : (courtVal || ""),
                  status: statusVal || ""
                },
                $setOnInsert: { "meta.matchId": alias },
              },
              { upsert: false }
            );
            // Normalize legacy "Unschedule" spelling to "Unscheduled"
            await Match.updateMany(
              { ...findBase, $or: orFilters, status: "Unschedule" },
              { $set: { status: "Unscheduled" } },
              { upsert: false }
            );
            // Ensure status reflects fields for non-Ongoing/Completed
            await Match.updateMany(
              { 
                ...findBase, 
                $or: orFilters, 
                status: { $nin: ["Ongoing", "Completed"] },
                date: { $ne: null }, 
                time: { $ne: "" }, 
                court: { $ne: "" } 
              },
              { $set: { status: "Scheduled" } },
              { upsert: false }
            );
            await Match.updateMany(
              { 
                ...findBase, 
                $or: orFilters, 
                status: { $nin: ["Ongoing", "Completed"] },
                $or: [ { date: null }, { time: "" }, { court: "" } ] 
              },
              { $set: { status: "Unscheduled" } },
              { upsert: false }
            );
            // Ensure meta.matchId is stored for future exact matching
            await Match.updateMany(
              { ...findBase, $or: orFilters, $or: [{ "meta.matchId": { $exists: false } }, { "meta.matchId": "" }] },
              { $set: { "meta.matchId": alias } },
              { upsert: false }
            );
          }
        }
      }
    } catch (_) {}

    // Normalize payment methods if provided
    if (Array.isArray(body.paymentMethods)) {
      body.paymentMethods = body.paymentMethods.map((pm) => {
        const next = { ...pm };
        if (typeof next.qrCodeImage === 'string') {
          next.qrCodeImage = canonicalizeStorageUrl(next.qrCodeImage);
        }
        return next;
      });
    }

    // Compute next date fields
    const hasIncomingDates = Object.prototype.hasOwnProperty.call(body, 'tournamentDates');
    const nextTournamentDates = hasIncomingDates ? normalizeDatesArray(body.tournamentDates) : tournament.tournamentDates;
    const nextRegistrationDeadline = Object.prototype.hasOwnProperty.call(body, 'registrationDeadline')
      ? normalizeSingleDate(body.registrationDeadline) || tournament.registrationDeadline
      : tournament.registrationDeadline;
    const nextRegistrationOpensAt = Object.prototype.hasOwnProperty.call(body, 'registrationOpensAt')
      ? normalizeSingleDate(body.registrationOpensAt)
      : tournament.registrationOpensAt;
    const nextRegistrationClosesAt = Object.prototype.hasOwnProperty.call(body, 'registrationClosesAt')
      ? normalizeSingleDate(body.registrationClosesAt)
      : tournament.registrationClosesAt;

    Object.assign(tournament, {
      tournamentName: body.tournamentName || tournament.tournamentName,
      poweredBy: body.poweredBy !== undefined ? body.poweredBy : tournament.poweredBy,
      host: body.host !== undefined ? body.host : tournament.host,
      description: body.description || tournament.description,
      registrationInstructions:
        body.registrationInstructions || tournament.registrationInstructions,
      registrationDeadline: nextRegistrationDeadline,
      registrationOpensAt: nextRegistrationOpensAt,
      registrationClosesAt: nextRegistrationClosesAt,
      tournamentDates: nextTournamentDates,
      category: body.category || tournament.category,
      skillLevel: body.skillLevel || tournament.skillLevel,
      duprRequirement: (typeof body.duprRequirement === 'string' && body.duprRequirement)
        ? String(body.duprRequirement).toUpperCase()
        : tournament.duprRequirement,
      entryFeeMin: body.entryFeeMin
        ? Number(body.entryFeeMin)
        : tournament.entryFeeMin,
      entryFeeMax: body.entryFeeMax
        ? Number(body.entryFeeMax)
        : tournament.entryFeeMax,
      prizePool: body.prizePool || tournament.prizePool,
      venueName: body.venueName || tournament.venueName,
      venueAddress: body.venueAddress || tournament.venueAddress,
      venueCity: body.venueCity || tournament.venueCity,
      venueState: body.venueState || tournament.venueState,
      venueZip: body.venueZip || tournament.venueZip,
      contactEmail: body.contactEmail || tournament.contactEmail,
      contactPhone: body.contactPhone || tournament.contactPhone,
      rules: body.rules || tournament.rules,
      events: body.events || tournament.events,
      paymentMethods: body.paymentMethods || tournament.paymentMethods,
      additionalInfo: body.additionalInfo || tournament.additionalInfo,
      guidelinePictures: Array.isArray(body.guidelinePictures)
        ? body.guidelinePictures
        : (tournament.guidelinePictures || []),
      schedulePictures: nextSchedulePictures,
    });

    try {
      const firstYmd = (() => {
        const baseDate = Array.isArray(tournament.tournamentDates) && tournament.tournamentDates.length
          ? tournament.tournamentDates[0]
          : nextRegistrationDeadline;
        return toYMD(baseDate);
      })();
      if (firstYmd) {
        (tournament.tournamentCategories || []).forEach((cat) => {
          try {
            if (cat?.groupStage?.groups && Array.isArray(cat.groupStage.groups)) {
              cat.groupStage.groups.forEach((g) => {
                const matches = g?.matches || {};
                Object.keys(matches || {}).forEach((k) => {
                  const m = matches[k] || {};
                  if (!m.date || String(m.date).trim() === '') m.date = firstYmd;
                  if (!m.mdDate || String(m.mdDate).trim() === '') m.mdDate = firstYmd;
                  if (!m.wdDate || String(m.wdDate).trim() === '') m.wdDate = firstYmd;
                  if (!m.xdDate || String(m.xdDate).trim() === '') m.xdDate = firstYmd;
                });
              });
            }
            if (cat?.eliminationMatches?.matches && Array.isArray(cat.eliminationMatches.matches)) {
              cat.eliminationMatches.matches = cat.eliminationMatches.matches.map((m) => {
                const next = { ...(m || {}) };
                if (!next.date || String(next.date).trim() === '') next.date = firstYmd;
                return next;
              });
            }
          } catch {}
        });
      }
    } catch {}

    // Apply explicit QR clears
    try {
      const toClear = (() => {
        if (Array.isArray(body.clearPaymentQrIds)) return body.clearPaymentQrIds;
        if (typeof body.clearPaymentQrIds === 'string') {
          try { const arr = JSON.parse(body.clearPaymentQrIds); return Array.isArray(arr) ? arr : []; } catch { return []; }
        }
        return [];
      })();
      if (Array.isArray(toClear) && toClear.length > 0 && Array.isArray(tournament.paymentMethods)) {
        tournament.paymentMethods = tournament.paymentMethods.map((pm) => {
          if (toClear.includes(pm.id) || toClear.includes(String(pm.id))) {
            return { ...pm, qrCodeImage: '' };
          }
          return pm;
        });
      }
    } catch (_) {}

    // Compute removed images for storage deletion
    try {
      const canon = (u) => {
        try { return canonicalizeStorageUrl(String(u || '').trim()); } catch { return String(u || '').trim(); }
      };
      const toSet = new Set((tournament.schedulePictures || []).map((u) => canon(u)));
      const removedSchedule = prevSchedule.filter((u) => !toSet.has(canon(u)));
      const { deleteFromGCSByUrl } = require('../utils/gcs');
      await Promise.all(removedSchedule.map((u) => deleteFromGCSByUrl(u)).filter(Boolean));
    } catch (_) {}
    try {
      const toSet = new Set((tournament.guidelinePictures || []).map((u) => String(u || '').trim()));
      const removedGuidelines = prevGuidelines.filter((u) => !toSet.has(String(u || '').trim()));
      const { deleteFromGCSByUrl } = require('../utils/gcs');
      await Promise.all(removedGuidelines.map((u) => deleteFromGCSByUrl(u)).filter(Boolean));
    } catch (_) {}

    // ✅ Update brackets (with matches & standings)
    if (body.tournamentCategories) {

      // Build lookup maps
      const existingList = Array.isArray(tournament.tournamentCategories)
        ? tournament.tournamentCategories.map((cat) =>
            typeof cat.toObject === "function" ? cat.toObject() : cat,
          )
        : [];
      const existingById = new Map();
      existingList.forEach((cat) => {
        const idStr = cat?._id ? cat._id.toString() : undefined;
        if (idStr) existingById.set(idStr, cat);
      });
      const incomingById = new Map();
      body.tournamentCategories.forEach((cat) => {
        const idStr = cat?._id ? cat._id.toString() : undefined;
        if (idStr) incomingById.set(idStr, cat);
      });

      // If incoming appears to be a partial update (not the full list), merge only provided categories
      const isPartialUpdate = body.tournamentCategories.length < existingList.length;

      if (isPartialUpdate) {
        // Filter out categories that aren't in the incoming list (they were removed)
        // Only keep and update categories that are in the incoming list
        tournament.tournamentCategories = existingList
          .map((existingCat, idx) => {
            const idStr = existingCat?._id ? existingCat._id.toString() : undefined;
            const incomingCat = idStr ? incomingById.get(idStr) : undefined;

            // If category is not in incoming list, return null to filter it out
            if (!incomingCat) {
              return null; // Mark for removal
            }

            // Merge existing with incoming, incoming wins when defined
            const merged = {
              ...existingCat,
              ...incomingCat,
            };

            // Preserve subdocument _id
            if (existingCat && existingCat._id && !merged._id) {
              merged._id = existingCat._id;
            }

            // removed backend debug logs
            try {
              const gmRaw = incomingCat?.gamesPerMatch ?? merged?.gamesPerMatch ?? 3;
              const gm = Math.min(Math.max(Number(gmRaw), 1), 3);
              merged.gamesPerMatch = gm;
              const bmRaw = incomingCat?.bracketMode ?? merged?.bracketMode ?? (Array.isArray(merged?.groupStage?.groups) ? merged.groupStage.groups.length : 4);
              const bm = [1, 2, 4, 8].includes(Number(bmRaw)) ? Number(bmRaw) : (Array.isArray(merged?.groupStage?.groups) ? merged.groupStage.groups.length : 4);
              merged.bracketMode = bm;
            } catch (_) {}

            return merged;
          })
          .filter((cat) => cat !== null); // Remove categories that were marked for deletion
      } else {
        // Full update path: align by _id where possible, fallback by index
        tournament.tournamentCategories = body.tournamentCategories.map(
          (updatedCat, i) => {
            const updatedIdStr = updatedCat?._id ? updatedCat._id.toString() : undefined;
            const existingPlain = (updatedIdStr && existingById.get(updatedIdStr)) || existingList[i] || {};

            // removed backend debug logs

            const merged = { ...existingPlain, ...updatedCat };

            if (existingPlain && existingPlain._id && !merged._id) {
              merged._id = existingPlain._id;
            }

            // removed backend debug logs

            if (merged.groupStage?.groups) {
              merged.groupStage.groups.forEach((group, groupIndex) => {
                if (group.matches) {
                  // removed backend debug logs
                }
              });
            }

            try {
              const gmRaw = updatedCat?.gamesPerMatch ?? merged?.gamesPerMatch ?? 3;
              const gm = Math.min(Math.max(Number(gmRaw), 1), 3);
              merged.gamesPerMatch = gm;
              const bmRaw = updatedCat?.bracketMode ?? merged?.bracketMode ?? (Array.isArray(merged?.groupStage?.groups) ? merged.groupStage.groups.length : 4);
              const bm = [1, 2, 4, 8].includes(Number(bmRaw)) ? Number(bmRaw) : (Array.isArray(merged?.groupStage?.groups) ? merged.groupStage.groups.length : 4);
              merged.bracketMode = bm;
            } catch (_) {}

            return merged;
          },
        );
      }
    }

    // Handle file uploads (upload to GCS)
    if (req.files?.paymentMethodsFiles) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      await Promise.all(
        req.files.paymentMethodsFiles.map(async (file, i) => {
          if (tournament.paymentMethods[i]) {
            const dest = `tournaments/payment_methods/${file.filename}`;
            const url = await uploadToGCS(file.path, dest);
            tournament.paymentMethods[i].qrCodeImage = url;
            fs.promises.unlink(file.path).catch(() => {});
          }
        })
      );
    }
    if (req.files?.tournamentPicture) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      const f = req.files.tournamentPicture[0];
      const dest = `tournaments/pictures/${f.filename}`;
      tournament.tournamentPicture = await uploadToGCS(f.path, dest);
      fs.promises.unlink(f.path).catch(() => {});
    }

    // Append any newly uploaded guideline pictures
    if (Array.isArray(req.files?.guidelinePictures) && req.files.guidelinePictures.length > 0) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      const uploaded = await Promise.all(
        req.files.guidelinePictures.map(async (file) => {
          const dest = `tournaments/guidelines/${file.filename}`;
          const url = await uploadToGCS(file.path, dest);
          fs.promises.unlink(file.path).catch(() => {});
          return url;
        })
      );
      tournament.guidelinePictures = [
        ...(Array.isArray(tournament.guidelinePictures) ? tournament.guidelinePictures : []),
        ...uploaded,
      ];
    }

    // Append any newly uploaded schedule pictures
    if (Array.isArray(req.files?.schedulePictures) && req.files.schedulePictures.length > 0) {
      const fs = require('fs');
      const { uploadToGCS } = require('../utils/gcs');
      const uploadedSched = await Promise.all(
        req.files.schedulePictures.map(async (file) => {
          const dest = `tournaments/schedule/${file.filename}`;
          const url = await uploadToGCS(file.path, dest);
          fs.promises.unlink(file.path).catch(() => {});
          return url;
        })
      );
      tournament.schedulePictures = [
        ...(Array.isArray(tournament.schedulePictures) ? tournament.schedulePictures : []),
        ...uploadedSched,
      ];
    }

    // ✅ Sanitize bracket data (standings and matches) to prevent 500s
    try {
      const coerceName = (val) => {
        if (typeof val === 'string') return val;
        if (val && typeof val === 'object') {
          if (typeof val.player === 'string') return val.player;
          if (typeof val.name === 'string') return val.name;
          const first = val.firstName || '';
          const last = val.lastName || '';
          const full = `${first} ${last}`.trim();
          if (full) return full;
        }
        if (val === null || val === undefined) return '';
        try { return String(val); } catch (_) { return ''; }
      };

      const sanitizeMatches = (matches) => {
        if (!matches) return matches;
        // Matches can be an array or an object (Mixed)
        if (Array.isArray(matches)) {
          return matches.map((m) => ({
            ...m,
            player1: coerceName(m?.player1) || 'TBD',
            player2: coerceName(m?.player2) || 'TBD',
          }));
        }
        if (typeof matches === 'object') {
          const out = {};
          Object.keys(matches).forEach((k) => {
            const m = matches[k] || {};
            out[k] = {
              ...m,
              player1: coerceName(m?.player1) || 'TBD',
              player2: coerceName(m?.player2) || 'TBD',
            };
          });
          return out;
        }
        return matches;
      };

      if (Array.isArray(tournament.tournamentCategories)) {
        tournament.tournamentCategories = tournament.tournamentCategories.map((cat) => {
          const nextCat = { ...cat };
          // Group stage
          if (nextCat?.groupStage?.groups && Array.isArray(nextCat.groupStage.groups)) {
            nextCat.groupStage.groups = nextCat.groupStage.groups.map((g) => {
              const nextG = { ...g };
              // Ensure standings players are strings
              if (Array.isArray(nextG.standings)) {
                nextG.standings = nextG.standings.map((s) => ({
                  ...s,
                  player: coerceName(s?.player) || '',
                }));
              }
              // Ensure originalPlayers aligns and are strings (if present)
              if (Array.isArray(nextG.originalPlayers)) {
                nextG.originalPlayers = nextG.originalPlayers.map((p) => coerceName(p) || '');
              }
              // Sanitize matches structure
              nextG.matches = sanitizeMatches(nextG.matches);

              try {
                const asNum = (x) => {
                  const n = Number(x);
                  return Number.isFinite(n) ? n : 0;
                };
                const basePlayers = Array.isArray(nextG.originalPlayers) && nextG.originalPlayers.length
                  ? nextG.originalPlayers.slice()
                  : (Array.isArray(nextG.standings) ? nextG.standings.map((s) => String(s.player || '')) : []);

                const stats = new Map();
                const ensure = (name) => {
                  const key = String(name || '').trim();
                  if (!key) return;
                  if (!stats.has(key)) stats.set(key, { wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 });
                };

                if (nextG && nextG.matches && !Array.isArray(nextG.matches) && typeof nextG.matches === 'object') {
                  Object.keys(nextG.matches).forEach((k) => {
                    const m = nextG.matches[k] || {};
                    const parts = String(k).split('-');
                    const i = parseInt(parts[0]);
                    const off = parseInt(parts[1]);
                    const j = i + 1 + (isNaN(off) ? 0 : off);
                    const p1 = m.player1 && String(m.player1).trim() ? String(m.player1) : (basePlayers[i] || '');
                    const p2 = m.player2 && String(m.player2).trim() ? String(m.player2) : (basePlayers[j] || '');
                    if (!m.player1 && p1) m.player1 = p1;
                    if (!m.player2 && p2) m.player2 = p2;
                    m.player1Name = String(m.player1 || p1 || '');
                    m.player2Name = String(m.player2 || p2 || '');
                    const isObjectId = (val) => typeof val === 'string' && /^[a-f0-9]{24}$/i.test(val.trim());
                    const raw1 = basePlayers[i];
                    const raw2 = basePlayers[j];
                    if (!m.player1Id && isObjectId(raw1)) m.player1Id = String(raw1);
                    if (!m.player2Id && isObjectId(raw2)) m.player2Id = String(raw2);
                    if (!m.matchId) m.matchId = `G${k}`;
                    if (!p1 || !p2) return;
                    ensure(p1);
                    ensure(p2);
                    const gamesCount = Math.min(Math.max(Number(nextCat?.gamesPerMatch ?? 3), 1), 3);
                    const setP1 = [asNum(m.game1Player1), asNum(m.game2Player1), asNum(m.game3Player1)];
                    const setP2 = [asNum(m.game1Player2), asNum(m.game2Player2), asNum(m.game3Player2)];
                    const fs1 = asNum(m.finalScorePlayer1);
                    const fs2 = asNum(m.finalScorePlayer2);
                    const s1 = stats.get(p1);
                    const s2 = stats.get(p2);
                    let pf1 = 0, pa1 = 0, pf2 = 0, pa2 = 0;
                    for (let idx = 0; idx < gamesCount; idx++) {
                      pf1 += setP1[idx];
                      pa1 += setP2[idx];
                      pf2 += setP2[idx];
                      pa2 += setP1[idx];
                    }
                    s1.pointsFor += pf1;
                    s1.pointsAgainst += pa1;
                    s2.pointsFor += pf2;
                    s2.pointsAgainst += pa2;
                    if (fs1 + fs2 > 0) {
                      if (fs1 > fs2) { s1.wins += 1; s2.losses += 1; }
                      else if (fs2 > fs1) { s2.wins += 1; s1.losses += 1; }
                    } else {
                      let w1 = 0, w2 = 0;
                      for (let idx = 0; idx < gamesCount; idx++) {
                        if (setP1[idx] > setP2[idx]) w1 += 1;
                        else if (setP2[idx] > setP1[idx]) w2 += 1;
                      }
                      if (w1 > w2) { s1.wins += 1; s2.losses += 1; }
                      else if (w2 > w1) { s2.wins += 1; s1.losses += 1; }
                    }
                  });
                } else if (Array.isArray(nextG.matches)) {
                  nextG.matches.forEach((m, idx) => {
                    const p1 = String(m.player1 || '').trim();
                    const p2 = String(m.player2 || '').trim();
                    m.player1Name = p1;
                    m.player2Name = p2;
                    if (!m.player1Id && /^[a-f0-9]{24}$/i.test(p1)) m.player1Id = p1;
                    if (!m.player2Id && /^[a-f0-9]{24}$/i.test(p2)) m.player2Id = p2;
                    if (!m.matchId) m.matchId = `G${idx + 1}`;
                    if (!p1 || !p2) return;
                    ensure(p1);
                    ensure(p2);
                    const gamesCount = Math.min(Math.max(Number(nextCat?.gamesPerMatch ?? 3), 1), 3);
                    const setP1 = [asNum(m.game1Player1), asNum(m.game2Player1), asNum(m.game3Player1)];
                    const setP2 = [asNum(m.game1Player2), asNum(m.game2Player2), asNum(m.game3Player2)];
                    const fs1 = asNum(m.finalScorePlayer1);
                    const fs2 = asNum(m.finalScorePlayer2);
                    const s1 = stats.get(p1);
                    const s2 = stats.get(p2);
                    let pf1 = 0, pa1 = 0, pf2 = 0, pa2 = 0;
                    for (let s = 0; s < gamesCount; s++) {
                      pf1 += setP1[s];
                      pa1 += setP2[s];
                      pf2 += setP2[s];
                      pa2 += setP1[s];
                    }
                    s1.pointsFor += pf1;
                    s1.pointsAgainst += pa1;
                    s2.pointsFor += pf2;
                    s2.pointsAgainst += pa2;
                    if (fs1 + fs2 > 0) {
                      if (fs1 > fs2) { s1.wins += 1; s2.losses += 1; }
                      else if (fs2 > fs1) { s2.wins += 1; s1.losses += 1; }
                    } else {
                      let w1 = 0, w2 = 0;
                      for (let s = 0; s < gamesCount; s++) {
                        if (setP1[s] > setP2[s]) w1 += 1;
                        else if (setP2[s] > setP1[s]) w2 += 1;
                      }
                      if (w1 > w2) { s1.wins += 1; s2.losses += 1; }
                      else if (w2 > w1) { s2.wins += 1; s1.losses += 1; }
                    }
                  });
                }

                const names = Array.from(new Set([...
                  (Array.isArray(basePlayers) ? basePlayers.map((p) => String(p || '')) : []),
                  ...Array.from(stats.keys()),
                ].filter(Boolean)));
                let computed = names.map((n) => {
                  const s = stats.get(n) || { wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 };
                  const pd = (s.pointsFor || 0) - (s.pointsAgainst || 0);
                  const rankPoints = (s.wins || 0) * 3;
                  return { player: n, wins: s.wins || 0, losses: s.losses || 0, pointsFor: s.pointsFor || 0, pointsAgainst: s.pointsAgainst || 0, pointDifferential: pd, rankPoints };
                });
                computed = computed.sort((a, b) => {
                  if (b.wins !== a.wins) return b.wins - a.wins;
                  if (b.pointDifferential !== a.pointDifferential) return b.pointDifferential - a.pointDifferential;
                  return (b.pointsFor || 0) - (a.pointsFor || 0);
                });
                if (computed.length > 0) {
                  nextG.standings = computed;
                  if (!Array.isArray(nextG.originalPlayers) || nextG.originalPlayers.length === 0) {
                    nextG.originalPlayers = names;
                  }
                }
              } catch (_) {}
              return nextG;
            });
          }
          // Elimination matches
          if (nextCat?.eliminationMatches?.matches) {
            nextCat.eliminationMatches.matches = sanitizeMatches(nextCat.eliminationMatches.matches);
          }
          return nextCat;
        });
      }
    } catch (sanitizeErr) {
      // Best-effort sanitation; do not fail the request due to sanitation issues
      console.warn('⚠️ Bracket sanitation skipped due to error:', sanitizeErr?.message || sanitizeErr);
    }

    // removed backend debug logs before save
    tournament.markModified('tournamentCategories');

    // Attempt normal save; if VersionError occurs due to __v mismatch, fall back to findByIdAndUpdate
    let savedTournament;
    try {
      savedTournament = await tournament.save();
    } catch (e) {
      const isVersionError = e?.name === 'VersionError' || /No matching document found for id/i.test(e?.message || '');
      if (isVersionError) {
        // Build update payload from the mutated document and bypass __v check
        const updateData = typeof tournament.toObject === 'function'
          ? tournament.toObject()
          : JSON.parse(JSON.stringify(tournament));
        // Avoid immutable _id updates
        delete updateData._id;

        savedTournament = await Tournament.findByIdAndUpdate(
          req.params.id,
          updateData,
          { new: true, runValidators: false }
        );
      } else {
        throw e;
      }
    }

    // Invalidate cached GET responses for this tournament so reloads pick up changes
    try {
      invalidateTournamentGetCache(savedTournament._id.toString());
    } catch (cacheErr) {
      console.warn("⚠️ Cache invalidation failed after tournament update:", cacheErr?.message || cacheErr);
    }

    try {
      if (Array.isArray(savedTournament.schedulePictures)) {
        savedTournament.schedulePictures = await Promise.all(
          savedTournament.schedulePictures.map(async (url) => {
            try { return await getSignedUrlFromAny(url); } catch (_) { return url; }
          })
        );
      }
      if (savedTournament.tournamentPicture) {
        try { savedTournament.tournamentPicture = await getSignedUrlFromAny(savedTournament.tournamentPicture); } catch (_) {}
      }
      if (Array.isArray(savedTournament.paymentMethods)) {
        savedTournament.paymentMethods = await Promise.all(
          savedTournament.paymentMethods.map(async (pm) => {
            if (pm && pm.qrCodeImage) {
              try { pm.qrCodeImage = await getSignedUrlFromAny(pm.qrCodeImage); } catch (_) {}
            }
            return pm;
          })
        );
      }
    } catch (_) {}

    // Upsert normalized Elimination matches from saved tournament state
    try {
      const Match = require("../models/Match");
      const Team = require("../models/Team");
      const makeId = (val) => {
        const s = String(val || "").trim();
        return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
      };
      const normIds = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || "")).filter((s) => /^[a-f0-9]{24}$/i.test(s))));
      const roundMeta = (r) => {
        const raw = String(r || "").trim();
        const up = raw.toUpperCase();
        const key =
          /R\s*16|\bR16\b|\bROUND\s*OF\s*16\b/i.test(raw) ? "R16" :
          /\bQF\b|QUARTER/i.test(raw) ? "QF" :
          /\bSF\b|SEMI/i.test(raw) ? "SF" :
          /BRONZE/i.test(raw) ? "BRONZE" :
          /FINAL/i.test(raw) ? "FINAL" :
          up || "ELIMINATION";
        const order = key === "R16" ? 10 : key === "QF" ? 20 : key === "SF" ? 30 : key === "FINAL" ? 40 : key === "BRONZE" ? 45 : 50;
        return { key, order, label: raw || key };
      };
      const cats = Array.isArray(savedTournament.tournamentCategories) ? savedTournament.tournamentCategories : [];
      for (const cat of cats) {
        const categoryId = String(cat?._id || "");
        const gamesPerMatch = Number(cat?.eliminationMatches?.gamesPerMatch ?? cat?.gamesPerMatch ?? 1);
        const list = (cat?.eliminationMatches && Array.isArray(cat.eliminationMatches.matches)) ? cat.eliminationMatches.matches : [];
        for (const m of list) {
          const round = String(m?.round || "Elimination");
          const { key: roundKey, order: roundOrder, label: roundLabel } = roundMeta(round);
          const t1 = makeId(m?.team1Id);
          const t2 = makeId(m?.team2Id);
          const hasTeamPairs =
            Array.isArray(m?.mdPlayersTeam1) || Array.isArray(m?.mdPlayersTeam2) ||
            Array.isArray(m?.wdPlayersTeam1) || Array.isArray(m?.wdPlayersTeam2) ||
            Array.isArray(m?.xdPlayersTeam1) || Array.isArray(m?.xdPlayersTeam2) ||
            (m?.mdScores || m?.wdScores || m?.xdScores);
          const isTeam = !!(t1 && t2) || hasTeamPairs;
          const matchIdStr = String(m?.id || m?._id || m?.matchId || "").trim();
          let filter = { tournamentId: savedTournament._id, categoryId, round };
          if (matchIdStr) filter["meta.matchId"] = matchIdStr;
          let docBase = {
            tournamentId: savedTournament._id,
            categoryId,
            round,
            stage: "elimination",
            gamesPerMatch,
            status: String(m?.status || "").trim() || "Unscheduled",
            date: m?.date ? new Date(m.date) : undefined,
            time: m?.time || undefined,
            court: m?.court || undefined,
            meta: {
              matchId: matchIdStr || undefined,
              roundKey,
              roundOrder,
              roundLabel,
              bracketIndex: typeof m?.bracketIndex !== "undefined" ? m.bracketIndex : undefined,
              bracketName: typeof m?.bracketName !== "undefined" ? m.bracketName : undefined,
              mdPlayersTeam1: Array.isArray(m?.mdPlayersTeam1) ? m.mdPlayersTeam1 : undefined,
              mdPlayersTeam2: Array.isArray(m?.mdPlayersTeam2) ? m.mdPlayersTeam2 : undefined,
              wdPlayersTeam1: Array.isArray(m?.wdPlayersTeam1) ? m.wdPlayersTeam1 : undefined,
              wdPlayersTeam2: Array.isArray(m?.wdPlayersTeam2) ? m.wdPlayersTeam2 : undefined,
              xdPlayersTeam1: Array.isArray(m?.xdPlayersTeam1) ? m.xdPlayersTeam1 : undefined,
              xdPlayersTeam2: Array.isArray(m?.xdPlayersTeam2) ? m.xdPlayersTeam2 : undefined,
            },
          };
          const g1p1 = Number(m?.game1Player1 || m?.mdScores?.final?.team1 || 0);
          const g1p2 = Number(m?.game1Player2 || m?.mdScores?.final?.team2 || 0);
          const g2p1 = Number(m?.game2Player1 || m?.wdScores?.final?.team1 || 0);
          const g2p2 = Number(m?.game2Player2 || m?.wdScores?.final?.team2 || 0);
          const g3p1 = Number(m?.game3Player1 || m?.xdScores?.final?.team1 || 0);
          const g3p2 = Number(m?.game3Player2 || m?.xdScores?.final?.team2 || 0);
          const fs1Raw = Number(m?.finalScorePlayer1 || 0);
          const fs2Raw = Number(m?.finalScorePlayer2 || 0);
          const hasFs = (fs1Raw + fs2Raw) > 0;
          const winsFromEvents = (() => {
            let a = 0, b = 0;
            const finals = [
              { a: g1p1, b: g1p2 },
              { a: g2p1, b: g2p2 },
              { a: g3p1, b: g3p2 },
            ];
            for (const f of finals) {
              if ((f.a + f.b) === 0) continue;
              if (f.a > f.b) a += 1; else if (f.b > f.a) b += 1;
            }
            return { a, b };
          })();
          const finalTeam1 = hasFs ? fs1Raw : winsFromEvents.a;
          const finalTeam2 = hasFs ? fs2Raw : winsFromEvents.b;
          if (isTeam) {
            let team1Members = [];
            let team2Members = [];
            try {
              if (t1) {
                const tdoc1 = await Team.findById(t1).select("playerIds").lean();
                team1Members = Array.isArray(tdoc1?.playerIds) ? tdoc1.playerIds.map(String) : [];
              } else {
                team1Members = normIds([])
                  .concat(Array.isArray(m?.mdPlayersTeam1) ? m.mdPlayersTeam1 : [])
                  .concat(Array.isArray(m?.wdPlayersTeam1) ? m.wdPlayersTeam1 : [])
                  .concat(Array.isArray(m?.xdPlayersTeam1) ? m.xdPlayersTeam1 : []);
              }
              if (t2) {
                const tdoc2 = await Team.findById(t2).select("playerIds").lean();
                team2Members = Array.isArray(tdoc2?.playerIds) ? tdoc2.playerIds.map(String) : [];
              } else {
                team2Members = normIds([])
                  .concat(Array.isArray(m?.mdPlayersTeam2) ? m.mdPlayersTeam2 : [])
                  .concat(Array.isArray(m?.wdPlayersTeam2) ? m.wdPlayersTeam2 : [])
                  .concat(Array.isArray(m?.xdPlayersTeam2) ? m.xdPlayersTeam2 : []);
              }
            } catch (_) {}
            if (t1) filter.team1Id = t1;
            if (t2) filter.team2Id = t2;
            const doc = {
              ...docBase,
              team1Id: t1 || undefined,
              team2Id: t2 || undefined,
              team1Members: team1Members.length ? team1Members : undefined,
              team2Members: team2Members.length ? team2Members : undefined,
              scores: {
                game1: { team1: g1p1, team2: g1p2 },
                game2: { team1: g2p1, team2: g2p2 },
                game3: { team1: g3p1, team2: g3p2 },
                final: { team1: finalTeam1, team2: finalTeam2 },
              },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
          } else {
            const p1 = makeId(m?.player1?._id || m?.player1Id || m?.player1);
            const p2 = makeId(m?.player2?._id || m?.player2Id || m?.player2);
            if (p1 && p2) {
              filter.player1Id = p1;
              filter.player2Id = p2;
            } else {
              filter.player1Name = String(m?.player1Name || m?.player1 || "").trim();
              filter.player2Name = String(m?.player2Name || m?.player2 || "").trim();
            }
            const doc = {
              ...docBase,
              player1Id: p1 || undefined,
              player2Id: p2 || undefined,
              player1Name: String(m?.player1Name || m?.player1 || "").trim() || undefined,
              player2Name: String(m?.player2Name || m?.player2 || "").trim() || undefined,
              scores: {
                game1: { team1: g1p1, team2: g1p2 },
                game2: { team1: g2p1, team2: g2p2 },
                game3: { team1: g3p1, team2: g3p2 },
                final: { team1: finalTeam1, team2: finalTeam2 },
              },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
          }
        }
      }
    } catch (_) {}

    try {
      const TournamentCategory = require("../models/TournamentCategories");
      const cats = Array.isArray(savedTournament.tournamentCategories) ? savedTournament.tournamentCategories : [];
      for (const cat of cats) {
        const groupStageSummary = cat.groupStage
          ? {
              groups: Array.isArray(cat.groupStage.groups)
                ? cat.groupStage.groups.map((g) => ({ id: g.id, name: g.name }))
                : [],
            }
          : null;
        const eliminationSummary = cat.eliminationMatches
          ? {
              status: cat.eliminationMatches.status || undefined,
              fee: cat.eliminationMatches.fee ?? 0,
              gamesPerMatch: cat.eliminationMatches.gamesPerMatch ?? cat.gamesPerMatch,
            }
          : null;
        const doc = {
          _id: cat._id,
          tournamentId: savedTournament._id,
          division: cat.division,
          ageCategory: cat.ageCategory,
          skillLevel: cat.skillLevel,
          maxParticipants: cat.maxParticipants,
          reservedSlots: cat.reservedSlots,
          setPartner: !!cat.setPartner,
          bracketMode: cat.bracketMode,
          gamesPerMatch: cat.gamesPerMatch,
          groupStage: groupStageSummary,
          eliminationMatches: eliminationSummary,
          withShirt: !!cat.withShirt,
          fee: cat.fee ?? 0,
          pairOverrides: cat.pairOverrides || null,
          pointsSubmitted: !!cat.pointsSubmitted,
          pointsSubmittedAt: cat.pointsSubmittedAt || null,
          locked: !!cat.locked,
          status: cat.status || "Open",
        };
        await TournamentCategory.updateOne({ _id: cat._id }, { $set: doc }, { upsert: true });
      }
    } catch (_) {}
    try {
      const TournamentCategory = require("../models/TournamentCategories");
      const existing = await TournamentCategory.find({ tournamentId: savedTournament._id }).select("_id").lean();
      const currentIds = (Array.isArray(savedTournament.tournamentCategories) ? savedTournament.tournamentCategories : [])
        .map((c) => c && c._id)
        .filter(Boolean);
      const toRemove = existing
        .map((x) => x && x._id)
        .filter((id) => id && !currentIds.some((cid) => String(cid) === String(id)));
      if (toRemove.length) {
        await TournamentCategory.deleteMany({ _id: { $in: toRemove } });
        try {
          await Registration.deleteMany({
            tournamentId: savedTournament._id,
            $or: [
              { categoryId: { $in: toRemove } },
              { category: { $in: toRemove.map(String) } },
            ],
          });
        } catch (_) {}
      }
    } catch (_) {}
    res.json({ message: "Tournament updated successfully", tournament: savedTournament });
  } catch (error) {
    console.error("Error updating tournament:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ✅ Delete Tournament (only author)
exports.deleteTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });

    if (!hasAccessToTournament(tournament, req.user))
      return res
        .status(403)
        .json({ message: "You can only delete tournaments you created or co-host" });

    const tid = String(tournament._id);
    // Cascade delete related data
    try {
      const CourtAssignmentDay = require("../models/CourtAssignmentDay");
      const TournamentCategory = require("../models/TournamentCategories");
      const Match = require("../models/Match");
      await Promise.all([
        Registration.deleteMany({ tournamentId: tournament._id }),
        CourtAssignmentDay.deleteMany({ tournamentId: tournament._id }),
        Match.deleteMany({ tournamentId: tournament._id }),
        TournamentCategory.deleteMany({ tournamentId: tournament._id }),
      ]);
    } catch (_) {}
    await tournament.deleteOne();
    try {
      await PlayerRanking.updateMany(
        {},
        { $pull: { pointsLog: { tournamentId: tid } } },
      );
      const docs = await PlayerRanking.find();
      for (const doc of docs) {
        const newTotal = (doc.pointsLog || []).reduce(
          (sum, e) => sum + (e.totalTournamentPoints || 0),
          0,
        );
        doc.points = newTotal;
        await doc.save();
      }
    } catch (_) {}
    try { invalidateTournamentGetCache(tid); } catch (_) {}
    res.json({ message: "Tournament deleted successfully", deletedTournamentId: tid });
  } catch (error) {
    console.error("Error deleting tournament:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

// ✅ Reopen a category for editing (clear lock and submitted points)
exports.reopenCategoryForEditing = async (req, res) => {
  try {
    const { id, categoryId } = req.params;
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isPrivileged) {
      return res.status(403).json({ message: "Access denied" });
    }
    const tournament = await Tournament.findById(id);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const cat = categories.find((c) => String(c._id) === String(categoryId));
    if (!cat) return res.status(404).json({ message: "Category not found" });
    cat.locked = false;
    cat.pointsSubmitted = false;
    cat.pointsSubmittedAt = null;
    await tournament.save();
    return res.json({ ok: true, locked: !!cat.locked, pointsSubmitted: !!cat.pointsSubmitted });
  } catch (error) {
    console.error("Reopen category error:", error);
    return res.status(500).json({ message: "Server error" });
  }
};

// ✅ Submit points for a category (superadmin/clubadmin)
exports.submitCategoryPoints = async (req, res) => {
  try {
    const { id, categoryId } = req.params;
    const tierInput = Number(req.body?.tournamentTier || req.body?.tier || 1);
    const tier = [1, 2, 3].includes(tierInput) ? tierInput : 1;
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isPrivileged) {
      return res.status(403).json({ message: "Only superadmin/clubadmin can submit points" });
    }
    const tournament = await Tournament.findById(id)
      .populate({
        path: "registrations.player",
        select: "firstName lastName birthDate pplId",
      })
      .populate({
        path: "registrations.partner",
        select: "firstName lastName birthDate pplId",
      })
      .lean();
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const catIdx = (Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : []).findIndex((c) => String(c._id) === String(categoryId));
    if (catIdx < 0) return res.status(404).json({ message: "Category not found" });
    const cat = tournament.tournamentCategories[catIdx];
    if (cat.pointsSubmitted || cat.locked) {
      return res.status(409).json({ message: "Points already submitted or category locked" });
    }
    const normalizeName = (u) => `${String(u?.firstName || "").trim()} ${String(u?.lastName || "").trim()}`.trim();
    const regEntries = Array.isArray(tournament.registrations) ? tournament.registrations : [];
    const nameToPplIds = new Map();
    regEntries.forEach((r) => {
      const pName = normalizeName(r.player);
      const pId = String(r.player?.pplId || "").trim();
      if (pName && pId) nameToPplIds.set(pName.toLowerCase(), [pId]);
      if (r.partner) {
        const partnerName = normalizeName(r.partner);
        const partnerId = String(r.partner?.pplId || "").trim();
        if (partnerName && partnerId) nameToPplIds.set(partnerName.toLowerCase(), [partnerId]);
      }
      if (r.playerName && !nameToPplIds.has(String(r.playerName || "").toLowerCase())) {
        const n = String(r.playerName || "").trim();
        const existing = nameToPplIds.get(n.toLowerCase()) || [];
        if (pId) nameToPplIds.set(n.toLowerCase(), Array.from(new Set([...existing, pId])));
      }
    });
    const resolvePplIds = (displayName) => {
      const raw = String(displayName || "").trim();
      if (!raw) return [];
      const parts = raw.split("/").map((s) => s.replace(/\s+/g, " ").trim());
      const ids = [];
      parts.forEach((part) => {
        const key = part.toLowerCase();
        const found = nameToPplIds.get(key) || [];
        found.forEach((f) => ids.push(String(f)));
      });
      return Array.from(new Set(ids)).filter((x) => !!x);
    };
    const getStagePoints = (t, stage) => {
      const map = {
        3: { Champion: 2000, "1st Runner-Up": 1400, "2nd Runner-Up": 1000, Semifinalist: 800, Quarterfinalist: 600, "Round of 16": 300 },
        2: { Champion: 1500, "1st Runner-Up": 1050, "2nd Runner-Up": 800, Semifinalist: 600, Quarterfinalist: 400, "Round of 16": 200 },
        1: { Champion: 1000, "1st Runner-Up": 700, "2nd Runner-Up": 500, Semifinalist: 400, Quarterfinalist: 200, "Round of 16": 0 },
      };
      const tierMap = map[t] || map[1];
      return tierMap[stage] ?? 0;
    };
    const getRRPointPerTier = (t) => (t === 3 ? 100 : t === 2 ? 75 : 50);
    const rrWins = new Map();
    const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
    groups.forEach((g) => {
      (Array.isArray(g.standings) ? g.standings : []).forEach((s) => {
        const name = String(s.player || "").trim();
        const wins = Number(s.wins) || 0;
        if (!name) return;
        rrWins.set(name, (rrWins.get(name) || 0) + wins);
        if (name.includes("/")) {
          name.split("/").map((p) => p.trim()).forEach((n) => {
            rrWins.set(n, (rrWins.get(n) || 0) + wins);
          });
        }
      });
    });
    const stageMap = new Map();
    const matches = (cat.eliminationMatches && Array.isArray(cat.eliminationMatches.matches)) ? cat.eliminationMatches.matches : [];
    const norm = (s) => String(s || "").toLowerCase();
    const markStage = (loserName, stage) => {
      const n = String(loserName || "").trim();
      if (!n) return;
      stageMap.set(n, stage);
      if (n.includes("/")) {
        n.split("/").map((p) => p.trim()).forEach((part) => stageMap.set(part, stage));
      }
    };
    let finalPlayers = [];
    let bronzePlayers = [];
    matches.forEach((m) => {
      const r = norm(m.round || m.title);
      const p1 = String(m.player1 || m.player1Name || "").trim();
      const p2 = String(m.player2 || m.player2Name || "").trim();
      const fs1 = Number(m.finalScorePlayer1 || 0);
      const fs2 = Number(m.finalScorePlayer2 || 0);
      const winnerName = fs1 > fs2 ? p1 : fs2 > fs1 ? p2 : "";
      const loserName = fs1 > fs2 ? p2 : fs2 > fs1 ? p1 : "";
      if (!p1 || !p2) return;
      if (r.includes("final") && !r.includes("semi")) {
        finalPlayers = [p1, p2];
        if (winnerName) {
          stageMap.set(winnerName, "Champion");
          if (winnerName.includes("/")) winnerName.split("/").map((x) => x.trim()).forEach((n) => stageMap.set(n, "Champion"));
        }
        if (loserName) {
          markStage(loserName, "1st Runner-Up");
        }
      } else if (r.includes("bronze")) {
        bronzePlayers = [p1, p2];
        if (winnerName) markStage(winnerName, "2nd Runner-Up");
        if (loserName) markStage(loserName, "Semifinalist");
      } else if (r.includes("semi")) {
        if (loserName) markStage(loserName, "Semifinalist");
      } else if (r.includes("quarter")) {
        if (loserName) markStage(loserName, "Quarterfinalist");
      } else if (r.includes("round of 16") || r.includes("r16")) {
        if (loserName) markStage(loserName, "Round of 16");
      }
    });
    const defaultStage = (() => {
      const hasQuarter = matches.some((m) => norm(m.round || m.title).includes("quarter"));
      const hasSemi = matches.some((m) => norm(m.round || m.title).includes("semi"));
      if (hasQuarter) return "Quarterfinalist";
      if (hasSemi) return "Semifinalist";
      return "Round of 16";
    })();
    const division = String(cat.division || "").toLowerCase();
    let openCategory = "";
    if (division.includes("men") && division.includes("single")) openCategory = "mens-singles";
    else if (division.includes("women") && division.includes("single")) openCategory = "womens-singles";
    else if (division.includes("men") && division.includes("double")) openCategory = "mens-doubles";
    else if (division.includes("women") && division.includes("double")) openCategory = "womens-doubles";
    else if (division.includes("mixed") && division.includes("double")) {
      openCategory = division.includes("women") ? "womens-mixed-doubles" : "mens-mixed-doubles";
    }
    const affected = new Set();
    rrWins.forEach((_, name) => affected.add(name));
    matches.forEach((m) => {
      [m.player1 || m.player1Name, m.player2 || m.player2Name].forEach((n) => {
        const s = String(n || "").trim();
        if (s) affected.add(s);
        if (s.includes("/")) s.split("/").map((x) => x.trim()).forEach((z) => affected.add(z));
      });
    });
    const rrPerWin = getRRPointPerTier(tier);
    let updatedCount = 0;
    for (const name of Array.from(affected)) {
      const pplIds = resolvePplIds(name);
      const wins = rrWins.get(name) || 0;
      const stageReached = stageMap.get(name) || defaultStage;
      const stagePoints = getStagePoints(tier, stageReached);
      const rrPointsTotal = wins * rrPerWin;
      const totalTournamentPoints = stagePoints + rrPointsTotal;
      for (const pplId of pplIds) {
        const doc = await PlayerRanking.findOneAndUpdate(
          { pplId, category: openCategory },
          {
            $setOnInsert: { name, age: 0 },
            $push: {
              pointsLog: {
                source: "tournament",
                tournamentId: id,
                tournamentTier: tier,
                stageReached,
                rrWins: wins,
                rrPointsPerWin: rrPerWin,
                stagePoints,
                totalTournamentPoints,
              },
            },
          },
          { upsert: true, new: true },
        );
        const newTotal = (doc.pointsLog || []).reduce((sum, e) => sum + (e.totalTournamentPoints || 0), 0);
        doc.points = newTotal;
        await doc.save();
        updatedCount += 1;
      }
    }
    const toUpdate = await Tournament.findById(id);
    const idx = (Array.isArray(toUpdate.tournamentCategories) ? toUpdate.tournamentCategories : []).findIndex((c) => String(c._id) === String(categoryId));
    if (idx >= 0) {
      toUpdate.tournamentCategories[idx].pointsSubmitted = true;
      toUpdate.tournamentCategories[idx].pointsSubmittedAt = new Date();
      toUpdate.tournamentCategories[idx].locked = true;
      await toUpdate.save();
    }
    invalidateTournamentGetCache(id);
    res.json({ message: "Category points submitted", updatedEntries: updatedCount, tournamentId: id, categoryId });
  } catch (error) {
    console.error("Error submitting category points:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};
// ✅ Approve & Add Player (with age)
exports.addApprovedPlayer = async (req, res) => {
  const { playerId, category } = req.body;

  // Validate required fields
  if (!playerId || !category) {
    return res.status(400).json({
      message: "Missing required fields: playerId and category are required",
    });
  }

  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });

    // Only the creator or co-hosts can approve players
    if (!hasAccessToTournament(tournament, req.user))
      return res
        .status(403)
        .json({ message: "You can only manage tournaments you created or co-host" });

    const catEq = (a, b) => String(a || "") === String(b || "");
    const playerEq = (a, b) => String(a || "") === String(b || "");

    // removed backend debug logs

    // Find the specific registration for this player and category that is awaiting action
    const pendingRegistration = tournament.registrations.find(
      (r) =>
        (playerEq(r.player, playerId) || playerEq(r.player?._id, playerId)) &&
        (catEq(r.category, category) || catEq(r.category?._id, category)) &&
        (r.status === "pending" || r.status === "waiting" || r.status === "reserved"),
    );

    // Check if there's already an approved registration for this player and category
    const existingApprovedRegistration = tournament.registrations.find(
      (r) =>
        (playerEq(r.player, playerId) || playerEq(r.player?._id, playerId)) &&
        (catEq(r.category, category) || catEq(r.category?._id, category)) &&
        r.status === "approved",
    );

    // removed backend debug logs

    // 🔍 Check for any registration with this player (regardless of status/category)
    const anyPlayerRegistration = tournament.registrations.filter(
      (r) => r.player.toString() === playerId,
    );
    // removed backend debug logs

    // 🔍 Check for any registration with this category (regardless of player/status)
    const anyCategoryRegistration = tournament.registrations.filter(
      (r) => catEq(r.category, category) || catEq(r.category?._id, category),
    );
    // removed backend debug logs

    // If already approved, return success message instead of error
    if (existingApprovedRegistration) {
      try {
        const Registration = require("../models/Registration");
        const Team = require("../models/Team");
        const { Types } = require("mongoose");
        const asId = (v) => (Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
        const cId = asId(category) || category;
        const pId = asId(playerId) || playerId;
        const p2 = asId(existingApprovedRegistration.partner) || existingApprovedRegistration.partner;
        const tm = Array.isArray(existingApprovedRegistration.teamMembers)
          ? existingApprovedRegistration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
          : [];
        const filter = { tournamentId: tournament._id, categoryId: cId, playerId: pId };
        const doc = {
          tournamentId: tournament._id,
          categoryId: cId,
          category: String(cId || category),
          playerId: pId,
          partnerId: p2 || undefined,
          teamMembers: tm,
          teamName: existingApprovedRegistration.teamName || undefined,
          status: "approved",
          proofOfPayment: existingApprovedRegistration.proofOfPayment || [],
          contactNumber: existingApprovedRegistration.contactNumber || existingApprovedRegistration.playerPhone || undefined,
          email: existingApprovedRegistration.email || existingApprovedRegistration.playerEmail || undefined,
          emergencyContact: existingApprovedRegistration.emergencyContact || undefined,
          emergencyPhone: existingApprovedRegistration.emergencyPhone || undefined,
          registrationDate: existingApprovedRegistration.registrationDate || new Date(),
        };
        await Registration.updateOne(filter, { $set: doc }, { upsert: true });
        try {
          const makeIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
          if (existingApprovedRegistration.partner) {
            const playerIds = makeIds([playerId, existingApprovedRegistration.partner]);
            await Team.updateOne(
              { tournamentId: tournament._id, categoryId: category, playerIds },
              { $set: { tournamentId: tournament._id, categoryId: category, playerIds, teamName: existingApprovedRegistration.teamName || undefined } },
              { upsert: true }
            );
          } else if (Array.isArray(existingApprovedRegistration.teamMembers) && existingApprovedRegistration.teamMembers.length > 0) {
            const playerIds = makeIds(existingApprovedRegistration.teamMembers);
            await Team.updateOne(
              { tournamentId: tournament._id, categoryId: category, playerIds },
              { $set: { tournamentId: tournament._id, categoryId: category, playerIds, teamName: existingApprovedRegistration.teamName || undefined } },
              { upsert: true }
            );
          }
        } catch (_) {}
      } catch (_) {}

      try {
        await exports.buildTeamsFromRegistrations(
          { body: { tournamentId: tournament._id, categoryId: category } },
          { status: () => ({ json: () => {} }) }
        );
        await exports.syncTeamsForTournament(
          { body: { tournamentId: tournament._id, categoryId: category } },
          { status: () => ({ json: () => {} }) }
        );
      } catch (_) {}

      // Get the populated tournament to return consistent data
      const populatedTournament = await Tournament.findById(req.params.id)
        .populate({
          path: "registrations.player",
          select:
            "firstName lastName birthDate gender duprRatings pplId duprId",
        })
        .populate({
          path: "registrations.partner",
          select:
            "firstName lastName birthDate gender duprRatings pplId duprId",
        })
        .populate({
          path: "registrations.teamMembers",
          select:
            "firstName lastName birthDate gender duprRatings pplId duprId",
        });

      // Compute age for all registered players
      populatedTournament.registrations = populatedTournament.registrations.map(
        (r) => {
          if (r.player && r.player.birthDate) {
            const today = new Date();
            const birth = new Date(r.player.birthDate);
            let age = today.getFullYear() - birth.getFullYear();
            const monthDiff = today.getMonth() - birth.getMonth();
            if (
              monthDiff < 0 ||
              (monthDiff === 0 && today.getDate() < birth.getDate())
            ) {
              age--;
            }
            r.player.age = age;
          } else if (r.player) {
            r.player.age = null;
          }
          return r;
        },
      );

      return res.json({
        message: "Player is already approved for this category",
        tournament: populatedTournament,
      });
    }

    if (pendingRegistration) {

      // Remove the pending registration
      tournament.registrations = tournament.registrations.filter(
        (r) => r._id.toString() !== pendingRegistration._id.toString(),
      );

      const categoryObjEarly = Array.isArray(tournament.tournamentCategories)
        ? tournament.tournamentCategories.find((cat) => {
            const catIdString = cat._id ? cat._id.toString() : "";
            const categoryString = category ? category.toString() : "";
            return catIdString === categoryString;
          })
        : null;
      const divisionLowerEarly = String(categoryObjEarly?.division || "").toLowerCase();
      const isSinglesEarly = divisionLowerEarly.includes("single");

      // Create approved registration preserving all original data
      const approvedRegistration = {
        player: playerId,
        category,
        status: "approved",
        // Preserve all original registration data
        partner: isSinglesEarly ? undefined : pendingRegistration.partner,
        teamMembers: pendingRegistration.teamMembers,
        teamName: pendingRegistration.teamName,
        proofOfPayment: pendingRegistration.proofOfPayment,
        contactNumber: pendingRegistration.contactNumber,
        email: pendingRegistration.email,
        playerName: pendingRegistration.playerName,
        playerEmail: pendingRegistration.playerEmail,
        playerPhone: pendingRegistration.playerPhone,
        emergencyContact: pendingRegistration.emergencyContact,
        emergencyPhone: pendingRegistration.emergencyPhone,
        ...(pendingRegistration.shirtSize
          ? { shirtSize: pendingRegistration.shirtSize }
          : {}),
        registrationDate: pendingRegistration.registrationDate,
      };

      if (pendingRegistration.teamName !== undefined && pendingRegistration.teamName !== null) {
        approvedRegistration.teamName = pendingRegistration.teamName;
      }
      if (!isSinglesEarly && pendingRegistration.partner !== undefined && pendingRegistration.partner !== null) {
        approvedRegistration.partner = pendingRegistration.partner;
      }

      if (!isSinglesEarly) {
        try {
          const existingWithPartner = (tournament.registrations || []).find((r) => {
            if (!r) return false;
            const samePlayer = (playerEq(r.player, playerId) || playerEq(r.player?._id, playerId));
            const sameCat = (catEq(r.category, category) || catEq(r.category?._id, category));
            return samePlayer && sameCat && !!r.partner;
          });
          if (existingWithPartner?.partner) {
            approvedRegistration.partner = existingWithPartner.partner;
          }
        } catch (_) {}
      } else {
        delete approvedRegistration.partner;
        delete approvedRegistration.partnerStatus;
        delete approvedRegistration.teamMembers;
        delete approvedRegistration.teamName;
      }

      // removed backend debug logs

      // removed backend debug logs

      tournament.registrations.push(approvedRegistration);
      try {
        const Registration = require("../models/Registration");
        const { Types } = require("mongoose");
        const asId = (v) => (Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
        const cId = asId(category) || category;
        const pId = asId(playerId) || playerId;
        const p2 = asId(approvedRegistration.partner) || approvedRegistration.partner;
        const tm = Array.isArray(approvedRegistration.teamMembers)
          ? approvedRegistration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
          : [];
        const filter = { tournamentId: tournament._id, categoryId: cId, playerId: pId };
        const doc = {
          tournamentId: tournament._id,
          categoryId: cId,
          category: String(cId || category),
          playerId: pId,
          partnerId: p2 || undefined,
          teamMembers: tm,
          teamName: approvedRegistration.teamName || undefined,
          status: "approved",
          proofOfPayment: approvedRegistration.proofOfPayment || [],
          contactNumber: approvedRegistration.contactNumber || approvedRegistration.playerPhone || undefined,
          email: approvedRegistration.email || approvedRegistration.playerEmail || undefined,
          emergencyContact: approvedRegistration.emergencyContact || undefined,
          emergencyPhone: approvedRegistration.emergencyPhone || undefined,
          registrationDate: approvedRegistration.registrationDate || new Date(),
        };
        await Registration.updateOne(filter, { $set: doc }, { upsert: true });
        try {
          const Team = require("../models/Team");
          const makeIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
          if (approvedRegistration.partner) {
            const playerIds = makeIds([playerId, approvedRegistration.partner]);
            await Team.updateOne(
              { tournamentId: tournament._id, categoryId: category, playerIds },
              { $set: { tournamentId: tournament._id, categoryId: category, playerIds, teamName: approvedRegistration.teamName || undefined } },
              { upsert: true }
            );
          } else if (Array.isArray(approvedRegistration.teamMembers) && approvedRegistration.teamMembers.length > 0) {
            const playerIds = makeIds(approvedRegistration.teamMembers);
            await Team.updateOne(
              { tournamentId: tournament._id, categoryId: category, playerIds },
              { $set: { tournamentId: tournament._id, categoryId: category, playerIds, teamName: approvedRegistration.teamName || undefined } },
              { upsert: true }
            );
          }
        } catch (_) {}
      } catch (_) {}

      try {
        await exports.buildTeamsFromRegistrations(
          { body: { tournamentId: tournament._id, categoryId: category } },
          { status: () => ({ json: () => {} }) }
        );
        await exports.syncTeamsForTournament(
          { body: { tournamentId: tournament._id, categoryId: category } },
          { status: () => ({ json: () => {} }) }
        );
      } catch (_) {}

      // removed backend debug logs
    } else {
      // Fallback: allow manual creation of an approved registration when no pending exists
      const categoryObj = Array.isArray(tournament.tournamentCategories)
        ? tournament.tournamentCategories.find((cat) => {
            const catIdString = cat._id ? cat._id.toString() : "";
            const categoryString = category ? category.toString() : "";
            return catIdString === categoryString;
          })
        : null;
      const divisionLower = String(categoryObj?.division || "").toLowerCase();
      const isSingles = divisionLower.includes("single");
      const isTeam = divisionLower.includes("team");
      const isDoubles = !isSingles && !isTeam;

      const user = await User.findById(playerId).lean();
      const derivedPlayerName = user ? `${user.firstName || ""} ${user.lastName || ""}`.trim() : undefined;
      const derivedEmail = user ? user.email : undefined;
      const derivedPhone = user ? user.phoneNumber : undefined;

      const approvedRegistration = {
        player: playerId,
        category,
        status: "approved",
        playerName: derivedPlayerName,
        playerEmail: derivedEmail,
        playerPhone: derivedPhone,
        registrationDate: new Date(),
      };

      tournament.registrations.push(approvedRegistration);
      try {
        const Registration = require("../models/Registration");
        const { Types } = require("mongoose");
        const asId = (v) => (Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
        const cId = asId(category) || category;
        const pId = asId(playerId) || playerId;
        const p2 = asId(approvedRegistration.partner) || approvedRegistration.partner;
        const tm = Array.isArray(approvedRegistration.teamMembers)
          ? approvedRegistration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
          : [];
        const filter = { tournamentId: tournament._id, categoryId: cId, playerId: pId };
        const doc = {
          tournamentId: tournament._id,
          categoryId: cId,
          category: String(cId || category),
          playerId: pId,
          partnerId: p2 || undefined,
          teamMembers: tm,
          teamName: approvedRegistration.teamName || undefined,
          status: "approved",
          proofOfPayment: approvedRegistration.proofOfPayment || [],
          contactNumber: approvedRegistration.contactNumber || approvedRegistration.playerPhone || undefined,
          email: approvedRegistration.email || approvedRegistration.playerEmail || undefined,
          emergencyContact: approvedRegistration.emergencyContact || undefined,
          emergencyPhone: approvedRegistration.emergencyPhone || undefined,
          registrationDate: approvedRegistration.registrationDate || new Date(),
        };
        await Registration.updateOne(filter, { $set: doc }, { upsert: true });
        try {
          const Team = require("../models/Team");
          const makeIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
          if (approvedRegistration.partner) {
            const playerIds = makeIds([playerId, approvedRegistration.partner]);
            await Team.updateOne(
              { tournamentId: tournament._id, categoryId: category, playerIds },
              { $set: { tournamentId: tournament._id, categoryId: category, playerIds, teamName: approvedRegistration.teamName || undefined } },
              { upsert: true }
            );
          } else if (Array.isArray(approvedRegistration.teamMembers) && approvedRegistration.teamMembers.length > 0) {
            const playerIds = makeIds(approvedRegistration.teamMembers);
            await Team.updateOne(
              { tournamentId: tournament._id, categoryId: category, playerIds },
              { $set: { tournamentId: tournament._id, categoryId: category, playerIds, teamName: approvedRegistration.teamName || undefined } },
              { upsert: true }
            );
          }
        } catch (_) {}
      } catch (_) {}

      try {
        await exports.buildTeamsFromRegistrations(
          { body: { tournamentId: tournament._id, categoryId: category } },
          { status: () => ({ json: () => {} }) }
        );
        await exports.syncTeamsForTournament(
          { body: { tournamentId: tournament._id, categoryId: category } },
          { status: () => ({ json: () => {} }) }
        );
      } catch (_) {}

      await tournament.save();

      invalidateTournamentGetCache(tournament._id.toString());

      let categoryName = category;
      if (categoryObj) {
        const division = categoryObj.division || "";
        const skillLevel =
          categoryObj.skillLevel === "Open" && categoryObj.tier
            ? `Open Tier ${categoryObj.tier}`
            : categoryObj.skillLevel || "";
        const age = categoryObj.ageCategory || "";
        const parts = [division, skillLevel, age].filter((part) => part && part.trim());
        categoryName = parts.length > 0 ? parts.join(" | ") : "Tournament Category";
      }
      const notificationMessage = `Your ${isTeam ? "team" : isDoubles ? "doubles" : "single"} registration for "${tournament.tournamentName}" in ${categoryName} has been approved!`;
      try {
        await createNotification({
          userId: playerId,
          type: "tournament",
          message: notificationMessage,
          metadata: {
            tournamentId: tournament._id,
            tournamentName: tournament.tournamentName,
            category: categoryName,
            registrationStatus: "approved",
            registrationType: isTeam ? "team" : isDoubles ? "doubles" : "single",
          },
        });
      } catch (_) {}
      const populatedTournament = await Tournament.findById(tournament._id)
        .populate({
          path: "registrations.player",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .populate({
          path: "registrations.partner",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        })
        .populate({
          path: "registrations.teamMembers",
          select: "firstName lastName birthDate gender duprRatings pplId duprId",
          options: { lean: true },
        });
      populatedTournament.registrations = populatedTournament.registrations.map((r) => {
        if (r.player && r.player.birthDate) {
          const today = new Date();
          const birth = new Date(r.player.birthDate);
          let age = today.getFullYear() - birth.getFullYear();
          const monthDiff = today.getMonth() - birth.getMonth();
          if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
            age--;
          }
          r.player.age = age;
        } else if (r.player) {
          r.player.age = null;
        }
        return r;
      });
      return res.json({
        message: "Player approved successfully (created new approved registration)",
        tournament: populatedTournament,
      });
    }

    // removed backend debug logs before save
    await tournament.save();
    // removed backend debug logs after save

    // Invalidate cached tournament GETs so UI reflects the latest state
    invalidateTournamentGetCache(tournament._id.toString());

    // 🔔 Create notification for the approved player
    try {
      // Determine the category name for the notification
      let categoryName = category;
      if (
        tournament.tournamentCategories &&
        tournament.tournamentCategories.length > 0
      ) {
        const categoryObj = tournament.tournamentCategories.find((cat) => {
          const catIdString = cat._id ? cat._id.toString() : "";
          const categoryString = category ? category.toString() : "";
          return catIdString === categoryString;
        });

        if (categoryObj) {
          // Create display name from category parts
          const division = categoryObj.division || "";
          const skillLevel =
            categoryObj.skillLevel === "Open" && categoryObj.tier
              ? `Open Tier ${categoryObj.tier}`
              : categoryObj.skillLevel || "";
          const age = categoryObj.ageCategory || "";

          const parts = [division, skillLevel, age].filter(
            (part) => part && part.trim(),
          );
          categoryName =
            parts.length > 0 ? parts.join(" | ") : "Tournament Category";

          // removed backend debug logs
        }
      }

      // Determine registration type for notification message using pending registration
      let registrationType = "single";
      if (pendingRegistration && Array.isArray(pendingRegistration.teamMembers) && pendingRegistration.teamMembers.length > 0) {
        registrationType = "team";
      } else if (pendingRegistration && pendingRegistration.partner) {
        registrationType = "doubles";
      }

      const notificationMessage = `Your ${registrationType} registration for "${tournament.tournamentName}" in ${categoryName} has been approved! You can now participate in the tournament.`;

      await createNotification({
        userId: playerId,
        type: "tournament",
        message: notificationMessage,
        metadata: {
          tournamentId: tournament._id,
          tournamentName: tournament.tournamentName,
          category: categoryName,
          registrationStatus: "approved",
          registrationType: registrationType,
        },
      });

      // Notify the approver (host/co-host) so their navbar shows the action
      try {
        const adminMessage = `You approved a ${registrationType} registration in ${categoryName} for "${tournament.tournamentName}".`;
        await createNotification({
          userId: req.user._id,
          type: "tournament",
          message: adminMessage,
          metadata: {
            tournamentId: tournament._id,
            tournamentName: tournament.tournamentName,
            category: categoryName,
            registrationStatus: "approved",
            registrationType: registrationType,
          },
        });
      } catch (_) {}
      // removed backend debug logs
    } catch (error) {
      console.error(
        "❌ APPROVAL NOTIFICATION ERROR - Failed to create notification:",
        error,
      );
      // Don't fail the entire request if notification creation fails
    }

    // removed backend debug logs after population

    // Populate registrations.player with required fields
    const populatedTournament = await Tournament.findById(tournament._id)
      .populate({
        path: "registrations.player",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.partner",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.teamMembers",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      });

    // removed backend debug logs

    // ✅ Compute age for all registered players
    populatedTournament.registrations = populatedTournament.registrations.map(
      (r) => {
        if (r.player && r.player.birthDate) {
          const today = new Date();
          const birth = new Date(r.player.birthDate);
          let age = today.getFullYear() - birth.getFullYear();
          const monthDiff = today.getMonth() - birth.getMonth();
          if (
            monthDiff < 0 ||
            (monthDiff === 0 && today.getDate() < birth.getDate())
          ) {
            age--;
          }
          r.player.age = age;
        } else if (r.player) {
          r.player.age = null;
        }
        return r;
      },
    );

    res.json({
      message: "Player approved successfully",
      tournament: populatedTournament,
    });
  } catch (error) {
    console.error("Error approving player:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Reject Player Registration
exports.rejectPlayerRegistration = async (req, res) => {
  try {
    const { playerId, category, reason } = req.body;
    // removed backend debug logs

    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });

    // Only the creator or co-hosts can reject players
    if (!hasAccessToTournament(tournament, req.user))
      return res
        .status(403)
        .json({ message: "You can only manage tournaments you created or co-host" });

    // Find the pending registration
    // For doubles/teams, we need to check if the playerId matches the player, partner, or any team member
    const registrationIndex = tournament.registrations.findIndex(
      (r) => {
        if (String(r.category) !== String(category) || !["pending", "reserved", "waiting", "approved"].includes(r.status)) {
          return false;
        }

        // Check if playerId matches the main player
        if (r.player.toString() === playerId) {
          return true;
        }

        // Check if playerId matches the partner (for doubles)
        if (r.partner && r.partner.toString() === playerId) {
          return true;
        }

        // Check if playerId matches any team member (for team categories)
        if (r.teamMembers && Array.isArray(r.teamMembers)) {
          return r.teamMembers.some(member => member.toString() === playerId);
        }

        return false;
      }
    );

    // removed backend debug logs

    if (registrationIndex === -1) {
      return res
        .status(404)
        .json({ message: "Registration not found" });
    }

    // Get the registration data before removing it (for notifications)
    const rejectedRegistration = tournament.registrations[registrationIndex];

    // Determine the category name for the notification
    let categoryName = category;
    if (
      tournament.tournamentCategories &&
      tournament.tournamentCategories.length > 0
    ) {
      const categoryObj = tournament.tournamentCategories.find((cat) => {
        const catIdString = cat._id ? cat._id.toString() : "";
        const categoryString = category ? category.toString() : "";
        return catIdString === categoryString;
      });

      if (categoryObj) {
        // Create display name from category parts
        const division = categoryObj.division || "";
        const skillLevel =
          categoryObj.skillLevel === "Open" && categoryObj.tier
            ? `Open Tier ${categoryObj.tier}`
            : categoryObj.skillLevel || "";
        const age = categoryObj.ageCategory || "";

        const parts = [division, skillLevel, age].filter(
          (part) => part && part.trim(),
        );
        categoryName =
          parts.length > 0 ? parts.join(" | ") : "Tournament Category";

        // removed backend debug logs
      }
    }

    // Determine registration type for notification message
    let registrationType = "single";
    if (rejectedRegistration.partner) {
      registrationType = "doubles";
    } else if (
      rejectedRegistration.teamMembers &&
      rejectedRegistration.teamMembers.length > 0
    ) {
      registrationType = "team";
    }

    // Create rejection notification message
    const rejectionMessage = `Your ${registrationType} registration for "${tournament.tournamentName}" in ${categoryName} has been rejected. ${reason ? `Reason: ${reason}` : ""}`;

    // Remove the registration from the tournament
    tournament.registrations.splice(registrationIndex, 1);
    await tournament.save();

    try {
      const Registration = require("../models/Registration");
      const { Types } = require("mongoose");
      const toId = (v) => (v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
      const catId = toId(rejectedRegistration.category?._id || rejectedRegistration.category);
      const playerIdObj = toId(rejectedRegistration.player?._id || rejectedRegistration.player);
      const partnerIdObj = toId(rejectedRegistration.partner?._id || rejectedRegistration.partner);
      const teamMembersIds = Array.isArray(rejectedRegistration.teamMembers)
        ? rejectedRegistration.teamMembers.map((u) => toId(u?._id || u)).filter(Boolean)
        : [];
      const teamMembersStr = teamMembersIds.map(String);
      const filterBase = {
        tournamentId: tournament._id,
        $or: [
          { categoryId: catId },
          { category: String(catId || rejectedRegistration.category || "") }
        ],
      };
      const candidates = await Registration.find(filterBase).lean();
      const toDelete = candidates
        .filter((r) => {
          const matchesPlayer = playerIdObj && String(r.playerId || "") === String(playerIdObj);
          const matchesPartner = partnerIdObj && String(r.partnerId || "") === String(partnerIdObj);
          const rMembers = Array.isArray(r.teamMembers) ? r.teamMembers.map(String).sort().join(",") : "";
          const mMembers = teamMembersStr.sort().join(",");
          const matchesMembers = mMembers && rMembers === mMembers;
          return matchesPlayer || matchesPartner || matchesMembers;
        })
        .map((r) => r._id);
      if (toDelete.length) {
        await Registration.deleteMany({ _id: { $in: toDelete } });
      } else {
        if (playerIdObj) {
          await Registration.deleteMany({
            tournamentId: tournament._id,
            playerId: playerIdObj,
            $or: [
              { categoryId: catId },
              { category: String(catId || rejectedRegistration.category || "") }
            ],
          });
        }
      }
      try {
        const broadOr = [];
        if (playerIdObj) {
          broadOr.push({ playerId: playerIdObj }, { partnerId: playerIdObj });
        }
        if (partnerIdObj) {
          broadOr.push({ playerId: partnerIdObj }, { partnerId: partnerIdObj });
        }
        if (teamMembersIds.length > 0) {
          broadOr.push({ teamMembers: { $all: teamMembersIds, $size: teamMembersIds.length } });
        }
        if (broadOr.length > 0) {
          await Registration.deleteMany({ tournamentId: tournament._id, $or: broadOr });
        }
      } catch {}
    } catch (_) {}
    try {
      if (!Array.isArray(tournament.registrations) || tournament.registrations.length === 0) {
        const Registration = require("../models/Registration");
        await Registration.deleteMany({ tournamentId: tournament._id });
      }
    } catch {}

    // 🔔 Create rejection notifications
    try {
      // Always notify the main player
      await createNotification({
        userId: playerId,
        type: "tournament",
        message: rejectionMessage,
        metadata: {
          tournamentId: tournament._id,
          tournamentName: tournament.tournamentName,
          category: categoryName,
          registrationStatus: "rejected",
          registrationType: registrationType,
          rejectionReason: reason || "No reason provided",
        },
      });

      // removed backend debug logs

      // If this is a doubles registration, notify the partner
      if (rejectedRegistration.partner) {
        // removed backend debug logs

        try {
          await createNotification({
            userId: rejectedRegistration.partner,
            type: "tournament",
            message: rejectionMessage,
            metadata: {
              tournamentId: tournament._id,
              tournamentName: tournament.tournamentName,
              category: categoryName,
              registrationStatus: "rejected",
              registrationType: registrationType,
              rejectionReason: reason || "No reason provided",
            },
          });
          // removed backend debug logs
        } catch (error) {
          console.error(
            "❌ PARTNER REJECTION NOTIFICATION ERROR - Failed to create notification for partner:",
            rejectedRegistration.partner,
            error,
          );
        }
      }

      // If this is a team registration, notify all team members (except the registrant who already got notified)
      if (
        rejectedRegistration.teamMembers &&
        Array.isArray(rejectedRegistration.teamMembers) &&
        rejectedRegistration.teamMembers.length > 0
      ) {

        // Create rejection notifications for each team member, excluding the registrant to avoid duplicates
        for (const teamMemberId of rejectedRegistration.teamMembers) {
          // Skip the registrant since they already received a notification
          if (teamMemberId.toString() === playerId.toString()) {
            continue;
          }

          try {
            await createNotification({
              userId: teamMemberId,
              type: "tournament",
              message: rejectionMessage,
              metadata: {
                tournamentId: tournament._id,
                tournamentName: tournament.tournamentName,
                category: categoryName,
                registrationStatus: "rejected",
                registrationType: registrationType,
                rejectionReason: reason || "No reason provided",
              },
            });
            // removed backend debug logs
          } catch (error) {
            console.error(
              "❌ TEAM REJECTION NOTIFICATION ERROR - Failed to create notification for team member:",
              teamMemberId,
              error,
            );
          }
        }

        // removed backend debug logs
      }
    } catch (error) {
      console.error(
        "❌ REJECTION NOTIFICATION ERROR - Failed to create notification:",
        error,
      );
      // Don't fail the entire request if notification creation fails
    }

    res.json({
      message: "Player registration rejected successfully",
      rejectionReason: reason,
    });
  } catch (error) {
    console.error("Error rejecting player:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Delete Registration
exports.deleteRegistration = async (req, res) => {
  try {
    const { tournamentId, registrationId } = req.params;

    // First, get the tournament and the registration to be deleted
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // Only the creator or co-hosts can delete registrations
    if (!hasAccessToTournament(tournament, req.user)) {
      return res
        .status(403)
        .json({ message: "You can only manage tournaments you created or co-host" });
    }

    // Find the registration to get player info before deletion
    let registrationToDelete = tournament.registrations.find(
      (reg) => reg._id.toString() === registrationId,
    );
    if (!registrationToDelete) {
      try {
        const Registration = require("../models/Registration");
        const normReg = await Registration.findById(registrationId).lean();
        if (normReg && String(normReg.tournamentId || "") === String(tournamentId)) {
          registrationToDelete = {
            _id: normReg._id,
            player: normReg.playerId,
            partner: normReg.partnerId,
            teamMembers: normReg.teamMembers,
            teamName: normReg.teamName,
            category: normReg.categoryId || normReg.category,
            playerName: normReg.playerName,
            firstName: normReg.firstName,
            lastName: normReg.lastName,
          };
        } else {
          return res.status(404).json({ message: "Registration not found" });
        }
      } catch (e) {
        return res.status(404).json({ message: "Registration not found" });
      }
    }

    const playerName =
      registrationToDelete.playerName ||
      `${registrationToDelete.firstName} ${registrationToDelete.lastName}` ||
      registrationToDelete.teamName;
    const removedCategoryId = String(
      registrationToDelete.category?._id || registrationToDelete.category || "",
    );
    let mainName = String(playerName || "").trim();
    if (!mainName) {
      try {
        const userMain = await User.findById(
          registrationToDelete.player?._id || registrationToDelete.player,
        ).lean();
        if (userMain) {
          mainName = `${userMain.firstName || ""} ${userMain.lastName || ""}`.trim() || userMain.name || "";
        }
      } catch {}
    }
    const namesToRemove = new Set();
    if (mainName) namesToRemove.add(mainName);
    if (registrationToDelete.teamName) namesToRemove.add(String(registrationToDelete.teamName));
    if (registrationToDelete.partner) {
      try {
        const userPartner = await User.findById(
          registrationToDelete.partner?._id || registrationToDelete.partner,
        ).lean();
        const partnerName = userPartner
          ? `${userPartner.firstName || ""} ${userPartner.lastName || ""}`.trim() || userPartner.name || ""
          : "";
        if (partnerName) {
          const pair1 = `${mainName} / ${partnerName}`.trim();
          const pair2 = `${partnerName} / ${mainName}`.trim();
          namesToRemove.add(pair1);
          namesToRemove.add(pair2);
        }
      } catch {}
    }

    // Remove the registration
    const result = await Tournament.updateOne(
      { _id: tournamentId },
      { $pull: { registrations: { _id: registrationId } } },
    );

    if (tournament.tournamentCategories && (namesToRemove.size > 0 || mainName)) {
      const updatedCategories = tournament.tournamentCategories.map((category) => {
        const catIdStr = String(category?._id || "");
        if (removedCategoryId && catIdStr !== removedCategoryId) return category;
        const updatedCategory = { ...category.toObject() };
        if (updatedCategory.groupStage?.groups) {
          updatedCategory.groupStage.groups = updatedCategory.groupStage.groups.map((group) => {
            if (Array.isArray(group.standings)) {
              group.standings = group.standings.filter((standing) => !namesToRemove.has(String(standing.player || "")));
            }
            if (Array.isArray(group.originalPlayers)) {
              group.originalPlayers = group.originalPlayers.filter((p) => !namesToRemove.has(String(p || "")));
            }
            if (group.matches) {
              Object.keys(group.matches).forEach((matchKey) => {
                const match = group.matches[matchKey];
                if (namesToRemove.has(String(match.player1 || ""))) {
                  match.player1 = "TBD";
                  match.score1 = 0;
                  if (String(match.winner || "") === String(match.player1 || "")) match.winner = null;
                }
                if (namesToRemove.has(String(match.player2 || ""))) {
                  match.player2 = "TBD";
                  match.score2 = 0;
                  if (String(match.winner || "") === String(match.player2 || "")) match.winner = null;
                }
              });
            }
            return group;
          });
        }
        if (updatedCategory.eliminationMatches?.matches) {
          updatedCategory.eliminationMatches.matches = updatedCategory.eliminationMatches.matches.map((match) => {
            if (namesToRemove.has(String(match.player1 || ""))) {
              match.player1 = "TBD";
              match.score1 = 0;
              if (String(match.winner || "") === String(match.player1 || "")) match.winner = null;
            }
            if (namesToRemove.has(String(match.player2 || ""))) {
              match.player2 = "TBD";
              match.score2 = 0;
              if (String(match.winner || "") === String(match.player2 || "")) match.winner = null;
            }
            return match;
          });
        }
        return updatedCategory;
      });
      await Tournament.updateOne(
        { _id: tournamentId },
        { $set: { tournamentCategories: updatedCategories } },
      );
      try {
        invalidateTournamentGetCache(tournamentId);
      } catch {}
    }

    try {
      const Registration = require("../models/Registration");
      const asId = (v) => {
        try {
          const { Types } = require("mongoose");
          return v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined;
        } catch {
          return undefined;
        }
      };
      const catId = asId(registrationToDelete.category?._id || registrationToDelete.category);
      const playerId = asId(registrationToDelete.player?._id || registrationToDelete.player);
      const partnerId = asId(registrationToDelete.partner?._id || registrationToDelete.partner);
      const teamMembersIds = Array.isArray(registrationToDelete.teamMembers)
        ? registrationToDelete.teamMembers.map((u) => asId(u?._id || u)).filter(Boolean)
        : [];
      const teamMembersStr = teamMembersIds.map(String);
      const filterBase = {
        tournamentId: tournament._id,
        $or: [{ categoryId: catId }, { category: String(catId || registrationToDelete.category || "") }],
      };
      const candidates = await Registration.find(filterBase).lean();
      const toDelete = candidates
        .filter((r) => {
          const matchesPlayer = playerId && String(r.playerId || "") === String(playerId);
          const matchesPartner = partnerId && String(r.partnerId || "") === String(partnerId);
          const rMembers = Array.isArray(r.teamMembers) ? r.teamMembers.map(String).sort().join(",") : "";
          const mMembers = teamMembersStr.sort().join(",");
          const matchesMembers = mMembers && rMembers === mMembers;
          return matchesPlayer || matchesPartner || matchesMembers;
        })
        .map((r) => r._id);
      if (toDelete.length) {
        await Registration.deleteMany({ _id: { $in: toDelete } });
      } else {
        if (playerId) {
          await Registration.deleteMany({
            tournamentId: tournament._id,
            playerId,
            $or: [{ categoryId: catId }, { category: String(catId || registrationToDelete.category || "") }],
          });
        }
      }
      try {
        const broadOr = [];
        if (playerId) {
          broadOr.push({ playerId }, { partnerId: playerId });
        }
        if (partnerId) {
          broadOr.push({ playerId: partnerId }, { partnerId });
        }
        if (teamMembersIds.length > 0) {
          broadOr.push({ teamMembers: { $all: teamMembersIds, $size: teamMembersIds.length } });
        }
        if (broadOr.length > 0) {
          await Registration.deleteMany({ tournamentId: tournament._id, $or: broadOr });
        }
      } catch {}
      try {
        const Team = require("../models/Team");
        const Standing = require("../models/Standing");
        const Match = require("../models/Match");
        const makeIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
        if (partnerId) {
          const ids = makeIds([playerId, partnerId]);
          const team = await Team.findOne({ tournamentId: tournament._id, categoryId: catId, playerIds: ids }).lean();
          if (team) {
            await Standing.deleteMany({ tournamentId: tournament._id, categoryId: catId, teamId: team._id });
            await Team.deleteOne({ _id: team._id });
          }
        }
        if (teamMembersIds.length > 0) {
          const ids = makeIds(teamMembersIds);
          const team = await Team.findOne({ tournamentId: tournament._id, categoryId: catId, playerIds: ids }).lean();
          if (team) {
            await Standing.deleteMany({ tournamentId: tournament._id, categoryId: catId, teamId: team._id });
            await Team.deleteOne({ _id: team._id });
          }
        }
        if (playerId) {
          await Standing.deleteMany({ tournamentId: tournament._id, categoryId: catId, playerId });
          await Match.updateMany(
            { tournamentId: tournament._id, categoryId: catId, $or: [{ player1Id: playerId }, { player2Id: playerId }] },
            {
              $set: {
                player1Id: undefined,
                player2Id: undefined,
                player1Name: "TBD",
                player2Name: "TBD",
                status: "Unscheduled",
                scores: {
                  game1: { team1: 0, team2: 0 },
                  game2: { team1: 0, team2: 0 },
                  game3: { team1: 0, team2: 0 },
                  final: { team1: 0, team2: 0 },
                },
              },
            }
          );
        }
      } catch (_) {}
    } catch (_) {}

    try {
      const latest = await Tournament.findById(tournamentId).select("registrations").lean();
      if (!latest || !Array.isArray(latest.registrations) || latest.registrations.length === 0) {
        try {
          const Registration = require("../models/Registration");
          await Registration.deleteMany({ tournamentId: tournament._id });
        } catch {}
      }
    } catch {}

    return res
      .status(200)
      .json({ message: "Player removed from category and brackets updated" });
  } catch (err) {
    console.error("Delete registration error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.replaceRegistrationPlayer = async (req, res) => {
  try {
    const { tournamentId, registrationId } = req.params;
    const slot = String(req.body?.slot || "").trim();
    const newPlayerIdRaw = req.body?.newPlayerId || req.body?.userId || "";
    const newPlayerId = String(newPlayerIdRaw || "").trim();
    const adminCorrectionModeRaw = String(req.body?.adminCorrectionMode || req.query?.adminCorrectionMode || "").trim().toLowerCase();
    const adminCorrectionMode = adminCorrectionModeRaw === "1" || adminCorrectionModeRaw === "true" || adminCorrectionModeRaw === "yes";
    const correctionReason = String(req.body?.reason || req.body?.correctionReason || "").trim();
    const teamMemberIndex = Number.isFinite(Number(req.body?.teamMemberIndex))
      ? Number(req.body.teamMemberIndex)
      : null;

    if (!tournamentId || !registrationId) {
      return res.status(400).json({ message: "Missing tournamentId or registrationId" });
    }
    if (!slot) {
      return res.status(400).json({ message: "Missing slot" });
    }
    if (!newPlayerId) {
      return res.status(400).json({ message: "Missing newPlayerId" });
    }

    const mongoose = require("mongoose");
    const TournamentAuditLog = require("../models/TournamentAuditLog");
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isAdmin = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!hasAccessToTournament(tournament, req.user) && !isAdmin) {
      return res.status(403).json({ message: "You can only manage tournaments you created or co-host" });
    }

    const Registration = require("../models/Registration");
    const Team = require("../models/Team");
    const Standing = require("../models/Standing");
    const Match = require("../models/Match");

    const asObjectId = (v) => {
      try {
        const { Types } = require("mongoose");
        const s = String(v || "").trim();
        if (!s) return null;
        return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
      } catch {
        return null;
      }
    };

    const newUser = await User.findById(newPlayerId).lean();
    if (!newUser) {
      return res.status(404).json({ message: "New player not found" });
    }

    const slotLower = slot.toLowerCase();
    const isMigrated = !!tournament.migratedRegistrations;

    const normalizeUserName = (u) => {
      const name = `${u?.firstName || ""} ${u?.lastName || ""}`.trim();
      return name || String(u?.name || "").trim() || "";
    };

    const findLegacyReg = () => {
      const list = Array.isArray(tournament.registrations) ? tournament.registrations : [];
      return list.find((r) => String(r?._id || "") === String(registrationId));
    };

    const legacyReg = findLegacyReg();
    const storedReg = await Registration.findById(registrationId).lean().catch(() => null);

    if (!legacyReg && !storedReg) {
      return res.status(404).json({ message: "Registration not found" });
    }

    const getRegCategoryId = () => {
      const raw = legacyReg
        ? (legacyReg.category?._id || legacyReg.category?.id || legacyReg.categoryId || legacyReg.category)
        : (storedReg.categoryId || storedReg.category);
      return String(raw || "").trim();
    };
    const categoryIdStr = getRegCategoryId();
    const categoryIdObj = asObjectId(categoryIdStr);
    if (!categoryIdObj) {
      return res.status(400).json({ message: "Missing or invalid categoryId for this registration" });
    }

    const listAllRegsForDupCheck = async () => {
      const out = [];
      const normCatId = (r) => {
        try {
          const rr = r && typeof r === "object" ? r : {};
          const raw = rr.category?._id || rr.category?.id || rr.categoryId || rr.category;
          return String(raw || "").trim();
        } catch {
          return "";
        }
      };
      const embedded = Array.isArray(tournament.registrations) ? tournament.registrations : [];
      embedded
        .filter((r) => normCatId(r) === String(categoryIdObj))
        .forEach((r) => out.push(r));
      try {
        const docs = await Registration.find({ tournamentId: tournament._id, categoryId: categoryIdObj }).lean();
        docs.forEach((r) => out.push(r));
      } catch (_) {}
      return out;
    };

    const regParticipantIds = (reg) => {
      const ids = [];
      const p = reg?.player || reg?.primaryPlayer || reg?.playerId;
      if (p) ids.push(String(typeof p === "object" ? (p._id || p.id) : p));
      const partner = reg?.partner || reg?.partnerId;
      if (partner) ids.push(String(typeof partner === "object" ? (partner._id || partner.id) : partner));
      const members = Array.isArray(reg?.teamMembers) ? reg.teamMembers : [];
      members.forEach((m) => {
        if (!m) return;
        ids.push(String(typeof m === "object" ? (m._id || m.id) : m));
      });
      return ids.map((x) => String(x || "").trim()).filter(Boolean);
    };

    const isActiveRegistrationForConflict = (r) => {
      const statusLower = String(r?.status || "").toLowerCase().trim();
      if (!statusLower) return true;
      if (statusLower === "rejected" || statusLower === "cancelled" || statusLower === "refunded" || statusLower === "deleted") return false;
      if (Boolean(r?.voidedAt) || Boolean(r?.inactive) || Boolean(r?.archived)) return false;
      const ps = String(r?.partnerStatus || "").toLowerCase().trim();
      if (ps === "declined") return false;
      return true;
    };

    const allRegsSameCat = await listAllRegsForDupCheck();
    const conflicts = allRegsSameCat.filter((r) => {
      const rid = String(r?._id || r?.id || "").trim();
      if (!rid || rid === String(registrationId)) return false;
      if (!isActiveRegistrationForConflict(r)) return false;
      const ids = regParticipantIds(r);
      return ids.includes(String(newPlayerId));
    });
    if (conflicts.length > 0) {
      return res.status(400).json({ message: "Player is already registered in this category" });
    }

    const categoryLockedByScoresOrDupr = (() => {
      const cats = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
      const cat = cats.find((c) => String(c?._id || "") === String(categoryIdStr));
      if (!cat) return { hasScores: false, hasDupr: false };
      const hasScores = (m) => {
        const mm = (m && typeof m === "object") ? m : {};
        const nums = [
          mm.game1Player1, mm.game1Player2,
          mm.game2Player1, mm.game2Player2,
          mm.game3Player1, mm.game3Player2,
          mm.finalScorePlayer1, mm.finalScorePlayer2,
        ].map((x) => Number(x) || 0);
        if (nums.some((n) => n > 0)) return true;
        const s = mm.scores || {};
        const games = [s.game1, s.game2, s.game3, s.final].filter(Boolean);
        if (games.some((g) => (Number(g?.team1) || 0) > 0 || (Number(g?.team2) || 0) > 0)) return true;
        const md = Array.isArray(mm.mdScores) ? mm.mdScores : null;
        const wd = Array.isArray(mm.wdScores) ? mm.wdScores : null;
        const xd = Array.isArray(mm.xdScores) ? mm.xdScores : null;
        const anyArr = [md, wd, xd].filter(Boolean).flat();
        if (anyArr.some((x) => Number(x) > 0)) return true;
        return false;
      };
      const hasDupr = (m) => {
        const mm = (m && typeof m === "object") ? m : {};
        if (Boolean(mm.duprMatchCode) && !Boolean(mm.duprDeletedUpstream)) return true;
        const g = mm.duprGames && typeof mm.duprGames === "object" ? mm.duprGames : {};
        return Object.keys(g).some((k) => {
          const info = g[k] || {};
          const code = String(info?.matchCode || "").trim();
          const deleted = Boolean(info?.deletedUpstream || mm.duprDeletedUpstream);
          return Boolean(code) && !deleted;
        });
      };
      let anyScores = false;
      let anyDupr = false;
      const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
      for (const g of groups) {
        const matches = g?.matches && typeof g.matches === "object" ? g.matches : {};
        for (const k of Object.keys(matches)) {
          const m = matches[k];
          if (hasScores(m)) anyScores = true;
          if (hasDupr(m)) anyDupr = true;
          if (anyScores && anyDupr) break;
        }
        if (anyScores && anyDupr) break;
      }
      const elim = cat?.eliminationMatches?.matches;
      if (Array.isArray(elim)) {
        for (const m of elim) {
          if (hasScores(m)) anyScores = true;
          if (hasDupr(m)) anyDupr = true;
          if (anyScores && anyDupr) break;
        }
      }
      return { hasScores: anyScores, hasDupr: anyDupr };
    })();

    if (categoryLockedByScoresOrDupr.hasDupr) {
      return res.status(409).json({ message: "Cannot change participants after DUPR submission. Delete/void the DUPR match first, then retry in Admin Correction Mode." });
    }
    if (categoryLockedByScoresOrDupr.hasScores && !adminCorrectionMode) {
      return res.status(409).json({ message: "Cannot change participants after scores exist. Use Admin Correction Mode to override." });
    }
    if (adminCorrectionMode && !correctionReason) {
      return res.status(400).json({ message: "Missing reason for Admin Correction Mode" });
    }

    const oldPlayerId = String(
      legacyReg
        ? ((legacyReg.player && (legacyReg.player._id || legacyReg.player.id)) || legacyReg.player || legacyReg.primaryPlayer?._id || legacyReg.primaryPlayer || "")
        : (storedReg.playerId || ""),
    ).trim();
    const oldPartnerId = String(
      legacyReg
        ? ((legacyReg.partner && (legacyReg.partner._id || legacyReg.partner.id)) || legacyReg.partner || "")
        : (storedReg.partnerId || ""),
    ).trim();
    const oldTeamMemberIds = legacyReg
      ? (Array.isArray(legacyReg.teamMembers) ? legacyReg.teamMembers.map((m) => String(m?._id || m?.id || m || "")).filter(Boolean) : [])
      : (Array.isArray(storedReg?.teamMembers) ? storedReg.teamMembers.map((m) => String(m || "")).filter(Boolean) : []);

    const getOldUser = async (id) => {
      const s = String(id || "").trim();
      if (!s) return null;
      return await User.findById(s).lean().catch(() => null);
    };
    const oldPlayerUser = await getOldUser(oldPlayerId);
    const oldPartnerUser = await getOldUser(oldPartnerId);

    const oldMainName = String(
      legacyReg
        ? (legacyReg.teamName || legacyReg.playerName || normalizeUserName(oldPlayerUser))
        : (storedReg.teamName || storedReg.playerName || normalizeUserName(oldPlayerUser)),
    ).trim();
    const oldPartnerName = String(
      legacyReg
        ? (legacyReg.partnerName || normalizeUserName(oldPartnerUser))
        : (storedReg.partnerName || normalizeUserName(oldPartnerUser)),
    ).trim();

    const newUserName = normalizeUserName(newUser);

    const setLegacy = async () => {
      if (!legacyReg) return;
      if (slotLower === "player") {
        legacyReg.player = asObjectId(newPlayerId) || legacyReg.player;
        legacyReg.playerName = newUserName || legacyReg.playerName;
      } else if (slotLower === "partner") {
        legacyReg.partner = asObjectId(newPlayerId) || legacyReg.partner;
        legacyReg.partnerName = newUserName || legacyReg.partnerName;
        legacyReg.partnerStatus = "accepted";
      } else if (slotLower === "teammember") {
        if (!Array.isArray(legacyReg.teamMembers)) legacyReg.teamMembers = [];
        if (teamMemberIndex == null || teamMemberIndex < 0 || teamMemberIndex >= legacyReg.teamMembers.length) {
          throw new Error("Invalid teamMemberIndex");
        }
        legacyReg.teamMembers[teamMemberIndex] = asObjectId(newPlayerId) || legacyReg.teamMembers[teamMemberIndex];
      } else {
        throw new Error("Invalid slot");
      }
      await tournament.save();
    };

    const updateStored = async () => {
      if (!storedReg) return;
      const update = {};
      if (slotLower === "player") {
        update.playerId = asObjectId(newPlayerId);
        update.playerName = newUserName || storedReg.playerName;
      } else if (slotLower === "partner") {
        update.partnerId = asObjectId(newPlayerId);
        update.partnerName = newUserName || storedReg.partnerName;
        update.partnerStatus = "accepted";
      } else if (slotLower === "teammember") {
        const arr = Array.isArray(storedReg.teamMembers) ? storedReg.teamMembers.map(String) : [];
        if (teamMemberIndex == null || teamMemberIndex < 0 || teamMemberIndex >= arr.length) {
          throw new Error("Invalid teamMemberIndex");
        }
        arr[teamMemberIndex] = String(newPlayerId);
        update.teamMembers = arr.map((x) => asObjectId(x)).filter(Boolean);
      } else {
        throw new Error("Invalid slot");
      }
      await Registration.updateOne({ _id: storedReg._id }, { $set: update });
    };

    const beforeAudit = {
      registrationId: String(registrationId),
      categoryId: categoryIdStr,
      slot: slotLower,
      oldPlayerId,
      oldPartnerId,
      oldTeamMemberIds,
      newPlayerId,
    };

    const runReplace = async (session) => {
      const t = await Tournament.findById(tournamentId).session(session || null);
      if (!t) throw new Error("Tournament not found");
      const embedded = Array.isArray(t.registrations) ? t.registrations : [];
      const embeddedReg = embedded.find((r) => String(r?._id || "") === String(registrationId)) || null;
      if (embeddedReg) {
        if (slotLower === "player") {
          embeddedReg.player = asObjectId(newPlayerId) || embeddedReg.player;
          embeddedReg.playerName = newUserName || embeddedReg.playerName;
        } else if (slotLower === "partner") {
          embeddedReg.partner = asObjectId(newPlayerId) || embeddedReg.partner;
          embeddedReg.partnerName = newUserName || embeddedReg.partnerName;
          embeddedReg.partnerStatus = "accepted";
        } else if (slotLower === "teammember") {
          const stable = oldTeamMemberIds.length
            ? oldTeamMemberIds.slice()
            : (Array.isArray(embeddedReg.teamMembers) ? embeddedReg.teamMembers.map((m) => String(m?._id || m?.id || m || "")).filter(Boolean) : []);
          if (teamMemberIndex == null || teamMemberIndex < 0 || teamMemberIndex >= stable.length) {
            const e = new Error("Invalid teamMemberIndex");
            e.status = 400;
            throw e;
          }
          stable[teamMemberIndex] = String(newPlayerId);
          const nextIds = stable.map((x) => asObjectId(x));
          if (nextIds.some((x) => !x)) {
            const e = new Error("Invalid team member IDs");
            e.status = 400;
            throw e;
          }
          embeddedReg.teamMembers = nextIds;
        } else {
          const e = new Error("Invalid slot");
          e.status = 400;
          throw e;
        }
        await t.save({ session });
      }

      if (storedReg) {
        const update = {};
        if (slotLower === "player") {
          update.playerId = asObjectId(newPlayerId);
          update.playerName = newUserName || storedReg.playerName;
        } else if (slotLower === "partner") {
          update.partnerId = asObjectId(newPlayerId);
          update.partnerName = newUserName || storedReg.partnerName;
          update.partnerStatus = "accepted";
        } else if (slotLower === "teammember") {
          const stable = oldTeamMemberIds.slice();
          if (teamMemberIndex == null || teamMemberIndex < 0 || teamMemberIndex >= stable.length) {
            const e = new Error("Invalid teamMemberIndex");
            e.status = 400;
            throw e;
          }
          stable[teamMemberIndex] = String(newPlayerId);
          const nextIds = stable.map((x) => asObjectId(x));
          if (nextIds.some((x) => !x)) {
            const e = new Error("Invalid team member IDs");
            e.status = 400;
            throw e;
          }
          update.teamMembers = nextIds;
        }
        await Registration.updateOne({ _id: storedReg._id }, { $set: update }, { session });
      }

      try {
        const removedId = (() => {
          if (slotLower === "partner") return String(oldPartnerId || "").trim();
          if (slotLower === "player") return String(oldPlayerId || "").trim();
          if (slotLower === "teammember") {
            if (teamMemberIndex == null) return "";
            return String(oldTeamMemberIds[teamMemberIndex] || "").trim();
          }
          return "";
        })();
        const removedObj = asObjectId(removedId);
        if (removedObj) {
          const catObj = categoryIdObj;
          try {
            await Registration.updateMany(
              { tournamentId: t._id, categoryId: catObj, playerId: removedObj, _id: { $ne: storedReg?._id } },
              { $set: { status: "rejected", partnerId: undefined, partnerStatus: "pending" } },
              { session },
            );
          } catch (_) {}
          try {
            const embeddedList = Array.isArray(t.registrations) ? t.registrations : [];
            let changed = false;
            embeddedList.forEach((r) => {
              const rid = String(r?._id || "").trim();
              if (!rid || rid === String(registrationId)) return;
              const rCatRaw = r?.category?._id || r?.category?.id || r?.categoryId || r?.category;
              const rCat = String(rCatRaw || "").trim();
              if (rCat !== String(catObj)) return;
              const rp = r?.player && typeof r.player === "object" ? (r.player._id || r.player.id) : r?.player;
              if (String(rp || "").trim() !== String(removedObj)) return;
              const st = String(r?.status || "").trim().toLowerCase();
              if (st === "rejected") return;
              r.status = "rejected";
              r.partner = undefined;
              r.partnerStatus = "pending";
              changed = true;
            });
            if (changed) await t.save({ session });
          } catch (_) {}
        }
      } catch (_) {}

      const actorId = asObjectId(req.user?._id || req.user?.id);
      if (actorId) {
        await TournamentAuditLog.create(
          [
            {
              tournamentId: asObjectId(tournamentId),
              entityType: "registration",
              entityId: String(registrationId),
              action: adminCorrectionMode ? "replace_player_admin_correction" : "replace_player",
              actorId,
              actorRoles: roles,
              reason: correctionReason,
              before: beforeAudit,
              after: { ...beforeAudit, appliedAt: new Date().toISOString() },
              meta: { slot: slotLower, teamMemberIndex },
            },
          ],
          { session },
        );
      }
    };

    let session = null;
    try {
      session = await mongoose.startSession();
      await session.withTransaction(async () => {
        await runReplace(session);
      });
    } catch (e) {
      try { if (session) await session.endSession(); } catch (_) {}
      const msg = String(e?.message || "");
      if (e?.status === 400 || msg.includes("Invalid")) {
        return res.status(400).json({ message: msg || "Invalid request" });
      }
      await runReplace(null);
    } finally {
      try { if (session) await session.endSession(); } catch (_) {}
    }

    const newMainName = String(
      slotLower === "player"
        ? (legacyReg?.teamName || storedReg?.teamName || newUserName || oldMainName)
        : oldMainName,
    ).trim();
    const newPartnerName = String(
      slotLower === "partner"
        ? (newUserName || oldPartnerName)
        : oldPartnerName,
    ).trim();

    const replaceInCategory = (cats, catId, mapping) => {
      const list = Array.isArray(cats) ? cats : [];
      const getNext = (val) => (mapping.has(String(val)) ? mapping.get(String(val)) : val);
      return list.map((c) => {
        const idStr = String(c?._id || "");
        if (catId && idStr && String(idStr) !== String(catId)) return c;
        const next = c && typeof c.toObject === "function" ? c.toObject() : { ...(c || {}) };
        if (next.groupStage?.groups) {
          next.groupStage.groups = next.groupStage.groups.map((g) => {
            const gg = { ...(g || {}) };
            if (Array.isArray(gg.standings)) {
              gg.standings = gg.standings.map((s) => {
                const ss = { ...(s || {}) };
                ss.player = getNext(ss.player);
                if (ss.teamName) ss.teamName = getNext(ss.teamName);
                if (ss.displayName) ss.displayName = getNext(ss.displayName);
                return ss;
              });
            }
            if (Array.isArray(gg.originalPlayers)) {
              gg.originalPlayers = gg.originalPlayers.map((p) => getNext(p));
            }
            if (gg.matches) {
              Object.keys(gg.matches).forEach((k) => {
                const m = gg.matches[k];
                if (!m) return;
                const mm = m;
                mm.player1 = getNext(mm.player1);
                mm.player2 = getNext(mm.player2);
                if (mm.winner) mm.winner = getNext(mm.winner);
              });
            }
            return gg;
          });
        }
        if (next.eliminationMatches?.matches) {
          next.eliminationMatches.matches = next.eliminationMatches.matches.map((m) => {
            const mm = { ...(m || {}) };
            mm.player1 = getNext(mm.player1);
            mm.player2 = getNext(mm.player2);
            if (mm.winner) mm.winner = getNext(mm.winner);
            return mm;
          });
        }
        return next;
      });
    };

    try {
      const mapping = new Map();
      if (oldMainName && newMainName && oldMainName !== newMainName) mapping.set(oldMainName, newMainName);
      if (oldPartnerName && newPartnerName && oldPartnerName !== newPartnerName) mapping.set(oldPartnerName, newPartnerName);
      if (oldMainName && oldPartnerName && newMainName && newPartnerName) {
        const oldPair1 = `${oldMainName} / ${oldPartnerName}`.trim();
        const oldPair2 = `${oldPartnerName} / ${oldMainName}`.trim();
        const newPair1 = `${newMainName} / ${newPartnerName}`.trim();
        const newPair2 = `${newPartnerName} / ${newMainName}`.trim();
        if (oldPair1 !== newPair1) mapping.set(oldPair1, newPair1);
        if (oldPair2 !== newPair2) mapping.set(oldPair2, newPair2);
      }

      if (mapping.size > 0 && Array.isArray(tournament.tournamentCategories)) {
        const updatedCategories = replaceInCategory(tournament.tournamentCategories, categoryIdStr, mapping);
        await Tournament.updateOne({ _id: tournament._id }, { $set: { tournamentCategories: updatedCategories } });
      }
    } catch (_) {}

    try {
      const oldIdObj = asObjectId(slotLower === "partner" ? oldPartnerId : oldPlayerId);
      const newIdObj = asObjectId(newPlayerId);
      const isTeamReg =
        (legacyReg && Array.isArray(legacyReg.teamMembers) && legacyReg.teamMembers.length > 0) ||
        (storedReg && Array.isArray(storedReg.teamMembers) && storedReg.teamMembers.length > 0);

      const looksDoubles = !!(oldPartnerId || (legacyReg && legacyReg.partner) || (storedReg && storedReg.partnerId));

      if (!isTeamReg && !looksDoubles && oldIdObj && newIdObj && categoryIdObj) {
        await Standing.updateMany(
          { tournamentId: tournament._id, categoryId: categoryIdObj, playerId: oldIdObj },
          { $set: { playerId: newIdObj, displayName: newUserName } },
        );
        await Match.updateMany(
          { tournamentId: tournament._id, categoryId: categoryIdObj, player1Id: oldIdObj },
          { $set: { player1Id: newIdObj, player1Name: newUserName } },
        );
        await Match.updateMany(
          { tournamentId: tournament._id, categoryId: categoryIdObj, player2Id: oldIdObj },
          { $set: { player2Id: newIdObj, player2Name: newUserName } },
        );
      }

      if ((looksDoubles || isTeamReg) && categoryIdObj) {
        const oldIds = looksDoubles
          ? [oldPlayerId, oldPartnerId].map(asObjectId).filter(Boolean).map(String).sort()
          : oldTeamMemberIds.map(asObjectId).filter(Boolean).map(String).sort();
        const newIds = (() => {
          if (looksDoubles) {
            const p1 = slotLower === "player" ? newPlayerId : oldPlayerId;
            const p2 = slotLower === "partner" ? newPlayerId : oldPartnerId;
            return [p1, p2].map(asObjectId).filter(Boolean).map(String).sort();
          }
          if (slotLower === "teammember") {
            const arr = oldTeamMemberIds.slice();
            if (teamMemberIndex != null && teamMemberIndex >= 0 && teamMemberIndex < arr.length) {
              arr[teamMemberIndex] = newPlayerId;
            }
            return arr.map(asObjectId).filter(Boolean).map(String).sort();
          }
          return oldTeamMemberIds.map(asObjectId).filter(Boolean).map(String).sort();
        })();

        if (oldIds.length > 0 && newIds.length > 0) {
          const team = await Team.findOne({ tournamentId: tournament._id, categoryId: categoryIdObj, playerIds: oldIds }).lean();
          if (team) {
            await Team.updateOne({ _id: team._id }, { $set: { playerIds: newIds } });
            const displayName = looksDoubles ? `${newMainName} / ${newPartnerName}`.trim() : (legacyReg?.teamName || storedReg?.teamName || team.teamName || "");
            await Standing.updateMany(
              { tournamentId: tournament._id, categoryId: categoryIdObj, teamId: team._id },
              { $set: { displayName, teamName: legacyReg?.teamName || storedReg?.teamName || team.teamName || "" } },
            );
            await Match.updateMany(
              { tournamentId: tournament._id, categoryId: categoryIdObj, team1Id: team._id },
              { $set: { team1Members: newIds } },
            );
            await Match.updateMany(
              { tournamentId: tournament._id, categoryId: categoryIdObj, team2Id: team._id },
              { $set: { team2Members: newIds } },
            );
          }
        }
      }
    } catch (_) {}

    try {
      invalidateTournamentGetCache(tournamentId);
    } catch {}

    return res.status(200).json({ message: "Registration updated" });
  } catch (err) {
    console.error("replaceRegistrationPlayer error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.getTournamentAuditLogs = async (req, res) => {
  try {
    const { id } = req.params;
    const TournamentAuditLog = require("../models/TournamentAuditLog");
    const tournament = await Tournament.findById(id).select("createdBy coHosts").lean();
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isAdmin = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isAdmin && !hasAccessToTournament(tournament, req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const entityType = String(req.query?.entityType || "").trim();
    const entityId = String(req.query?.entityId || "").trim();
    const limitRaw = Number(req.query?.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, limitRaw)) : 100;
    const cursor = String(req.query?.cursor || "").trim();

    const filter = { tournamentId: tournament._id };
    if (entityType) filter.entityType = entityType;
    if (entityId) filter.entityId = entityId;
    if (cursor) {
      try {
        const { Types } = require("mongoose");
        if (Types.ObjectId.isValid(cursor)) {
          filter._id = { $lt: new Types.ObjectId(cursor) };
        }
      } catch (_) {}
    }

    const logs = await TournamentAuditLog.find(filter)
      .sort({ _id: -1 })
      .limit(limit)
      .lean();
    const nextCursor = logs.length ? String(logs[logs.length - 1]._id) : "";
    return res.json({ logs, nextCursor });
  } catch (err) {
    console.error("getTournamentAuditLogs error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

exports.deleteDuprMatchForCorrection = async (req, res) => {
  try {
    const { id } = req.params;
    const stageRaw = String(req.body?.stage || req.query?.stage || "").trim().toLowerCase();
    const categoryId = String(req.body?.categoryId || req.query?.categoryId || "").trim();
    const groupId = String(req.body?.groupId || req.query?.groupId || "").trim();
    const matchKey = String(req.body?.matchKey || req.query?.matchKey || "").trim();
    const gameNoRaw = req.body?.gameNo ?? req.query?.gameNo ?? null;
    const gameNo = gameNoRaw === null || gameNoRaw === undefined || gameNoRaw === "" ? null : Number(gameNoRaw);
    const reason = String(req.body?.reason || "").trim();
    if (!categoryId || !matchKey) {
      return res.status(400).json({ message: "Missing categoryId or matchKey" });
    }
    if (!reason) {
      return res.status(400).json({ message: "Missing reason" });
    }
    const stage = stageRaw || (String(groupId || "").toLowerCase() === "elimination" ? "elimination" : "group");

    const TournamentAuditLog = require("../models/TournamentAuditLog");
    const duprService = require("../services/duprService");
    const tournament = await Tournament.findById(id);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isAdmin = roles.includes("superadmin") || roles.includes("clubadmin");
    if (!isAdmin && !hasAccessToTournament(tournament, req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const cats = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const catIndex = cats.findIndex((c) => String(c?._id || "") === String(categoryId));
    if (catIndex < 0) return res.status(404).json({ message: "Category not found" });
    const cat = tournament.tournamentCategories[catIndex];

    const nowIso = new Date().toISOString();
    let before = null;
    let after = null;
    let entityId = "";
    let codesToDelete = [];

    const extractTargets = (m) => {
      const out = [];
      const mm = (m && typeof m === "object") ? m : {};
      const duprGames = mm.duprGames && typeof mm.duprGames === "object" ? mm.duprGames : {};
      if (Number.isFinite(gameNo) && gameNo > 0) {
        const info = duprGames[`g${gameNo}`] || {};
        const code = String(info?.matchCode || mm.duprMatchCode || "").trim();
        const identifier = String(info?.identifier || mm.duprIdentifier || "").trim();
        if (code) out.push({ code, identifier, gameNo: Number(gameNo) });
        return out;
      }
      Object.keys(duprGames).forEach((k) => {
        const info = duprGames[k] || {};
        const code = String(info?.matchCode || "").trim();
        const deleted = Boolean(info?.deletedUpstream || mm.duprDeletedUpstream);
        if (code && !deleted) out.push({ code, identifier: String(info?.identifier || mm.duprIdentifier || "").trim(), gameNo: Number(String(k).replace(/\D+/g, "")) || null });
      });
      const top = String(mm.duprMatchCode || "").trim();
      if (top && !out.some((x) => x.code === top)) out.push({ code: top, identifier: String(mm.duprIdentifier || "").trim(), gameNo: null });
      return out;
    };

    const setDeleted = (m) => {
      const mm = (m && typeof m === "object") ? { ...m } : {};
      const duprGames = mm.duprGames && typeof mm.duprGames === "object" ? { ...mm.duprGames } : {};
      const targets = extractTargets(mm);
      targets.forEach((t) => {
        if (!t?.code) return;
        Object.keys(duprGames).forEach((k) => {
          const info = duprGames[k] || {};
          const code = String(info?.matchCode || "").trim();
          if (code && code === String(t.code)) {
            duprGames[k] = {
              ...info,
              synced: false,
              deletedAt: nowIso,
              deletedUpstream: true,
              matchCode: null,
              identifier: undefined,
              matchId: undefined,
            };
          }
        });
      });
      mm.duprGames = duprGames;
      mm.duprSynced = undefined;
      mm.duprIdentifier = undefined;
      mm.duprMatchCode = undefined;
      mm.duprDeletedUpstream = true;
      mm.duprDeletedAt = nowIso;
      mm.duprNeedsCorrection = true;
      mm.duprCorrectionSeq = (Number(mm.duprCorrectionSeq) || 0) + 1;
      mm.duprCorrectionReason = reason;
      return mm;
    };

    if (stage === "elimination") {
      const em = Array.isArray(cat?.eliminationMatches?.matches) ? cat.eliminationMatches.matches : [];
      const idx = (() => {
        const s = String(matchKey || "").trim();
        if (s.startsWith("e-")) {
          const n = parseInt(s.slice(2), 10);
          return Number.isFinite(n) ? n : -1;
        }
        const n2 = parseInt(s, 10);
        return Number.isFinite(n2) ? n2 : -1;
      })();
      if (idx < 0 || !em[idx]) return res.status(404).json({ message: "Elimination match not found" });
      const m0 = em[idx] && typeof em[idx].toObject === "function" ? em[idx].toObject() : (em[idx] || {});
      before = { ...m0 };
      entityId = `elim:${categoryId}:${idx}${Number.isFinite(gameNo) ? `:g${gameNo}` : ""}`;
      codesToDelete = extractTargets(m0);
      if (!codesToDelete.length) return res.status(400).json({ message: "No DUPR matchCode found to delete" });
      const next = setDeleted(m0);
      cat.eliminationMatches.matches[idx] = next;
      after = { ...next };
      try { tournament.markModified(`tournamentCategories.${catIndex}.eliminationMatches.matches`); } catch (_) {}
    } else {
      if (!groupId) return res.status(400).json({ message: "Missing groupId" });
      const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
      const groupIndex = groups.findIndex((g) => String(g?.id || "") === String(groupId));
      if (groupIndex < 0) return res.status(404).json({ message: "Group not found" });
      const g = cat.groupStage.groups[groupIndex];
      const mm = g.matches && typeof g.matches === "object" ? g.matches : {};
      const m0 = mm[matchKey] || null;
      if (!m0) return res.status(404).json({ message: "Match not found" });
      before = { ...(m0 && typeof m0.toObject === "function" ? m0.toObject() : m0) };
      entityId = `group:${categoryId}:${groupId}:${matchKey}${Number.isFinite(gameNo) ? `:g${gameNo}` : ""}`;
      codesToDelete = extractTargets(before);
      if (!codesToDelete.length) return res.status(400).json({ message: "No DUPR matchCode found to delete" });
      const next = setDeleted(before);
      g.matches = { ...mm, [matchKey]: next };
      after = { ...next };
      const matchesPath = `tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.matches`;
      tournament.set(matchesPath, g.matches);
      try { tournament.markModified(matchesPath); } catch (_) { try { tournament.markModified("tournamentCategories"); } catch (_) {} }
    }

    const baseCandidatesRaw = [
      process.env.DUPR_API_BASE,
      process.env.DUPR_API_BASE_URL,
      "https://prod.mydupr.com/api",
      "https://api.dupr.gg",
    ];
    const bases = Array.from(new Set(baseCandidatesRaw.map((b) => String(b || "").trim()).filter(Boolean)));
    const deleteOne = async (code, identifier) => {
      const payload = { matchCode: String(code || "").trim() };
      const idf = String(identifier || "").trim();
      if (idf) payload.identifier = idf;
      let lastErr = null;
      for (const base0 of bases) {
        const base = String(base0).replace(/\/$/, "");
        const url = `${base}/match/v1.0/delete`;
        try {
          await duprService.attemptReq(url, "DELETE", payload);
          return { ok: true, base, url };
        } catch (e1) {
          const st = e1?.response?.status || 0;
          const msg = String(e1?.response?.data?.message || e1?.message || "").toLowerCase();
          if (st === 404 || msg.includes("already deleted") || msg.includes("already removed") || msg.includes("not found")) {
            return { ok: true, base, url, already: true };
          }
          if (st === 405) {
            try {
              await duprService.attemptReq(url, "POST", payload);
              return { ok: true, base, url, method: "POST" };
            } catch (e2) {
              lastErr = e2;
            }
          } else {
            lastErr = e1;
          }
        }
      }
      const status = lastErr?.response?.status || 502;
      const message = lastErr?.response?.data?.message || lastErr?.message || "Delete failed";
      return { ok: false, status, message };
    };

    for (const t of codesToDelete) {
      const r = await deleteOne(t.code, t.identifier);
      if (!r.ok) {
        return res.status(Number(r.status) || 502).json({ message: r.message || "Delete failed" });
      }
    }

    await tournament.save();
    try {
      await TournamentAuditLog.create({
        tournamentId: tournament._id,
        entityType: "match",
        entityId,
        action: "dupr_delete_for_correction",
        actorId: req.user?._id || req.user?.id,
        actorRoles: roles,
        reason,
        before,
        after,
        meta: { categoryId, groupId: groupId || null, matchKey, stage, gameNo: Number.isFinite(gameNo) ? Number(gameNo) : null },
      });
    } catch (_) {}

    try { invalidateTournamentGetCache(id); } catch {}
    return res.json({ ok: true, message: "Deleted on DUPR and marked for correction", entityId });
  } catch (err) {
    console.error("deleteDuprMatchForCorrection error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ✅ Register for tournament
const registerForTournament = async (req, res) => {
  try {

    const {
      tournamentId,
      category,
      partnerId,
      playerName,
      playerEmail,
      playerPhone,
      emergencyContact,
      emergencyPhone,
      registrationWithShirt: registrationWithShirtRaw,
      shirtSize: shirtSizeRaw,
      teamName,
      teamMembers,
      waitlist: waitlistRaw,
      paymentMode: paymentModeRaw,
      paymongoCheckoutSessionId: paymongoCheckoutSessionIdRaw,
      paymentStatus: paymentStatusRaw,
    } = req.body;

    // removed backend debug logs

    // Validate required fields
    if (!tournamentId || !category || !playerName || !playerEmail) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Check if user is authenticated
    if (!req.user || !req.user._id) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    // Find the tournament
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    const now = new Date();
    if (tournament.registrationOpensAt) {
      const opens = new Date(tournament.registrationOpensAt);
      if (!isNaN(opens.getTime()) && now < opens) {
        return res.status(400).json({ message: "Registration has not opened yet" });
      }
    }
    if (tournament.registrationClosesAt) {
      const closes = new Date(tournament.registrationClosesAt);
      if (!isNaN(closes.getTime()) && now > closes) {
        return res.status(400).json({ message: "Registration is closed" });
      }
    }
    if (tournament.registrationDeadline) {
      const dl = new Date(tournament.registrationDeadline);
      const endOfDay = new Date(dl.getFullYear(), dl.getMonth(), dl.getDate(), 23, 59, 59, 999);
      if (!isNaN(dl.getTime()) && now > endOfDay) {
        return res.status(400).json({ message: "Registration is closed" });
      }
    }

    // Enhanced registration validation
    
    // Rule 1: Check for ANY existing registration by current user in this category FIRST
    const userExistingRegistrations = tournament.registrations.filter(
      (r) => String(r.category) === String(category) &&
        (r.player.toString() === req.user._id.toString() || 
         (r.partner && r.partner.toString() === req.user._id.toString()) ||
         (r.teamMembers && Array.isArray(r.teamMembers) && 
          r.teamMembers.some(memberId => memberId.toString() === req.user._id.toString())))
    );

    // Rule 1a: Check partner status restrictions for doubles categories
    if (partnerId) {
      const partnerRegistrations = tournament.registrations.filter(
        (r) => 
          String(r.category) === String(category) &&
          ((r.player.toString() === req.user._id.toString() && r.partner && r.partner.toString() === partnerId.toString()) ||
           (r.player.toString() === partnerId.toString() && r.partner && r.partner.toString() === req.user._id.toString()))
      );

      for (const partnerReg of partnerRegistrations) {
        const partnerStatus = partnerReg.partnerStatus;
        
        // If partner status is pending or accepted, block registration
        if (partnerStatus === 'pending' || partnerStatus === 'accepted') {
          const statusMessage = partnerStatus === 'pending' 
            ? `You have a pending partner invitation for this category. Please wait for your partner to respond or cancel the existing invitation before registering again.`
            : `You already have an accepted partnership for this category. To change partners, please contact the tournament organizer.`;
          
          return res
            .status(400)
            .json({ message: statusMessage });
        }
        
        // If partner status is declined, allow registration (no blocking)
        // This is handled by not blocking when partnerStatus === 'declined'
      }
    }

    // Rule 1b: Check if user has any accepted partnership in this category (regardless of who they're trying to partner with now)
    for (const existingReg of userExistingRegistrations) {
      if (existingReg.partnerStatus === 'accepted') {
        return res
          .status(400)
          .json({ 
            message: `You already have an accepted partnership for this category. To change partners, please contact the tournament organizer.` 
          });
      }
      // Note: declined partnerships are allowed to re-register (no blocking)
    }

    // Rule 2: Check if player is already registered as a team member in this category
    const teamMemberRegistrations = tournament.registrations.filter(
      (r) => String(r.category) === String(category) &&
             r.teamMembers && Array.isArray(r.teamMembers) &&
             r.teamMembers.some(memberId => memberId.toString() === req.user._id.toString()) &&
             !(r.status === "awaiting_payment" && String(r.player) === String(req.user._id)) &&
             r.partnerStatus !== 'declined'  // Allow re-registration if previous partnership was declined
    );

    if (teamMemberRegistrations.length > 0) {
      return res
        .status(400)
        .json({ 
          message: `You are already registered as a team member in this category. Each player can only participate once per category.` 
        });
    }

    // Resolve category object and compute real-time capacity
    const categoryObj = tournament.tournamentCategories.find((cat) => {
      const catIdString = cat._id ? cat._id.toString() : "";
      const categoryString = category ? category.toString() : "";
      return catIdString === categoryString;
    });

    const divLower = String(categoryObj?.division || "").toLowerCase();
    const isTeamDiv = divLower.includes("team");
    const isSinglesDiv = divLower.includes("singles");
    const skillLower = String(categoryObj?.skillLevel || "").toLowerCase();
    const isMixedNoviceDiv = divLower.includes("mixed") && divLower.includes("doubles") && skillLower === "novice";
    const computeSlots = (list) => {
      if (isTeamDiv) {
        const teamRegs = list.filter((r) => (Array.isArray(r.teamMembers) && r.teamMembers.length > 0) || r.teamName);
        return teamRegs.length;
      }
      if (isSinglesDiv || isMixedNoviceDiv) {
        return list.length;
      }
      const pairRegs = list.filter((r) => !!r.partner);
      const soloRegs = list.filter((r) => !r.partner);
      return pairRegs.length + Math.ceil(soloRegs.length / 2);
    };
    const capacity = parseInt(categoryObj?.maxParticipants) || 0;
    const reservedSlots = parseInt(categoryObj?.reservedSlots) || 0;
    const regsForCategory = tournament.registrations.filter((r) => String(r.category) === String(category));
    const approvedUsed = computeSlots(regsForCategory.filter((r) => r.status === "approved"));
    const computePendingUsed = (list) =>
      computeSlots(
        list.filter(
          (r) =>
            (r.status === "pending" || r.status === "awaiting_payment") &&
            !r.waitlist &&
            r.partnerStatus !== "declined"
        )
      );
    const pendingUsed = computePendingUsed(regsForCategory);
    const usedTotal = approvedUsed + pendingUsed + reservedSlots;
    const remainingSlots = capacity > 0 ? Math.max(0, capacity - usedTotal) : 0;
    const shouldWaitlist = remainingSlots <= 0;

    // If user already has a waitlist registration, either upgrade to pending if slots available or block duplicate
    const existingWaitlistReg = regsForCategory.find(
      (r) => r.player.toString() === req.user._id.toString() && r.waitlist === true
    );

    if (existingWaitlistReg) {
      if (remainingSlots > 0) {
        existingWaitlistReg.waitlist = false;
        existingWaitlistReg.status = "pending";
        await tournament.save();

        const registrationTypeUpgrade = (existingWaitlistReg.teamName || (Array.isArray(existingWaitlistReg.teamMembers) && existingWaitlistReg.teamMembers.length > 0))
          ? "team"
          : (existingWaitlistReg.partner ? "doubles" : "single");
        const registrationNounUpgrade = registrationTypeUpgrade === "team"
          ? "team registration"
          : (registrationTypeUpgrade === "doubles" ? "doubles registration" : "registration");

        await createNotification({
          userId: req.user._id,
          type: "tournament",
          message: `Your ${registrationNounUpgrade} for "${tournament.tournamentName}" in ${String(categoryObj?.division || "Tournament Category")} has been moved from waiting list to pending approval due to a newly available slot.`,
          metadata: {
            tournamentId: tournament._id,
            tournamentName: tournament.tournamentName,
            category: String(categoryObj?.division || "Tournament Category"),
            registrationStatus: "pending",
            registrationType: registrationTypeUpgrade,
          },
        });

        return res.status(200).json({
          message: "Waiting list registration upgraded to pending",
          registration: existingWaitlistReg,
        });
      }
      return res.status(400).json({ message: "You are already on the waiting list for this category" });
    }

    // Rule 3: Check if player is already registered in this category (excluding declined partnerships and excluding pure waitlist handled above)
    const existingRegistrations = tournament.registrations.filter(
      (r) => r.player.toString() === req.user._id.toString() && 
             String(r.category) === String(category) &&
             String(r.status || "").toLowerCase() !== "awaiting_payment" &&
             r.partnerStatus !== 'declined'
    );

    if (existingRegistrations.length > 0) {
      // More robust category detection
      const categoryLower = String(category).toLowerCase();
      const isDoublesCategory = categoryLower.includes('doubles') || 
                               categoryLower.includes('mixed') || 
                               categoryLower.includes('pair') ||
                               categoryLower.includes('team');
      const errorMessage = isDoublesCategory 
        ? `You are already registered in this doubles/mixed category. To register with a different partner, please contact the tournament organizer.`
        : `You are already registered in this singles category. Each player can only register once per category.`;
      return res.status(400).json({ message: errorMessage });
    }

    // Handle proof of payment files (upload up to 2 to GCS)
    let proofOfPaymentPaths = [];
    const fs = require('fs');
    const { uploadToGCS } = require('../utils/gcs');
    if (Array.isArray(req.files) && req.files.length > 0) {
      for (const f of req.files.slice(0, 2)) {
        const dest = `tournaments/proofs/${f.filename}`;
        const url = await uploadToGCS(f.path, dest);
        proofOfPaymentPaths.push(url);
        fs.promises.unlink(f.path).catch(() => {});
      }
    } else if (req.file) {
      const dest = `tournaments/proofs/${req.file.filename}`;
      const url = await uploadToGCS(req.file.path, dest);
      proofOfPaymentPaths.push(url);
      fs.promises.unlink(req.file.path).catch(() => {});
    }

    // Normalize shirt fields (accept any text; no dependency on checkbox)
    const registrationWithShirt = ["true", "1", "yes", "on"].includes(
      String(registrationWithShirtRaw || "").toLowerCase()
    );
    const shirtSize = typeof shirtSizeRaw === "string"
      ? shirtSizeRaw.trim()
      : undefined;
    const paymentMode = String(paymentModeRaw || "manual").toLowerCase() === "paymongo" ? "paymongo" : "manual";
    const paymongoCheckoutSessionId = String(paymongoCheckoutSessionIdRaw || "").trim();

    const normalizeGender = (value) => {
      const g = String(value || "").toLowerCase().trim();
      if (g === "f" || g === "female" || g === "woman" || g === "women") return "female";
      if (g === "m" || g === "male" || g === "man" || g === "men") return "male";
      return "";
    };

    const normalizeDivision = (value) => {
      return String(value || "")
        .toLowerCase()
        .replace(/[’‘]/g, "'");
    };

    if (partnerId && categoryObj) {
      const dbPartner = await User.findById(partnerId).select("gender birthDate");
      if (!dbPartner) {
        return res.status(400).json({ message: "Selected partner not found" });
      }
      const divisionLower = normalizeDivision(categoryObj.division || "");
      const userGender = normalizeGender(req.user.gender);
      const partnerGender = normalizeGender(dbPartner.gender);
      if (divisionLower.includes("mixed")) {
        if (userGender && partnerGender && userGender === partnerGender) {
          return res.status(400).json({ message: "Mixed doubles requires an opposite-gender partner." });
        }
      } else if (divisionLower.includes("women")) {
        if (partnerGender && partnerGender !== "female") {
          return res.status(400).json({ message: "Women's doubles requires a female partner." });
        }
      } else if (divisionLower.includes("men") && !divisionLower.includes("women")) {
        if (partnerGender && partnerGender !== "male") {
          return res.status(400).json({ message: "Men's doubles requires a male partner." });
        }
      }
    }

    const categoryFeeAtRegistration = Number(categoryObj?.fee ?? categoryObj?.entryFee ?? 0);
    let lockedPaidAmount = Number.isFinite(categoryFeeAtRegistration) && categoryFeeAtRegistration > 0
      ? categoryFeeAtRegistration
      : 0;
    const requiresPayment = !shouldWaitlist && lockedPaidAmount > 0;
    const requestedPaymentStatus = String(paymentStatusRaw || "").toLowerCase().trim();
    let isPaid = requestedPaymentStatus === "paid";
    let paymongoPaymentIntentId = "";
    let paymongoPaymentId = "";
    if (requiresPayment) {
      if (paymentMode === "paymongo") {
        if (!paymongoCheckoutSessionId) {
          return res.status(400).json({ message: "Missing PayMongo checkout session ID" });
        }
        const gatewayVerification = await verifyPayMongoCheckoutSessionPaid(paymongoCheckoutSessionId);
        if (gatewayVerification?.isPaid) isPaid = true;
        paymongoPaymentIntentId = String(gatewayVerification?.paymentIntentId || "").trim();
        paymongoPaymentId = String(gatewayVerification?.paymentId || "").trim();
        const verifiedPaidAmount = Number(gatewayVerification?.paidAmount || 0);
        if (Number.isFinite(verifiedPaidAmount) && verifiedPaidAmount > 0) {
          lockedPaidAmount = verifiedPaidAmount;
        }
        if (!isPaid) {
          return res.status(402).json({ message: "PayMongo payment not completed" });
        }
      } else {
        if (proofOfPaymentPaths.length === 0) {
          return res.status(400).json({ message: "Proof of payment is required before registration." });
        }
        isPaid = false;
      }
    }

    const existingAwaitingPaymentRegistration = tournament.registrations.find(
      (r) =>
        String(r.player) === String(req.user._id) &&
        String(r.category) === String(category) &&
        r.status === "awaiting_payment"
    );
    if (existingAwaitingPaymentRegistration) {
      if (!isPaid) {
        return res.status(402).json({ message: "Payment required before registration." });
      }
      // Important: when upgrading a paid awaiting registration, do not let the user's own
      // awaiting slot force them into waitlist. Recompute slot pressure excluding this record.
      const regsWithoutCurrentAwaiting = regsForCategory.filter(
        (r) => String(r._id) !== String(existingAwaitingPaymentRegistration._id)
      );
      const pendingUsedWithoutCurrentAwaiting = computePendingUsed(regsWithoutCurrentAwaiting);
      const usedTotalWithoutCurrentAwaiting = approvedUsed + pendingUsedWithoutCurrentAwaiting + reservedSlots;
      const remainingSlotsWithoutCurrentAwaiting =
        capacity > 0 ? Math.max(0, capacity - usedTotalWithoutCurrentAwaiting) : 0;
      const shouldWaitlistOnUpgrade = remainingSlotsWithoutCurrentAwaiting <= 0;

      existingAwaitingPaymentRegistration.status = shouldWaitlistOnUpgrade ? "waiting" : "pending";
      existingAwaitingPaymentRegistration.paymentStatus = "paid";
      existingAwaitingPaymentRegistration.paymentMode = "paymongo";
      existingAwaitingPaymentRegistration.paidAmount =
        Number(existingAwaitingPaymentRegistration.paidAmount || 0) > 0
          ? Number(existingAwaitingPaymentRegistration.paidAmount || 0)
          : lockedPaidAmount;
      existingAwaitingPaymentRegistration.paymongoCheckoutSessionId = paymongoCheckoutSessionId;
      existingAwaitingPaymentRegistration.paymongoPaymentIntentId = paymongoPaymentIntentId;
      existingAwaitingPaymentRegistration.paymongoPaymentId = paymongoPaymentId;
      existingAwaitingPaymentRegistration.waitlist = shouldWaitlistOnUpgrade;
      await tournament.save();
      try {
        const Registration = require("../models/Registration");
        const { Types } = require("mongoose");
        const asId = (v) => (v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
        const normIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
        const cId = asId(category) || category;
        const pId = asId(req.user._id) || req.user._id;
        const prId = asId(existingAwaitingPaymentRegistration.partner) || existingAwaitingPaymentRegistration.partner || undefined;
        const tm = Array.isArray(existingAwaitingPaymentRegistration.teamMembers)
          ? existingAwaitingPaymentRegistration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
          : [];
        const filter = {
          tournamentId: tournament._id,
          categoryId: cId,
          playerId: pId,
          teamName: existingAwaitingPaymentRegistration.teamName || null,
          teamMembers: normIds(tm),
        };
        if (prId) filter.partnerId = prId;
        const doc = {
          tournamentId: tournament._id,
          categoryId: cId,
          category: String(cId || category),
          playerId: pId,
          partnerId: prId || undefined,
          teamMembers: normIds(tm),
          teamName: existingAwaitingPaymentRegistration.teamName || undefined,
          status: existingAwaitingPaymentRegistration.status,
          proofOfPayment: existingAwaitingPaymentRegistration.proofOfPayment || [],
          contactNumber:
            existingAwaitingPaymentRegistration.contactNumber ||
            existingAwaitingPaymentRegistration.playerPhone ||
            undefined,
          email:
            existingAwaitingPaymentRegistration.email ||
            existingAwaitingPaymentRegistration.playerEmail ||
            undefined,
          emergencyContact: existingAwaitingPaymentRegistration.emergencyContact || undefined,
          emergencyPhone: existingAwaitingPaymentRegistration.emergencyPhone || undefined,
          paymongoCheckoutSessionId: existingAwaitingPaymentRegistration.paymongoCheckoutSessionId || "",
          paymongoPaymentIntentId: existingAwaitingPaymentRegistration.paymongoPaymentIntentId || "",
          paymongoPaymentId: existingAwaitingPaymentRegistration.paymongoPaymentId || "",
          paidAmount: Number(existingAwaitingPaymentRegistration.paidAmount || 0),
          registrationDate: existingAwaitingPaymentRegistration.registrationDate || new Date(),
        };
        await Registration.updateOne(filter, { $set: doc }, { upsert: true });
      } catch (_) {}
      await sendTournamentPaymentReceipt(
        existingAwaitingPaymentRegistration,
        tournament.tournamentName,
        categoryObj,
        req.user,
      );
      await sendTournamentRegistrationConfirmation(
        existingAwaitingPaymentRegistration,
        tournament.tournamentName,
        categoryObj,
        req.user,
      );
      return res.status(200).json({
        message: shouldWaitlistOnUpgrade
          ? "Payment verified. Registration remains in waiting list."
          : "Payment verified. Registration moved to pending.",
        registration: existingAwaitingPaymentRegistration,
      });
    }

    if (requiresPayment && paymentMode === "paymongo" && !isPaid) {
      return res.status(402).json({ message: "Payment required before registration." });
    }

    // Create registration object
    const registration = {
      player: req.user._id,
      category,
      status: shouldWaitlist ? "waiting" : "pending",
      partnerStatus: partnerId ? "accepted" : "pending",
      playerName,
      playerEmail,
      playerPhone,
      emergencyContact,
      emergencyPhone,
      proofOfPayment: proofOfPaymentPaths,
      paymentMode: requiresPayment ? paymentMode : "manual",
      paymentStatus: requiresPayment ? (paymentMode === "paymongo" ? "paid" : "pending") : "pending",
      paidAmount: requiresPayment && paymentMode === "paymongo" ? lockedPaidAmount : 0,
      paymongoCheckoutSessionId: requiresPayment && paymentMode === "paymongo" ? paymongoCheckoutSessionId : "",
      paymongoPaymentIntentId: requiresPayment && paymentMode === "paymongo" ? paymongoPaymentIntentId : "",
      paymongoPaymentId: requiresPayment && paymentMode === "paymongo" ? paymongoPaymentId : "",
      registrationDate: new Date(),
      registrationWithShirt,
      ...(shirtSize ? { shirtSize } : {}),
      waitlist: shouldWaitlist,
    };

    // Add partner if provided (for doubles categories)
    if (partnerId) {
      registration.partner = partnerId;
    }

    // Add team data if provided (for team categories)
    if (teamName) {
      registration.teamName = teamName;
      // removed backend debug logs
    } else {
      // removed backend debug logs
    }

    // 🔍 DEBUG: Log all request body data for team registration debugging
    // removed backend debug logs

    // Handle teamMembers - can come as individual array items from FormData or as an object
    if (
      req.body.teamMembers ||
      Object.keys(req.body).some((key) => key.startsWith("teamMembers["))
    ) {
      let teamMemberIds = [];

      try {
        const tmKeys = Object.keys(req.body).filter((k) => String(k).startsWith("teamMembers"));
        console.log("[registerForTournament] teamMembers keys", tmKeys);
        const tmSample = tmKeys.slice(0, 6).map((k) => [k, req.body[k]]);
        console.log("[registerForTournament] teamMembers sample", tmSample);
      } catch (_) {}

      // removed backend debug logs

      if (Array.isArray(req.body.teamMembers)) {
        const incoming = req.body.teamMembers;
        const aggregated = [];
        for (const item of incoming) {
          if (typeof item === "string") {
            const s = item.trim();
            if (s.startsWith("[") && s.endsWith("]")) {
              try {
                const parsed = JSON.parse(s);
                if (Array.isArray(parsed)) aggregated.push(...parsed);
              } catch (_) {
                // ignore malformed json element
              }
            } else {
              aggregated.push(s);
            }
          } else if (item != null) {
            aggregated.push(String(item));
          }
        }
        teamMemberIds = aggregated;
      } else if (req.body.teamMembers && typeof req.body.teamMembers === "string") {
        try {
          teamMemberIds = JSON.parse(req.body.teamMembers);
        } catch (_) {
          teamMemberIds = [];
        }
      } else if (
        req.body.teamMembers &&
        typeof req.body.teamMembers === "object" &&
        !Array.isArray(req.body.teamMembers)
      ) {
        teamMemberIds = Object.values(req.body.teamMembers).filter((id) => id && id !== "");
      } else {
        const teamMemberKeys = Object.keys(req.body).filter((key) => key.startsWith("teamMembers["));
        teamMemberIds = teamMemberKeys.map((key) => req.body[key]).filter((id) => id && id !== "");
      }

      // removed backend debug logs

      const normalized = Array.isArray(teamMemberIds)
        ? Array.from(new Set(teamMemberIds.map((id) => (typeof id === "string" ? id.trim() : String(id))).filter((id) => id)))
        : [];
      try { console.log("[registerForTournament] parsed teamMembers", normalized); } catch (_) {}
      registration.teamMembers = normalized;
    } else {
      // removed backend debug logs
    }

    // Atomically add registration only if the user doesn't already have an active registration in this category
    const userIdStr = req.user._id.toString();
    const catStr = String(category);
    const atomicCondition = {
      _id: tournament._id,
      registrations: {
        $not: {
          $elemMatch: {
            category: catStr,
            partnerStatus: { $ne: "declined" },
            $or: [
              { player: req.user._id },
              { partner: req.user._id },
              { teamMembers: req.user._id },
            ],
          },
        },
      },
    };
    const atomicUpdate = { $push: { registrations: registration } };
    const atomicResult = await Tournament.updateOne(atomicCondition, atomicUpdate);
    if (!atomicResult || atomicResult.modifiedCount === 0) {
      return res
        .status(400)
        .json({
          message:
            "Duplicate registration detected for this category. Each player can only register once per category.",
        });
    }
    try {
      const Registration = require("../models/Registration");
      const { Types } = require("mongoose");
      const asId = (v) => (v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
      const normIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
      const cId = asId(category) || category;
      const pId = asId(req.user._id) || req.user._id;
      const prId = asId(registration.partner) || registration.partner || undefined;
      const tm = Array.isArray(registration.teamMembers)
        ? registration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
        : [];
      const filter = {
        tournamentId: tournament._id,
        categoryId: cId,
        playerId: pId,
        teamName: registration.teamName || null,
        teamMembers: normIds(tm),
      };
      if (prId) filter.partnerId = prId;
      const doc = {
        tournamentId: tournament._id,
        categoryId: cId,
        category: String(cId || category),
        playerId: pId,
        partnerId: prId || undefined,
        teamMembers: normIds(tm),
        teamName: registration.teamName || undefined,
        status: registration.status,
        proofOfPayment: registration.proofOfPayment || [],
        contactNumber: registration.contactNumber || registration.playerPhone || undefined,
        email: registration.email || registration.playerEmail || undefined,
        emergencyContact: registration.emergencyContact || undefined,
        emergencyPhone: registration.emergencyPhone || undefined,
        registrationDate: registration.registrationDate || new Date(),
      };
      await Registration.updateOne(filter, { $set: doc }, { upsert: true });
    } catch (_) {}

    // Resolve category information for detailed notification
    let categoryName = "Tournament Category";
    if (category) {
      
      // Find the category object in the tournament
      const categoryObj = tournament.tournamentCategories.find((cat) => {
        const catIdString = cat._id ? cat._id.toString() : "";
        const categoryString = category ? category.toString() : "";
        return catIdString === categoryString;
      });

      if (categoryObj) {
        // Create display name from category parts
        const division = categoryObj.division || "";
        const skillLevel =
          categoryObj.skillLevel === "Open" && categoryObj.tier
            ? `Open Tier ${categoryObj.tier}`
            : categoryObj.skillLevel || "";
        const age = categoryObj.ageCategory || "";

        const parts = [division, skillLevel, age].filter(
          (part) => part && part.trim(),
        );
        categoryName =
          parts.length > 0 ? parts.join(" | ") : "Tournament Category";

        // removed backend debug logs
      }
    }

    // Create notifications for the user and team members about successful registration
    const registrationType = (registration.teamName || (Array.isArray(registration.teamMembers) && registration.teamMembers.length > 0))
      ? "team"
      : (registration.partner ? "doubles" : "single");

    const registrationNoun = registrationType === "team"
      ? "team registration"
      : (registrationType === "doubles" ? "doubles registration" : "registration");

    const isWaitlist = !!registration.waitlist;
    const messageText = isWaitlist
      ? `Your ${registrationNoun} for "${tournament.tournamentName}" in ${categoryName} has been submitted to the waiting list.`
      : `Your ${registrationNoun} for "${tournament.tournamentName}" in ${categoryName} has been submitted and is pending approval.`;

    const notificationData = {
      type: "tournament",
      message: messageText,
      metadata: {
        tournamentId: tournament._id,
        tournamentName: tournament.tournamentName,
        category: categoryName,
        registrationStatus: isWaitlist ? "waiting_list" : "pending",
        registrationType,
      },
    };

    // Always notify the registrant
    await createNotification({
      userId: req.user._id,
      ...notificationData,
    });

    // Partner invitation disabled: auto-accept partner on registration and no invite notification

    // If this is a team registration, notify all team members (except the registrant who already got notified)
    if (
      registration.teamMembers &&
      Array.isArray(registration.teamMembers) &&
      registration.teamMembers.length > 0
    ) {

      // Create notifications for each team member, excluding the registrant to avoid duplicates
      for (const teamMemberId of registration.teamMembers) {
        // Skip the registrant since they already received a notification
        if (teamMemberId.toString() === req.user._id.toString()) {
          continue;
        }

        try {
          await createNotification({
            userId: teamMemberId,
            ...notificationData,
          });
          // removed backend debug logs
        } catch (error) {
          console.error(
            "❌ TEAM NOTIFICATION ERROR - Failed to create notification for team member:",
            teamMemberId,
            error,
          );
        }
      }

      // removed backend debug logs
    }

    await sendTournamentPaymentReceipt(
      registration,
      tournament.tournamentName,
      categoryObj,
      req.user,
    );
    await sendTournamentRegistrationConfirmation(
      registration,
      tournament.tournamentName,
      categoryObj,
      req.user,
    );
    res.status(201).json({
      message:
        "Registration submitted successfully. Awaiting club admin approval.",
      registration,
    });
  } catch (error) {
    console.error("Tournament registration error:", error);
    res.status(500).json({ message: "Server error during registration" });
  }
};

// Export the new function
exports.registerForTournament = registerForTournament;

// ✅ Publish tournament
exports.publishTournament = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Find the tournament
    const tournament = await Tournament.findById(id);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // Check if user is the tournament creator or co-host
    if (!hasAccessToTournament(tournament, userId)) {
      return res.status(403).json({ message: "Not authorized to publish this tournament" });
    }

    // Update published status
    tournament.published = true;
    await tournament.save();

    res.json({ 
      message: "Tournament published successfully",
      tournament: {
        _id: tournament._id,
        published: tournament.published
      }
    });
  } catch (error) {
    console.error("Error publishing tournament:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Unpublish tournament
exports.unpublishTournament = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    // Find the tournament
    const tournament = await Tournament.findById(id);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // Check if user is the tournament creator or co-host
    if (!hasAccessToTournament(tournament, userId)) {
      return res.status(403).json({ message: "Not authorized to unpublish this tournament" });
    }

    // Update published status
    tournament.published = false;
    await tournament.save();

    res.json({ 
      message: "Tournament unpublished successfully",
      tournament: {
        _id: tournament._id,
        published: tournament.published
      }
    });
  } catch (error) {
    console.error("Error unpublishing tournament:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Add co-host to tournament
exports.addCoHost = async (req, res) => {
  try {

    const tournamentId = req.params.id;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // removed backend debug logs

    // Check if user is the creator
    if (tournament.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Check if user is already a co-host
    if (tournament.coHosts.includes(userId)) {
      return res.status(400).json({ message: "User is already a co-host" });
    }

    // Check if user is trying to add themselves
    if (tournament.createdBy.toString() === userId) {
      return res.status(400).json({ message: "Cannot add tournament owner as co-host" });
    }

    tournament.coHosts.push(userId);
    await tournament.save();

    // Populate the co-hosts for response
    await tournament.populate('coHosts', 'firstName lastName email');

    res.json({ message: "Co-host added successfully", coHosts: tournament.coHosts });
  } catch (error) {
    console.error("❌ Error adding co-host:", error.message);
    console.error("❌ Full error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Remove co-host from tournament
exports.removeCoHost = async (req, res) => {
  try {

    const tournamentId = req.params.id;
    const { userId } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // removed backend debug logs

    // Check if user is the creator
    if (tournament.createdBy.toString() !== req.user.id) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Remove co-host
    tournament.coHosts = tournament.coHosts.filter(
      coHost => coHost.toString() !== userId
    );

    await tournament.save();

    // Populate the co-hosts for response
    await tournament.populate('coHosts', 'firstName lastName email');

    res.json({ message: "Co-host removed successfully", coHosts: tournament.coHosts });
  } catch (error) {
    console.error("❌ Error removing co-host:", error.message);
    console.error("❌ Full error:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Add referee to tournament
exports.addReferee = async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // Allow tournament creator/co-host/superadmin with access
    if (!hasAccessToTournament(tournament, req.user)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Initialize referees array if it doesn't exist
    if (!tournament.referees) {
      tournament.referees = [];
    }

    const refereeUser = await User.findOne({
      _id: userId,
      roles: { $in: ["referee"] },
      archived: { $ne: true },
    }).select("_id");
    if (!refereeUser) {
      return res.status(400).json({ message: "Selected user is not an active referee account" });
    }

    // Check if user is already a referee
    if (tournament.referees.some((id) => String(id) === String(userId))) {
      return res.status(400).json({ message: "User is already a referee" });
    }

    tournament.referees.push(userId);
    await tournament.save();

    // Populate the referees for response
    await tournament.populate('referees', 'firstName lastName email');

    res.json({ message: "Referee added successfully", referees: tournament.referees });
  } catch (error) {
    console.error("❌ Error adding referee:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Remove referee from tournament
exports.removeReferee = async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const { userId } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // Allow tournament creator/co-host/superadmin with access
    if (!hasAccessToTournament(tournament, req.user)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    // Initialize referees array if it doesn't exist
    if (!tournament.referees) {
      tournament.referees = [];
    }

    // Remove referee
    tournament.referees = tournament.referees.filter(
      referee => referee.toString() !== userId
    );

    await tournament.save();

    // Populate the referees for response
    await tournament.populate('referees', 'firstName lastName email');

    res.json({ message: "Referee removed successfully", referees: tournament.referees });
  } catch (error) {
    console.error("❌ Error removing referee:", error.message);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Get eligible referee users for a tournament
exports.getEligibleReferees = async (req, res) => {
  try {
    const tournamentId = req.params.id;
    const tournament = await Tournament.findById(tournamentId)
      .select("createdBy coHosts referees")
      .lean();
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }
    if (!hasAccessToTournament(tournament, req.user)) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const allReferees = await User.find({
      roles: { $in: ["referee"] },
      archived: { $ne: true },
    })
      .select("_id firstName lastName email roles")
      .lean();

    const assignedRefIds = new Set((Array.isArray(tournament?.referees) ? tournament.referees : []).map((id) => String(id)));

    const eligible = allReferees.filter((u) => {
      const id = String(u?._id || "");
      if (!id) return false;
      if (assignedRefIds.has(id)) return false;
      return true;
    });

    return res.json({ referees: eligible });
  } catch (error) {
    console.error("Error fetching eligible referees:", error);
    return res.status(500).json({ message: "Server error" });
  }
};
// ✅ Bulk Approve Players (New Form Structure)
exports.addApprovedPlayersBulk = async (req, res) => {
  const { registrationData } = req.body;

  // Validate required fields
  if (!registrationData || !Array.isArray(registrationData) || registrationData.length === 0) {
    return res.status(400).json({
      message: "Missing required fields: registrationData array is required",
    });
  }

  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament)
      return res.status(404).json({ message: "Tournament not found" });

    // Only the creator or co-hosts can approve players
    if (!hasAccessToTournament(tournament, req.user))
      return res
        .status(403)
        .json({ message: "You can only manage tournaments you created or co-host" });

    const catEq = (a, b) => String(a || "") === String(b || "");
    const playerEq = (a, b) => String(a || "") === String(b || "");

    const results = [];
    const errors = [];

    // Process each registration
    for (const regData of registrationData) {
      try {
        const { category, type, player1, player2, teamName, teamMembers } = regData;

        if (!category || !type) {
          errors.push(`Missing category or type for registration`);
          continue;
        }

        if (type === 'singles') {
          if (!player1) {
            errors.push(`Missing player for singles registration in category ${category}`);
            continue;
          }

          // Check for duplicate registration
          const existingRegistration = tournament.registrations.find(reg => 
            reg.player && reg.player.toString() === player1.toString() && 
            (catEq(reg.category, category) || catEq(reg.category?._id, category)) && 
            reg.status === 'approved'
          );

          if (existingRegistration) {
            errors.push(`Player is already registered in category ${category}`);
            continue;
          }

          // Try to locate a corresponding pending registration to preserve full details
          // 1) Prefer same-category pending for this player
          let pendingRegistration = tournament.registrations.find(reg =>
            reg.player && reg.player.toString() === player1.toString() &&
            (catEq(reg.category, category) || catEq(reg.category?._id, category)) &&
            reg.status === 'pending'
          );
          // 2) If none, fall back to ANY pending registration for this player (different category)
          if (!pendingRegistration) {
            pendingRegistration = tournament.registrations.find(reg =>
              reg.player && reg.player.toString() === player1.toString() &&
              reg.status === 'pending'
            );
          }

          let approvedRegistration;
          if (pendingRegistration) {
            // Remove the pending registration before adding the approved one
            tournament.registrations = tournament.registrations.filter(
              (r) => r._id.toString() !== pendingRegistration._id.toString(),
            );

            // Preserve all relevant fields from pending
            approvedRegistration = {
              player: player1,
              category,
              status: "approved",
              proofOfPayment: pendingRegistration.proofOfPayment,
              contactNumber: pendingRegistration.contactNumber,
              email: pendingRegistration.email,
              playerName: pendingRegistration.playerName,
              playerEmail: pendingRegistration.playerEmail,
              playerPhone: pendingRegistration.playerPhone,
              emergencyContact: pendingRegistration.emergencyContact,
              emergencyPhone: pendingRegistration.emergencyPhone,
              registrationWithShirt: pendingRegistration.registrationWithShirt === true,
              ...(pendingRegistration.registrationWithShirt && pendingRegistration.shirtSize
                ? { shirtSize: pendingRegistration.shirtSize }
                : {}),
              registrationDate: pendingRegistration.registrationDate || new Date(),
            };
          } else {
            // Fallback: derive details from regData or User profile
            const user = await User.findById(player1).lean();
            const derivedPlayerName = regData.playerName || (user ? `${user.firstName} ${user.lastName}`.trim() : undefined);
            const derivedEmail = regData.playerEmail || regData.email || (user ? user.email : undefined);
            const derivedPhone = regData.playerPhone || regData.contactNumber || (user ? user.phoneNumber : undefined);

            approvedRegistration = {
              player: player1,
              category,
              status: "approved",
              proofOfPayment: regData.proofOfPayment,
              contactNumber: regData.contactNumber || derivedPhone,
              email: regData.email || derivedEmail,
              playerName: derivedPlayerName,
              playerEmail: derivedEmail,
              playerPhone: derivedPhone,
              emergencyContact: regData.emergencyContact, // not available on User schema
              emergencyPhone: regData.emergencyPhone,     // not available on User schema
              ...(regData.shirtSize
                ? { shirtSize: String(regData.shirtSize).trim() }
                : {}),
              registrationDate: regData.registrationDate ? new Date(regData.registrationDate) : new Date(),
            };
          }

          tournament.registrations.push(approvedRegistration);
          try {
            const Registration = require("../models/Registration");
            const { Types } = require("mongoose");
            const asId = (v) => (v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
            const normIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
            const cId = asId(category) || category;
            const p1Id = asId(player1) || player1;
            const prId = asId(approvedRegistration.partner) || approvedRegistration.partner || undefined;
            const tm = Array.isArray(approvedRegistration.teamMembers)
              ? approvedRegistration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
              : [];
            const filter = {
              tournamentId: tournament._id,
              categoryId: cId,
              playerId: p1Id,
              teamName: approvedRegistration.teamName || null,
              teamMembers: normIds(tm),
            };
            if (prId) filter.partnerId = prId;
            const doc = {
              tournamentId: tournament._id,
              categoryId: cId,
              category: String(cId || category),
              playerId: p1Id,
              partnerId: prId || undefined,
              teamMembers: normIds(tm),
              teamName: approvedRegistration.teamName || undefined,
              status: "approved",
              proofOfPayment: approvedRegistration.proofOfPayment || [],
              contactNumber: approvedRegistration.contactNumber || approvedRegistration.playerPhone || undefined,
              email: approvedRegistration.email || approvedRegistration.playerEmail || undefined,
              emergencyContact: approvedRegistration.emergencyContact || undefined,
              emergencyPhone: approvedRegistration.emergencyPhone || undefined,
              registrationDate: approvedRegistration.registrationDate || new Date(),
            };
            await Registration.updateOne(filter, { $set: doc }, { upsert: true });
          } catch (_) {}
          try {
            let categoryName = category;
            if (tournament.tournamentCategories && tournament.tournamentCategories.length > 0) {
              const categoryObj = tournament.tournamentCategories.find((cat) => {
                const catIdString = cat._id ? cat._id.toString() : "";
                const categoryString = category ? category.toString() : "";
                return catIdString === categoryString;
              });
              if (categoryObj) {
                const division = categoryObj.division || "";
                const skillLevel = categoryObj.skillLevel === "Open" && categoryObj.tier ? `Open Tier ${categoryObj.tier}` : categoryObj.skillLevel || "";
                const age = categoryObj.ageCategory || "";
                const parts = [division, skillLevel, age].filter((part) => part && part.trim());
                categoryName = parts.length > 0 ? parts.join(" | ") : "Tournament Category";
              }
            }
            const notificationMessage = `Your single registration for "${tournament.tournamentName}" in ${categoryName} has been approved!`;
            await createNotification({
              userId: player1,
              type: "tournament",
              message: notificationMessage,
              metadata: {
                tournamentId: tournament._id,
                tournamentName: tournament.tournamentName,
                category: categoryName,
                registrationStatus: "approved",
                registrationType: "single",
              },
            });
          } catch (_) {}
          results.push({
            type: 'singles',
            category,
            player: player1,
            status: 'approved'
          });

        } else if (type === 'doubles') {
          if (!player2) {
            const categoryObj = Array.isArray(tournament.tournamentCategories)
              ? tournament.tournamentCategories.find((cat) => {
                  const catIdString = cat._id ? cat._id.toString() : "";
                  const categoryString = category ? category.toString() : "";
                  return catIdString === categoryString;
                })
              : null;
            const divLower = String(categoryObj?.division || "").toLowerCase();
            const skillLower = String(categoryObj?.skillLevel || "").toLowerCase();
            const isNoviceDoubles = (divLower.includes("double") || divLower.includes("mixed")) && (
              skillLower.includes("novice") ||
              divLower.includes("novice")
            );

            if (player1 && isNoviceDoubles) {
              let pendingRegistration = tournament.registrations.find(reg =>
                reg.player && reg.player.toString() === player1.toString() &&
                (catEq(reg.category, category) || catEq(reg.category?._id, category)) &&
                reg.status === 'pending'
              );
              if (!pendingRegistration) {
                pendingRegistration = tournament.registrations.find(reg =>
                  reg.status === 'pending' && reg.player && reg.player.toString() === player1.toString()
                );
              }

              let approvedRegistration;
              if (pendingRegistration) {
                tournament.registrations = tournament.registrations.filter(
                  (r) => r._id.toString() !== pendingRegistration._id.toString(),
                );

                approvedRegistration = {
                  player: player1,
                  category,
                  status: "approved",
                  proofOfPayment: pendingRegistration.proofOfPayment,
                  contactNumber: pendingRegistration.contactNumber,
                  email: pendingRegistration.email,
                  playerName: pendingRegistration.playerName,
                  playerEmail: pendingRegistration.playerEmail,
                  playerPhone: pendingRegistration.playerPhone,
                  emergencyContact: pendingRegistration.emergencyContact,
                  emergencyPhone: pendingRegistration.emergencyPhone,
                  registrationWithShirt: pendingRegistration.registrationWithShirt === true,
                  ...(pendingRegistration.registrationWithShirt && pendingRegistration.shirtSize
                    ? { shirtSize: pendingRegistration.shirtSize }
                    : {}),
                  registrationDate: pendingRegistration.registrationDate || new Date(),
                };
              } else {
                const user1 = await User.findById(player1).lean();
                const derivedPlayerName = regData.playerName || (user1 ? `${user1.firstName} ${user1.lastName}`.trim() : undefined);
                const derivedEmail = regData.playerEmail || regData.email || (user1 ? user1.email : undefined);
                const derivedPhone = regData.playerPhone || regData.contactNumber || (user1 ? user1.phoneNumber : undefined);

                approvedRegistration = {
                  player: player1,
                  category,
                  status: "approved",
                  proofOfPayment: regData.proofOfPayment,
                  contactNumber: regData.contactNumber || derivedPhone,
                  email: regData.email || derivedEmail,
                  playerName: derivedPlayerName,
                  playerEmail: derivedEmail,
                  playerPhone: derivedPhone,
                  emergencyContact: regData.emergencyContact,
                  emergencyPhone: regData.emergencyPhone,
                  registrationWithShirt: !!regData.registrationWithShirt,
                  ...(regData.registrationWithShirt && regData.shirtSize
                    ? { shirtSize: String(regData.shirtSize).trim().toUpperCase() }
                    : {}),
                  registrationDate: regData.registrationDate ? new Date(regData.registrationDate) : new Date(),
                };
              }

              tournament.registrations.push(approvedRegistration);
              try {
                let categoryName = category;
                if (Array.isArray(tournament.tournamentCategories) && tournament.tournamentCategories.length > 0) {
                  const cat = tournament.tournamentCategories.find((c) => String(c._id) === String(category));
                  if (cat) {
                    const division = cat.division || "";
                    const skillLevel = cat.skillLevel === "Open" && cat.tier ? `Open Tier ${cat.tier}` : cat.skillLevel || "";
                    const age = cat.ageCategory || "";
                    const parts = [division, skillLevel, age].filter((part) => part && part.trim());
                    categoryName = parts.length > 0 ? parts.join(" | ") : "Tournament Category";
                  }
                }
                const notificationMessage = `Your doubles registration for "${tournament.tournamentName}" in ${categoryName} has been approved! Your partner will be assigned soon.`;
                await createNotification({
                  userId: player1,
                  type: "tournament",
                  message: notificationMessage,
                  metadata: { tournamentId: tournament._id, tournamentName: tournament.tournamentName, category: categoryName, registrationStatus: "approved", registrationType: "doubles" },
                });
              } catch (_) {}
              results.push({ type: 'doubles', category, player: player1, status: 'approved' });
              continue;
            } else {
              errors.push(`Missing player1 or player2 for doubles registration in category ${category}`);
              continue;
            }
          }

          // Check for duplicate registration (either player1-player2 or player2-player1)
          const existingRegistration = tournament.registrations.find(reg => 
            reg.player && reg.partner && (catEq(reg.category, category) || catEq(reg.category?._id, category)) && reg.status === 'approved' &&
            ((reg.player.toString() === player1.toString() && reg.partner.toString() === player2.toString()) ||
             (reg.player.toString() === player2.toString() && reg.partner.toString() === player1.toString()))
          );

          if (existingRegistration) {
            errors.push(`This player pair is already registered in category ${category}`);
            continue;
          }

          // Try to locate a corresponding pending registration to preserve full details
          // 1) Prefer same-category pending with exact pair match
          let pendingRegistration = tournament.registrations.find(reg =>
            (catEq(reg.category, category) || catEq(reg.category?._id, category)) && reg.status === 'pending' && (
              (reg.player && reg.partner && reg.player.toString() === player1.toString() && reg.partner.toString() === player2.toString()) ||
              (reg.player && reg.partner && reg.player.toString() === player2.toString() && reg.partner.toString() === player1.toString())
            )
          );
          // 2) If none, fall back to ANY pending registration for player1
          if (!pendingRegistration) {
            pendingRegistration = tournament.registrations.find(reg =>
              reg.status === 'pending' && reg.player && reg.player.toString() === player1.toString()
            );
          }

          let approvedRegistration;
          if (pendingRegistration) {
            // Remove the pending registration before adding the approved one
            tournament.registrations = tournament.registrations.filter(
              (r) => r._id.toString() !== pendingRegistration._id.toString(),
            );

            approvedRegistration = {
              player: player1,
              partner: player2,
              category,
              status: "approved",
              proofOfPayment: pendingRegistration.proofOfPayment,
              contactNumber: pendingRegistration.contactNumber,
              email: pendingRegistration.email,
              playerName: pendingRegistration.playerName,
              playerEmail: pendingRegistration.playerEmail,
              playerPhone: pendingRegistration.playerPhone,
              emergencyContact: pendingRegistration.emergencyContact,
              emergencyPhone: pendingRegistration.emergencyPhone,
              registrationWithShirt: pendingRegistration.registrationWithShirt === true,
              ...(pendingRegistration.registrationWithShirt && pendingRegistration.shirtSize
                ? { shirtSize: pendingRegistration.shirtSize }
                : {}),
              registrationDate: pendingRegistration.registrationDate || new Date(),
            };
          } else {
            // Fallback: derive details from regData or player1's User profile
            const user1 = await User.findById(player1).lean();
            const derivedPlayerName = regData.playerName || (user1 ? `${user1.firstName} ${user1.lastName}`.trim() : undefined);
            const derivedEmail = regData.playerEmail || regData.email || (user1 ? user1.email : undefined);
            const derivedPhone = regData.playerPhone || regData.contactNumber || (user1 ? user1.phoneNumber : undefined);

            approvedRegistration = {
              player: player1,
              partner: player2,
              category,
              status: "approved",
              proofOfPayment: regData.proofOfPayment,
              contactNumber: regData.contactNumber || derivedPhone,
              email: regData.email || derivedEmail,
              playerName: derivedPlayerName,
              playerEmail: derivedEmail,
              playerPhone: derivedPhone,
              emergencyContact: regData.emergencyContact,
              emergencyPhone: regData.emergencyPhone,
              registrationWithShirt: !!regData.registrationWithShirt,
              ...(regData.registrationWithShirt && regData.shirtSize
                ? { shirtSize: String(regData.shirtSize).trim().toUpperCase() }
                : {}),
              registrationDate: regData.registrationDate ? new Date(regData.registrationDate) : new Date(),
            };
          }

          // Partner immutability guard: if there is already a partner set for this player+category,
          // keep it and do not overwrite during bulk approval.
          try {
            const existingWithPartner = (tournament.registrations || []).find((r) => {
              if (!r) return false;
              const samePlayer = (playerEq(r.player, player1) || playerEq(r.player?._id, player1));
              const sameCat = (catEq(r.category, category) || catEq(r.category?._id, category));
              return samePlayer && sameCat && !!r.partner;
            });
            if (existingWithPartner?.partner) {
              approvedRegistration.partner = existingWithPartner.partner;
            }
          } catch (_) {}

          tournament.registrations.push(approvedRegistration);
          try {
            const Registration = require("../models/Registration");
            const { Types } = require("mongoose");
            const asId = (v) => (v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
            const normIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
            const cId = asId(category) || category;
            const p1Id = asId(player1) || player1;
            const prId = asId(approvedRegistration.partner) || approvedRegistration.partner || undefined;
            const tm = Array.isArray(approvedRegistration.teamMembers)
              ? approvedRegistration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
              : [];
            const filter = {
              tournamentId: tournament._id,
              categoryId: cId,
              playerId: p1Id,
              teamName: approvedRegistration.teamName || null,
              teamMembers: normIds(tm),
            };
            if (prId) filter.partnerId = prId;
            const doc = {
              tournamentId: tournament._id,
              categoryId: cId,
              category: String(cId || category),
              playerId: p1Id,
              partnerId: prId || undefined,
              teamMembers: normIds(tm),
              teamName: approvedRegistration.teamName || undefined,
              status: "approved",
              proofOfPayment: approvedRegistration.proofOfPayment || [],
              contactNumber: approvedRegistration.contactNumber || approvedRegistration.playerPhone || undefined,
              email: approvedRegistration.email || approvedRegistration.playerEmail || undefined,
              emergencyContact: approvedRegistration.emergencyContact || undefined,
              emergencyPhone: approvedRegistration.emergencyPhone || undefined,
              registrationDate: approvedRegistration.registrationDate || new Date(),
            };
            await Registration.updateOne(filter, { $set: doc }, { upsert: true });
          } catch (_) {}
          try {
            let categoryName = category;
            if (tournament.tournamentCategories && tournament.tournamentCategories.length > 0) {
              const categoryObj = tournament.tournamentCategories.find((cat) => {
                const catIdString = cat._id ? cat._id.toString() : "";
                const categoryString = category ? category.toString() : "";
                return catIdString === categoryString;
              });
              if (categoryObj) {
                const division = categoryObj.division || "";
                const skillLevel = categoryObj.skillLevel === "Open" && categoryObj.tier ? `Open Tier ${categoryObj.tier}` : categoryObj.skillLevel || "";
                const age = categoryObj.ageCategory || "";
                const parts = [division, skillLevel, age].filter((part) => part && part.trim());
                categoryName = parts.length > 0 ? parts.join(" | ") : "Tournament Category";
              }
            }
            const notificationMessage = `Your doubles registration for "${tournament.tournamentName}" in ${categoryName} has been approved!`;
            await createNotification({
              userId: player1,
              type: "tournament",
              message: notificationMessage,
              metadata: { tournamentId: tournament._id, tournamentName: tournament.tournamentName, category: categoryName, registrationStatus: "approved", registrationType: "doubles" },
            });
            await createNotification({
              userId: player2,
              type: "tournament",
              message: notificationMessage,
              metadata: { tournamentId: tournament._id, tournamentName: tournament.tournamentName, category: categoryName, registrationStatus: "approved", registrationType: "doubles" },
            });
            // Notify approver as well
            try {
              const adminMessage = `You approved a doubles registration in ${categoryName} for "${tournament.tournamentName}".`;
              await createNotification({
                userId: req.user._id,
                type: "tournament",
                message: adminMessage,
                metadata: { tournamentId: tournament._id, tournamentName: tournament.tournamentName, category: categoryName, registrationStatus: "approved", registrationType: "doubles" },
              });
            } catch (_) {}
          } catch (_) {}
          results.push({
            type: 'doubles',
            category,
            player: player1,
            partner: player2,
            status: 'approved'
          });

        } else if (type === 'team') {
          if (!teamName || !teamMembers || !Array.isArray(teamMembers) || teamMembers.length === 0) {
            errors.push(`Missing teamName or teamMembers for team registration in category ${category}`);
            continue;
          }

          // Check for duplicate team registration by team name and category
          const existingTeamRegistration = tournament.registrations.find(reg => 
            reg.teamName && reg.teamName === teamName && 
            (catEq(reg.category, category) || catEq(reg.category?._id, category)) && 
            reg.status === 'approved'
          );

          if (existingTeamRegistration) {
            errors.push(`Team "${teamName}" is already registered in category ${category}`);
            continue;
          }

          // For team registration, use the first team member as the main player
          const mainPlayer = teamMembers[0];

          // Try to locate a corresponding pending registration to preserve full details
          // 1) Prefer same-category + same teamName pending
          let pendingRegistration = tournament.registrations.find(reg =>
            reg.teamName && reg.teamName === teamName &&
            (catEq(reg.category, category) || catEq(reg.category?._id, category)) &&
            reg.status === 'pending'
          );
          // 2) If none, fall back to ANY pending registration for the main player
          if (!pendingRegistration) {
            pendingRegistration = tournament.registrations.find(reg =>
              reg.status === 'pending' && reg.player && reg.player.toString() === mainPlayer.toString()
            );
          }

          let approvedRegistration;
          if (pendingRegistration) {
            // Remove the pending registration before adding the approved one
            tournament.registrations = tournament.registrations.filter(
              (r) => r._id.toString() !== pendingRegistration._id.toString(),
            );

            approvedRegistration = {
              player: mainPlayer,
              category,
              status: "approved",
              teamName,
              teamMembers,
              proofOfPayment: pendingRegistration.proofOfPayment,
              contactNumber: pendingRegistration.contactNumber,
              email: pendingRegistration.email,
              playerName: pendingRegistration.playerName,
              playerEmail: pendingRegistration.playerEmail,
              playerPhone: pendingRegistration.playerPhone,
              emergencyContact: pendingRegistration.emergencyContact,
              emergencyPhone: pendingRegistration.emergencyPhone,
              registrationWithShirt: pendingRegistration.registrationWithShirt === true,
              ...(pendingRegistration.registrationWithShirt && pendingRegistration.shirtSize
                ? { shirtSize: pendingRegistration.shirtSize }
                : {}),
              registrationDate: pendingRegistration.registrationDate || new Date(),
            };
          } else {
            // Fallback: derive details from regData or mainPlayer's User profile
            const userMain = await User.findById(mainPlayer).lean();
            const derivedPlayerName = regData.playerName || (userMain ? `${userMain.firstName} ${userMain.lastName}`.trim() : undefined);
            const derivedEmail = regData.playerEmail || regData.email || (userMain ? userMain.email : undefined);
            const derivedPhone = regData.playerPhone || regData.contactNumber || (userMain ? userMain.phoneNumber : undefined);

            approvedRegistration = {
              player: mainPlayer,
              category,
              status: "approved",
              teamName,
              teamMembers,
              proofOfPayment: regData.proofOfPayment,
              contactNumber: regData.contactNumber || derivedPhone,
              email: regData.email || derivedEmail,
              playerName: derivedPlayerName,
              playerEmail: derivedEmail,
              playerPhone: derivedPhone,
              emergencyContact: regData.emergencyContact,
              emergencyPhone: regData.emergencyPhone,
              registrationWithShirt: !!regData.registrationWithShirt,
              ...(regData.registrationWithShirt && regData.shirtSize
                ? { shirtSize: String(regData.shirtSize).trim().toUpperCase() }
                : {}),
              registrationDate: regData.registrationDate ? new Date(regData.registrationDate) : new Date(),
            };
          }

          tournament.registrations.push(approvedRegistration);
          try {
            const Registration = require("../models/Registration");
            const { Types } = require("mongoose");
            const asId = (v) => (v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined);
            const normIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
            const cId = asId(category) || category;
            const mainId = asId(mainPlayer) || mainPlayer;
            const tm = Array.isArray(approvedRegistration.teamMembers)
              ? approvedRegistration.teamMembers.map((u) => asId(u) || u).filter(Boolean)
              : [];
            const filter = {
              tournamentId: tournament._id,
              categoryId: cId,
              playerId: mainId,
              teamName: approvedRegistration.teamName || null,
              teamMembers: normIds(tm),
            };
            const doc = {
              tournamentId: tournament._id,
              categoryId: cId,
              category: String(cId || category),
              playerId: mainId,
              partnerId: undefined,
              teamMembers: normIds(tm),
              teamName: approvedRegistration.teamName || undefined,
              status: "approved",
              proofOfPayment: approvedRegistration.proofOfPayment || [],
              contactNumber: approvedRegistration.contactNumber || approvedRegistration.playerPhone || undefined,
              email: approvedRegistration.email || approvedRegistration.playerEmail || undefined,
              emergencyContact: approvedRegistration.emergencyContact || undefined,
              emergencyPhone: approvedRegistration.emergencyPhone || undefined,
              registrationDate: approvedRegistration.registrationDate || new Date(),
            };
            await Registration.updateOne(filter, { $set: doc }, { upsert: true });
          } catch (_) {}
          try {
            let categoryName = category;
            if (tournament.tournamentCategories && tournament.tournamentCategories.length > 0) {
              const categoryObj = tournament.tournamentCategories.find((cat) => {
                const catIdString = cat._id ? cat._id.toString() : "";
                const categoryString = category ? category.toString() : "";
                return catIdString === categoryString;
              });
              if (categoryObj) {
                const division = categoryObj.division || "";
                const skillLevel = categoryObj.skillLevel === "Open" && categoryObj.tier ? `Open Tier ${categoryObj.tier}` : categoryObj.skillLevel || "";
                const age = categoryObj.ageCategory || "";
                const parts = [division, skillLevel, age].filter((part) => part && part.trim());
                categoryName = parts.length > 0 ? parts.join(" | ") : "Tournament Category";
              }
            }
            const notificationMessage = `Your team registration for "${tournament.tournamentName}" in ${categoryName} has been approved!`;
            for (const memberId of teamMembers) {
              await createNotification({
                userId: memberId,
                type: "tournament",
                message: notificationMessage,
                metadata: { tournamentId: tournament._id, tournamentName: tournament.tournamentName, category: categoryName, registrationStatus: "approved", registrationType: "team" },
              });
            }
            // Notify approver as well
            try {
              const adminMessage = `You approved a team registration in ${categoryName} for "${tournament.tournamentName}".`;
              await createNotification({
                userId: req.user._id,
                type: "tournament",
                message: adminMessage,
                metadata: { tournamentId: tournament._id, tournamentName: tournament.tournamentName, category: categoryName, registrationStatus: "approved", registrationType: "team" },
              });
            } catch (_) {}
          } catch (_) {}
          results.push({
            type: 'team',
            category,
            teamName,
            teamMembers,
            mainPlayer,
            status: 'approved'
          });
        }

      } catch (regError) {
        console.error("Error processing registration:", regError);
        errors.push(`Error processing registration: ${regError.message}`);
      }
    }

    // Save the tournament with new registrations
    await tournament.save();

    // Invalidate cached tournament GETs so UI reflects the latest state
    invalidateTournamentGetCache(tournament._id.toString());

    // Populate the tournament for response
    const populatedTournament = await Tournament.findById(tournament._id)
      .populate({
        path: "registrations.player",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.partner",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      })
      .populate({
        path: "registrations.teamMembers",
        select: "firstName lastName birthDate gender duprRatings pplId duprId",
        options: { lean: true },
      });

    const response = {
      message: `Successfully processed ${results.length} registrations`,
      results,
      tournament: populatedTournament,
    };

    if (errors.length > 0) {
      response.errors = errors;
      response.message += ` with ${errors.length} errors`;
    }

    res.json(response);

  } catch (error) {
    console.error("Error in bulk approval:", error);
    res.status(500).json({ message: "Server error" });
  }
};

// ✅ Assign partner to a player registration
exports.assignPartner = async (req, res) => {
  try {
    const { id: tournamentId } = req.params;
    const { playerId, partnerId, categoryId } = req.body;

    // removed backend debug logs

    // Validate required fields
    if (!playerId || !partnerId || !categoryId) {
      return res.status(400).json({ 
        message: "Missing required fields: playerId, partnerId, and categoryId are required" 
      });
    }

    // Find the tournament
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({ message: "Tournament not found" });
    }

    // removed backend debug logs

    // Check if user has access to modify this tournament
    if (!hasAccessToTournament(tournament, req.user)) {
      return res.status(403).json({ message: "Access denied" });
    }

    // Find the player's registration - handle both string and ObjectId comparison
    const playerRegistration = tournament.registrations.find(reg => {
      const playerMatch = reg.player.toString() === playerId || reg.player._id?.toString() === playerId;
      const categoryMatch = reg.category === categoryId || reg.category.toString() === categoryId;
      
      // removed backend debug logs
      
      return playerMatch && categoryMatch;
    });

    if (!playerRegistration) {
      return res.status(404).json({ 
        message: "Player registration not found for this category" 
      });
    }

    // If player already has a partner, do not change it
    if (playerRegistration.partner) {
      const existingPartnerId = playerRegistration.partner.toString();
      if (existingPartnerId === partnerId.toString()) {
        return res.status(200).json({
          message: "Partner already assigned",
          playerRegistration
        });
      }
      return res.status(400).json({
        message: "Player already has a partner assigned and cannot be changed"
      });
    }

    // Find the partner's registration to ensure they're registered for the same category
    const partnerRegistration = tournament.registrations.find(reg => {
      const playerMatch = reg.player.toString() === partnerId || reg.player._id?.toString() === partnerId;
      const categoryMatch = reg.category === categoryId || reg.category.toString() === categoryId;
      
      // removed backend debug logs
      
      return playerMatch && categoryMatch;
    });

    if (!partnerRegistration) {
      return res.status(404).json({ 
        message: "Partner registration not found for this category" 
      });
    }

    // Check if partner is already assigned to someone else
    if (partnerRegistration.partner) {
      return res.status(400).json({ 
        message: "Partner is already assigned to another player" 
      });
    }

    // Get category details
    const categoryObj = tournament.tournamentCategories.find(cat => 
      cat._id.toString() === categoryId || cat._id === categoryId
    );
    
    const isNoviceCategory = categoryObj && 
      categoryObj.skillLevel && 
      categoryObj.skillLevel.toLowerCase().includes('novice');

    // Enforce gender rules for doubles categories when assigning partners manually
    if (categoryObj && categoryObj.division) {
      const normalizeGender = (value) => {
        const g = String(value || "").toLowerCase().trim();
        if (g === "f" || g === "female" || g === "woman" || g === "women") return "female";
        if (g === "m" || g === "male" || g === "man" || g === "men") return "male";
        return "";
      };

      const normalizeDivision = (value) => {
        return String(value || "")
          .toLowerCase()
          .replace(/[’‘]/g, "'");
      };

      const divisionLower = normalizeDivision(categoryObj.division || "");

      const playerUser = await User.findById(playerRegistration.player).select("gender");
      const partnerUser = await User.findById(partnerRegistration.player).select("gender");

      const playerGender = normalizeGender(playerUser?.gender);
      const partnerGender = normalizeGender(partnerUser?.gender);

      if (divisionLower.includes("mixed")) {
        if (playerGender && partnerGender && playerGender === partnerGender) {
          return res.status(400).json({ message: "Mixed doubles requires an opposite-gender partner." });
        }
      } else if (divisionLower.includes("women")) {
        if (partnerGender && partnerGender !== "female") {
          return res.status(400).json({ message: "Women's doubles requires a female partner." });
        }
      } else if (divisionLower.includes("men") && !divisionLower.includes("women")) {
        if (partnerGender && partnerGender !== "male") {
          return res.status(400).json({ message: "Men's doubles requires a male partner." });
        }
      }
    }

    // removed backend debug logs

    if (isNoviceCategory) {
      // For novice categories: assign partner to the clicked player and remove partner's separate registration
      // removed backend debug logs
      
      // Assign the partner to the clicked player and mark as accepted
      playerRegistration.partner = partnerId;
      playerRegistration.partnerStatus = "accepted";
      
      // Remove the partner's separate registration to avoid duplicates
      const partnerRegistrationIndex = tournament.registrations.findIndex(reg => 
        reg._id.toString() === partnerRegistration._id.toString()
      );
      
      if (partnerRegistrationIndex !== -1) {
        tournament.registrations.splice(partnerRegistrationIndex, 1);
        // removed backend debug logs
      }
      
      // removed backend debug logs
      
      // Save the tournament
      await tournament.save();

      try {
        if (tournament.migratedRegistrations) {
          const { Types } = require("mongoose");
          const Registration = require("../models/Registration");
          const Team = require("../models/Team");
          const tId = tournament._id;
          const cId = Types.ObjectId.isValid(String(categoryId)) ? new Types.ObjectId(String(categoryId)) : categoryId;
          const p1 = Types.ObjectId.isValid(String(playerId)) ? new Types.ObjectId(String(playerId)) : playerId;
          const p2 = Types.ObjectId.isValid(String(partnerId)) ? new Types.ObjectId(String(partnerId)) : partnerId;
          await Registration.updateOne(
            { tournamentId: tId, $or: [{ categoryId: cId }, { category: String(cId || categoryId) }], playerId: p1 },
            { $set: { partnerId: p2, partnerStatus: "accepted" } },
            { upsert: true }
          );
          const makeIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
          const playerIds = makeIds([p1, p2]);
          await Team.updateOne(
            { tournamentId: tId, categoryId: cId, playerIds },
            { $set: { tournamentId: tId, categoryId: cId, playerIds, teamName: playerRegistration.teamName || undefined } },
            { upsert: true }
          );
          await Registration.deleteMany({
            tournamentId: tId,
            $or: [{ categoryId: cId }, { category: String(cId || categoryId) }],
            playerId: p2,
          });
        }
      } catch (_) {}

      res.json({ 
        message: "Partner assigned successfully",
        playerRegistration,
        removedPartnerRegistration: true
      });
    } else {
      // For non-novice categories: assign partners to each other (original behavior)
      // removed backend debug logs
      
      playerRegistration.partner = partnerId;
      partnerRegistration.partner = playerId;
      playerRegistration.partnerStatus = "accepted";
      partnerRegistration.partnerStatus = "accepted";

      // Save the tournament
      await tournament.save();

      // removed backend debug logs

      try {
        if (tournament.migratedRegistrations) {
          const { Types } = require("mongoose");
          const Registration = require("../models/Registration");
          const Team = require("../models/Team");
          const tId = tournament._id;
          const cId = Types.ObjectId.isValid(String(categoryId)) ? new Types.ObjectId(String(categoryId)) : categoryId;
          const p1 = Types.ObjectId.isValid(String(playerId)) ? new Types.ObjectId(String(playerId)) : playerId;
          const p2 = Types.ObjectId.isValid(String(partnerId)) ? new Types.ObjectId(String(partnerId)) : partnerId;
          await Registration.updateOne(
            { tournamentId: tId, $or: [{ categoryId: cId }, { category: String(cId || categoryId) }], playerId: p1 },
            { $set: { partnerId: p2, partnerStatus: "accepted" } },
            { upsert: true }
          );
          await Registration.updateOne(
            { tournamentId: tId, $or: [{ categoryId: cId }, { category: String(cId || categoryId) }], playerId: p2 },
            { $set: { partnerId: p1, partnerStatus: "accepted" } },
            { upsert: true }
          );
          const makeIds = (arr) => (Array.isArray(arr) ? arr.filter(Boolean).map((x) => String(x)).sort() : []);
          const playerIds = makeIds([p1, p2]);
          await Team.updateOne(
            { tournamentId: tId, categoryId: cId, playerIds },
            { $set: { tournamentId: tId, categoryId: cId, playerIds, teamName: playerRegistration.teamName || partnerRegistration.teamName || undefined } },
            { upsert: true }
          );
        }
      } catch (_) {}

      res.json({ 
        message: "Partner assigned successfully",
        playerRegistration,
        partnerRegistration
      });
    }

  } catch (error) {
    console.error("Error assigning partner:", error);
    res.status(500).json({ message: "Server error" });
  }
};

    // Normalize incoming categories extras (withShirt, setPartner, fee)
    try {
      if (Array.isArray(body.tournamentCategories)) {
        body.tournamentCategories = body.tournamentCategories.map((cat) => ({
          ...cat,
          withShirt: cat?.withShirt === true,
          setPartner: cat?.setPartner === true,
          fee:
            cat?.fee === null || cat?.fee === undefined || cat?.fee === ''
              ? null
              : Number(cat.fee),
          reservedSlots:
            cat?.reservedSlots === null || cat?.reservedSlots === undefined || cat?.reservedSlots === ''
              ? 0
              : Number(cat.reservedSlots),
        }));
      }
    } catch (_) {}
// ✅ Update standings for a specific group in a category
exports.updateGroupStandings = async (req, res) => {
  try {
    const { id, categoryId, groupId } = req.params;
    const { standings } = req.body || {};

    if (!Array.isArray(standings)) {
      return res.status(400).json({ message: "Standings must be an array" });
    }

    const tournament = await Tournament.findById(id).select("tournamentCategories createdBy coHosts");
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    // Allow superadmins, clubadmins, and referees
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin") || roles.includes("referee");
    if (!isPrivileged && !hasAccessToTournament(tournament, req.user?.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const cat = categories.find((c) => String(c._id) === String(categoryId));
    if (!cat) return res.status(404).json({ message: "Category not found" });
    if (cat.locked || cat.pointsSubmitted) {
      return res.status(409).json({ message: "Category is locked or points already submitted" });
    }

    const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
    const groupIndex = groups.findIndex((g) => String(g.id) === String(groupId));
    if (groupIndex < 0) return res.status(404).json({ message: "Group not found" });

    // Sanitize and normalize incoming standings
    const normalized = standings.map((s) => ({
      player: String(s.player || '').trim(),
      wins: Number(s.wins) || 0,
      losses: Number(s.losses) || 0,
      pointsFor: Number(s.pointsFor) || 0,
      pointsAgainst: Number(s.pointsAgainst) || 0,
      pointDifferential: Number(s.pointDifferential) || ((Number(s.pointsFor)||0) - (Number(s.pointsAgainst)||0)),
      rankPoints: Number(s.rankPoints) || 0,
    }));

    tournament.tournamentCategories[categories.findIndex((c) => String(c._id) === String(categoryId))]
      .groupStage
      .groups[groupIndex]
      .standings = normalized;

  // Keep originalPlayers in sync with the latest bracket order
  try {
    const players = normalized.map((r) => String(r.player || '').trim());
    tournament.tournamentCategories[categories.findIndex((c) => String(c._id) === String(categoryId))]
      .groupStage
      .groups[groupIndex]
      .originalPlayers = players;
  } catch (_) {}

    try {
      tournament.markModified(`tournamentCategories.${categories.findIndex((c) => String(c._id) === String(categoryId))}.groupStage.groups.${groupIndex}.standings`);
    tournament.markModified(`tournamentCategories.${categories.findIndex((c) => String(c._id) === String(categoryId))}.groupStage.groups.${groupIndex}.originalPlayers`);
    } catch (_) {
      tournament.markModified('tournamentCategories');
    }

    await tournament.save();
    invalidateTournamentGetCache(id);
    try {
      const Standing = require("../models/Standing");
      const Team = require("../models/Team");
      const arr = Array.isArray(normalized) ? normalized : [];
      const makeId = (val) => {
        const s = String(val || "").trim();
        return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
      };
      for (const s of arr) {
        const pid = makeId(s.player);
        let filter;
        let doc;
        if (pid) {
          filter = { tournamentId: id, categoryId, playerId: pid };
          doc = {
            tournamentId: id,
            categoryId,
            playerId: pid,
            wins: s.wins,
            losses: s.losses,
            pointsFor: s.pointsFor,
            pointsAgainst: s.pointsAgainst,
            pointDifferential: s.pointDifferential,
            rankPoints: s.rankPoints,
            meta: { playerKey: String(s.player) },
          };
        } else {
          let maybeTeam = null;
          try { maybeTeam = await Team.findById(s.player).lean(); } catch (_) {}
          if (maybeTeam && maybeTeam._id) {
            filter = { tournamentId: id, categoryId, teamId: String(maybeTeam._id) };
            doc = {
              tournamentId: id,
              categoryId,
              teamId: String(maybeTeam._id),
              teamName: maybeTeam.teamName || undefined,
              wins: s.wins,
              losses: s.losses,
              pointsFor: s.pointsFor,
              pointsAgainst: s.pointsAgainst,
              pointDifferential: s.pointDifferential,
              rankPoints: s.rankPoints,
              meta: { playerKey: String(s.player), teamMemberIds: Array.isArray(maybeTeam.playerIds) ? maybeTeam.playerIds.map((x) => String(x)) : undefined },
            };
          } else {
            let teamByName = null;
            try {
              teamByName = await Team.findOne({ tournamentId: id, categoryId, teamName: String(s.player) }).lean();
            } catch (_) {}
            if (teamByName && teamByName._id) {
              filter = { tournamentId: id, categoryId, teamId: String(teamByName._id) };
              doc = {
                tournamentId: id,
                categoryId,
                teamId: String(teamByName._id),
                teamName: teamByName.teamName || undefined,
                wins: s.wins,
                losses: s.losses,
                pointsFor: s.pointsFor,
                pointsAgainst: s.pointsAgainst,
                pointDifferential: s.pointDifferential,
                rankPoints: s.rankPoints,
                meta: { playerKey: String(s.player), teamMemberIds: Array.isArray(teamByName.playerIds) ? teamByName.playerIds.map((x) => String(x)) : undefined },
              };
            } else {
              filter = { tournamentId: id, categoryId, "meta.playerKey": String(s.player) };
              doc = {
                tournamentId: id,
                categoryId,
                displayName: String(s.player),
                wins: s.wins,
                losses: s.losses,
                pointsFor: s.pointsFor,
                pointsAgainst: s.pointsAgainst,
                pointDifferential: s.pointDifferential,
                rankPoints: s.rankPoints,
                meta: { playerKey: String(s.player) },
              };
            }
          }
        }
        await Standing.updateOne(filter, { $set: doc }, { upsert: true });
      }
    } catch (_) {}
    try {
      if (global.emitTournamentEvent) {
        global.emitTournamentEvent(id, "standings:update", { categoryId, groupId, standings: normalized });
      }
    } catch (_) {}
    res.json({ ok: true, standings: normalized });
  } catch (error) {
    console.error('Error updating group standings:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ✅ Update group matches and recompute standings
exports.updateGroupMatches = async (req, res) => {
  try {
    const { id, categoryId, groupId } = req.params;
    const { matches } = req.body || {};
    const pruneMissingRaw =
      String(req.query?.pruneMissing || req.body?.pruneMissing || "")
        .trim()
        .toLowerCase();
    const replaceRaw =
      String(req.query?.replace || req.body?.replace || "")
        .trim()
        .toLowerCase();
    const PRUNE_MISSING =
      pruneMissingRaw === "true" || pruneMissingRaw === "1" || replaceRaw === "true" || replaceRaw === "1";
    let __normMatchUpserts = 0;

    const tournament = await Tournament.findById(id);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin") || roles.includes("referee");
    if (!isPrivileged && !hasAccessToTournament(tournament, req.user?.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const catIndex = categories.findIndex((c) => String(c._id) === String(categoryId));
    if (catIndex < 0) return res.status(404).json({ message: "Category not found" });
    const cat = tournament.tournamentCategories[catIndex];
    if (cat.locked || cat.pointsSubmitted) {
      return res.status(409).json({ message: "Category is locked or points already submitted" });
    }

    const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
    const groupIndex = groups.findIndex((g) => String(g.id) === String(groupId));
    if (groupIndex < 0) return res.status(404).json({ message: "Group not found" });
    const group = cat.groupStage.groups[groupIndex];

    const isObjectId = (val) => typeof val === 'string' && /^[a-f0-9]{24}$/i.test(String(val).trim());
    const asNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
    const duprMetaOnlyRaw =
      String(req.query?.duprMetaOnly || req.body?.duprMetaOnly || "")
        .trim()
        .toLowerCase();
    const DUPR_META_ONLY = duprMetaOnlyRaw === "true" || duprMetaOnlyRaw === "1";
    const isAdmin = roles.includes("superadmin") || roles.includes("clubadmin");
    const isTournamentStaff = (() => {
      try {
        if (isAdmin) return true;
        return hasAccessToTournament(tournament, req.user);
      } catch {
        return false;
      }
    })();
    const forceResultEditRaw =
      String(req.query?.forceResultEdit || req.body?.forceResultEdit || "")
        .trim()
        .toLowerCase();
    const FORCE_RESULT_EDIT =
      isTournamentStaff && (forceResultEditRaw === "true" || forceResultEditRaw === "1");
    const clearDuprRaw =
      String(req.query?.clearDupr || req.body?.clearDupr || "")
        .trim()
        .toLowerCase();
    const CLEAR_DUPR =
      isAdmin && !DUPR_META_ONLY && (clearDuprRaw === "true" || clearDuprRaw === "1");
    const isDuprField = (field) => {
      const f = String(field || "");
      if (!f) return false;
      if (f === "duprGames") return true;
      return f.startsWith("dupr");
    };
    const hasSubmittedToDupr = (m) => {
      try {
        const mm = (m && typeof m === "object") ? m : {};
        if (Boolean(mm.duprMatchCode) && !Boolean(mm.duprDeletedUpstream)) return true;
        const g = mm.duprGames && typeof mm.duprGames === "object" ? mm.duprGames : {};
        return Object.keys(g).some((k) => {
          const info = g[k] || {};
          const code = String(info?.matchCode || "").trim();
          const deleted = Boolean(info?.deletedUpstream || mm.duprDeletedUpstream);
          return Boolean(code) && !deleted;
        });
      } catch {
        return false;
      }
    };
    const hasAnyScores = (mm) => {
      try {
        const m = (mm && typeof mm === "object") ? mm : {};
        const nums = [
          m.game1Player1, m.game1Player2,
          m.game2Player1, m.game2Player2,
          m.game3Player1, m.game3Player2,
          m.finalScorePlayer1, m.finalScorePlayer2,
        ].map((x) => Number(x) || 0);
        if (nums.some((n) => n > 0)) return true;
        const s = m.scores || {};
        const games = [s.game1, s.game2, s.game3, s.final].filter(Boolean);
        if (games.some((g) => (Number(g?.team1) || 0) > 0 || (Number(g?.team2) || 0) > 0)) return true;
        const md = Array.isArray(m.mdScores) ? m.mdScores : null;
        const wd = Array.isArray(m.wdScores) ? m.wdScores : null;
        const xd = Array.isArray(m.xdScores) ? m.xdScores : null;
        const anyArr = [md, wd, xd].filter(Boolean).flat();
        if (anyArr.some((x) => Number(x) > 0)) return true;
        return false;
      } catch {
        return false;
      }
    };
    const adminCorrectionModeRaw =
      String(req.query?.adminCorrectionMode || req.body?.adminCorrectionMode || "")
        .trim()
        .toLowerCase();
    const adminCorrectionMode =
      isTournamentStaff && (adminCorrectionModeRaw === "true" || adminCorrectionModeRaw === "1");
    const correctionReason = String(req.body?.reason || req.body?.correctionReason || "").trim();
    const auditEntries = [];
    const auditActorId = req.user?._id || req.user?.id || null;
    const auditSnapshot = (m) => {
      const mm = (m && typeof m === "object") ? m : {};
      return {
        status: mm.status,
        date: mm.date,
        time: mm.time,
        court: mm.court,
        venue: mm.venue,
        player1: mm.player1,
        player2: mm.player2,
        player1Name: mm.player1Name,
        player2Name: mm.player2Name,
        team1Id: mm.team1Id,
        team2Id: mm.team2Id,
        team1Members: mm.team1Members,
        team2Members: mm.team2Members,
        team1Name: mm.team1Name,
        team2Name: mm.team2Name,
        game1Player1: mm.game1Player1,
        game1Player2: mm.game1Player2,
        game2Player1: mm.game2Player1,
        game2Player2: mm.game2Player2,
        game3Player1: mm.game3Player1,
        game3Player2: mm.game3Player2,
        finalScorePlayer1: mm.finalScorePlayer1,
        finalScorePlayer2: mm.finalScorePlayer2,
        mdScores: mm.mdScores,
        wdScores: mm.wdScores,
        xdScores: mm.xdScores,
        duprMatchCode: mm.duprMatchCode,
        duprIdentifier: mm.duprIdentifier,
        duprDeletedUpstream: mm.duprDeletedUpstream,
        duprDeletedAt: mm.duprDeletedAt,
        duprNeedsUpdate: mm.duprNeedsUpdate,
        duprScoreSig: mm.duprScoreSig,
        duprNeedsCorrection: mm.duprNeedsCorrection,
        duprCorrectionSeq: mm.duprCorrectionSeq,
        duprCorrectionReason: mm.duprCorrectionReason,
        duprGames: mm.duprGames,
      };
    };
    const computeChangedFields = (before, after) => {
      const b = auditSnapshot(before);
      const a = auditSnapshot(after);
      const keys = Array.from(new Set(Object.keys(b).concat(Object.keys(a))));
      const changed = [];
      keys.forEach((k) => {
        const bv = b[k];
        const av = a[k];
        if (k === "duprGames" || k === "mdScores" || k === "wdScores" || k === "xdScores") {
          if (JSON.stringify(bv || null) !== JSON.stringify(av || null)) changed.push(k);
          return;
        }
        if (String(bv ?? "") !== String(av ?? "")) changed.push(k);
      });
      return { before: b, after: a, changed };
    };

    if (matches && typeof matches === 'object' && !Array.isArray(matches)) {
      const existingMatches = group.matches || {};
      const existingMatchCount = Object.keys(existingMatches).length;
      const incomingMatchKeys = Object.keys(matches);
      
      console.log(`[UPDATE-GROUP-MATCHES] Group: ${groupId}, Existing matches: ${existingMatchCount}, Incoming matches: ${incomingMatchKeys.length}`, {
        existingKeys: Object.keys(existingMatches),
        incomingKeys: incomingMatchKeys
      });
      
      // Build merged matches:
      // - Default: deep copy existing then overlay incoming (never lose matches)
      // - PRUNE_MISSING: start empty and only keep incoming keys, preserving schedule fields from existing when available
      const mergedMatches = {};
      if (!PRUNE_MISSING) {
        Object.keys(existingMatches).forEach((key) => {
          mergedMatches[key] = { ...existingMatches[key] };
        });
      }
      
      // Now update only the matches that are in the incoming payload
      Object.keys(matches).forEach((key) => {
        // Merge each match individually to preserve all fields including status
        const existing = existingMatches[key] || {};
        const incoming = matches[key] || {};
        const existingStatusNorm = String(existing?.status || "").trim();
        const existingLower = String(existingStatusNorm).toLowerCase();
        const lockedByDupr = hasSubmittedToDupr(existing);
        const lockedByStatus = (() => {
          try {
            if (existingLower !== "completed") return false;
            if (existing?.team1Id && existing?.team2Id) return true;
            const gpmEff = Math.min(Math.max(Number(cat?.gamesPerMatch ?? 3), 1), 3);
            const setsToWin = Math.ceil(gpmEff / 2);
            const sets = [
              [asNum(existing?.game1Player1), asNum(existing?.game1Player2)],
              [asNum(existing?.game2Player1), asNum(existing?.game2Player2)],
              [asNum(existing?.game3Player1), asNum(existing?.game3Player2)],
            ].slice(0, gpmEff);
            let w1 = 0;
            let w2 = 0;
            sets.forEach(([a, b]) => {
              if ((a + b) <= 0) return;
              if (a > b) w1 += 1;
              else if (b > a) w2 += 1;
            });
            return w1 >= setsToWin || w2 >= setsToWin;
          } catch {
            return true;
          }
        })();
        const RESULT_LOCKED = Boolean(lockedByDupr || lockedByStatus);
        const scoreFields = new Set([
          "game1Player1",
          "game1Player2",
          "game2Player1",
          "game2Player2",
          "game3Player1",
          "game3Player2",
          "finalScorePlayer1",
          "finalScorePlayer2",
          "mdScores",
          "wdScores",
          "xdScores",
        ]);
        const participantFields = new Set([
          "player1",
          "player2",
          "player1Name",
          "player2Name",
          "team1Id",
          "team2Id",
          "team1Members",
          "team2Members",
          "team1Name",
          "team2Name",
        ]);
        const normalizeParticipantValue = (value) => {
          if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item ?? "").trim()));
          return String(value ?? "").trim();
        };
        const hasParticipantFieldChange = (nextValue, prevValue) =>
          Object.keys(nextValue || {}).some((f) =>
            participantFields.has(f) &&
            normalizeParticipantValue(nextValue?.[f]) !== normalizeParticipantValue(prevValue?.[f])
          );
        const wantsParticipantChange = !DUPR_META_ONLY && hasParticipantFieldChange(incoming, existing);
        const wantsScoreChange = !DUPR_META_ONLY && Object.keys(incoming || {}).some((f) => scoreFields.has(f));
        const participantLocked = hasAnyScores(existing);
        if (lockedByDupr && (wantsParticipantChange || wantsScoreChange)) {
          return res.status(409).json({
            message: "DUPR Lock: delete/void the DUPR match first before editing participants or scores.",
            lockType: "dupr",
            categoryId: String(categoryId),
            groupId: String(groupId),
            matchKey: String(key),
          });
        }
        if ((wantsParticipantChange || wantsScoreChange) && adminCorrectionMode && !correctionReason) {
          return res.status(400).json({ message: "Missing reason for Admin Correction Mode" });
        }
        if (wantsParticipantChange && participantLocked && !adminCorrectionMode) {
          return res.status(409).json({
            message: "Participant Lock: scores already exist. Enable Admin Correction Mode and provide a reason to proceed.",
            lockType: "participant",
            categoryId: String(categoryId),
            groupId: String(groupId),
            matchKey: String(key),
          });
        }
        
        // CRITICAL: Log what we're receiving to debug
        console.log(`[UPDATE-GROUP-MATCHES] Processing match ${key}:`, {
          incomingFields: Object.keys(incoming),
          existingHasDate: !!existing.date,
          existingHasTime: !!existing.time,
          existingHasCourt: !!existing.court,
          existingStatus: existing.status
        });
        
        // CRITICAL FIX: Mobile app should NEVER send schedule fields (date, time, court, venue)
        // These fields are ONLY managed by the web scheduler
        // If mobile app sends them, we IGNORE them and preserve existing values
        // This prevents mobile app from accidentally clearing schedule data
        
        // ALWAYS preserve existing schedule data - never accept it from mobile app
        const updateDate = existing.date;  // Always use existing - mobile app can't change this
        const updateTime = existing.time;  // Always use existing - mobile app can't change this
        const updateCourt = existing.court; // Always use existing - mobile app can't change this
        const updateVenue = existing.venue; // Always use existing - mobile app can't change this
        
        // Log if mobile app tried to send schedule fields (this is a bug in mobile app)
        if (incoming.date !== undefined || incoming.time !== undefined || incoming.court !== undefined || incoming.venue !== undefined) {
          console.warn(`[UPDATE-GROUP-MATCHES] WARNING: Mobile app sent schedule fields for match ${key}. These are IGNORED. Schedule fields can only be set by web scheduler.`);
        }
        // CRITICAL: Determine final status
        // 1. If incoming has status, use it (mobile app or explicit update)
        // 2. If schedule info exists (date, time, court), auto-set to "Scheduled" unless status is "Ongoing" or "Completed"
        // 3. Otherwise, preserve existing status
        const hasScheduleInfo = updateDate && updateTime && updateCourt && 
                                String(updateDate).trim() !== '' && 
                                String(updateTime).trim() !== '' && 
                                String(updateCourt).trim() !== '';
        
        const normalizeStatus = (v) => String(v || '').trim();
        const lower = (v) => normalizeStatus(v).toLowerCase();
        const incomingHasStatus = incoming.status !== undefined && incoming.status !== null && normalizeStatus(incoming.status) !== '';
        let finalStatus;
        if (DUPR_META_ONLY) {
          finalStatus = existingStatusNorm;
        } else if (incomingHasStatus) {
          const incomingNorm = normalizeStatus(incoming.status);
          const incomingLower = lower(incoming.status);
          // Role-aware guardrails:
          // - Referees can only move a match to Ongoing or Completed
          // - They cannot set Scheduled/Unschedule (these are managed by the scheduler)
          // General precedence rules still apply to prevent accidental downgrades
        const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
        const isRefereeOnly = roles.includes('referee') && !roles.includes('clubadmin') && !roles.includes('superadmin');
        if (isRefereeOnly && (incomingLower === 'scheduled' || incomingLower === 'unschedule')) {
            console.warn(`[UPDATE-GROUP-MATCHES] Referee attempted to set status "${incomingNorm}" for match ${key}. Ignoring to protect schedule.`);
            finalStatus = existingStatusNorm;
        } else if (isRefereeOnly && existingLower === 'completed') {
          finalStatus = existingStatusNorm;
        } else if (isRefereeOnly && existingLower === 'ongoing' && (incomingLower === 'scheduled' || incomingLower === 'unschedule')) {
          finalStatus = existingStatusNorm;
          } else {
            finalStatus = incomingNorm;
          }
        } else if (hasScheduleInfo) {
          // Only auto-set to Scheduled if not already Ongoing or Completed
          if (existingLower !== 'ongoing' && existingLower !== 'completed') {
            finalStatus = 'Scheduled';
            console.log(`[UPDATE-GROUP-MATCHES] Auto-setting match ${key} to "Scheduled" - has schedule info`);
          } else {
            finalStatus = existingStatusNorm;
          }
        } else {
          finalStatus = existingStatusNorm || undefined;
        }
        if (RESULT_LOCKED && !FORCE_RESULT_EDIT) {
          if (existingLower === "completed") {
            finalStatus = existingStatusNorm;
          }
        }
        // CRITICAL: Merge carefully - preserve ALL existing fields, only update what's explicitly provided
        // Start with existing match (which is already in mergedMatches from the deep copy above)
        // Then only override with incoming fields that have meaningful values
        // Initialize merged entry
        mergedMatches[key] = PRUNE_MISSING ? {} : { ...existing };
        
        // Only update fields that are explicitly provided AND have meaningful values
        // This ensures we never overwrite with empty strings or undefined
        if (updateDate !== undefined && updateDate !== null && String(updateDate).trim() !== '') {
          mergedMatches[key].date = updateDate;
        }
        if (updateTime !== undefined && updateTime !== null && String(updateTime).trim() !== '') {
          mergedMatches[key].time = updateTime;
        }
        if (updateCourt !== undefined && updateCourt !== null && String(updateCourt).trim() !== '') {
          mergedMatches[key].court = updateCourt;
        }
        if (updateVenue !== undefined && updateVenue !== null && String(updateVenue).trim() !== '') {
          mergedMatches[key].venue = updateVenue;
        }
        if (finalStatus !== undefined && finalStatus !== null && String(finalStatus).trim() !== '') {
          mergedMatches[key].status = finalStatus;
        }
        
        const roleList = Array.isArray(req.user?.roles) ? req.user.roles : [];
        const isRefereeForFields = roleList.includes('referee') && !roleList.includes('clubadmin') && !roleList.includes('superadmin');
        const incLowerForFilter = String(incoming?.status || '').trim().toLowerCase();
        const disallowedIdentityFields = new Set([
          'player1','player2','player1Name','player2Name','team1Id','team2Id','matchId'
        ]);
        Object.keys(incoming).forEach((field) => {
          if (['date', 'time', 'court', 'venue', 'status'].includes(field)) return;
          if (incoming[field] === undefined || incoming[field] === null) return;
          if (DUPR_META_ONLY && !isDuprField(field)) return;
          if (RESULT_LOCKED && !FORCE_RESULT_EDIT && scoreFields.has(field)) return;
          if (!DUPR_META_ONLY && RESULT_LOCKED && !FORCE_RESULT_EDIT && isDuprField(field)) return;
          if (!DUPR_META_ONLY && participantLocked && participantFields.has(field) && !adminCorrectionMode) return;
          if (isRefereeForFields) {
            if (incLowerForFilter === 'ongoing') return;
            if (disallowedIdentityFields.has(field)) return;
          }
          mergedMatches[key][field] = incoming[field];
        });
        if (RESULT_LOCKED && !FORCE_RESULT_EDIT) {
          try {
            [
              "game1Player1",
              "game1Player2",
              "game2Player1",
              "game2Player2",
              "game3Player1",
              "game3Player2",
              "finalScorePlayer1",
              "finalScorePlayer2",
              "mdScores",
              "wdScores",
              "xdScores",
            ].forEach((f) => {
              if (Object.prototype.hasOwnProperty.call(existing, f)) {
                mergedMatches[key][f] = existing[f];
              }
            });
            if (!DUPR_META_ONLY) {
              Object.keys(existing || {}).forEach((f) => {
                if (!isDuprField(f)) return;
                mergedMatches[key][f] = existing[f];
              });
            }
          } catch (_) {}
        }
        // Coerce numeric game fields and recompute final scores; auto-complete if any points exist
        try {
          const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
          const g1p1 = toNum(mergedMatches[key].game1Player1);
          const g1p2 = toNum(mergedMatches[key].game1Player2);
          const g2p1 = toNum(mergedMatches[key].game2Player1);
          const g2p2 = toNum(mergedMatches[key].game2Player2);
          const g3p1 = toNum(mergedMatches[key].game3Player1);
          const g3p2 = toNum(mergedMatches[key].game3Player2);
          mergedMatches[key].game1Player1 = g1p1;
          mergedMatches[key].game1Player2 = g1p2;
          mergedMatches[key].game2Player1 = g2p1;
          mergedMatches[key].game2Player2 = g2p2;
          mergedMatches[key].game3Player1 = g3p1;
          mergedMatches[key].game3Player2 = g3p2;
          const gpmEff = Math.min(Math.max(Number(cat?.gamesPerMatch ?? 3), 1), 3);
          const sets = [[g1p1,g1p2],[g2p1,g2p2],[g3p1,g3p2]].slice(0, gpmEff);
          let w1 = 0; let w2 = 0;
          sets.forEach(([a,b]) => { if (a>b) w1++; else if (b>a) w2++; });
          mergedMatches[key].finalScorePlayer1 = toNum(mergedMatches[key].finalScorePlayer1 ?? w1) || w1;
          mergedMatches[key].finalScorePlayer2 = toNum(mergedMatches[key].finalScorePlayer2 ?? w2) || w2;
          const anyPoints = sets.some(([a,b]) => (a + b) > 0);
          if (anyPoints) {
            const cur = String(mergedMatches[key].status || '').trim().toLowerCase();
            if (cur !== 'completed' && cur !== 'ongoing') {
              mergedMatches[key].status = 'Completed';
            }
          }
          console.log(`[UPDATE-GROUP-MATCHES] Numeric fields for ${key}:`, {
            g1: `${g1p1}-${g1p2}`, g2: `${g2p1}-${g2p2}`, g3: `${g3p1}-${g3p2}`,
            final: `${mergedMatches[key].finalScorePlayer1}-${mergedMatches[key].finalScorePlayer2}`,
            status: mergedMatches[key].status
          });
        } catch (_) {}

        try {
          const { before, after, changed } = computeChangedFields(existing, mergedMatches[key] || {});
          if (changed.length) {
            const wantsParticipantChange = !DUPR_META_ONLY && hasParticipantFieldChange(incoming, existing);
            const wantsScoreChange = !DUPR_META_ONLY && Object.keys(incoming || {}).some((f) => scoreFields.has(f));
            const wantsScheduleChange = !DUPR_META_ONLY && ["date", "time", "court", "venue", "status"].some((f) => Object.prototype.hasOwnProperty.call(incoming || {}, f));
            const action = DUPR_META_ONLY
              ? "match_dupr_meta_update"
              : wantsParticipantChange
                ? (adminCorrectionMode ? "match_participants_update_admin_correction" : "match_participants_update")
                : wantsScoreChange
                  ? (adminCorrectionMode ? "match_score_update_admin_correction" : "match_score_update")
                  : wantsScheduleChange
                    ? "match_schedule_update"
                    : "match_update";
            auditEntries.push({
              tournamentId: tournament._id,
              entityType: "match",
              entityId: `group:${String(categoryId)}:${String(groupId)}:${String(key)}`,
              action,
              actorId: auditActorId,
              actorRoles: roles,
              reason: adminCorrectionMode ? correctionReason : "",
              before,
              after,
              meta: { stage: "group", categoryId: String(categoryId), groupId: String(groupId), matchKey: String(key), changedFields: changed, duprMetaOnly: DUPR_META_ONLY ? 1 : 0 },
            });
          }
        } catch (_) {}
        console.log(`[UPDATE-GROUP-MATCHES] Merged match ${key}:`, {
          existingFields: Object.keys(existing),
          incomingFields: Object.keys(incoming),
          finalFields: Object.keys(mergedMatches[key]),
          hasScheduleInfo,
          incomingStatus: incoming.status,
          existingStatus: existing.status,
          finalStatus: finalStatus
        });
      });
      
      const finalMatchCount = Object.keys(mergedMatches).length;
      console.log(`[UPDATE-GROUP-MATCHES] After merge: ${finalMatchCount} matches`, {
        allKeys: Object.keys(mergedMatches),
        existingCount: existingMatchCount,
        incomingCount: incomingMatchKeys.length
      });
      
      // Verify counts only in non-prune mode; prune mode intentionally reduces count
      if (!PRUNE_MISSING && finalMatchCount < existingMatchCount) {
        console.error(`[UPDATE-GROUP-MATCHES] ERROR: Lost matches! Before: ${existingMatchCount}, After: ${finalMatchCount}`);
        console.error(`[UPDATE-GROUP-MATCHES] Existing keys: ${Object.keys(existingMatches).join(', ')}`);
        console.error(`[UPDATE-GROUP-MATCHES] Final keys: ${Object.keys(mergedMatches).join(', ')}`);
        return res.status(500).json({ 
          message: "Error: Matches were lost during update. This should not happen.",
          existingCount: existingMatchCount,
          finalCount: finalMatchCount
        });
      }
      
      // Log sample of matches to verify schedule data is preserved
      Object.keys(mergedMatches).slice(0, 3).forEach((key) => {
        const m = mergedMatches[key];
        console.log(`[UPDATE-GROUP-MATCHES] Sample match ${key}:`, {
          hasDate: !!m.date,
          hasTime: !!m.time,
          hasCourt: !!m.court,
          status: m.status
        });
      });

      // Never automatically clear DUPR submission metadata.
      // Only allow clearing via explicit admin action (CLEAR_DUPR).
      try {
        if (CLEAR_DUPR) {
          const keysChanged = Object.keys(matches || {});
          keysChanged.forEach((key) => {
            const m = mergedMatches[key] || {};
            const total =
              asNum(m.game1Player1) + asNum(m.game1Player2) +
              asNum(m.game2Player1) + asNum(m.game2Player2) +
              asNum(m.game3Player1) + asNum(m.game3Player2) +
              asNum(m.finalScorePlayer1) + asNum(m.finalScorePlayer2);
            if (total === 0) {
              delete m.duprGames;
              delete m.duprSynced;
              delete m.duprMatchCode;
              delete m.duprDeletedUpstream;
              delete m.duprScoreSig;
              delete m.duprNeedsUpdate;
              mergedMatches[key] = m;
              console.log(`[UPDATE-GROUP-MATCHES] Cleared DUPR metadata for match ${key} due to explicit clearDupr request`);
            }
          });
        }
      } catch (_) {}

      try {
        if (DUPR_META_ONLY) {
          const keysChanged = Object.keys(matches || {});
          keysChanged.forEach((k) => {
            const m = mergedMatches[k] || {};
            const g = m.duprGames && typeof m.duprGames === "object" ? m.duprGames : {};
            const hasActiveCode =
              Boolean(String(m.duprMatchCode || "").trim()) ||
              Object.keys(g).some((kk) => {
                const info = g[kk] || {};
                const code = String(info?.matchCode || "").trim();
                const deleted = Boolean(info?.deletedUpstream || m.duprDeletedUpstream);
                return Boolean(code) && !deleted;
              });
            if (hasActiveCode) {
              if (m.duprNeedsCorrection) delete m.duprNeedsCorrection;
            }
            mergedMatches[k] = m;
          });
        }
      } catch (_) {}

      // Detect score changes for already-submitted matches and flag update requirement
      try {
        const keysChanged = Object.keys(matches || {});
        const computeSig = (mm) => {
          const g1a = asNum(mm.game1Player1), g1b = asNum(mm.game1Player2);
          const g2a = asNum(mm.game2Player1), g2b = asNum(mm.game2Player2);
          const g3a = asNum(mm.game3Player1), g3b = asNum(mm.game3Player2);
          const parts = [];
          if ((g1a + g1b) > 0) parts.push(`g1:${g1a}-${g1b}`);
          if ((g2a + g2b) > 0) parts.push(`g2:${g2a}-${g2b}`);
          if ((g3a + g3b) > 0) parts.push(`g3:${g3a}-${g3b}`);
          return parts.join("|");
        };
        keysChanged.forEach((key) => {
          const prev = existingMatches[key] || {};
          const m = mergedMatches[key] || {};
          const newSig = computeSig(m);
          const oldSigStored = String(prev.duprScoreSig || "").trim();
          const prevSigComputed = computeSig(prev);
          const oldSig = oldSigStored || prevSigComputed;
          const duprInfo = m.duprGames || {};
          const hadSubmitted =
            Boolean(m.duprMatchCode) ||
            Object.keys(duprInfo).some((k) => String((duprInfo[k] || {}).matchCode || "").trim());
          if (hadSubmitted) {
            // If signature changed compared to previous, require update
            if ((oldSig || newSig) && oldSig !== newSig) {
              m.duprNeedsUpdate = true;
            }
            // Always persist the latest signature for future comparisons
            if (newSig) m.duprScoreSig = newSig;
            mergedMatches[key] = m;
          }
        });
      } catch (e) {
        console.warn("[UPDATE-GROUP-MATCHES] DUPR update detection failed:", e?.message || e);
      }

      const isRefereeRole = Array.isArray(req.user?.roles) && req.user.roles.includes('referee');
      const keysFromIncoming = Object.keys(matches || {});
      if (isRefereeRole && group.matches && typeof group.matches === 'object' && !Array.isArray(group.matches) && !PRUNE_MISSING) {
        const beforeCount = Object.keys(group.matches || {}).length;
        keysFromIncoming.forEach((k) => {
          group.matches[k] = mergedMatches[k];
        });
        const afterCount = Object.keys(group.matches || {}).length;
        console.log(`[UPDATE-GROUP-MATCHES] Referee in-place update for keys [${keysFromIncoming.join(', ')}]. Before: ${beforeCount}, After: ${afterCount}`);
      } else {
        group.matches = mergedMatches;
      }
    } else if (Array.isArray(matches)) {
      group.matches = matches;
    }

    // In prune mode, refresh originalPlayers from current matches to avoid stale standings participants
    try {
      if (PRUNE_MISSING) {
        const participants = new Set();
        const mm = group.matches || {};
        const keys = Array.isArray(mm) ? mm.map((_, idx) => String(idx + 1)) : Object.keys(mm);
        keys.forEach((k) => {
          const m = Array.isArray(mm) ? mm[parseInt(k) - 1] || {} : (mm[k] || {});
          if (m.team1Id && m.team2Id) {
            participants.add(String(m.team1Id || "").trim());
            participants.add(String(m.team2Id || "").trim());
          } else {
            const p1 = String(m.player1 || m.player1Name || "").trim();
            const p2 = String(m.player2 || m.player2Name || "").trim();
            if (p1) participants.add(p1);
            if (p2) participants.add(p2);
          }
        });
        const list = Array.from(participants).filter(Boolean);
        if (list.length) {
          group.originalPlayers = list;
        }
      }
    } catch (_) {}

    const basePlayers = Array.isArray(group.originalPlayers) && group.originalPlayers.length
      ? group.originalPlayers.slice()
      : (Array.isArray(group.standings) ? group.standings.map((s) => String(s.player || '')) : []);

    const stats = new Map();
    const ensure = (key) => {
      const k = String(key || '').trim();
      if (!k) return;
      if (!stats.has(k)) stats.set(k, { wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0 });
    };

    if (group && group.matches && !Array.isArray(group.matches) && typeof group.matches === 'object') {
      Object.keys(group.matches).forEach((k) => {
        const m = group.matches[k] || {};
        const parts = String(k).split('-');
        const i = parseInt(parts[0]);
        const off = parseInt(parts[1]);
        const j = i + 1 + (isNaN(off) ? 0 : off);
        if (!m.matchId) m.matchId = `G${k}`;
        if (m.team1Id && m.team2Id) {
          const t1 = String(m.team1Id);
          const t2 = String(m.team2Id);
          ensure(t1); ensure(t2);
          const finals = [m.mdScores?.final, m.wdScores?.final, m.xdScores?.final].filter(Boolean);
          let pfA = 0, pfB = 0, wA = 0, wB = 0;
          for (const f of finals) {
            const a = asNum(f?.team1);
            const b = asNum(f?.team2);
            pfA += a; pfB += b;
            if (a > b) wA += 1; else if (b > a) wB += 1;
          }
          const s1 = stats.get(t1);
          const s2 = stats.get(t2);
          s1.pointsFor += pfA; s1.pointsAgainst += pfB;
          s2.pointsFor += pfB; s2.pointsAgainst += pfA;
          if (wA > wB) { s1.wins += 1; s2.losses += 1; }
          else if (wB > wA) { s2.wins += 1; s1.losses += 1; }
        } else {
          const p1 = m.player1 && String(m.player1).trim() ? String(m.player1) : (basePlayers[i] || '');
          const p2 = m.player2 && String(m.player2).trim() ? String(m.player2) : (basePlayers[j] || '');
          if (!m.player1 && p1) m.player1 = p1;
          if (!m.player2 && p2) m.player2 = p2;
          m.player1Name = String(m.player1 || p1 || '');
          m.player2Name = String(m.player2 || p2 || '');
          const raw1 = basePlayers[i];
          const raw2 = basePlayers[j];
          if (!m.player1Id && isObjectId(raw1)) m.player1Id = String(raw1);
          if (!m.player2Id && isObjectId(raw2)) m.player2Id = String(raw2);
          if (!p1 || !p2) return;
          ensure(p1);
          ensure(p2);
          const g1p1 = asNum(m.game1Player1);
          const g1p2 = asNum(m.game1Player2);
          const g2p1 = asNum(m.game2Player1);
          const g2p2 = asNum(m.game2Player2);
          const g3p1 = asNum(m.game3Player1);
          const g3p2 = asNum(m.game3Player2);
          const fs1 = asNum(m.finalScorePlayer1);
          const fs2 = asNum(m.finalScorePlayer2);
          const s1 = stats.get(p1);
          const s2 = stats.get(p2);
          s1.pointsFor += g1p1 + g2p1 + g3p1;
          s1.pointsAgainst += g1p2 + g2p2 + g3p2;
          s2.pointsFor += g1p2 + g2p2 + g3p2;
          s2.pointsAgainst += g1p1 + g2p1 + g3p1;
          // Only calculate wins/losses if match has scores and status is not explicitly set to prevent completion
          // Preserve status field - don't auto-complete based on scores if status was manually set
          const matchStatus = String(m.status || '').trim().toLowerCase();
          const shouldCalculateWins = matchStatus !== 'scheduled' && matchStatus !== 'unschedule';
          if (shouldCalculateWins) {
            if (fs1 + fs2 > 0) {
              if (fs1 > fs2) { s1.wins += 1; s2.losses += 1; }
              else if (fs2 > fs1) { s2.wins += 1; s1.losses += 1; }
            } else {
              const w1 = (g1p1 > g1p2 ? 1 : 0) + (g2p1 > g2p2 ? 1 : 0) + (g3p1 > g3p2 ? 1 : 0);
              const w2 = (g1p2 > g1p1 ? 1 : 0) + (g2p2 > g2p1 ? 1 : 0) + (g3p2 > g3p1 ? 1 : 0);
              if (w1 > w2) { s1.wins += 1; s2.losses += 1; }
              else if (w2 > w1) { s2.wins += 1; s1.losses += 1; }
            }
          }
        }
      });
    } else if (Array.isArray(group.matches)) {
      group.matches.forEach((m, idx) => {
        const p1 = String(m.player1 || '').trim();
        const p2 = String(m.player2 || '').trim();
        m.player1Name = p1;
        m.player2Name = p2;
        if (!m.player1Id && isObjectId(p1)) m.player1Id = p1;
        if (!m.player2Id && isObjectId(p2)) m.player2Id = p2;
        if (!m.matchId) m.matchId = `G${idx + 1}`;
        if (!p1 || !p2) return;
        ensure(p1);
        ensure(p2);
        const g1p1 = asNum(m.game1Player1);
        const g1p2 = asNum(m.game1Player2);
        const g2p1 = asNum(m.game2Player1);
        const g2p2 = asNum(m.game2Player2);
        const g3p1 = asNum(m.game3Player1);
        const g3p2 = asNum(m.game3Player2);
        const fs1 = asNum(m.finalScorePlayer1);
        const fs2 = asNum(m.finalScorePlayer2);
        const s1 = stats.get(p1);
        const s2 = stats.get(p2);
        s1.pointsFor += g1p1 + g2p1 + g3p1;
        s1.pointsAgainst += g1p2 + g2p2 + g3p2;
        s2.pointsFor += g1p2 + g2p2 + g3p2;
        s2.pointsAgainst += g1p1 + g2p1 + g3p1;
        // Only calculate wins/losses if match has scores and status is not explicitly set to prevent completion
        const matchStatus = String(m.status || '').trim().toLowerCase();
        const shouldCalculateWins = matchStatus !== 'scheduled' && matchStatus !== 'unschedule';
        if (shouldCalculateWins) {
          if (fs1 + fs2 > 0) {
            if (fs1 > fs2) { s1.wins += 1; s2.losses += 1; }
            else if (fs2 > fs1) { s2.wins += 1; s1.losses += 1; }
          } else {
            const w1 = (g1p1 > g1p2 ? 1 : 0) + (g2p1 > g2p2 ? 1 : 0) + (g3p1 > g3p2 ? 1 : 0);
            const w2 = (g1p2 > g1p1 ? 1 : 0) + (g2p2 > g2p1 ? 1 : 0) + (g3p2 > g3p1 ? 1 : 0);
            if (w1 > w2) { s1.wins += 1; s2.losses += 1; }
            else if (w2 > w1) { s2.wins += 1; s1.losses += 1; }
          }
        }
      });
    }

    const keysChanged = Object.keys(matches || {});
    const computed = computeIncremental(group, keysChanged);

    tournament.tournamentCategories[catIndex].groupStage.groups[groupIndex].standings = computed;
    try {
      tournament.markModified(`tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.standings`);
      tournament.markModified(`tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.matches`);
    } catch (_) {
      tournament.markModified('tournamentCategories');
    }

    // Log final state before save
    const finalMatches = group.matches || {};
    const finalMatchCount = Array.isArray(finalMatches) ? finalMatches.length : Object.keys(finalMatches).length;
    console.log(`[UPDATE-GROUP-MATCHES] Before save: ${finalMatchCount} matches in group ${groupId}`);
    if (!Array.isArray(finalMatches)) {
      console.log(`[UPDATE-GROUP-MATCHES] Match keys:`, Object.keys(finalMatches));
    }
    
    const matchesPath = `tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.matches`;
    const standingsPath = `tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.standings`;
    try {
      const tDoc = await Tournament.findById(id);
      if (!tDoc) throw new Error("Tournament not found on save path");
      tDoc.set(matchesPath, group.matches || {});
      tDoc.set(standingsPath, computed);
      try {
        tDoc.markModified(matchesPath);
        tDoc.markModified(standingsPath);
      } catch (_) {}
      await tDoc.save();
    } catch (errSave) {
      throw errSave;
    }
    invalidateTournamentGetCache(id);
    
    // In prune mode, delete normalized matches that are no longer present
    try {
      if (PRUNE_MISSING) {
        const Match = require("../models/Match");
        const roundTag = `G${groupId}`;
        const finalMatchesObj = group.matches || {};
        const keepKeys = Array.isArray(finalMatchesObj)
          ? finalMatchesObj.map((_, idx) => String(idx + 1))
          : Object.keys(finalMatchesObj);
        await Match.deleteMany({
          tournamentId: id,
          categoryId,
          round: roundTag,
          "meta.groupId": groupId,
          "meta.matchKey": { $nin: keepKeys },
        });
      }
    } catch (_) {}

    // Verify after save
    const savedTournament = await Tournament.findById(id).select("tournamentCategories").lean();
    const savedGroup = savedTournament?.tournamentCategories?.[catIndex]?.groupStage?.groups?.[groupIndex];
    const savedMatches = savedGroup?.matches || {};
    const savedMatchCount = Array.isArray(savedMatches) ? savedMatches.length : Object.keys(savedMatches).length;
    console.log(`[UPDATE-GROUP-MATCHES] After save: ${savedMatchCount} matches in group ${groupId}`);
    try {
      const keys = Array.isArray(savedMatches) ? savedMatches.map((_, idx) => String(idx + 1)) : Object.keys(savedMatches);
      const sampleKey = keys[0];
      if (sampleKey) {
        const sm = Array.isArray(savedMatches) ? (savedMatches[parseInt(sampleKey) - 1] || {}) : (savedMatches[sampleKey] || {});
        const toNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
        console.log(`[UPDATE-GROUP-MATCHES] Saved sample ${sampleKey}:`, {
          g1: `${toNum(sm.game1Player1)}-${toNum(sm.game1Player2)}`,
          g2: `${toNum(sm.game2Player1)}-${toNum(sm.game2Player2)}`,
          g3: `${toNum(sm.game3Player1)}-${toNum(sm.game3Player2)}`,
          final: `${toNum(sm.finalScorePlayer1)}-${toNum(sm.finalScorePlayer2)}`,
          status: String(sm.status || '').trim()
        });
      }
    } catch (_) {}
    try { await bracketQueue.enqueueRecompute({ tournamentId: id, categoryId, groupId }); } catch (_) {}
    try {
      if (global.emitTournamentEvent) {
        global.emitTournamentEvent(id, "matches:update", { categoryId, groupId, keys: keysChanged });
        global.emitTournamentEvent(id, "standings:update", { categoryId, groupId, standings: computed });
      }
    } catch (_) {}
    try {
      const Match = require("../models/Match");
      const makeId = (val) => {
        const s = String(val || "").trim();
        return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
      };
      const roundTag = (() => {
        const nm = String(group?.name || '').trim();
        if (nm) return nm;
        try {
          const letter = String(groupId || '').split('-').pop().toUpperCase();
          if (letter) return `Group ${letter}`;
        } catch {}
        return `G${groupId}`;
      })();
      const finalMatchesObj = savedMatches;
      const keys = Array.isArray(finalMatchesObj) ? finalMatchesObj.map((_, idx) => String(idx + 1)) : Object.keys(finalMatchesObj);
      for (const key of keys) {
        const m = Array.isArray(finalMatchesObj) ? finalMatchesObj[parseInt(key) - 1] || {} : (finalMatchesObj[key] || {});
        const hasTeamPairs =
          Array.isArray(m?.mdPlayersTeam1) || Array.isArray(m?.mdPlayersTeam2) ||
          Array.isArray(m?.wdPlayersTeam1) || Array.isArray(m?.wdPlayersTeam2) ||
          Array.isArray(m?.xdPlayersTeam1) || Array.isArray(m?.xdPlayersTeam2) ||
          (m?.mdScores || m?.wdScores || m?.xdScores);
        const isTeam = !!(m.team1Id && m.team2Id) || hasTeamPairs || /team/i.test(String(cat?.division || ""));
        if (isTeam) {
          const t1 = makeId(m.team1Id);
          const t2 = makeId(m.team2Id);
          if (!t1 || !t2) {
            const Registration = require("../models/Registration");
            const Team = require("../models/Team");
            const normIds = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || "")).filter((s) => /^[a-f0-9]{24}$/i.test(s))));
            const getMembers = async (teamNameRaw) => {
              const tn = String(teamNameRaw || "").trim();
              if (!tn) return [];
              const regs = await Registration.find({ tournamentId: id, categoryId, status: "approved", teamName: tn })
                .select("playerId partnerId teamMembers")
                .lean();
              const ids = [];
              for (const r of regs) {
                if (r.playerId) ids.push(String(r.playerId));
                if (r.partnerId) ids.push(String(r.partnerId));
                if (Array.isArray(r.teamMembers)) ids.push(...r.teamMembers.map((x) => String(x)));
              }
              return normIds(ids);
            };
            const name1 = String(m.team1Name || m.player1Name || "").trim();
            const name2 = String(m.team2Name || m.player2Name || "").trim();
            let team1Members = await getMembers(name1);
            let team2Members = await getMembers(name2);
            if (!team1Members.length) {
              const collect = []
                .concat(Array.isArray(m.mdPlayersTeam1) ? m.mdPlayersTeam1 : [])
                .concat(Array.isArray(m.wdPlayersTeam1) ? m.wdPlayersTeam1 : [])
                .concat(Array.isArray(m.xdPlayersTeam1) ? m.xdPlayersTeam1 : []);
              team1Members = normIds(collect);
            }
            if (!team2Members.length) {
              const collect = []
                .concat(Array.isArray(m.mdPlayersTeam2) ? m.mdPlayersTeam2 : [])
                .concat(Array.isArray(m.wdPlayersTeam2) ? m.wdPlayersTeam2 : [])
                .concat(Array.isArray(m.xdPlayersTeam2) ? m.xdPlayersTeam2 : []);
              team2Members = normIds(collect);
            }
            let teamDoc1 = null;
            let teamDoc2 = null;
            try {
              if (name1) {
                teamDoc1 = await Team.findOne({ tournamentId: id, categoryId, teamName: name1 }).lean();
              }
              if (!teamDoc1 && team1Members.length) {
                const created = await Team.create({ tournamentId: id, categoryId, playerIds: team1Members, teamName: name1 || undefined });
                teamDoc1 = created ? created.toObject() : null;
              }
            } catch (_) {}
            try {
              if (name2) {
                teamDoc2 = await Team.findOne({ tournamentId: id, categoryId, teamName: name2 }).lean();
              }
              if (!teamDoc2 && team2Members.length) {
                const created = await Team.create({ tournamentId: id, categoryId, playerIds: team2Members, teamName: name2 || undefined });
                teamDoc2 = created ? created.toObject() : null;
              }
            } catch (_) {}
            const filter = { tournamentId: id, categoryId, round: roundTag, "meta.groupId": groupId, "meta.matchKey": key };
            const g1p1 = Number(m.game1Player1 || m.mdScores?.final?.team1 || 0);
            const g1p2 = Number(m.game1Player2 || m.mdScores?.final?.team2 || 0);
            const g2p1 = Number(m.game2Player1 || m.wdScores?.final?.team1 || 0);
            const g2p2 = Number(m.game2Player2 || m.wdScores?.final?.team2 || 0);
            const g3p1 = Number(m.game3Player1 || m.xdScores?.final?.team1 || 0);
            const g3p2 = Number(m.game3Player2 || m.xdScores?.final?.team2 || 0);
            const fs1Raw = Number(m.finalScorePlayer1 || 0);
            const fs2Raw = Number(m.finalScorePlayer2 || 0);
            const hasFs = (fs1Raw + fs2Raw) > 0;
            const winsFromEvents = (() => {
              let a = 0, b = 0;
              const finals = [
                { a: g1p1, b: g1p2 },
                { a: g2p1, b: g2p2 },
                { a: g3p1, b: g3p2 },
              ];
              for (const f of finals) {
                if ((f.a + f.b) === 0) continue;
                if (f.a > f.b) a += 1; else if (f.b > f.a) b += 1;
              }
              return { a, b };
            })();
            const finalTeam1 = hasFs ? fs1Raw : winsFromEvents.a;
            const finalTeam2 = hasFs ? fs2Raw : winsFromEvents.b;
            const baseStatus = String(m.status || "").trim();
            const anyScorePlayed = (g1p1 + g1p2 + g2p1 + g2p2 + g3p1 + g3p2 + finalTeam1 + finalTeam2) > 0;
            const statusOut = baseStatus.toLowerCase() === 'completed' ? 'Completed'
              : (anyScorePlayed ? 'Completed' : (baseStatus || "Unscheduled"));
            const doc = {
              tournamentId: id,
              categoryId,
              round: roundTag,
              stage: "group",
              groupId: groupId,
              matchKey: key,
              gamesPerMatch: Number(cat?.gamesPerMatch || 1),
              team1Name: name1 || undefined,
              team2Name: name2 || undefined,
              team1Id: teamDoc1 && teamDoc1._id ? String(teamDoc1._id) : undefined,
              team2Id: teamDoc2 && teamDoc2._id ? String(teamDoc2._id) : undefined,
              team1Members: Array.isArray(team1Members) ? team1Members : undefined,
              team2Members: Array.isArray(team2Members) ? team2Members : undefined,
              status: statusOut,
              scores: {
                game1: { team1: g1p1, team2: g1p2 },
                game2: { team1: g2p1, team2: g2p2 },
                game3: { team1: g3p1, team2: g3p2 },
                final: { team1: finalTeam1, team2: finalTeam2 },
              },
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              meta: {
                matchId: String(m.matchId || `G${key}`),
                groupId: groupId,
                matchKey: key,
                mdPlayersTeam1: Array.isArray(m?.mdPlayersTeam1) ? m.mdPlayersTeam1 : undefined,
                mdPlayersTeam2: Array.isArray(m?.mdPlayersTeam2) ? m.mdPlayersTeam2 : undefined,
                wdPlayersTeam1: Array.isArray(m?.wdPlayersTeam1) ? m.wdPlayersTeam1 : undefined,
                wdPlayersTeam2: Array.isArray(m?.wdPlayersTeam2) ? m.wdPlayersTeam2 : undefined,
                xdPlayersTeam1: Array.isArray(m?.xdPlayersTeam1) ? m.xdPlayersTeam1 : undefined,
                xdPlayersTeam2: Array.isArray(m?.xdPlayersTeam2) ? m.xdPlayersTeam2 : undefined,
                teamMemberIdsTeam1: team1Members.length ? team1Members : undefined,
                teamMemberIdsTeam2: team2Members.length ? team2Members : undefined,
                ...pickTeamGamePlayers(m),
              },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
            __normMatchUpserts += 1;
            continue;
          }
          const finals = [m.mdScores?.final, m.wdScores?.final, m.xdScores?.final].filter(Boolean);
          let sum1 = 0, sum2 = 0;
          for (const f of finals) {
            sum1 += Number(f?.team1 || 0);
            sum2 += Number(f?.team2 || 0);
          }
          const filter = { tournamentId: id, categoryId, round: roundTag, team1Id: t1, team2Id: t2 };
          let team1Members = [];
          let team2Members = [];
          try {
            const Team = require("../models/Team");
            const tdoc1 = await Team.findById(t1).select("playerIds").lean();
            const tdoc2 = await Team.findById(t2).select("playerIds").lean();
            team1Members = Array.isArray(tdoc1?.playerIds) ? tdoc1.playerIds.map(String) : [];
            team2Members = Array.isArray(tdoc2?.playerIds) ? tdoc2.playerIds.map(String) : [];
          } catch (_) {}
          const g1p1 = Number(m.game1Player1 || m.mdScores?.final?.team1 || 0);
          const g1p2 = Number(m.game1Player2 || m.mdScores?.final?.team2 || 0);
          const g2p1 = Number(m.game2Player1 || m.wdScores?.final?.team1 || 0);
          const g2p2 = Number(m.game2Player2 || m.wdScores?.final?.team2 || 0);
          const g3p1 = Number(m.game3Player1 || m.xdScores?.final?.team1 || 0);
          const g3p2 = Number(m.game3Player2 || m.xdScores?.final?.team2 || 0);
          const fs1Raw = Number(m.finalScorePlayer1 || 0);
          const fs2Raw = Number(m.finalScorePlayer2 || 0);
          const hasFs = (fs1Raw + fs2Raw) > 0;
          const winsFromEvents = (() => {
            let a = 0, b = 0;
            const finals = [
              { a: g1p1, b: g1p2 },
              { a: g2p1, b: g2p2 },
              { a: g3p1, b: g3p2 },
            ];
            for (const f of finals) {
              if ((f.a + f.b) === 0) continue;
              if (f.a > f.b) a += 1; else if (f.b > f.a) b += 1;
            }
            return { a, b };
          })();
          const finalTeam1 = hasFs ? fs1Raw : winsFromEvents.a;
          const finalTeam2 = hasFs ? fs2Raw : winsFromEvents.b;
          const baseStatus2 = String(m.status || "").trim();
          const anyScorePlayed2 = (g1p1 + g1p2 + g2p1 + g2p2 + g3p1 + g3p2 + finalTeam1 + finalTeam2) > 0;
          const statusOut2 = baseStatus2.toLowerCase() === 'completed' ? 'Completed'
            : (anyScorePlayed2 ? 'Completed' : (baseStatus2 || "Unscheduled"));
          const doc = {
            tournamentId: id,
            categoryId,
            round: roundTag,
            stage: "group",
            groupId: groupId,
            matchKey: key,
            gamesPerMatch: Number(cat?.gamesPerMatch || 1),
            team1Id: t1,
            team2Id: t2,
            team1Members: team1Members.length ? team1Members : undefined,
            team2Members: team2Members.length ? team2Members : undefined,
            status: statusOut2,
            scores: {
              game1: { team1: g1p1, team2: g1p2 },
              game2: { team1: g2p1, team2: g2p2 },
              game3: { team1: g3p1, team2: g3p2 },
              final: { team1: finalTeam1, team2: finalTeam2 },
            },
            date: m.date || undefined,
            time: m.time || undefined,
            court: m.court || undefined,
            meta: {
              matchId: String(m.matchId || `G${key}`),
              groupId: groupId,
              matchKey: key,
            mdPlayersTeam1: Array.isArray(m?.mdPlayersTeam1) ? m.mdPlayersTeam1 : undefined,
            mdPlayersTeam2: Array.isArray(m?.mdPlayersTeam2) ? m.mdPlayersTeam2 : undefined,
            wdPlayersTeam1: Array.isArray(m?.wdPlayersTeam1) ? m.wdPlayersTeam1 : undefined,
            wdPlayersTeam2: Array.isArray(m?.wdPlayersTeam2) ? m.wdPlayersTeam2 : undefined,
            xdPlayersTeam1: Array.isArray(m?.xdPlayersTeam1) ? m.xdPlayersTeam1 : undefined,
            xdPlayersTeam2: Array.isArray(m?.xdPlayersTeam2) ? m.xdPlayersTeam2 : undefined,
              teamMemberIdsTeam1: undefined,
              teamMemberIdsTeam2: undefined,
            },
          };
          await Match.updateOne(filter, { $set: doc }, { upsert: true });
          __normMatchUpserts += 1;
        } else {
          const p1 = makeId(m.player1Id || m.player1);
          const p2 = makeId(m.player2Id || m.player2);
          if (!p1 || !p2) {
            const name1 = String(m.player1Name || m.player1 || '').trim();
            const name2 = String(m.player2Name || m.player2 || '').trim();
            const metaFilter = { tournamentId: id, categoryId, round: roundTag, "meta.groupId": groupId, "meta.matchKey": key };
            const nameFilter = { tournamentId: id, categoryId, round: roundTag, player1Name: name1 || undefined, player2Name: name2 || undefined };
            const filter = { $or: [ metaFilter, nameFilter ] };
            const g1p1 = Number(m.game1Player1 || 0), g1p2 = Number(m.game1Player2 || 0);
            const g2p1 = Number(m.game2Player1 || 0), g2p2 = Number(m.game2Player2 || 0);
            const g3p1 = Number(m.game3Player1 || 0), g3p2 = Number(m.game3Player2 || 0);
            const fs1 = Number(m.finalScorePlayer1 || 0), fs2 = Number(m.finalScorePlayer2 || 0);
            const anyScore = (g1p1+g1p2+g2p1+g2p2+g3p1+g3p2+fs1+fs2) > 0;
            const statusOut = String(m.status || "").trim().toLowerCase() === 'completed' ? 'Completed'
              : (anyScore ? 'Completed' : (String(m.status || "").trim() || "Unscheduled"));
            const doc = {
              tournamentId: id,
              categoryId,
              round: roundTag,
              stage: "group",
              groupId: groupId,
              matchKey: key,
              gamesPerMatch: Number(cat?.gamesPerMatch || 1),
              player1Name: name1 || undefined,
              player2Name: name2 || undefined,
              status: statusOut,
              scores: {
                game1: { team1: g1p1, team2: g1p2 },
                game2: { team1: g2p1, team2: g2p2 },
                game3: { team1: g3p1, team2: g3p2 },
                final: { team1: fs1, team2: fs2 },
              },
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
            __normMatchUpserts += 1;
          } else {
            const filter = { tournamentId: id, categoryId, round: roundTag, player1Id: p1, player2Id: p2 };
            const g1p1 = Number(m.game1Player1 || 0), g1p2 = Number(m.game1Player2 || 0);
            const g2p1 = Number(m.game2Player1 || 0), g2p2 = Number(m.game2Player2 || 0);
            const g3p1 = Number(m.game3Player1 || 0), g3p2 = Number(m.game3Player2 || 0);
            const fs1 = Number(m.finalScorePlayer1 || 0), fs2 = Number(m.finalScorePlayer2 || 0);
            const anyScore = (g1p1+g1p2+g2p1+g2p2+g3p1+g3p2+fs1+fs2) > 0;
            const statusOut = String(m.status || "").trim().toLowerCase() === 'completed' ? 'Completed'
              : (anyScore ? 'Completed' : (String(m.status || "").trim() || "Unscheduled"));
            const doc = {
              tournamentId: id,
              categoryId,
              round: roundTag,
              stage: "group",
              groupId: groupId,
              matchKey: key,
              gamesPerMatch: Number(cat?.gamesPerMatch || 1),
              player1Id: p1,
              player2Id: p2,
              player1Name: String(m.player1Name || "").trim() || undefined,
              player2Name: String(m.player2Name || "").trim() || undefined,
              status: statusOut,
              scores: {
                game1: { team1: g1p1, team2: g1p2 },
                game2: { team1: g2p1, team2: g2p2 },
                game3: { team1: g3p1, team2: g3p2 },
                final: { team1: fs1, team2: fs2 },
              },
              date: m.date || undefined,
              time: m.time || undefined,
              court: m.court || undefined,
              meta: { matchId: String(m.matchId || `G${key}`), groupId: groupId, matchKey: key },
            };
            await Match.updateOne(filter, { $set: doc }, { upsert: true });
            __normMatchUpserts += 1;
          }
        }
      }
    } catch (_) {}
    // Upsert normalized Standings from computed standings
    let __normStandingUpserts = 0;
    try {
      const Standing = require("../models/Standing");
      const Team = require("../models/Team");
      const makeId = (val) => {
        const s = String(val || "").trim();
        return /^[a-f0-9]{24}$/i.test(s) ? s : undefined;
      };
      const arr = Array.isArray(computed) ? computed : [];
      for (const s of arr) {
        const pid = makeId(s.player);
        let filter;
        let doc;
        if (pid) {
          filter = { tournamentId: id, categoryId, playerId: pid };
          doc = {
            tournamentId: id,
            categoryId,
            playerId: pid,
            wins: s.wins,
            losses: s.losses,
            pointsFor: s.pointsFor,
            pointsAgainst: s.pointsAgainst,
            pointDifferential: s.pointDifferential,
            rankPoints: s.rankPoints,
            meta: { playerKey: String(s.player) },
          };
        } else {
          let maybeTeam = null;
          try { maybeTeam = await Team.findById(s.player).lean(); } catch (_) {}
          if (maybeTeam && maybeTeam._id) {
            filter = { tournamentId: id, categoryId, teamId: String(maybeTeam._id) };
            doc = {
              tournamentId: id,
              categoryId,
              teamId: String(maybeTeam._id),
              teamName: maybeTeam.teamName || undefined,
              wins: s.wins,
              losses: s.losses,
              pointsFor: s.pointsFor,
              pointsAgainst: s.pointsAgainst,
              pointDifferential: s.pointDifferential,
              rankPoints: s.rankPoints,
              meta: { playerKey: String(s.player), teamMemberIds: Array.isArray(maybeTeam.playerIds) ? maybeTeam.playerIds.map((x) => String(x)) : undefined },
            };
          } else {
            filter = { tournamentId: id, categoryId, "meta.playerKey": String(s.player) };
            doc = {
              tournamentId: id,
              categoryId,
              displayName: String(s.player),
              wins: s.wins,
              losses: s.losses,
              pointsFor: s.pointsFor,
              pointsAgainst: s.pointsAgainst,
              pointDifferential: s.pointDifferential,
              rankPoints: s.rankPoints,
              meta: { playerKey: String(s.player) },
            };
          }
        }
        await Standing.updateOne(filter, { $set: doc }, { upsert: true });
        __normStandingUpserts += 1;
      }
      // In prune mode, remove normalized standings for participants not present anymore
      try {
        if (PRUNE_MISSING) {
          const presentMetaKeys = arr.map((s) => String(s.player || "")).filter((x) => x);
          const presentPlayerIds = arr
            .map((s) => makeId(s.player))
            .filter((x) => x);
          const presentTeamIds = [];
          for (const s of arr) {
            const tid = makeId(s.player);
            if (tid) {
              try {
                const tdoc = await Team.findById(tid).select("_id").lean();
                if (tdoc && tdoc._id) presentTeamIds.push(String(tdoc._id));
              } catch (_) {}
            }
          }
          await Standing.deleteMany({
            tournamentId: id,
            categoryId,
            $and: [
              { $or: [
                { playerId: { $exists: true } },
                { teamId: { $exists: true } },
                { "meta.playerKey": { $exists: true } },
              ]},
              { $nor: [
                { playerId: { $in: presentPlayerIds } },
                { teamId: { $in: presentTeamIds } },
                { "meta.playerKey": { $in: presentMetaKeys } },
              ]},
            ],
          });
        }
      } catch (_) {}
    } catch (_) {}
    try {
      if (auditEntries.length) {
        const TournamentAuditLog = require("../models/TournamentAuditLog");
        await TournamentAuditLog.insertMany(auditEntries, { ordered: false });
      }
    } catch (_) {}
    res.json({ ok: true, standings: computed, normalized: { matches: __normMatchUpserts, standings: __normStandingUpserts } });
  } catch (error) {
    console.error('Error updating group matches:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

exports.updateEliminationMatches = async (req, res) => {
  try {
    const { id, categoryId } = req.params;
    const { matches } = req.body || {};
    const replaceRaw =
      String(req.query?.replace || req.body?.replace || "")
        .trim()
        .toLowerCase();
    const REPLACE_ALL = replaceRaw === "true" || replaceRaw === "1";
    const duprMetaOnlyRaw =
      String(req.query?.duprMetaOnly || req.body?.duprMetaOnly || "")
        .trim()
        .toLowerCase();
    const DUPR_META_ONLY = duprMetaOnlyRaw === "true" || duprMetaOnlyRaw === "1";

    const tournament = await Tournament.findById(id);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });

    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin") || roles.includes("referee");
    const isAdmin = roles.includes("superadmin") || roles.includes("clubadmin");
    const forceResultEditRaw =
      String(req.query?.forceResultEdit || req.body?.forceResultEdit || "")
        .trim()
        .toLowerCase();
    const FORCE_RESULT_EDIT =
      isAdmin && (forceResultEditRaw === "true" || forceResultEditRaw === "1");
    const adminCorrectionModeRaw =
      String(req.query?.adminCorrectionMode || req.body?.adminCorrectionMode || "")
        .trim()
        .toLowerCase();
    const adminCorrectionMode =
      isAdmin && (adminCorrectionModeRaw === "true" || adminCorrectionModeRaw === "1");
    const correctionReason = String(req.body?.reason || req.body?.correctionReason || "").trim();
    if (!isPrivileged && !hasAccessToTournament(tournament, req.user?.id)) {
      return res.status(403).json({ message: "Access denied" });
    }

    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const catIndex = categories.findIndex((c) => String(c?._id) === String(categoryId));
    if (catIndex < 0) return res.status(404).json({ message: "Category not found" });
    const cat = tournament.tournamentCategories[catIndex];
    if (cat.locked || cat.pointsSubmitted) {
      return res.status(409).json({ message: "Category is locked or points already submitted" });
    }

    if (!cat.eliminationMatches) cat.eliminationMatches = { matches: [] };
    const existingArr = Array.isArray(cat?.eliminationMatches?.matches) ? cat.eliminationMatches.matches : [];
    const existing = existingArr.map((m) => {
      try { return (m && typeof m.toObject === "function") ? m.toObject() : (m || {}); } catch { return m || {}; }
    });

    const isDuprField = (field) => {
      const f = String(field || "");
      if (!f) return false;
      if (f === "duprGames") return true;
      return f.startsWith("dupr");
    };
    const hasSubmittedToDupr = (m) => {
      try {
        const mm = (m && typeof m === "object") ? m : {};
        if (Boolean(mm.duprMatchCode) && !Boolean(mm.duprDeletedUpstream)) return true;
        const g = mm.duprGames && typeof mm.duprGames === "object" ? mm.duprGames : {};
        return Object.keys(g).some((k) => {
          const info = g[k] || {};
          const code = String(info?.matchCode || "").trim();
          const deleted = Boolean(info?.deletedUpstream || mm.duprDeletedUpstream);
          return Boolean(code) && !deleted;
        });
      } catch {
        return false;
      }
    };
    const scoreFields = new Set([
      "game1Player1",
      "game1Player2",
      "game2Player1",
      "game2Player2",
      "game3Player1",
      "game3Player2",
      "finalScorePlayer1",
      "finalScorePlayer2",
      "mdScores",
      "wdScores",
      "xdScores",
    ]);
    const participantFields = new Set([
      "player1",
      "player2",
      "player1Name",
      "player2Name",
      "team1Id",
      "team2Id",
      "team1Members",
      "team2Members",
      "team1Name",
      "team2Name",
    ]);
    const hasAnyScores = (mm) => {
      try {
        const m = (mm && typeof mm === "object") ? mm : {};
        const nums = [
          m.game1Player1, m.game1Player2,
          m.game2Player1, m.game2Player2,
          m.game3Player1, m.game3Player2,
          m.finalScorePlayer1, m.finalScorePlayer2,
        ].map((x) => Number(x) || 0);
        if (nums.some((n) => n > 0)) return true;
        const s = m.scores || {};
        const games = [s.game1, s.game2, s.game3, s.final].filter(Boolean);
        if (games.some((g) => (Number(g?.team1) || 0) > 0 || (Number(g?.team2) || 0) > 0)) return true;
        return false;
      } catch {
        return false;
      }
    };
    const auditEntries = [];
    const auditActorId = req.user?._id || req.user?.id || null;
    const auditSnapshot = (m) => {
      const mm = (m && typeof m === "object") ? m : {};
      return {
        status: mm.status,
        date: mm.date,
        time: mm.time,
        court: mm.court,
        venue: mm.venue,
        player1: mm.player1,
        player2: mm.player2,
        player1Name: mm.player1Name,
        player2Name: mm.player2Name,
        team1Id: mm.team1Id,
        team2Id: mm.team2Id,
        team1Members: mm.team1Members,
        team2Members: mm.team2Members,
        team1Name: mm.team1Name,
        team2Name: mm.team2Name,
        game1Player1: mm.game1Player1,
        game1Player2: mm.game1Player2,
        game2Player1: mm.game2Player1,
        game2Player2: mm.game2Player2,
        game3Player1: mm.game3Player1,
        game3Player2: mm.game3Player2,
        finalScorePlayer1: mm.finalScorePlayer1,
        finalScorePlayer2: mm.finalScorePlayer2,
        mdScores: mm.mdScores,
        wdScores: mm.wdScores,
        xdScores: mm.xdScores,
        duprMatchCode: mm.duprMatchCode,
        duprIdentifier: mm.duprIdentifier,
        duprDeletedUpstream: mm.duprDeletedUpstream,
        duprDeletedAt: mm.duprDeletedAt,
        duprNeedsUpdate: mm.duprNeedsUpdate,
        duprScoreSig: mm.duprScoreSig,
        duprNeedsCorrection: mm.duprNeedsCorrection,
        duprCorrectionSeq: mm.duprCorrectionSeq,
        duprCorrectionReason: mm.duprCorrectionReason,
        duprGames: mm.duprGames,
        meta: mm.meta,
        round: mm.round,
      };
    };
    const computeChangedFields = (before, after) => {
      const b = auditSnapshot(before);
      const a = auditSnapshot(after);
      const keys = Array.from(new Set(Object.keys(b).concat(Object.keys(a))));
      const changed = [];
      keys.forEach((k) => {
        const bv = b[k];
        const av = a[k];
        if (k === "duprGames" || k === "mdScores" || k === "wdScores" || k === "xdScores" || k === "meta") {
          if (JSON.stringify(bv || null) !== JSON.stringify(av || null)) changed.push(k);
          return;
        }
        if (String(bv ?? "") !== String(av ?? "")) changed.push(k);
      });
      return { before: b, after: a, changed };
    };
    const mergeOne = (base, incoming) => {
      const out = { ...(base || {}) };
      const inc = (incoming && typeof incoming === "object") ? incoming : {};
      const baseLower = String(out?.status || "").trim().toLowerCase();
      const RESULT_LOCKED = (() => {
        try {
          if (hasSubmittedToDupr(out)) return true;
          if (baseLower !== "completed") return false;
          if (out?.team1Id && out?.team2Id) return true;
          const toNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
          const gpmEff = Math.min(Math.max(Number(cat?.gamesPerMatch ?? 3), 1), 3);
          const setsToWin = Math.ceil(gpmEff / 2);
          const sets = [
            [toNum(out?.game1Player1), toNum(out?.game1Player2)],
            [toNum(out?.game2Player1), toNum(out?.game2Player2)],
            [toNum(out?.game3Player1), toNum(out?.game3Player2)],
          ].slice(0, gpmEff);
          let w1 = 0;
          let w2 = 0;
          sets.forEach(([a, b]) => {
            if ((a + b) <= 0) return;
            if (a > b) w1 += 1;
            else if (b > a) w2 += 1;
          });
          return w1 >= setsToWin || w2 >= setsToWin;
        } catch {
          return true;
        }
      })();
      Object.keys(inc).forEach((k) => {
        const v = inc[k];
        if (v === undefined || v === null) return;
        if (typeof v === "string" && v.trim() === "") return;
        if (DUPR_META_ONLY && !isDuprField(k)) return;
        if (RESULT_LOCKED && !FORCE_RESULT_EDIT && scoreFields.has(k)) return;
        if (!DUPR_META_ONLY && RESULT_LOCKED && !FORCE_RESULT_EDIT && isDuprField(k)) return;
        if (!DUPR_META_ONLY && hasAnyScores(base) && participantFields.has(k) && !adminCorrectionMode) return;
        out[k] = v;
      });
      if (RESULT_LOCKED && !FORCE_RESULT_EDIT) {
        try {
          scoreFields.forEach((f) => {
            if (Object.prototype.hasOwnProperty.call(base || {}, f)) out[f] = (base || {})[f];
          });
          if (!DUPR_META_ONLY) {
            Object.keys(base || {}).forEach((f) => {
              if (!isDuprField(f)) return;
              out[f] = (base || {})[f];
            });
          }
          if (String(baseLower) === "completed") out.status = (base || {}).status;
        } catch (_) {}
      }
      return out;
    };

    let next = REPLACE_ALL ? [] : existing.slice();

    if (Array.isArray(matches)) {
      const max = Math.max(existing.length, matches.length);
      for (let i = 0; i < max; i++) {
        const inc = matches[i];
        if (inc === undefined || inc === null) {
          if (!REPLACE_ALL && existing[i] !== undefined) next[i] = existing[i];
          continue;
        }
        const base = existing[i] || {};
        const duprLocked = hasSubmittedToDupr(base);
        const wantsNonDupr = Object.keys(inc || {}).some((k) => !isDuprField(k));
        const wantsScore = Object.keys(inc || {}).some((k) => scoreFields.has(k));
        const wantsParticipant = Object.keys(inc || {}).some((k) => participantFields.has(k));
        if (duprLocked && !DUPR_META_ONLY && (wantsNonDupr || wantsScore || wantsParticipant)) {
          return res.status(409).json({ message: "DUPR Lock: delete/void the DUPR match first before editing participants or scores.", lockType: "dupr" });
        }
        if ((wantsScore || wantsParticipant) && adminCorrectionMode && !correctionReason) {
          return res.status(400).json({ message: "Missing reason for Admin Correction Mode" });
        }
        if (wantsParticipant && hasAnyScores(base) && !adminCorrectionMode) {
          return res.status(409).json({ message: "Participant Lock: scores already exist. Enable Admin Correction Mode and provide a reason to proceed.", lockType: "participant" });
        }
        next[i] = mergeOne(existing[i] || {}, inc || {});
        try {
          const { before, after, changed } = computeChangedFields(base, next[i] || {});
          if (changed.length) {
            const wantsParticipantChange = !DUPR_META_ONLY && Object.keys(inc || {}).some((k) => participantFields.has(k));
            const wantsScoreChange = !DUPR_META_ONLY && Object.keys(inc || {}).some((k) => scoreFields.has(k));
            const action = DUPR_META_ONLY
              ? "match_dupr_meta_update"
              : wantsParticipantChange
                ? (adminCorrectionMode ? "match_participants_update_admin_correction" : "match_participants_update")
                : wantsScoreChange
                  ? (adminCorrectionMode ? "match_score_update_admin_correction" : "match_score_update")
                  : "match_update";
            auditEntries.push({
              tournamentId: tournament._id,
              entityType: "match",
              entityId: `elim:${String(categoryId)}:${i}`,
              action,
              actorId: auditActorId,
              actorRoles: roles,
              reason: adminCorrectionMode ? correctionReason : "",
              before,
              after,
              meta: { stage: "elimination", categoryId: String(categoryId), matchKey: `e-${i}`, index: i, changedFields: changed, duprMetaOnly: DUPR_META_ONLY ? 1 : 0 },
            });
          }
        } catch (_) {}
      }
    } else if (matches && typeof matches === "object") {
      Object.keys(matches).forEach((k) => {
        const m = matches[k];
        const s = String(k || "").trim();
        const idxStr = s.startsWith("e-") ? s.slice(2) : s;
        const idx = parseInt(idxStr, 10);
        if (!Number.isFinite(idx) || idx < 0) return;
        const base = existing[idx] || {};
        const duprLocked = hasSubmittedToDupr(base);
        const wantsNonDupr = Object.keys(m || {}).some((kk) => !isDuprField(kk));
        const wantsScore = Object.keys(m || {}).some((kk) => scoreFields.has(kk));
        const wantsParticipant = Object.keys(m || {}).some((kk) => participantFields.has(kk));
        if (duprLocked && !DUPR_META_ONLY && (wantsNonDupr || wantsScore || wantsParticipant)) {
          throw Object.assign(new Error("DUPR Lock: delete/void the DUPR match first before editing participants or scores."), { status: 409, lockType: "dupr" });
        }
        if ((wantsScore || wantsParticipant) && adminCorrectionMode && !correctionReason) {
          throw Object.assign(new Error("Missing reason for Admin Correction Mode"), { status: 400 });
        }
        if (wantsParticipant && hasAnyScores(base) && !adminCorrectionMode) {
          throw Object.assign(new Error("Participant Lock: scores already exist. Enable Admin Correction Mode and provide a reason to proceed."), { status: 409, lockType: "participant" });
        }
        next[idx] = mergeOne(existing[idx] || {}, m || {});
        try {
          const { before, after, changed } = computeChangedFields(base, next[idx] || {});
          if (changed.length) {
            const wantsParticipantChange = !DUPR_META_ONLY && Object.keys(m || {}).some((kk) => participantFields.has(kk));
            const wantsScoreChange = !DUPR_META_ONLY && Object.keys(m || {}).some((kk) => scoreFields.has(kk));
            const action = DUPR_META_ONLY
              ? "match_dupr_meta_update"
              : wantsParticipantChange
                ? (adminCorrectionMode ? "match_participants_update_admin_correction" : "match_participants_update")
                : wantsScoreChange
                  ? (adminCorrectionMode ? "match_score_update_admin_correction" : "match_score_update")
                  : "match_update";
            auditEntries.push({
              tournamentId: tournament._id,
              entityType: "match",
              entityId: `elim:${String(categoryId)}:${idx}`,
              action,
              actorId: auditActorId,
              actorRoles: roles,
              reason: adminCorrectionMode ? correctionReason : "",
              before,
              after,
              meta: { stage: "elimination", categoryId: String(categoryId), matchKey: `e-${idx}`, index: idx, changedFields: changed, duprMetaOnly: DUPR_META_ONLY ? 1 : 0 },
            });
          }
        } catch (_) {}
      });
    } else {
      return res.status(400).json({ message: "matches is required" });
    }

    try {
      if (DUPR_META_ONLY) {
        const outArr = Array.isArray(next) ? next : [];
        outArr.forEach((m) => {
          const g = m?.duprGames && typeof m.duprGames === "object" ? m.duprGames : {};
          const hasActiveCode =
            Boolean(String(m?.duprMatchCode || "").trim()) ||
            Object.keys(g).some((kk) => {
              const info = g[kk] || {};
              const code = String(info?.matchCode || "").trim();
              const deleted = Boolean(info?.deletedUpstream || m?.duprDeletedUpstream);
              return Boolean(code) && !deleted;
            });
          if (hasActiveCode && m?.duprNeedsCorrection) {
            delete m.duprNeedsCorrection;
          }
        });
        next = outArr;
      }
    } catch (_) {}

    cat.eliminationMatches.matches = next;
    try { tournament.markModified(`tournamentCategories.${catIndex}.eliminationMatches.matches`); } catch (_) {}
    try { tournament.markModified("tournamentCategories"); } catch (_) {}
    await tournament.save();
    try {
      if (auditEntries.length) {
        const TournamentAuditLog = require("../models/TournamentAuditLog");
        await TournamentAuditLog.insertMany(auditEntries, { ordered: false });
      }
    } catch (_) {}
    return res.json({ ok: true, matches: next });
  } catch (error) {
    console.error("Error updating elimination matches:", error);
    if (error?.status) {
      return res.status(Number(error.status) || 409).json({ message: error.message || "Locked", lockType: error.lockType || undefined });
    }
    return res.status(500).json({ message: "Server error" });
  }
};

// ✅ Upsert a single normalized group match and mirror into embedded group state
exports.upsertNormalizedGroupMatch = async (req, res) => {
  try {
    const { id, categoryId, groupId, matchKey } = req.params;
    const body = req.body || {};
    const Tournament = require("../models/Tournament");
    const Match = require("../models/Match");
    const tournament = await Tournament.findById(id);
    if (!tournament) return res.status(404).json({ message: "Tournament not found" });
    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin") || roles.includes("referee");
    if (!isPrivileged && !hasAccessToTournament(tournament, req.user?.id)) {
      return res.status(403).json({ message: "Access denied" });
    }
    const categories = Array.isArray(tournament.tournamentCategories) ? tournament.tournamentCategories : [];
    const catIndex = categories.findIndex((c) => String(c?._id) === String(categoryId));
    if (catIndex < 0) return res.status(404).json({ message: "Category not found" });
    const cat = tournament.tournamentCategories[catIndex];
    const groups = (cat.groupStage && Array.isArray(cat.groupStage.groups)) ? cat.groupStage.groups : [];
    const groupIndex = groups.findIndex((g) => String(g.id) === String(groupId));
    if (groupIndex < 0) return res.status(404).json({ message: "Group not found" });
    const group = cat.groupStage.groups[groupIndex];
    const isAdmin = roles.includes("superadmin") || roles.includes("clubadmin");
    const isTournamentStaff = (() => {
      try {
        if (isAdmin) return true;
        return hasAccessToTournament(tournament, req.user);
      } catch {
        return false;
      }
    })();
    const adminCorrectionModeRaw =
      String(req.query?.adminCorrectionMode || req.body?.adminCorrectionMode || "")
        .trim()
        .toLowerCase();
    const adminCorrectionMode =
      isTournamentStaff && (adminCorrectionModeRaw === "true" || adminCorrectionModeRaw === "1");
    const correctionReason = String(req.body?.reason || req.body?.correctionReason || "").trim();
    const hasDupr = (m) => {
      try {
        const mm = (m && typeof m === "object") ? m : {};
        if (Boolean(mm.duprMatchCode) && !Boolean(mm.duprDeletedUpstream)) return true;
        const g = mm.duprGames && typeof mm.duprGames === "object" ? mm.duprGames : {};
        return Object.keys(g).some((k) => {
          const info = g[k] || {};
          const code = String(info?.matchCode || "").trim();
          const deleted = Boolean(info?.deletedUpstream || mm.duprDeletedUpstream);
          return Boolean(code) && !deleted;
        });
      } catch {
        return false;
      }
    };
    const hasAnyScores = (mm) => {
      try {
        const m = (mm && typeof mm === "object") ? mm : {};
        const nums = [
          m.game1Player1, m.game1Player2,
          m.game2Player1, m.game2Player2,
          m.game3Player1, m.game3Player2,
          m.finalScorePlayer1, m.finalScorePlayer2,
        ].map((x) => Number(x) || 0);
        return nums.some((n) => n > 0);
      } catch {
        return false;
      }
    };
    const participantFields = new Set([
      "player1",
      "player2",
      "player1Name",
      "player2Name",
      "team1Id",
      "team2Id",
      "team1Members",
      "team2Members",
      "team1Name",
      "team2Name",
    ]);
    const scoreFields = new Set([
      "game1Player1",
      "game1Player2",
      "game2Player1",
      "game2Player2",
      "game3Player1",
      "game3Player2",
      "finalScorePlayer1",
      "finalScorePlayer2",
      "mdScores",
      "wdScores",
      "xdScores",
    ]);
    const baseEmbedded = (group?.matches && typeof group.matches === "object") ? (group.matches[matchKey] || {}) : {};
    const normalizeParticipantValue = (value) => {
      if (Array.isArray(value)) return JSON.stringify(value.map((item) => String(item ?? "").trim()));
      return String(value ?? "").trim();
    };
    const hasParticipantFieldChange = (nextValue, prevValue) =>
      Object.keys(nextValue || {}).some((k) =>
        participantFields.has(k) &&
        normalizeParticipantValue(nextValue?.[k]) !== normalizeParticipantValue(prevValue?.[k])
      );
    const wantsParticipantChange = hasParticipantFieldChange(body, baseEmbedded);
    const wantsScoreChange = Object.keys(body || {}).some((k) => scoreFields.has(k));
    if (hasDupr(baseEmbedded) && (wantsParticipantChange || wantsScoreChange)) {
      return res.status(409).json({ message: "DUPR Lock: delete/void the DUPR match first before editing participants or scores.", lockType: "dupr" });
    }
    if ((wantsParticipantChange || wantsScoreChange) && adminCorrectionMode && !correctionReason) {
      return res.status(400).json({ message: "Missing reason for Admin Correction Mode" });
    }
    if (wantsParticipantChange && hasAnyScores(baseEmbedded) && !adminCorrectionMode) {
      return res.status(409).json({ message: "Participant Lock: scores already exist. Enable Admin Correction Mode and provide a reason to proceed.", lockType: "participant" });
    }
    const asNum = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
    const gpmEff = Math.min(Math.max(Number(cat?.gamesPerMatch ?? 3), 1), 3);
    const g1p1 = asNum(body.game1Player1);
    const g1p2 = asNum(body.game1Player2);
    const g2p1 = asNum(body.game2Player1);
    const g2p2 = asNum(body.game2Player2);
    const g3p1 = asNum(body.game3Player1);
    const g3p2 = asNum(body.game3Player2);
    const sets = [[g1p1,g1p2],[g2p1,g2p2],[g3p1,g3p2]].slice(0, gpmEff);
    const fs1 = asNum(body.finalScorePlayer1);
    const fs2 = asNum(body.finalScorePlayer2);
    const hasFs = (fs1 + fs2) > 0;
    let w1 = 0, w2 = 0;
    if (!hasFs) {
      sets.forEach(([a,b]) => { if ((a+b)>0) { if (a>b) w1++; else if (b>a) w2++; } });
    } else {
      w1 = fs1; w2 = fs2;
    }
    const anyPoints = sets.some(([a,b]) => (a+b) > 0) || (w1 + w2) > 0;
    const dateOut = String(body.date ?? baseEmbedded?.date ?? baseEmbedded?.mdDate ?? "").trim();
    const timeOut = String(body.time ?? baseEmbedded?.time ?? baseEmbedded?.mdTime ?? "").trim();
    const courtOut = String(body.court ?? baseEmbedded?.court ?? "").trim();
    const venueOut = String(body.venue ?? baseEmbedded?.venue ?? "").trim();
    const hasScheduleFields = Boolean(dateOut && timeOut && courtOut);
    const roundTag = (() => {
      const nm = String(group?.name || '').trim();
      if (nm) return nm;
      try {
        const letter = String(groupId || '').split('-').pop().toUpperCase();
        if (letter) return `Group ${letter}`;
      } catch {}
      return `G${groupId}`;
    })();
    const matchId = String(body.matchId || `G${matchKey}`);
    const statusRaw = String(body.status || "").trim();
    const statusLow = statusRaw.toLowerCase();
    const statusOut = (() => {
      if (statusLow === "completed") return "Completed";
      if (statusLow === "ongoing") return "Ongoing";
      if (statusLow === "scheduled") return "Scheduled";
      if (statusLow === "unschedule" || statusLow === "unscheduled") return "Unschedule";
      if (w1 > 0 || w2 > 0) return "Completed";
      if (anyPoints) return "Ongoing";
      if (hasScheduleFields) return "Scheduled";
      return "Unschedule";
    })();
    const player1Name = String(body.player1Name || body.player1 || "").trim();
    const player2Name = String(body.player2Name || body.player2 || "").trim();
    const teamGamePlayers = pickTeamGamePlayers(body);
    const filter = { tournamentId: id, categoryId, round: roundTag, "meta.groupId": groupId, "meta.matchKey": matchKey };
    const doc = {
      tournamentId: id,
      categoryId,
      round: roundTag,
      stage: "group",
      groupId,
      matchKey,
      gamesPerMatch: gpmEff,
      player1Name: player1Name || undefined,
      player2Name: player2Name || undefined,
      status: statusOut,
      scores: {
        game1: { team1: g1p1, team2: g1p2 },
        game2: { team1: g2p1, team2: g2p2 },
        game3: { team1: g3p1, team2: g3p2 },
        final: { team1: w1, team2: w2 },
      },
      date: dateOut || undefined,
      time: timeOut || undefined,
      court: courtOut || undefined,
      venue: venueOut || undefined,
      meta: { matchId, groupId, matchKey, ...teamGamePlayers },
    };
    await Match.updateOne(filter, { $set: doc }, { upsert: true });
    // Mirror into embedded group state for immediate UI consistency
    let embeddedUpdated = false;
    let embeddedMatch = null;
    const mm = group.matches && typeof group.matches === "object" ? group.matches : {};
    const base = mm[matchKey] || {};
    try {
      const merged = {
        ...base,
        player1: player1Name || base.player1,
        player2: player2Name || base.player2,
        player1Name: player1Name || base.player1Name || player1Name,
        player2Name: player2Name || base.player2Name || player2Name,
        game1Player1: g1p1,
        game1Player2: g1p2,
        game2Player1: g2p1,
        game2Player2: g2p2,
        game3Player1: g3p1,
        game3Player2: g3p2,
        finalScorePlayer1: w1,
        finalScorePlayer2: w2,
        date: dateOut,
        mdDate: dateOut,
        time: timeOut,
        mdTime: timeOut,
        court: courtOut,
        venue: venueOut,
        status: statusOut,
        matchId,
        ...teamGamePlayers,
      };
      try {
        const computeSig = (mm) => {
          const a1 = asNum(mm?.game1Player1), b1 = asNum(mm?.game1Player2);
          const a2 = asNum(mm?.game2Player1), b2 = asNum(mm?.game2Player2);
          const a3 = asNum(mm?.game3Player1), b3 = asNum(mm?.game3Player2);
          const parts = [];
          if ((a1 + b1) > 0) parts.push(`g1:${a1}-${b1}`);
          if ((a2 + b2) > 0) parts.push(`g2:${a2}-${b2}`);
          if ((a3 + b3) > 0) parts.push(`g3:${a3}-${b3}`);
          return parts.join("|");
        };
        const prev = base || {};
        const newSig = computeSig(merged);
        const oldSigStored = String(prev.duprScoreSig || "").trim();
        const prevSigComputed = computeSig(prev);
        const oldSig = oldSigStored || prevSigComputed;
        const duprInfo = merged.duprGames || {};
        const hadSubmitted =
          Boolean(merged.duprMatchCode) ||
          Object.keys(duprInfo).some((k) => String((duprInfo[k] || {}).matchCode || "").trim());
        if (hadSubmitted) {
          if ((oldSig || newSig) && oldSig !== newSig) merged.duprNeedsUpdate = true;
          if (newSig) merged.duprScoreSig = newSig;
        }
      } catch (_) {}

      const updatePath = `tournamentCategories.${catIndex}.groupStage.groups.${groupIndex}.matches.${matchKey}`;
      await Tournament.updateOne({ _id: id }, { $set: { [updatePath]: merged } });
      embeddedUpdated = true;
      embeddedMatch = merged;

      try {
        const TournamentAuditLog = require("../models/TournamentAuditLog");
        const before = {
          status: base?.status,
          date: base?.date,
          time: base?.time,
          court: base?.court,
          venue: base?.venue,
          player1: base?.player1,
          player2: base?.player2,
          player1Name: base?.player1Name,
          player2Name: base?.player2Name,
          team1Id: base?.team1Id,
          team2Id: base?.team2Id,
          team1Members: base?.team1Members,
          team2Members: base?.team2Members,
          team1Name: base?.team1Name,
          team2Name: base?.team2Name,
          game1Player1: base?.game1Player1,
          game1Player2: base?.game1Player2,
          game2Player1: base?.game2Player1,
          game2Player2: base?.game2Player2,
          game3Player1: base?.game3Player1,
          game3Player2: base?.game3Player2,
          finalScorePlayer1: base?.finalScorePlayer1,
          finalScorePlayer2: base?.finalScorePlayer2,
          mdScores: base?.mdScores,
          wdScores: base?.wdScores,
          xdScores: base?.xdScores,
          duprMatchCode: base?.duprMatchCode,
          duprIdentifier: base?.duprIdentifier,
          duprDeletedUpstream: base?.duprDeletedUpstream,
          duprDeletedAt: base?.duprDeletedAt,
          duprNeedsUpdate: base?.duprNeedsUpdate,
          duprScoreSig: base?.duprScoreSig,
          duprNeedsCorrection: base?.duprNeedsCorrection,
          duprCorrectionSeq: base?.duprCorrectionSeq,
          duprCorrectionReason: base?.duprCorrectionReason,
          duprGames: base?.duprGames,
        };
        const after = {
          status: merged?.status,
          date: merged?.date,
          time: merged?.time,
          court: merged?.court,
          venue: merged?.venue,
          player1: merged?.player1,
          player2: merged?.player2,
          player1Name: merged?.player1Name,
          player2Name: merged?.player2Name,
          team1Id: merged?.team1Id,
          team2Id: merged?.team2Id,
          team1Members: merged?.team1Members,
          team2Members: merged?.team2Members,
          team1Name: merged?.team1Name,
          team2Name: merged?.team2Name,
          game1Player1: merged?.game1Player1,
          game1Player2: merged?.game1Player2,
          game2Player1: merged?.game2Player1,
          game2Player2: merged?.game2Player2,
          game3Player1: merged?.game3Player1,
          game3Player2: merged?.game3Player2,
          finalScorePlayer1: merged?.finalScorePlayer1,
          finalScorePlayer2: merged?.finalScorePlayer2,
          mdScores: merged?.mdScores,
          wdScores: merged?.wdScores,
          xdScores: merged?.xdScores,
          duprMatchCode: merged?.duprMatchCode,
          duprIdentifier: merged?.duprIdentifier,
          duprDeletedUpstream: merged?.duprDeletedUpstream,
          duprDeletedAt: merged?.duprDeletedAt,
          duprNeedsUpdate: merged?.duprNeedsUpdate,
          duprScoreSig: merged?.duprScoreSig,
          duprNeedsCorrection: merged?.duprNeedsCorrection,
          duprCorrectionSeq: merged?.duprCorrectionSeq,
          duprCorrectionReason: merged?.duprCorrectionReason,
          duprGames: merged?.duprGames,
        };
        const changedFields = (() => {
          const keys = Array.from(new Set(Object.keys(before).concat(Object.keys(after))));
          const changed = [];
          keys.forEach((k) => {
            const bv = before[k];
            const av = after[k];
            if (k === "duprGames" || k === "mdScores" || k === "wdScores" || k === "xdScores") {
              if (JSON.stringify(bv || null) !== JSON.stringify(av || null)) changed.push(k);
              return;
            }
            if (String(bv ?? "") !== String(av ?? "")) changed.push(k);
          });
          return changed;
        })();
        const wantsParticipantChange = Object.prototype.hasOwnProperty.call(body || {}, "player1") ||
          Object.prototype.hasOwnProperty.call(body || {}, "player2") ||
          Object.prototype.hasOwnProperty.call(body || {}, "player1Name") ||
          Object.prototype.hasOwnProperty.call(body || {}, "player2Name") ||
          Object.prototype.hasOwnProperty.call(body || {}, "team1Id") ||
          Object.prototype.hasOwnProperty.call(body || {}, "team2Id") ||
          Object.prototype.hasOwnProperty.call(body || {}, "team1Members") ||
          Object.prototype.hasOwnProperty.call(body || {}, "team2Members");
        const wantsScoreChange = Object.prototype.hasOwnProperty.call(body || {}, "game1Player1") ||
          Object.prototype.hasOwnProperty.call(body || {}, "game1Player2") ||
          Object.prototype.hasOwnProperty.call(body || {}, "game2Player1") ||
          Object.prototype.hasOwnProperty.call(body || {}, "game2Player2") ||
          Object.prototype.hasOwnProperty.call(body || {}, "game3Player1") ||
          Object.prototype.hasOwnProperty.call(body || {}, "game3Player2") ||
          Object.prototype.hasOwnProperty.call(body || {}, "finalScorePlayer1") ||
          Object.prototype.hasOwnProperty.call(body || {}, "finalScorePlayer2");
        const action = wantsParticipantChange
          ? (adminCorrectionMode ? "match_participants_update_admin_correction" : "match_participants_update")
          : wantsScoreChange
            ? (adminCorrectionMode ? "match_score_update_admin_correction" : "match_score_update")
            : "match_update";
        await TournamentAuditLog.create({
          tournamentId: tournament._id,
          entityType: "match",
          entityId: `group:${String(categoryId)}:${String(groupId)}:${String(matchKey)}`,
          action,
          actorId: req.user?._id || req.user?.id,
          actorRoles: roles,
          reason: adminCorrectionMode ? correctionReason : "",
          before,
          after,
          meta: { stage: "group", categoryId: String(categoryId), groupId: String(groupId), matchKey: String(matchKey), changedFields },
        });
      } catch (_) {}
    } catch (err) {
    } finally {
      try { invalidateTournamentGetCache(id); } catch (_) {}
    }
    return res.json({ ok: true, normalized: true, embedded: embeddedUpdated, embeddedMatch });
  } catch (e) {
    console.error("Error upserting normalized group match:", e);
    return res.status(500).json({ message: "Server error" });
  }
};
