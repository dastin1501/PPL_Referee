import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOutletContext } from "react-router-dom";
import CategoryBracketModal from "../../components/CategoryBracketModal";
import apiClient from "../../utils/axiosConfig";
import toast from "react-hot-toast";

export default function Brackets() {
  const { tournament, setTournament } = useOutletContext() || {};
  const [selectedCategoryId, setSelectedCategoryId] = useState(() => tournament?.tournamentCategories?.[0]?._id || "");
  const [isPublished, setIsPublished] = useState(() => Boolean(tournament?.published));
  const [showRoundRobinMap, setShowRoundRobinMap] = useState({});
  const [showEliminationMap, setShowEliminationMap] = useState({});
  const [selectedBrackets, setSelectedBrackets] = useState({});
  const [bracketMode, setBracketMode] = useState({});
  const [availableBrackets, setAvailableBrackets] = useState({});
  const [isEditing, setIsEditing] = useState(false);
  const [matchEdits, setMatchEdits] = useState({});
  const [swapDebugInfo, setSwapDebugInfo] = useState(null);
  const [showSwapDebug, setShowSwapDebug] = useState(false);
  const [registrationsForBracket, setRegistrationsForBracket] = useState(null);
  const initializedCategories = useRef(new Set());
  const autoPersistSlotsTimerRef = useRef(null);
  const lastPersistedSlotsKeyRef = useRef(new Map());
  const scheduleMap = useMemo(() => {
    try {
      // #region debug-point B:schedule-map-start
      // #endregion
      const out = {};
      const normStatus = (raw, value) => {
        const low = String(raw || "").trim().toLowerCase();
        if (low === "completed") return "completed";
        if (low === "ongoing") return "ongoing";
        if (low === "scheduled") return "scheduled";
        if (low === "unschedule" || low === "unscheduled") return "unscheduled";
        const hasSched = Boolean(
          String(value?.date || value?.mdDate || "").trim() &&
          String(value?.time || value?.mdTime || "").trim() &&
          String(value?.court || "").trim()
        );
        return hasSched ? "scheduled" : "";
      };
      const statusRank = (raw, value) => {
        const low = normStatus(raw, value);
        if (low === "completed") return 4;
        if (low === "ongoing") return 3;
        if (low === "scheduled") return 2;
        if (low === "unscheduled") return 1;
        return 0;
      };
      const completeness = (value) => {
        let score = 0;
        if (String(value?.date || value?.mdDate || "").trim()) score += 1;
        if (String(value?.time || value?.mdTime || "").trim()) score += 1;
        if (String(value?.court || "").trim()) score += 1;
        if (String(value?.venue || "").trim()) score += 1;
        return score;
      };
      const choosePreferred = (existing, incoming) => {
        if (!existing) return incoming;
        if (!incoming) return existing;
        const existingRank = statusRank(existing?.status, existing);
        const incomingRank = statusRank(incoming?.status, incoming);
        if (incomingRank > existingRank) return incoming;
        if (existingRank > incomingRank) return existing;
        const existingComplete = completeness(existing);
        const incomingComplete = completeness(incoming);
        if (incomingComplete > existingComplete) return incoming;
        if (existingComplete > incomingComplete) return existing;
        return incoming;
      };
      const pushFrom = (venueName, timeSlots, assignments, scheduleDate) => {
        (assignments || []).forEach((row, rIdx) => {
          const tslot = timeSlots?.[rIdx];
          const tRow = String(tslot?.startTime || "").trim();
          (row || []).forEach((cell, cIdx) => {
            if (!cell || !cell.id) return;
            const idRaw = String(cell.id || "").trim();
            const elimMatch = idRaw.match(/^elim-([a-f0-9]{24})-(.+?)-g\d+$/i);
            if (elimMatch) {
              const catIdE = elimMatch[1];
              const matchIdE = elimMatch[2];
              const rawStatus = String(cell.status || "").trim();
              const rawLow = rawStatus.toLowerCase();
              const isSched = rawLow === "scheduled" || rawLow === "ongoing" || rawLow === "completed";
              const d = isSched ? String(cell.date || scheduleDate || "").trim() : "";
              const t = isSched ? String(cell.time || tRow || "").trim() : "";
              const courtVal = isSched ? String(cell.court || String(cIdx + 1)).trim() : "";
              const vName = isSched ? String(cell.venue || venueName || "").trim() : "";
              const statusVal = isSched ? (rawStatus || "Scheduled") : (rawStatus ? "Unscheduled" : "");
              out[catIdE] = out[catIdE] || {};
              out[catIdE].elimination = out[catIdE].elimination || {};
              out[catIdE].elimination[matchIdE] = choosePreferred(out[catIdE].elimination[matchIdE], {
                date: d,
                mdDate: d,
                time: t,
                mdTime: t,
                court: courtVal,
                venue: vName,
                status: statusVal,
              });
              return;
            }
            const catId = String(cell.categoryId || "").trim();
            const gid = `group-${String(cell.bracket || "A").toLowerCase()}`;
            const mk = String(cell.matchKey || cell.key || "").trim();
            if (!catId || !gid || !mk) return;
            const rawStatus = String(cell.status || "").trim();
            const rawLow = rawStatus.toLowerCase();
            const isSched = rawLow === "scheduled" || rawLow === "ongoing" || rawLow === "completed";
            const d = isSched ? String(cell.date || scheduleDate || "").trim() : "";
            const t = isSched ? String(cell.time || tRow || "").trim() : "";
            const courtVal = isSched ? String(cell.court || String(cIdx + 1)).trim() : "";
            const vName = isSched ? String(cell.venue || venueName || "").trim() : "";
            const statusVal = isSched ? (rawStatus || "Scheduled") : (rawStatus ? "Unscheduled" : "");
            out[catId] = out[catId] || {};
            out[catId][gid] = out[catId][gid] || {};
            out[catId][gid][mk] = choosePreferred(out[catId][gid][mk], {
              date: d,
              mdDate: d,
              time: t,
              mdTime: t,
              court: courtVal,
              venue: vName,
              status: statusVal,
            });
          });
        });
      };
      const processRoot = (root) => {
        if (!root || typeof root !== "object") return;
        const scheduleDate = String(root.scheduleDate || "").trim();
        if (Array.isArray(root?.venues) && root.venues.length > 0) {
          root.venues.forEach((v) => pushFrom(v?.name, v?.timeSlots, v?.assignments, scheduleDate));
        } else if (Array.isArray(root?.assignments) && Array.isArray(root?.timeSlots)) {
          pushFrom("", root.timeSlots, root.assignments, scheduleDate);
        }
      };
      const ca = tournament?.courtAssignments;
      const root = typeof ca === "string" ? JSON.parse(ca) : (ca || {});
      processRoot(root);
      const byDate = tournament?.courtAssignmentsByDate || {};
      Object.values(byDate).forEach((entry) => {
        if (entry && typeof entry === "object") processRoot(entry);
      });

      // #region debug-point B:schedule-map-end
      // #endregion
      return out;
    } catch {
      return {};
    }
  }, [tournament]);

  const autoSaveTimerRef = useRef(null);
  const lastSavedRef = useRef("");
  const latestTournamentRef = useRef(tournament);
  const isPublishingRef = useRef(false);
  const bracketRefreshSeqRef = useRef(0);
  const categoryDisplaySnapshotRef = useRef({});
  const bracketSyncClientIdRef = useRef(
    (() => {
      try {
        if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
          return crypto.randomUUID();
        }
      } catch {}
      return `brackets-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    })()
  );

  const broadcastBracketUpdate = useCallback((payload = {}) => {
    try {
      const tournamentId = String(tournament?._id || latestTournamentRef.current?._id || "").trim();
      if (!tournamentId) return;
      const bc = new BroadcastChannel("tournament_updates");
      bc.postMessage({
        tournamentId,
        type: "brackets",
        senderId: String(bracketSyncClientIdRef.current || ""),
        updatedAt: new Date().toISOString(),
        ...payload,
      });
      bc.close();
    } catch {}
  }, [tournament?._id]);

  useEffect(() => {
    setIsPublished(Boolean(tournament?.published));
  }, [tournament?._id, tournament?.published]);

  const normalizeSkillLevel = (raw) => {
    if (!raw) return "";
    const lower = String(raw).toLowerCase();
    if (lower.startsWith("open-tier")) return "Open";
    return raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  };

  const categories = Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : [];
  const selectedCategoryRaw = useMemo(() => {
    return categories.find((c) => String(c._id) === String(selectedCategoryId)) || categories[0];
  }, [categories, selectedCategoryId]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const tId = String(tournament?._id || "").trim();
        if (!tId) {
          setRegistrationsForBracket(null);
          return;
        }
        const all = [];
        let page = 1;
        while (true) {
          const { data } = await apiClient.get(
            `/tournaments/${tId}?includeRegistrations=true&includeAssets=false&includeComputed=false&regPage=${page}&regLimit=200`,
          );
          const payload = data?.tournament || data || {};
          const regs = Array.isArray(payload?.registrations) ? payload.registrations : [];
          all.push(...regs);
          const pag = payload?.registrationPagination || {};
          const total = Number(pag?.total || 0);
          const limit = Number(pag?.limit || 200);
          const hasMore = total > 0 ? all.length < total : regs.length >= limit;
          if (!hasMore) break;
          page += 1;
          if (page > 200) break;
        }
        if (!cancelled) setRegistrationsForBracket(all);
      } catch {
        if (!cancelled) setRegistrationsForBracket([]);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [tournament?._id]);

  const getCategoryType = (name) => {
    if (!name) return "singles";
    const s = String(name).toLowerCase();
    // Treat any explicit doubles/team label as authoritative
    if (s.includes("doubles")) return "doubles";
    if (s.includes("team")) return "team";
    // Special‑case: "open gender" divisions like "Open Gender Novice"
    // are doubles-style brackets even if the word "doubles" is missing.
    if (s.includes("open gender") && !s.includes("singles")) return "doubles";
    return "singles";
  };

  const approvedRegsForCategory = useMemo(() => {
    const regs = Array.isArray(registrationsForBracket)
      ? registrationsForBracket
      : (Array.isArray(tournament?.registrations) ? tournament.registrations : []);
    const cat = selectedCategoryRaw;
    if (!cat) return [];
    const normKey = (v) =>
      String(v || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const catId = String(cat?._id || "").trim();
    const catDiv = String(cat?.division || "").trim();
    const catDivKey = normKey(catDiv);
    const filtered = regs.filter((reg) => {
      const status = String(reg?.status || "").toLowerCase();
      if (status !== "approved") return false;
      const regCatIdRaw = reg?.categoryId;
      const regCatId = (regCatIdRaw && typeof regCatIdRaw === "object")
        ? (regCatIdRaw._id || regCatIdRaw.id)
        : regCatIdRaw;
      const regCat = reg?.category;
      const regCatStr = typeof regCat === "string"
        ? regCat
        : (regCat?._id || regCat?.division || regCat?.name || "");
      const regCatStrTrim = String(regCatStr || "").trim();
      const regCatKey = normKey(regCatStrTrim);
      const regLooksLikeId = /^[a-f0-9]{24}$/i.test(regCatStrTrim);
      if (regCatId && catId && String(regCatId) === String(catId)) return true;
      if (regCatStrTrim && catId && String(regCatStrTrim) === String(catId)) return true;
      if (regLooksLikeId && catId && String(regCatStrTrim) === String(catId)) return true;
      if (regCatKey && catDivKey && regCatKey === catDivKey) return true;
      return false;
    });
    return filtered;
  }, [registrationsForBracket, tournament?.registrations, selectedCategoryRaw]);

  const approvedPlayerIds = useMemo(() => {
    try {
      const regs = approvedRegsForCategory || [];
      const ids = new Set();
      const pushId = (val) => {
        if (!val) return;
        if (typeof val === "object") {
          const id = val._id || val.id;
          const ppl = val.pplId;
          if (id) ids.add(String(id));
          if (ppl) ids.add(String(ppl));
        } else {
          ids.add(String(val));
        }
      };
      regs.forEach((reg) => {
        pushId(reg.player || reg.primaryPlayer);
        pushId(reg.partner);
        (Array.isArray(reg.teamMembers) ? reg.teamMembers : []).forEach(pushId);
      });
      return Array.from(ids);
    } catch {
      return [];
    }
  }, [approvedRegsForCategory]);

  const approvedFallbackPlayers = useMemo(() => {
    const regs = approvedRegsForCategory || [];
    const out = [];
    const pushFrom = (p, fallbackName, gen) => {
      if (!p && !fallbackName) return;
      if (p && typeof p === "object") {
        let fn = p.firstName || "";
        let ln = p.lastName || "";
        // Singles (and some APIs) often have .name only; derive firstName/lastName so fallback matches bracket slot names
        if ((!fn && !ln) && (p.name || fallbackName)) {
          const name = String(p.name || fallbackName || "").trim();
          const parts = name.split(/\s+/);
          fn = parts[0] || "";
          ln = parts.slice(1).join(" ") || "";
        }
        const fullName = `${fn} ${ln}`.trim();
        out.push({
          _id: p._id || p.id || p.pplId || fullName || undefined,
          pplId: p.pplId,
          firstName: fn,
          lastName: ln,
          gender: p.gender || gen || "N/A",
        });
      } else {
        const name = fallbackName || "";
        const parts = name.trim().split(/\s+/);
        const fn = parts[0] || name;
        const ln = parts.slice(1).join(" ");
        out.push({
          _id: String(p) || name,
          pplId: undefined,
          firstName: fn,
          lastName: ln,
          gender: gen || "N/A",
        });
      }
    };
    regs.forEach((reg) => {
      const p = reg.player || reg.primaryPlayer;
      const playerName = (reg.playerName || "").trim();
      pushFrom(p, playerName, reg.gender);
      const partner = reg.partner;
      const partnerName = (reg.partnerName || "").trim();
      pushFrom(partner, partnerName, reg.partnerGender || reg.gender);
      const members = Array.isArray(reg.teamMembers) ? reg.teamMembers : [];
      members.forEach((m) => pushFrom(m, "", m?.gender || reg.gender));
    });
    return out;
  }, [approvedRegsForCategory]);

  const canonicalPlayerName = (s) =>
    String(s || "").replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
  const normalizeName = (s) => canonicalPlayerName(s).toLowerCase();
  const normalizeElimId = (raw) => String(raw || "").trim().toLowerCase().replace(/[-_]/g, "");
  const elimIdAliases = (raw) => {
    const id = String(raw || "").trim().toLowerCase();
    const out = new Set();
    const push = (v) => {
      const s = String(v || "").trim().toLowerCase();
      if (!s) return;
      out.add(s);
      out.add(normalizeElimId(s));
    };
    push(id);
    if (id.startsWith("quarter")) push(`qf${id.replace("quarter", "")}`);
    if (id.startsWith("qf")) push(`quarter${id.replace("qf", "")}`);
    if (id.startsWith("semi")) push(`sf${id.replace("semi", "")}`);
    if (id.startsWith("sf")) push(`semi${id.replace("sf", "")}`);
    if (id.startsWith("round16_")) push(`r16-${id.replace("round16_", "")}`);
    if (id.startsWith("r16-")) push(`round16_${id.replace("r16-", "")}`);
    if (id === "finals") push("final");
    if (id === "final") push("finals");
    return Array.from(out);
  };
  
  // Generate unique position ID for category-bracket-slot hierarchy
  const generatePositionId = (categoryId, groupId, slotIdx) => {
    return `${String(categoryId || "").trim()}:${String(groupId || "").trim()}:${slotIdx}`;
  };

  const bracketPlayersForCategory = useMemo(() => {
    const cat = selectedCategoryRaw;
    const groups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
    const names = [];
    groups.forEach((g) => {
      const op = Array.isArray(g?.originalPlayers) ? g.originalPlayers : [];
      const st = Array.isArray(g?.standings) ? g.standings.map((s) => s.player) : [];
      [...op, ...st].forEach((n) => {
        const s = String(n || "").trim();
        if (!s) return;
        const lower = s.toLowerCase();
        if (lower === "tbd") return;
        if (lower === "unknown" || lower === "unknown player") return;
        if (lower === "undefined undefined") return;
        names.push(s);
      });
    });
    const seen = new Set();
    const out = [];
    names.forEach((n) => {
      const norm = normalizeName(n);
      if (!norm || seen.has(norm)) return;
      seen.add(norm);
      out.push(n);
    });
    return out;
  }, [selectedCategoryRaw]);

  const bracketFallbackPlayers = useMemo(() => {
    const catType = getCategoryType(selectedCategoryRaw?.division || selectedCategoryRaw?.name || "");
    const isPairSlot = catType === "doubles" || catType === "team";
    const partsToPlayer = (name) => {
      const s = String(name || "").trim();
      if (isPairSlot && (s.includes(" / ") || s.includes("/"))) {
        return {
          _id: normalizeName(s),
          pplId: undefined,
          firstName: s,
          lastName: "",
          gender: "N/A",
        };
      }
      const parts = s.split(/\s+/);
      const fn = parts[0] || s;
      const ln = parts.slice(1).join(" ");
      return {
        _id: normalizeName(s),
        pplId: undefined,
        firstName: fn,
        lastName: ln,
        gender: "N/A",
      };
    };
    const arr = (bracketPlayersForCategory || []).map(partsToPlayer);
    const seen = new Set();
    return arr.filter((p) => {
      const key = String(p._id || p.pplId || normalizeName(`${p.firstName || ""} ${p.lastName || ""}`.trim()));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [bracketPlayersForCategory, selectedCategoryRaw]);

  const extendedAllowedIds = useMemo(() => {
    const base = (approvedPlayerIds || []).map(String);
    const extras = (bracketPlayersForCategory || []).map((n) => normalizeName(n));
    const set = new Set([...base, ...extras]);
    return Array.from(set);
  }, [approvedPlayerIds, bracketPlayersForCategory]);

  const skipAutoRefreshUntilRef = useRef(0);
  const autoRefreshInFlightRef = useRef(false);
  const lastAutoRefreshAtRef = useRef(0);
  const bracketPollEtagRef = useRef("");
  const matchEditsRef = useRef({});
  const bracketSettlingTimerRef = useRef(null);
  const bracketLoaderShownCategoriesRef = useRef(new Set());
  const bracketSettlingPendingCategoryRef = useRef("");
  const elimStatusOverridesRef = useRef({});
  const elimStatusOverrideUntilRef = useRef({});
  const ELIM_STATUS_OVERRIDE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

  const [normalizedElimState, setNormalizedElimState] = useState({ categoryId: "", matches: [] });
  const [isBracketSettling, setIsBracketSettling] = useState(false);

  const swapAllowedIds = useMemo(() => {
    return (bracketPlayersForCategory || []).map((n) => normalizeName(n));
  }, [bracketPlayersForCategory]);

  const showBracketSettlingLoader = useCallback((ms = 1800) => {
    try {
      if (bracketSettlingTimerRef.current) clearTimeout(bracketSettlingTimerRef.current);
    } catch {}
    setIsBracketSettling(true);
    bracketSettlingTimerRef.current = setTimeout(() => {
      setIsBracketSettling(false);
      bracketSettlingTimerRef.current = null;
    }, Math.max(300, Number(ms) || 0));
  }, [selectedCategoryId]);

  const finishBracketSettlingLoader = useCallback((catId) => {
    const targetCatId = String(catId || "").trim();
    if (!targetCatId) return;
    if (String(bracketSettlingPendingCategoryRef.current || "").trim() !== targetCatId) return;
    try {
      if (bracketSettlingTimerRef.current) clearTimeout(bracketSettlingTimerRef.current);
    } catch {}
    bracketSettlingTimerRef.current = null;
    bracketSettlingPendingCategoryRef.current = "";
    setIsBracketSettling(false);
  }, []);

  useEffect(() => {
    return () => {
      try {
        if (bracketSettlingTimerRef.current) clearTimeout(bracketSettlingTimerRef.current);
      } catch {}
    };
  }, []);

  useEffect(() => {
    bracketLoaderShownCategoriesRef.current = new Set();
  }, [tournament?._id]);

  const slottedMergedFallbackPlayers = useMemo(() => {
    const slottedSet = new Set((bracketPlayersForCategory || []).map((n) => normalizeName(n)));
    const out = [];
    const seen = new Set();
    const seenNames = new Set();
    
    // Prefer real accounts from approvedFallbackPlayers if their normalized name is slotted
    (approvedFallbackPlayers || []).forEach((p) => {
      const keyName = normalizeName(`${p.firstName || ""} ${p.lastName || ""}`);
      if (!slottedSet.has(keyName)) return;
      const key = String(p._id || p.pplId || keyName);
      if (seen.has(key)) return;
      seen.add(key);
      if (seenNames.has(keyName)) return;
      seenNames.add(keyName);
      out.push({
        _id: p._id || p.id || p.pplId || keyName,
        pplId: p.pplId,
        firstName: p.firstName || "",
        lastName: p.lastName || "",
        gender: p.gender || "N/A",
      });
    });
    // Fill any remaining slotted names from bracketFallbackPlayers
    (bracketFallbackPlayers || []).forEach((p) => {
      const keyName = normalizeName(`${p.firstName || ""} ${p.lastName || ""}`);
      if (!slottedSet.has(keyName)) return;
      const key = String(p._id || p.pplId || keyName);
      if (seen.has(key)) return;
      if (seenNames.has(keyName)) return;
      seen.add(key);
      seenNames.add(keyName);
      out.push({
        _id: p._id || p.pplId || keyName,
        pplId: p.pplId,
        firstName: p.firstName || "",
        lastName: p.lastName || "",
        gender: p.gender || "N/A",
      });
    });
    return out;
  }, [approvedFallbackPlayers, bracketFallbackPlayers, bracketPlayersForCategory]);

  const swapAllowedIdsExtended = useMemo(() => {
    const out = new Set();
    (slottedMergedFallbackPlayers || []).forEach((p) => {
      const id = String(p._id || "").trim();
      const ppl = String(p.pplId || "").trim();
      if (id) out.add(id);
      if (ppl) out.add(ppl);
    });
    return Array.from(out);
  }, [bracketPlayersForCategory, slottedMergedFallbackPlayers]);

  const extendedFallbackPlayers = useMemo(() => {
    const arr = [...(approvedFallbackPlayers || []), ...(bracketFallbackPlayers || [])];
    const seen = new Set();
    return arr.filter((p) => {
      const key = String(p._id || p.pplId || normalizeName(`${p.firstName || ""} ${p.lastName || ""}`));
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [approvedFallbackPlayers, bracketFallbackPlayers]);

  const derivePlayerName = (reg, division) => {
    const type = getCategoryType(division);
    if (type === "doubles") {
      const p1 = reg.player || reg.primaryPlayer || {};
      const p2 = reg.partner || {};
      const n1 = `${p1.firstName || ""} ${p1.lastName || ""}`.trim() || (p1.name || "");
      const n2 = `${p2.firstName || ""} ${p2.lastName || ""}`.trim() || (p2.name || "");
      const pair = [n1, n2].filter(Boolean).join(" / ");
      return pair || "Unknown Player";
    }
    if (type === "team") {
      if (reg.teamName) return reg.teamName;
      const members = Array.isArray(reg.teamMembers) ? reg.teamMembers : [];
      const names = members.slice(0, 2).map((m) => `${m.firstName || ""} ${m.lastName || ""}`.trim()).filter(Boolean);
      return names.length ? names.join(" / ") : (reg.player?.teamName || reg.playerName || "Team");
    }
    const p = reg.player || reg.primaryPlayer || {};
    const nameObj = `${p.firstName || ""} ${p.lastName || ""}`.trim();
    return (reg.playerName || "").trim() || nameObj || (p.name || "").trim() || "Unknown Player";
  };

  const hasScoreProgress = (match) => [
    match?.game1Player1, match?.game1Player2,
    match?.game2Player1, match?.game2Player2,
    match?.game3Player1, match?.game3Player2,
    match?.finalScorePlayer1, match?.finalScorePlayer2,
  ].some((x) => Number(x) > 0);

  const hasFullSchedule = (match) => Boolean(
    String(match?.date || match?.mdDate || "").trim() &&
    String(match?.time || match?.mdTime || "").trim() &&
    String(match?.court || "").trim()
  );

  const normalizePassiveMatchStatus = (match) => {
    const m = match && typeof match === "object" ? match : {};
    const statusLow = String(m.status || "").trim().toLowerCase();
    if (hasScoreProgress(m)) return m;
    if (statusLow === "completed" || statusLow === "ongoing") {
      return { ...m, status: hasFullSchedule(m) ? "Scheduled" : "Unschedule" };
    }
    if (!statusLow && hasFullSchedule(m)) {
      return { ...m, status: "Scheduled" };
    }
    return m;
  };

  const filterMatchesToPlayers = (matchesObj, players) => {
    const allowed = new Set(
      (Array.isArray(players) ? players : [])
        .map((p) => normalizeName(p))
        .filter(Boolean)
    );
    const matches = matchesObj && typeof matchesObj === "object" ? matchesObj : {};
    const out = {};
    Object.entries(matches).forEach(([matchKey, match]) => {
      const p1 = normalizeName(match?.player1Name || match?.player1 || "");
      const p2 = normalizeName(match?.player2Name || match?.player2 || "");
      if (!p1 || !p2) return;
      if (!allowed.has(p1) || !allowed.has(p2)) return;
      out[matchKey] = match;
    });
    return out;
  };

  const rebuildGroupMatches = (players, oldMatches) => {
    const toScore = (v) => {
      if (v === null || v === undefined || v === "") return 0;
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    const pl = (Array.isArray(players) ? players : [])
      .map((n) => String(n || "").trim())
      .filter((s) => {
        if (!s) return false;
        const lower = s.toLowerCase();
        if (lower === "tbd") return false;
        if (lower.startsWith("tbd ")) return false;
        if (lower === "unknown" || lower === "unknown player") return false;
        return true;
      });
    const res = {};
    const allOld = Object.values(oldMatches || {});
    for (let i = 0; i < pl.length; i++) {
      for (let j = i + 1; j < pl.length; j++) {
        const key = `${i}-${(j - i - 1)}`;
        const n1 = pl[i];
        const n2 = pl[j];
        const oldByKey = (oldMatches && typeof oldMatches === "object" && !Array.isArray(oldMatches))
          ? (oldMatches[key] || null)
          : null;
        const oldByName = allOld.find((m) => {
          const a = String(m.player1Name || m.player1 || "").trim();
          const b = String(m.player2Name || m.player2 || "").trim();
          return (a === n1 && b === n2) || (a === n2 && b === n1);
        }) || {};
        const old = { ...oldByName, ...(oldByKey || {}) };
        res[key] = {
          ...old,
          player1: n1,
          player1Name: n1,
          player2: n2,
          player2Name: n2,
          game1Player1: toScore(old.game1Player1),
          game1Player2: toScore(old.game1Player2),
          game2Player1: toScore(old.game2Player1),
          game2Player2: toScore(old.game2Player2),
          game3Player1: toScore(old.game3Player1),
          game3Player2: toScore(old.game3Player2),
          finalScorePlayer1: toScore(old.finalScorePlayer1),
          finalScorePlayer2: toScore(old.finalScorePlayer2),
          refereeNumber: String(old.refereeNumber || "").trim(),
          refereeG1: String(old.refereeG1 || "").trim(),
          refereeG2: String(old.refereeG2 || "").trim(),
          refereeG3: String(old.refereeG3 || "").trim(),
          refereeNote: String(old.refereeNote || "").trim(),
          signatureData: old.signatureData || "",
          gameSignatures: Array.isArray(old.gameSignatures) ? old.gameSignatures : [],
          status: String(old.status || "unscheduled").trim(),
          game1Team1Player: String(old.game1Team1Player || ""),
          game1Team1Player2: String(old.game1Team1Player2 || ""),
          game1Team2Player: String(old.game1Team2Player || ""),
          game1Team2Player2: String(old.game1Team2Player2 || ""),
          game2Team1Player: String(old.game2Team1Player || ""),
          game2Team1Player2: String(old.game2Team1Player2 || ""),
          game2Team2Player: String(old.game2Team2Player || ""),
          game2Team2Player2: String(old.game2Team2Player2 || ""),
          game3Team1Player: String(old.game3Team1Player || ""),
          game3Team1Player2: String(old.game3Team1Player2 || ""),
          game3Team2Player: String(old.game3Team2Player || ""),
          game3Team2Player2: String(old.game3Team2Player2 || ""),
        };
      }
    }
    return res;
  };

  const computeRoundRobinStandingsFromMatches = (matchesObj, players, prevStandings, gamesPerMatch) => {
    const list = (Array.isArray(players) ? players : [])
      .map((p) => canonicalPlayerName(p))
      .filter((p) => {
        if (!p) return false;
        const lower = p.toLowerCase();
        if (lower === "tbd") return false;
        if (lower.startsWith("tbd ")) return false;
        if (lower === "unknown" || lower === "unknown player") return false;
        return true;
      });
    const byName = new Map();
    const keyOf = (name) => normalizeName(name);
    const ensure = (name) => {
      const nm = canonicalPlayerName(name);
      const k = keyOf(nm);
      if (!k) return null;
      if (!byName.has(k)) {
        byName.set(k, {
          player: nm,
          wins: 0,
          losses: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          pointDifferential: 0,
          rankPoints: 0,
          qualified: false,
        });
      }
      return byName.get(k);
    };
    list.forEach((p) => ensure(p));

    const gp = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : 0;
    };
    const gpm = Math.min(Math.max(Number(gamesPerMatch ?? 3) || 3, 1), 3);

    const matches = matchesObj && typeof matchesObj === "object" ? matchesObj : {};
    Object.values(matches).forEach((m) => {
      const p1 = canonicalPlayerName(m?.player1Name || m?.player1 || "");
      const p2 = canonicalPlayerName(m?.player2Name || m?.player2 || "");
      if (!p1 || !p2) return;
      const p1l = p1.toLowerCase();
      const p2l = p2.toLowerCase();
      if (p1l === "tbd" || p1l.startsWith("tbd ") || p2l === "tbd" || p2l.startsWith("tbd ")) return;
      const r1 = ensure(p1);
      const r2 = ensure(p2);
      if (!r1 || !r2) return;

      const sets = [
        [gp(m?.game1Player1), gp(m?.game1Player2)],
        [gp(m?.game2Player1), gp(m?.game2Player2)],
        [gp(m?.game3Player1), gp(m?.game3Player2)],
      ].slice(0, gpm);

      let p1SetWins = 0;
      let p2SetWins = 0;
      let p1Pts = 0;
      let p2Pts = 0;
      sets.forEach(([a, b]) => {
        p1Pts += a;
        p2Pts += b;
        if (a > b) p1SetWins += 1;
        else if (b > a) p2SetWins += 1;
      });

      r1.pointsFor += p1Pts;
      r1.pointsAgainst += p2Pts;
      r2.pointsFor += p2Pts;
      r2.pointsAgainst += p1Pts;

      // Keep this consistent with the existing doubles RR logic:
      // wins/losses are accumulated per-set within the match.
      r1.wins += p1SetWins;
      r1.losses += p2SetWins;
      r2.wins += p2SetWins;
      r2.losses += p1SetWins;
    });

    // Carry forward qualified flags if present (don’t let recalculation wipe them)
    const prev = Array.isArray(prevStandings) ? prevStandings : [];
    const prevQ = new Map(prev.map((r) => [keyOf(r?.player), Boolean(r?.qualified)]).filter(([k]) => !!k));
    byName.forEach((row, k) => {
      row.qualified = Boolean(prevQ.get(k));
      row.pointDifferential = Number(row.pointsFor) - Number(row.pointsAgainst);
    });

    const rows = Array.from(byName.values());
    const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    rows.sort((a, b) => {
      const aWins = toNum(a?.wins);
      const bWins = toNum(b?.wins);
      if (bWins !== aWins) return bWins - aWins;
      const aFor = toNum(a?.pointsFor);
      const bFor = toNum(b?.pointsFor);
      if (bFor !== aFor) return bFor - aFor;
      const aAg = toNum(a?.pointsAgainst);
      const bAg = toNum(b?.pointsAgainst);
      if (aAg !== bAg) return aAg - bAg;
      return 0;
    });
    return rows;
  };

  const expectedPerGroupCap = useMemo(() => {
    try {
      const cat = selectedCategoryRaw;
      if (!cat) return null;
      const letters = computeLetters(cat);
      const groupCount = Math.max(1, letters.length || 1);
      const desiredAll = (approvedRegsForCategory || [])
        .map((reg) => derivePlayerName(reg, cat?.division || cat?.name || ""))
        .map((n) => canonicalPlayerName(n))
        .filter((n) => {
          const k = normalizeName(n);
          return !!k && k !== "unknown player" && k !== "tbd";
        });
      const seen = new Set();
      const desiredUnique = desiredAll.filter((n) => {
        const k = normalizeName(n);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      if (desiredUnique.length === 0) return null;
      return Math.max(1, Math.ceil(desiredUnique.length / groupCount));
    } catch {
      return null;
    }
  }, [selectedCategoryRaw, approvedRegsForCategory, bracketMode]);

  const updateGroupSlots = async (categoryId, groupId, nextSlots) => {
    try {
      const catId = String(categoryId || selectedCategoryRaw?._id || "").trim();
      const gid = String(groupId || "").trim();
      if (!catId || !gid) return;
      const slots = Array.isArray(nextSlots) ? nextSlots.map((s) => canonicalPlayerName(s)) : [];
      setTournament((prev) => {
        if (!prev || !Array.isArray(prev?.tournamentCategories)) return prev;
        const next = JSON.parse(JSON.stringify(prev));
        const cIdx = next.tournamentCategories.findIndex((c) => String(c?._id) === String(catId));
        if (cIdx < 0) return prev;
        const groups = next.tournamentCategories[cIdx]?.groupStage?.groups || [];
        const gIdx = groups.findIndex((g) => String(g?.id) === String(gid));
        if (gIdx < 0) return prev;
        const g = groups[gIdx] || {};
        const matches = rebuildGroupMatches(slots, g?.matches || {});

        // Build slot-aligned standings so swap logic keeps working.
        const stats = computeRoundRobinStandingsFromMatches(matches, slots, g?.standings, next.tournamentCategories[cIdx]?.gamesPerMatch);
        const statsByName = new Map(stats.map((r) => [normalizeName(r?.player), r]).filter(([k]) => !!k));
        const standingsAligned = slots.map((name) => {
          const k = normalizeName(name);
          const hit = statsByName.get(k);
          if (hit) return { ...hit, player: name };
          return { player: name, wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, pointDifferential: 0, rankPoints: 0, qualified: false };
        });

        groups[gIdx] = { ...g, originalPlayers: slots, standings: standingsAligned, matches };
        next.tournamentCategories[cIdx].groupStage.groups = groups;
        return next;
      });
      try {
        localStorage.setItem(`rrPlayers:${tournament?._id}:${catId}:${gid}`, JSON.stringify(nextSlots || []));
      } catch {}
    } catch {}
  };

  // Recover fixed slot order from round-robin match keys (0-0, 0-1, 1-0, etc.).
  // This avoids accidental reordering when standings get re-sorted by performance.
  const inferPlayerOrderFromMatches = (matchesObj) => {
    try {
      const matches = matchesObj && typeof matchesObj === "object" ? matchesObj : {};
      const slots = [];
      const seen = new Set();
      const allNames = [];
      Object.keys(matches).forEach((k) => {
        const m = String(k || "").match(/^(\d+)-(\d+)$/);
        if (!m) return;
        const i = Number(m[1]);
        const off = Number(m[2]);
        const j = i + off + 1;
        const row = matches[k] || {};
        const p1 = String(row.player1Name || row.player1 || "").trim();
        const p2 = String(row.player2Name || row.player2 || "").trim();
        if (p1) allNames.push(p1);
        if (p2) allNames.push(p2);
        if (p1 && !slots[i]) slots[i] = p1;
        if (p2 && !slots[j]) slots[j] = p2;
      });
      const uniqNames = [];
      allNames.forEach((n) => {
        const nn = normalizeName(n);
        if (!nn || seen.has(nn)) return;
        seen.add(nn);
        uniqNames.push(n);
      });
      for (let idx = 0; idx < slots.length; idx += 1) {
        if (slots[idx]) continue;
        const pick = uniqNames.find((n) => !slots.some((s) => normalizeName(s) === normalizeName(n)));
        if (pick) slots[idx] = pick;
      }
      return slots.map((n) => String(n || "").trim()).filter(Boolean);
    } catch {
      return [];
    }
  };

  const computeLetters = (cat) => {
    const mode = bracketMode[cat?._id] ?? cat?.bracketMode ?? (cat?.groupStage?.groups?.length || 4);
    const m = [1, 2, 4, 8].includes(Number(mode)) ? Number(mode) : 4;
    return ["A", "B", "C", "D", "E", "F", "G", "H"].slice(0, Math.max(m, 1));
  };

  const selectedCategory = useMemo(() => {
    const cat = selectedCategoryRaw;
    if (!cat) return undefined;
    // #region debug-point A:selected-category-start
    // #endregion
    const letters = computeLetters(cat);
    const shouldApplyScheduleOverlay = (baseMatch, overlayEntry) => {
      const base = baseMatch && typeof baseMatch === "object" ? baseMatch : {};
      const add = overlayEntry && typeof overlayEntry === "object" ? overlayEntry : {};
      const baseStatus = String(base?.status || "").trim().toLowerCase();
      const addStatus = String(add?.status || "").trim().toLowerCase();
      const baseIsExplicitUnscheduled = baseStatus === "unschedule" || baseStatus === "unscheduled";
      if (addStatus === "unschedule" || addStatus === "unscheduled") return true;
      if (baseIsExplicitUnscheduled && !hasFullSchedule(base)) return false;
      if (hasScoreProgress(base) || hasFullSchedule(base)) return true;
      if (baseStatus === "scheduled" || baseStatus === "ongoing" || baseStatus === "completed") return true;
      return false;
    };
    const existingGroups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
    const baseGroups = letters.map((letter) => {
      const id = `group-${letter.toLowerCase()}`;
      const found = existingGroups.find((g) => g.id === id);
      const k = `${cat._id}:${id}`;
      const overlay = matchEdits[k] || {};
      const baseMatches = found?.matches || {};
      let localPlayers = [];
      try {
        const lsKey = `rrPlayers:${tournament?._id}:${cat?._id}:${id}`;
        const ls = localStorage.getItem(lsKey);
        localPlayers = Array.isArray(JSON.parse(ls || "null")) ? JSON.parse(ls || "null") : [];
      } catch {}
      // Debug: Log if matches are missing
      if (found && Object.keys(baseMatches).length === 0 && found.originalPlayers?.length > 0) {
        console.warn(`[BRACKETS] Group ${id} has players but no matches!`, {
          groupId: id,
          originalPlayers: found.originalPlayers,
          hasMatches: !!found.matches,
          matchesType: typeof found.matches,
          matchesIsArray: Array.isArray(found.matches)
        });
      }
      const mergedMatches = {};
      const allKeys = new Set([
        ...Object.keys(baseMatches),
        ...Object.keys(overlay),
      ]);
      allKeys.forEach((mk) => {
        const orig = baseMatches[mk] || {};
        const ov = overlay[mk] || {};
        mergedMatches[mk] = normalizePassiveMatchStatus({ ...orig, ...ov });
      });
      const schedForCat = scheduleMap[String(cat._id)] || {};
      const schedForGroup = schedForCat[id] || {};
      Object.keys(schedForGroup).forEach((mk) => {
        const base = mergedMatches[mk] || {};
        const add = { ...schedForGroup[mk] };

        if (!shouldApplyScheduleOverlay(base, add)) return;
        const baseStatus = String(base.status || "").trim().toLowerCase();
        const addStatus = String(add.status || "").trim().toLowerCase();
        const baseHasProgress = hasScoreProgress(base);
        const shouldPreserveBaseStatus = baseHasProgress && (
          baseStatus === "completed" ||
          (baseStatus === "ongoing" && addStatus !== "completed")
        );
        const status = shouldPreserveBaseStatus ? (base.status || add.status) : (add.status || base.status);
        mergedMatches[mk] = normalizePassiveMatchStatus({ ...base, ...add, status });
      });
      return {
        id,
        name: `Group ${letter}`,
        standings: [],
        matches: mergedMatches,
        originalPlayers: (Array.isArray(localPlayers) && localPlayers.length > 0)
          ? localPlayers
          : (Array.isArray(found?.originalPlayers) ? found.originalPlayers : []),
      };
    });
    const hasExistingPlayers = existingGroups.some((g) => {
      const op = Array.isArray(g?.originalPlayers) ? g.originalPlayers.filter(Boolean) : [];
      const st = Array.isArray(g?.standings) ? g.standings.map((s) => s.player).filter(Boolean) : [];
      return (op.length + st.length) > 0;
    });
    const desiredAll = (approvedRegsForCategory || [])
      .map((reg) => derivePlayerName(reg, cat?.division || cat?.name || ""))
      .map((n) => canonicalPlayerName(n))
      .filter((n) => {
        const k = normalizeName(n);
        return !!k && k !== "unknown player" && k !== "tbd";
      });
    const desiredSet = new Set();
    const desiredUnique = desiredAll.filter((n) => {
      const k = normalizeName(n);
      if (!k || desiredSet.has(k)) return false;
      desiredSet.add(k);
      return true;
    });

    const groupCountForCap = Math.max(1, letters.length || 1);
    const hasDesired = (desiredUnique.length || 0) > 0;
    const categoryType = getCategoryType(cat?.division || cat?.name || "");
    const perGroupCap = hasDesired ? Math.max(1, Math.ceil(desiredUnique.length / groupCountForCap)) : Number.POSITIVE_INFINITY;

    let distributed;
    if (hasExistingPlayers) {
      distributed = baseGroups.map((g) => {
        const found = existingGroups.find((x) => String(x?.id) === String(g.id)) || {};
        let lsPlayers = [];
        try {
          const lsKey = `rrPlayers:${tournament?._id}:${cat?._id}:${g.id}`;
          const lsRaw = localStorage.getItem(lsKey);
          const parsed = JSON.parse(lsRaw || "null");
          if (Array.isArray(parsed)) lsPlayers = parsed;
        } catch {}
        const opFromMatches = inferPlayerOrderFromMatches(found?.matches || {});
        const opBase = Array.isArray(found?.originalPlayers) && found.originalPlayers.length
          ? found.originalPlayers
          : (opFromMatches.length > 0
              ? opFromMatches
              : (Array.isArray(found?.standings) ? found.standings.map((s) => s.player) : []));
        const rawOp = (Array.isArray(lsPlayers) && lsPlayers.length > 0) ? lsPlayers : opBase;
        const seenOp = new Set();
        const op = (Array.isArray(rawOp) ? rawOp : [])
          .map((p) => canonicalPlayerName(p))
          .filter((p) => {
            const k = normalizeName(p);
            if (!k || k === "unknown player" || k === "tbd" || seenOp.has(k)) return false;
            if (categoryType === "team" && hasDesired && !desiredSet.has(k)) return false;
            seenOp.add(k);
            return true;
          });
        // Preserve existing saved slots as-is for live categories.
        // Trimming by perGroupCap here can temporarily drop recently added players
        // and trigger match/score regressions while async saves are settling.
        const preservedOp = op;
        const savedMatches = (found?.matches && typeof found.matches === "object") ? found.matches : {};
        const liveMatches = filterMatchesToPlayers(
          (g.matches && typeof g.matches === "object") ? g.matches : {},
          preservedOp
        );
        let matches = rebuildGroupMatches(preservedOp, savedMatches);
        // Live merged matches (server + in-progress edits) always win over rebuild output.
        Object.keys(liveMatches).forEach((mk) => {
          matches[mk] = { ...(matches[mk] || {}), ...(liveMatches[mk] || {}) };
        });
        matches = filterMatchesToPlayers(matches, preservedOp);
        const st = computeRoundRobinStandingsFromMatches(
          matches,
          preservedOp,
          found?.standings,
          selectedCategoryRaw?.gamesPerMatch ?? cat?.gamesPerMatch
        );
        return { ...g, originalPlayers: preservedOp, standings: st, matches };
      });
      // Preserve explicit group slots as-is; do not rebalance/move existing players across groups here.
      // But append newly-approved missing players to least-filled groups so slots auto-fill.
      const presentSet = new Set(
        distributed
          .flatMap((g) => (Array.isArray(g?.originalPlayers) ? g.originalPlayers : []))
          .map((n) => normalizeName(n))
      );
      const missing = desiredUnique.filter((n) => !presentSet.has(normalizeName(n)));
      if (missing.length > 0) {
        const sizes = distributed.map((g) => (Array.isArray(g?.originalPlayers) ? g.originalPlayers.length : 0));
        let idx = sizes.findIndex((s) => s === Math.min(...sizes));
        missing.forEach((name) => {
          const withSpace = sizes
            .map((s, i) => ({ s, i }))
            .filter((x) => x.s < perGroupCap)
            .sort((a, b) => a.s - b.s);
          if (withSpace.length > 0) idx = withSpace[0].i;
          if (idx < 0) idx = 0;
          const g = distributed[idx] || {};
          const op = Array.isArray(g?.originalPlayers) ? g.originalPlayers : [];
          const st = Array.isArray(g?.standings) ? g.standings : [];
          if (op.length >= perGroupCap) return;
          const exists = op.some((p) => normalizeName(p) === normalizeName(name))
            || st.some((r) => normalizeName(r?.player) === normalizeName(name));
          if (!exists) {
            const nextOp = [...op, name];
            const nextSt = [...st, {
              player: name,
              wins: 0,
              losses: 0,
              pointsFor: 0,
              pointsAgainst: 0,
              qualified: false,
            }];
            const nextMatches = rebuildGroupMatches(nextOp, g.matches || {});
            distributed[idx] = { ...g, originalPlayers: nextOp, standings: nextSt, matches: nextMatches };
          }
          sizes[idx] = (Array.isArray(distributed[idx]?.originalPlayers) ? distributed[idx].originalPlayers.length : 0);
          const minSize = Math.min(...sizes);
          idx = sizes.findIndex((s) => s === minSize);
        });
      }
    } else {
      const count = letters.length || 1;
      const buckets = Array.from({ length: count }, () => []);
      desiredUnique.forEach((name, i) => {
        buckets[i % count].push(name);
      });
      distributed = baseGroups.map((g, idx) => {
        const players = buckets[idx] || [];
        const matches = rebuildGroupMatches(players, g.matches || {});
        const standings = computeRoundRobinStandingsFromMatches(
          matches,
          players,
          [],
          selectedCategoryRaw?.gamesPerMatch ?? cat?.gamesPerMatch
        );
        return { ...g, originalPlayers: players, standings, matches };
      });
    }
    const nextCat = { ...cat, groupStage: { groups: distributed } };
    // #region debug-point A:web-bracket-selected-category
    // #endregion
    try {
      const lsElimKey = `elimGpm:${tournament?._id}:${cat._id}`;
      const lsGpmKey = `gpm:${tournament?._id}:${cat._id}`;
      const lsElimRaw = localStorage.getItem(lsElimKey);
      if (lsElimRaw) {
        const lsObj = JSON.parse(lsElimRaw);
        if (lsObj && typeof lsObj === "object") {
          nextCat.eliminationGpm = { ...(nextCat.eliminationGpm || {}), ...lsObj };
        }
      }
      const lsGpmRaw = localStorage.getItem(lsGpmKey);
      if (lsGpmRaw) {
        const v = Math.min(Math.max(Number(lsGpmRaw) || Number(nextCat.gamesPerMatch) || 3, 1), 3);
        nextCat.gamesPerMatch = v;
      }
    } catch {}
    try {
      const baseEm = Array.isArray(nextCat?.eliminationMatches?.matches) ? nextCat.eliminationMatches.matches : [];
      const norm = String(normalizedElimState?.categoryId || "") === String(cat?._id || "")
        ? (Array.isArray(normalizedElimState?.matches) ? normalizedElimState.matches : [])
        : [];
      if (norm.length > 0) {
        const byAlias = new Map();
        norm.forEach((m) => {
          const ids = elimIdAliases(m?.meta?.matchId || m?.matchId || m?.id || m?.round || "");
          ids.forEach((k) => {
            if (!k) return;
            if (!byAlias.has(k)) byAlias.set(k, m);
          });
        });
        const patched = baseEm.map((m) => {
          const candidates = elimIdAliases(m?.id || m?.matchId || m?.title || m?.round || "");
          let hit = null;
          for (const k of candidates) {
            const v = byAlias.get(k);
            if (v) { hit = v; break; }
          }
          if (!hit) return m;
          const s = String(hit?.status || "").trim();
          const incoming = String(m?.status || "").trim().toLowerCase();
          const status = (incoming === "ongoing" || incoming === "completed") ? m.status : (s || "Scheduled");
          return {
            ...m,
            status,
            date: String(hit?.date || m?.date || ""),
            time: String(hit?.time || m?.time || ""),
            court: String(hit?.court || m?.court || ""),
            refereeNote: String(m?.refereeNote || hit?.refereeNote || ""),
            signatureData: String(m?.signatureData || hit?.signatureData || ""),
            gameSignatures: Array.isArray(m?.gameSignatures)
              ? m.gameSignatures
              : (Array.isArray(hit?.gameSignatures) ? hit.gameSignatures : []),
            refereeNumber: String(m?.refereeNumber || hit?.refereeNumber || ""),
          };
        });
        nextCat.eliminationMatches = { ...(nextCat?.eliminationMatches || {}), matches: patched };
      }
    } catch {}
    try {
      const schedForCat = scheduleMap[String(nextCat?._id || selectedCategoryRaw?._id || "")] || {};
      const schedElim = schedForCat?.elimination || {};
      if (schedElim && typeof schedElim === "object") {
        const patched = (Array.isArray(nextCat?.eliminationMatches?.matches) ? nextCat.eliminationMatches.matches : []).map((m) => {
          const keys = elimIdAliases(m?.id || m?.matchId || "");
          let ent = null;
          for (const k of keys) {
            ent = schedElim[k] || schedElim[k?.toLowerCase?.()] || null;
            if (ent) break;
          }
          if (!ent) return m;

          if (!shouldApplyScheduleOverlay(m, ent)) return m;
          const curNorm = String(m?.status || "").trim().toLowerCase();
          if (curNorm === "unschedule" || curNorm === "unscheduled") {
            return {
              ...m,
              date: String(ent?.date || m?.date || ""),
              time: String(ent?.time || m?.time || ""),
              court: String(ent?.court || m?.court || ""),
            };
          }
          const incoming = String(m?.status || "").trim().toLowerCase();
          const sRaw = String(ent?.status || "").trim();
          const sLow = sRaw.toLowerCase();
          const hasSched = Boolean(
            (ent?.date && String(ent.date).trim() !== "") &&
            (ent?.time && String(ent.time).trim() !== "") &&
            (ent?.court && String(ent.court).trim() !== "")
          );
          const sEff = (sLow === "unschedule" || sLow === "unscheduled")
            ? "Unscheduled"
            : (sRaw || (hasSched ? "Scheduled" : "Unscheduled"));
          const status = (incoming === "ongoing" || incoming === "completed") ? m.status : (sEff || "Scheduled");
          return {
            ...m,
            status,
            date: String(ent?.date || m?.date || ""),
            time: String(ent?.time || m?.time || ""),
            court: String(ent?.court || m?.court || ""),
          };
        });
        nextCat.eliminationMatches = { ...(nextCat?.eliminationMatches || {}), matches: patched };
      }
    } catch {}
    try {
      const prevSnapshot = categoryDisplaySnapshotRef.current[String(cat?._id || "")] || null;
      const hasRealProgress = (m) => hasScoreProgress(m);
      const hasFullSchedule = (m) => Boolean(
        String(m?.date || m?.mdDate || "").trim() &&
        String(m?.time || m?.mdTime || "").trim() &&
        String(m?.court || "").trim()
      );
      const isExplicitUnscheduled = (m) => {
        const low = String(m?.status || "").trim().toLowerCase();
        return low === "unschedule" || low === "unscheduled";
      };
      const preserveScheduleFields = (current, prev, meta) => {
        if (!prev || isExplicitUnscheduled(current) || hasFullSchedule(current)) return current;
        if (!hasFullSchedule(prev)) return current;
        const currentStatusLow = String(current?.status || "").trim().toLowerCase();
        const shouldBackfillSchedule = (
          currentStatusLow === "scheduled" ||
          currentStatusLow === "ongoing" ||
          currentStatusLow === "completed" ||
          hasRealProgress(current)
        );
        if (!shouldBackfillSchedule) return current;
        const prevStatus = String(prev?.status || "").trim();
        const nextStatus = currentStatusLow === "ongoing" || currentStatusLow === "completed"
          ? (hasRealProgress(current) ? current.status : (prevStatus || current.status))
          : (current.status || prevStatus);

        return {
          ...current,
          date: String(prev?.date || prev?.mdDate || current?.date || current?.mdDate || ""),
          mdDate: String(prev?.mdDate || prev?.date || current?.mdDate || current?.date || ""),
          time: String(prev?.time || prev?.mdTime || current?.time || current?.mdTime || ""),
          mdTime: String(prev?.mdTime || prev?.time || current?.mdTime || current?.time || ""),
          court: String(prev?.court || current?.court || ""),
          venue: String(prev?.venue || current?.venue || ""),
          status: nextStatus,
        };
      };
      if (prevSnapshot?.groups && Array.isArray(nextCat?.groupStage?.groups)) {
        nextCat.groupStage = {
          ...(nextCat.groupStage || {}),
          groups: nextCat.groupStage.groups.map((g) => {
            const prevGroup = prevSnapshot.groups[String(g?.id || "")] || {};
            const matches = (g?.matches && typeof g.matches === "object") ? g.matches : {};
            const nextMatches = {};
            Object.keys(matches).forEach((mk) => {
              nextMatches[mk] = preserveScheduleFields(matches[mk] || {}, prevGroup[String(mk || "")] || null, {
                categoryId: String(cat?._id || ""),
                groupId: String(g?.id || ""),
                matchKey: String(mk || ""),
              });
            });
            return { ...g, matches: nextMatches };
          }),
        };
      }
      if (prevSnapshot?.elimination && Array.isArray(nextCat?.eliminationMatches?.matches)) {
        nextCat.eliminationMatches = {
          ...(nextCat.eliminationMatches || {}),
          matches: nextCat.eliminationMatches.matches.map((m) => {
            const aliases = elimIdAliases(m?.id || m?.matchId || m?.title || "");
            let prev = null;
            for (const alias of aliases) {
              const hit = prevSnapshot.elimination[String(alias || "")] || null;
              if (hit) { prev = hit; break; }
            }
            return preserveScheduleFields(m, prev, {
              categoryId: String(cat?._id || ""),
              matchId: String(m?.id || m?.matchId || ""),
            });
          }),
        };
      }
    } catch {}
    setAvailableBrackets((prev) => ({ ...prev, [cat._id]: letters }));
    // #region debug-point C:selected-category-end
    // #endregion
    return nextCat;
  }, [selectedCategoryRaw, approvedRegsForCategory, bracketMode, matchEdits, normalizedElimState, scheduleMap]);

  useEffect(() => {
    try {
      const catId = String(selectedCategory?._id || "").trim();
      if (!catId) return;
      const prevSnapshot = categoryDisplaySnapshotRef.current[catId] || { groups: {}, elimination: {} };
      const snapshot = { groups: { ...(prevSnapshot.groups || {}) }, elimination: { ...(prevSnapshot.elimination || {}) } };
      const hasFullSchedule = (m) => Boolean(
        String(m?.date || m?.mdDate || "").trim() &&
        String(m?.time || m?.mdTime || "").trim() &&
        String(m?.court || "").trim()
      );
      const isExplicitUnscheduled = (m) => {
        const low = String(m?.status || "").trim().toLowerCase();
        return low === "unschedule" || low === "unscheduled";
      };
      const groups = Array.isArray(selectedCategory?.groupStage?.groups) ? selectedCategory.groupStage.groups : [];
      groups.forEach((g) => {
        const gid = String(g?.id || "").trim();
        if (!gid) return;
        const matches = (g?.matches && typeof g.matches === "object") ? g.matches : {};
        snapshot.groups[gid] = { ...(snapshot.groups[gid] || {}) };
        Object.keys(matches).forEach((mk) => {
          const m = matches[mk] || {};
          const nextEntry = {
            date: String(m?.date || m?.mdDate || ""),
            mdDate: String(m?.mdDate || m?.date || ""),
            time: String(m?.time || m?.mdTime || ""),
            mdTime: String(m?.mdTime || m?.time || ""),
            court: String(m?.court || ""),
            venue: String(m?.venue || ""),
            status: String(m?.status || ""),
          };
          if (hasFullSchedule(nextEntry) || isExplicitUnscheduled(nextEntry)) {
            snapshot.groups[gid][mk] = nextEntry;
          }
        });
      });
      const elimination = Array.isArray(selectedCategory?.eliminationMatches?.matches) ? selectedCategory.eliminationMatches.matches : [];
      elimination.forEach((m) => {
        const entry = {
          date: String(m?.date || m?.mdDate || ""),
          mdDate: String(m?.mdDate || m?.date || ""),
          time: String(m?.time || m?.mdTime || ""),
          mdTime: String(m?.mdTime || m?.time || ""),
          court: String(m?.court || ""),
          venue: String(m?.venue || ""),
          status: String(m?.status || ""),
        };
        if (hasFullSchedule(entry) || isExplicitUnscheduled(entry)) {
          elimIdAliases(m?.id || m?.matchId || m?.title || "").forEach((alias) => {
            if (!alias) return;
            snapshot.elimination[String(alias)] = entry;
          });
        }
      });
      categoryDisplaySnapshotRef.current = {
        ...categoryDisplaySnapshotRef.current,
        [catId]: snapshot,
      };
    } catch {}
  }, [selectedCategory]);

  // Ensure dashboard-visible slot order/count is the actual saved backend truth.
  // Without this, Brackets.jsx can show local-only slot fills (approved regs/localStorage)
  // that Tournament.jsx cannot possibly mirror.
  useEffect(() => {
    try {
      if (!tournament?._id || !selectedCategory?._id) return;
      if (isEditing) return;
      const catId = String(selectedCategory._id);
      const groups = Array.isArray(selectedCategory?.groupStage?.groups) ? selectedCategory.groupStage.groups : [];
      if (groups.length === 0) return;

      const key = JSON.stringify(
        groups.map((g) => ({
          id: String(g?.id || ""),
          originalPlayers: Array.isArray(g?.originalPlayers) ? g.originalPlayers.map((p) => String(p ?? "")) : [],
        }))
      );
      const lastKey = lastPersistedSlotsKeyRef.current.get(catId);
      if (lastKey === key) return;

      if (autoPersistSlotsTimerRef.current) clearTimeout(autoPersistSlotsTimerRef.current);
      autoPersistSlotsTimerRef.current = setTimeout(async () => {
        try {
          const freshRes = await apiClient.get(`/tournaments/${tournament._id}?ts=${Date.now()}`);
          const fresh = freshRes?.data?.tournament || freshRes?.data || {};
          const baseCats = Array.isArray(fresh?.tournamentCategories) ? fresh.tournamentCategories.map((c) => ({ ...c })) : [];
          const idx = baseCats.findIndex((c) => String(c?._id) === String(catId));
          if (idx < 0) return;

          const payloadGroups = groups.map((g) => ({
            ...g,
            id: String(g?.id || ""),
            name: String(g?.name || ""),
            originalPlayers: Array.isArray(g?.originalPlayers) ? g.originalPlayers.map((p) => String(p ?? "")) : [],
            standings: Array.isArray(g?.standings) ? g.standings.map((r) => ({ ...r, player: String(r?.player ?? "") })) : [],
            matches: (g?.matches && typeof g.matches === "object") ? g.matches : {},
          }));

          const serverCat = baseCats[idx] || {};
          baseCats[idx] = {
            ...serverCat,
            groupStage: { ...(serverCat?.groupStage || {}), groups: payloadGroups },
          };
          const res = await apiClient.put(`/tournaments/${tournament._id}`, { tournamentCategories: baseCats });
          const next = res?.data?.tournament || null;
          if (next) setTournament(next);
          lastPersistedSlotsKeyRef.current.set(catId, key);
        } catch {
          // Silent: bracket still works locally; save buttons still exist as fallback.
        }
      }, 400);
    } catch {}
    return () => {
      try {
        if (autoPersistSlotsTimerRef.current) clearTimeout(autoPersistSlotsTimerRef.current);
      } catch {}
    };
  }, [tournament?._id, selectedCategory?._id, selectedCategory?.groupStage?.groups, isEditing, setTournament]);

  const onSubmitPoints = async (category) => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const roles = Array.isArray(user?.roles) ? user.roles : [];
      const isPrivileged = roles.includes("superadmin") || roles.includes("clubadmin");
      if (!isPrivileged) return;
      const tier = 1;
      await apiClient.post(`/tournaments/${tournament?._id}/categories/${category?._id}/submit-points`, { tournamentTier: tier });
    } catch {}
  };

  const canSubmitPoints = (() => {
    try {
      const user = JSON.parse(localStorage.getItem("user") || "{}");
      const roles = Array.isArray(user?.roles) ? user.roles : [];
      return roles.includes("superadmin") || roles.includes("clubadmin");
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    latestTournamentRef.current = tournament;
  }, [tournament]);

  useEffect(() => {
    matchEditsRef.current = matchEdits || {};
  }, [matchEdits]);

  useEffect(() => {
    const catId = String(selectedCategoryRaw?._id || "").trim();
    if (!catId) return;
    if (bracketLoaderShownCategoriesRef.current.has(catId)) return;
    bracketLoaderShownCategoriesRef.current.add(catId);
    bracketSettlingPendingCategoryRef.current = catId;
    showBracketSettlingLoader(4500);
  }, [selectedCategoryRaw?._id, showBracketSettlingLoader]);

  useEffect(() => {
    const tId = String(tournament?._id || "").trim();
    const cId = String(selectedCategoryRaw?._id || "").trim();
    if (!tId || !cId) {
      setNormalizedElimState({ categoryId: "", matches: [] });
      return;
    }
    let cancelled = false;
    setNormalizedElimState({ categoryId: cId, matches: [] });
    // #region debug-point A:normalized-fetch-start
    // #endregion
    (async () => {
      try {
        const res = await apiClient.get(`/tournaments/${tId}/categories/${cId}/elimination/matches-normalized`);
        if (cancelled) return;
        const arr = Array.isArray(res?.data?.matches) ? res.data.matches : [];
        // #region debug-point A:normalized-fetch-success
        // #endregion
        setNormalizedElimState({ categoryId: cId, matches: arr });
      } catch {
        // #region debug-point A:normalized-fetch-error
        // #endregion
        if (!cancelled) setNormalizedElimState({ categoryId: cId, matches: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [tournament?._id, selectedCategoryRaw?._id]);

  useEffect(() => {
    // Rehydrate persisted elimination status overrides on reload/open.
    try {
      const tId = String(tournament?._id || "").trim();
      if (!tId) return;
      const cats = Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : [];
      cats.forEach((c) => {
        const cId = String(c?._id || "").trim();
        if (!cId) return;
        const raw = localStorage.getItem(`elimStatus:${tId}:${cId}`);
        const parsed = JSON.parse(raw || "null");
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
          elimStatusOverridesRef.current[cId] = { ...(elimStatusOverridesRef.current[cId] || {}), ...parsed };
          elimStatusOverrideUntilRef.current[cId] = Date.now() + ELIM_STATUS_OVERRIDE_TTL_MS;
        }
      });
    } catch {}
  }, [tournament?._id, tournament?.tournamentCategories]);

  useEffect(() => {
    if (!selectedCategory) return;
    const categoryId = selectedCategory._id;
    if (!initializedCategories.current.has(categoryId)) {
      const letters = availableBrackets[categoryId] || computeLetters(selectedCategory);
      setSelectedBrackets((prev) => {
        const current = prev[categoryId];
        const next = letters.includes(current) ? current : letters[0];
        return { ...prev, [categoryId]: next };
      });
      setShowRoundRobinMap((prev) => ({ ...prev, [categoryId]: true }));
      setShowEliminationMap((prev) => ({ ...prev, [categoryId]: false }));
      initializedCategories.current.add(categoryId);
    } else {
      // Keep selected bracket valid if availableBrackets changed, but don't toggle the view
      const letters = availableBrackets[categoryId] || computeLetters(selectedCategory);
      setSelectedBrackets((prev) => {
        const current = prev[categoryId];
        const next = letters.includes(current) ? current : letters[0];
        if (current === next) return prev;
        return { ...prev, [categoryId]: next };
      });
    }
  }, [selectedCategory, availableBrackets]);

  // Auto-refresh tournament data to pick up status changes from mobile app
  useEffect(() => {
    if (!tournament?._id) return;
    const activeCatId = String(selectedCategoryRaw?._id || "").trim();
    let bc = null;
    const hasPendingMatchEdits = () => {
      const pendingEdits = matchEditsRef.current || {};
      return Object.values(pendingEdits).some(
        (groupEdits) => groupEdits && typeof groupEdits === "object" && Object.keys(groupEdits).length > 0
      );
    };
    const mergeScheduleIntoCategories = (freshCategories, currentCategories) => {
      if (!Array.isArray(freshCategories) || currentCategories.length === 0) return freshCategories;
      return freshCategories.map((fc) => {
        const cc = currentCategories.find((c) => String(c?._id) === String(fc?._id));
        if (!cc?.groupStage?.groups) return fc;
        const freshGroups = Array.isArray(fc?.groupStage?.groups) ? fc.groupStage.groups : [];
        const curGroups = Array.isArray(cc?.groupStage?.groups) ? cc.groupStage.groups : [];
        const nextGroups = freshGroups.map((fg) => {
          const cg = curGroups.find((g) => String(g?.id) === String(fg?.id));
          if (!cg) return fg;
          const nextMatches = { ...(fg.matches || {}) };
          if (cg.matches && typeof cg.matches === "object") {
            Object.keys(cg.matches).forEach((mk) => {
              const curMatch = cg.matches[mk] || {};
              const curStatus = String(curMatch.status || "").trim().toLowerCase();
              const curHasScoreProgress = hasScoreProgress(curMatch);
              if ((curStatus === "ongoing" || curStatus === "completed") && curHasScoreProgress) {
                // Preserve actual live/completed progress, but do not let stale status-only rows override fresh schedule data.
                const fresh = nextMatches[mk] || {};
                const merged = { ...fresh, ...curMatch, status: curMatch.status };
                merged.refereeNote = String(curMatch?.refereeNote || "").trim() ? curMatch.refereeNote : (fresh.refereeNote || "");
                merged.signatureData = String(curMatch?.signatureData || "").trim() ? curMatch.signatureData : (fresh.signatureData || "");
                merged.refereeNumber = String(curMatch?.refereeNumber || "").trim() ? curMatch.refereeNumber : (fresh.refereeNumber || "");
                merged.gameSignatures = (Array.isArray(curMatch?.gameSignatures) && curMatch.gameSignatures.length > 0)
                  ? curMatch.gameSignatures
                  : (Array.isArray(fresh?.gameSignatures) ? fresh.gameSignatures : []);
                nextMatches[mk] = merged;
              } else if (curHasScoreProgress) {
                const fresh = nextMatches[mk] || {};
                const merged = { ...fresh, ...curMatch };
                merged.refereeNote = String(curMatch?.refereeNote || "").trim() ? curMatch.refereeNote : (fresh.refereeNote || "");
                merged.signatureData = String(curMatch?.signatureData || "").trim() ? curMatch.signatureData : (fresh.signatureData || "");
                merged.refereeNumber = String(curMatch?.refereeNumber || "").trim() ? curMatch.refereeNumber : (fresh.refereeNumber || "");
                merged.gameSignatures = (Array.isArray(curMatch?.gameSignatures) && curMatch.gameSignatures.length > 0)
                  ? curMatch.gameSignatures
                  : (Array.isArray(fresh?.gameSignatures) ? fresh.gameSignatures : []);
                nextMatches[mk] = merged;
              }
            });
          }
          Object.keys(nextMatches).forEach((mk) => {
            nextMatches[mk] = normalizePassiveMatchStatus(nextMatches[mk]);
          });
          const useCurPlayers = Array.isArray(cg.originalPlayers) && cg.originalPlayers.length > 0;
          const useCurStandings = Array.isArray(cg.standings) && cg.standings.length > 0;
          return {
            ...fg,
            matches: nextMatches,
            originalPlayers: useCurPlayers ? cg.originalPlayers : fg.originalPlayers,
            standings: useCurStandings ? cg.standings : fg.standings,
          };
        });
        const freshElim = Array.isArray(fc?.eliminationMatches?.matches) ? fc.eliminationMatches.matches : [];
        const curElim = Array.isArray(cc?.eliminationMatches?.matches) ? cc.eliminationMatches.matches : [];
        const catKey = String(fc?._id || "");
        const allowManual = Date.now() < Number(elimStatusOverrideUntilRef.current[catKey] || 0);
        const manualMap = allowManual ? (elimStatusOverridesRef.current[catKey] || {}) : {};
        const findCurrentElim = (fm) => {
          const aliases = new Set(elimIdAliases(fm?.id));
          const tNorm = String(fm?.title || "").trim().toLowerCase();
          return curElim.find((cm) => {
            const cmAliases = elimIdAliases(cm?.id);
            const idHit = cmAliases.some((a) => aliases.has(a));
            if (idHit) return true;
            const cmTitle = String(cm?.title || "").trim().toLowerCase();
            return Boolean(tNorm && cmTitle && tNorm === cmTitle);
          }) || null;
        };
        const nextElim = (freshElim.length > 0 ? freshElim : curElim).map((fm) => {
          const manualStatus = (() => {
            const ids = elimIdAliases(fm?.id);
            for (const k of ids) {
              const hit = String(manualMap[k] || "").trim();
              if (hit) return hit;
            }
            return "";
          })();
          if (manualStatus) return { ...fm, status: manualStatus };
          const cm = findCurrentElim(fm);
          const freshStatus = String(fm?.status || "").trim().toLowerCase();
          const curStatus = String(cm?.status || "").trim();
          const curNorm = curStatus.toLowerCase();
          if ((freshStatus === "scheduled" || !freshStatus) && (curNorm === "ongoing" || curNorm === "completed")) {
            return { ...fm, status: curStatus };
          }
          return fm;
        });
        return {
          ...fc,
          groupStage: { ...(fc.groupStage || {}), groups: nextGroups },
          eliminationMatches: {
            ...(fc?.eliminationMatches || {}),
            matches: nextElim
          }
        };
      });
    };
    const refreshTournament = async ({ force = false } = {}) => {
      try {
        if (!force && Date.now() < (skipAutoRefreshUntilRef.current || 0)) return;
        if (hasPendingMatchEdits()) return;
        // Avoid request pile-up when deployed latency is high.
        if (autoRefreshInFlightRef.current) return;
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        autoRefreshInFlightRef.current = true;
        const requestSeq = ++bracketRefreshSeqRef.current;
        lastAutoRefreshAtRef.current = Date.now();
        const currentTournament = latestTournamentRef.current || {};
        const currentTournamentId = currentTournament?._id || tournament?._id;
        if (!currentTournamentId) return;
        const freshRes = await apiClient.get(`/tournaments/${currentTournamentId}`, {
          headers: bracketPollEtagRef.current ? { "If-None-Match": bracketPollEtagRef.current } : {},
          validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
        });
        if (freshRes?.status === 304) {
          finishBracketSettlingLoader(activeCatId);
          return;
        }
        const nextEtag = String(freshRes?.headers?.etag || "").trim();
        if (nextEtag) bracketPollEtagRef.current = nextEtag;
        const fresh = freshRes?.data?.tournament || freshRes?.data || null;
        if (!fresh) return;
        if (requestSeq !== bracketRefreshSeqRef.current) return;
        const cur = currentTournament;
        const freshUpdatedAtMs = fresh?.updatedAt ? new Date(fresh.updatedAt).getTime() : 0;
        const currentUpdatedAtMs = cur?.updatedAt ? new Date(cur.updatedAt).getTime() : 0;
        if (freshUpdatedAtMs && currentUpdatedAtMs && freshUpdatedAtMs < currentUpdatedAtMs) return;
        const curCats = Array.isArray(cur?.tournamentCategories) ? cur.tournamentCategories : [];
        const freshCats = Array.isArray(fresh?.tournamentCategories) ? fresh.tournamentCategories : [];
        const merged = {
          ...fresh,
          // The scheduler is the source of truth for date/time/court data.
          // Always prefer fresh schedule payload so Brackets reflects unschedule/re-schedule immediately.
          courtAssignments: fresh.courtAssignments || {},
          courtAssignmentsByDate: fresh.courtAssignmentsByDate || {},
          tournamentCategories: mergeScheduleIntoCategories(freshCats, curCats),
        };
        // #region debug-point B:web-bracket-refresh-merge
        setTournament(merged);
        finishBracketSettlingLoader(activeCatId);
      } catch {
      } finally {
        autoRefreshInFlightRef.current = false;
      }
    };
    refreshTournament({ force: true });
    const handleFocusRefresh = () => {
      refreshTournament({ force: true });
    };
    const handleVisibilityChange = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      handleFocusRefresh();
    };
    if (typeof window !== "undefined") window.addEventListener("focus", handleFocusRefresh);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", handleVisibilityChange);
    try {
      bc = new BroadcastChannel("tournament_updates");
      bc.onmessage = (ev) => {
        const msg = ev?.data || {};
        if (String(msg?.tournamentId || "") !== String(tournament?._id || "")) return;
        const type = String(msg?.type || "");
        if (!["schedule", "brackets", "group", "elimination"].includes(type)) return;
        refreshTournament({ force: true });
      };
    } catch {}
    return () => {
      if (typeof window !== "undefined") window.removeEventListener("focus", handleFocusRefresh);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", handleVisibilityChange);
      try { bc && bc.close(); } catch {}
      autoRefreshInFlightRef.current = false;
    };
  }, [tournament?._id, selectedCategoryRaw?._id, setTournament, finishBracketSettlingLoader]);

  const handleChangeMode = (newMode) => {
    const cat = selectedCategoryRaw;
    if (!cat?._id) return;
    if (isEditing) {
      try { toast.error("Please save/cancel edits before changing bracket count."); } catch {}
      return;
    }
    const valid = [1, 2, 4, 8].includes(Number(newMode)) ? Number(newMode) : 4;
    const catId = String(cat._id);
    const tId = String(tournament?._id || "");
    const nextLetters = ["A", "B", "C", "D", "E", "F", "G", "H"].slice(0, Math.max(valid, 1));

    const desiredAll = (approvedRegsForCategory || [])
      .map((reg) => derivePlayerName(reg, cat?.division || cat?.name || ""))
      .map((n) => canonicalPlayerName(n))
      .filter((n) => {
        const k = normalizeName(n);
        return !!k && k !== "unknown player" && k !== "tbd";
      });
    const desiredSet = new Set();
    const desiredUnique = desiredAll.filter((n) => {
      const k = normalizeName(n);
      if (!k || desiredSet.has(k)) return false;
      desiredSet.add(k);
      return true;
    });

    const existingGroups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
    const pooledMatches = {};
    let pooledIdx = 0;
    existingGroups.forEach((g) => {
      const m = g?.matches && typeof g.matches === "object" ? g.matches : {};
      Object.values(m).forEach((row) => {
        const p1 = String(row?.player1Name || row?.player1 || "").trim();
        const p2 = String(row?.player2Name || row?.player2 || "").trim();
        if (!p1 || !p2) return;
        pooledMatches[`m${pooledIdx}`] = row;
        pooledIdx += 1;
      });
    });

    const allFromExisting = [];
    existingGroups.forEach((g) => {
      const gid = String(g?.id || "").trim();
      let lsPlayers = [];
      try {
        const lsKey = `rrPlayers:${tId}:${catId}:${gid}`;
        const lsRaw = localStorage.getItem(lsKey);
        const parsed = JSON.parse(lsRaw || "null");
        if (Array.isArray(parsed)) lsPlayers = parsed;
      } catch {}
      const opFromMatches = inferPlayerOrderFromMatches(g?.matches || {});
      const opBase = (Array.isArray(g?.originalPlayers) && g.originalPlayers.length)
        ? g.originalPlayers
        : (opFromMatches.length > 0
            ? opFromMatches
            : (Array.isArray(g?.standings) ? g.standings.map((s) => s.player) : []));
      const rawOp = (Array.isArray(lsPlayers) && lsPlayers.length > 0) ? lsPlayers : opBase;
      (Array.isArray(rawOp) ? rawOp : []).forEach((p) => {
        const nm = canonicalPlayerName(p);
        const k = normalizeName(nm);
        if (!k || k === "unknown player" || k === "tbd") return;
        allFromExisting.push(nm);
      });
    });

    const mergedPlayers = (() => {
      const seed = allFromExisting.length > 0 ? allFromExisting : desiredUnique;
      const out = [];
      const seen = new Set();
      seed.forEach((n) => {
        const k = normalizeName(n);
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push(n);
      });
      desiredUnique.forEach((n) => {
        const k = normalizeName(n);
        if (!k || seen.has(k)) return;
        seen.add(k);
        out.push(n);
      });
      return out;
    })();

    const buckets = Array.from({ length: Math.max(valid, 1) }, () => []);
    mergedPlayers.forEach((name, i) => {
      buckets[i % Math.max(valid, 1)].push(name);
    });

    const gamesPerMatch = selectedCategoryRaw?.gamesPerMatch ?? cat?.gamesPerMatch;
    const nextGroups = nextLetters.map((L, idx) => {
      const gid = `group-${String(L).toLowerCase()}`;
      const found = existingGroups.find((g) => String(g?.id) === String(gid)) || {};
      const players = buckets[idx] || [];
      const matches = rebuildGroupMatches(players, pooledMatches);
      const standings = computeRoundRobinStandingsFromMatches(matches, players, found?.standings, gamesPerMatch);
      return {
        ...found,
        id: gid,
        name: found?.name || `Group ${L}`,
        originalPlayers: players,
        standings,
        matches,
      };
    });

    setBracketMode((prev) => ({ ...prev, [catId]: valid }));
    setTournament((prev) => {
      if (!prev || !Array.isArray(prev?.tournamentCategories)) return prev;
      const nextCats = prev.tournamentCategories.map((c) => {
        if (String(c?._id) !== catId) return c;
        const gs = c?.groupStage && typeof c.groupStage === "object" ? c.groupStage : {};
        const curGroups = Array.isArray(gs?.groups) ? gs.groups : [];
        const nextIds = new Set(nextGroups.map((g) => String(g?.id || "")));
        const extras = curGroups.filter((g) => !nextIds.has(String(g?.id || "")));
        return {
          ...c,
          bracketMode: valid,
          groupStage: { ...gs, groups: [...nextGroups, ...extras] },
        };
      });
      return { ...prev, tournamentCategories: nextCats };
    });
    setSelectedBrackets((prev) => {
      const cur = prev?.[catId];
      const next = nextLetters.includes(cur) ? cur : nextLetters[0];
      return { ...(prev || {}), [catId]: next };
    });
    try {
      if (tId) {
        const prefix = `rrPlayers:${tId}:${catId}:`;
        nextGroups.forEach((g) => {
          const gid = String(g?.id || "");
          if (!gid) return;
          localStorage.setItem(`${prefix}${gid}`, JSON.stringify(Array.isArray(g?.originalPlayers) ? g.originalPlayers : []));
        });
      }
    } catch {}
  };

  const resetSequencesForSelectedCategory = async () => {
    try {
      const cat = selectedCategoryRaw;
      if (!tournament?._id || !cat?._id) return;
      let user = {};
      try { user = JSON.parse(sessionStorage.getItem("user_session") || localStorage.getItem("user") || "{}"); } catch {}
      const token = user?.token || "";
      const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
      const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`, opts);
      const fresh = freshRes?.data?.tournament || freshRes?.data || {};
      const baseCats = Array.isArray(fresh?.tournamentCategories) ? fresh.tournamentCategories.map((c) => ({ ...c })) : [];
      const idx = baseCats.findIndex((c) => String(c?._id) === String(cat._id));
      if (idx < 0) return;
      const curr = { ...(baseCats[idx] || {}) };
      const gs = curr.groupStage && typeof curr.groupStage === "object" ? { ...curr.groupStage } : { groups: [] };
      const groups = Array.isArray(gs.groups) ? gs.groups.map((g) => ({ ...g })) : [];
      const letters = computeLetters(curr);
      const letterIds = letters.map((L) => `group-${L.toLowerCase()}`);
      // Build desired baseline players from approved registrations for this category
      const regs = Array.isArray(fresh?.registrations) ? fresh.registrations : (tournament?.registrations || []);
      const approved = regs.filter((reg) => {
        const status = String(reg?.status || "").toLowerCase();
        if (status !== "approved") return false;
        const regCatId = reg?.categoryId;
        const regCat = reg?.category;
        const regCatStr = typeof regCat === "string" ? regCat : (regCat?._id || regCat?.division);
        const catId = curr?._id;
        const catDiv = curr?.division;
        return (
          (regCatId && (String(regCatId) === String(catId))) ||
          (regCatStr && (String(regCatStr) === String(catId) || String(regCatStr) === String(catDiv)))
        );
      });
      const desired = approved
        .map((reg) => derivePlayerName(reg, curr?.division || curr?.name || ""))
        .map((n) => String(n || "").trim())
        .filter(Boolean);
      // Keep only unique players/pairs so reset never duplicates slots across brackets.
      const seenDesired = new Set();
      const desiredUnique = desired.filter((name) => {
        const k = normalizeName(name);
        if (!k || seenDesired.has(k)) return false;
        seenDesired.add(k);
        return true;
      });
      // Evenly distribute desired players across bracket letters deterministically
      const count = letters.length || 1;
      const buckets = Array.from({ length: count }, () => []);
      desiredUnique.forEach((name, i) => {
        buckets[i % count].push(name);
      });
      // Rebuild next groups strictly from buckets to reset sequence completely
      const nextGroups = letterIds.map((gid, idx) => {
        const gFound = groups.find((g) => String(g?.id) === String(gid)) || { id: gid, name: `Group ${letters[idx]}`, matches: {} };
        const players = buckets[idx] || [];
        const standings = players.map((p) => ({
          player: String(p || ""),
          wins: 0,
          losses: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          pointDifferential: 0,
          rankPoints: 0,
          qualified: false,
        }));
        const matches = rebuildGroupMatches(players, gFound.matches || {});
        return { ...gFound, originalPlayers: players, standings, matches };
      });
      gs.groups = nextGroups;
      curr.bracketMode = count;
      curr.groupStage = gs;
      baseCats[idx] = curr;
      // Clear stale local sequence cache for this category, then seed it from reset output.
      try {
        const prefix = `rrPlayers:${tournament?._id}:${cat?._id}:`;
        Object.keys(localStorage || {}).forEach((k) => {
          if (String(k || "").startsWith(prefix)) localStorage.removeItem(k);
        });
        nextGroups.forEach((g) => {
          const gid = String(g?.id || "");
          if (!gid) return;
          localStorage.setItem(`${prefix}${gid}`, JSON.stringify(Array.isArray(g?.originalPlayers) ? g.originalPlayers : []));
        });
      } catch {}
      await apiClient.put(`/tournaments/${tournament?._id}`, { tournamentCategories: baseCats }, opts);
      const perGroupTasks = nextGroups.flatMap((g) => {
        const gid = String(g?.id || "");
        return [
          apiClient.put(`/tournaments/${tournament?._id}/categories/${cat?._id}/groups/${gid}/standings`, { standings: g.standings }, opts),
          putGroupMatchesWithReopen(cat?._id, gid, g.matches, opts),
        ];
      });
      await Promise.allSettled(perGroupTasks);
      const refresh = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`, opts);
      const next = refresh?.data?.tournament || refresh?.data || null;
      if (next) setTournament(next);
      toast.success("Reset sequences for all brackets");
    } catch {}
  };

  const handleToggleEdit = () => {
    setIsEditing((v) => {
      if (v) {
        try {
          const cat = selectedCategory;
          if (cat) {
            const letter = selectedBrackets[cat._id];
            const gid = `group-${String(letter || "").toLowerCase()}`;
            const k = `${cat._id}:${gid}`;
            setMatchEdits((prev) => {
              const next = { ...prev };
              delete next[k];
              return next;
            });
          }
        } catch {}
      }
      return !v;
    });
  };

  const upsertGroupAndSaveMatches = async (cat, gid, fullMatches, groupSnapshot = null) => {
    try {
      if (!tournament?._id || !cat?._id || !gid) return;
      const letters = computeLetters(cat);
      const letter = String(gid).replace(/^group-/, "").toUpperCase();
      const groupName = `Group ${letter}`;
      const normalizedSnapshot = (() => {
        const g = groupSnapshot && typeof groupSnapshot === "object" ? groupSnapshot : {};
        const op = Array.isArray(g?.originalPlayers) ? g.originalPlayers.map((p) => canonicalPlayerName(p)).filter(Boolean) : [];
        const st = Array.isArray(g?.standings)
          ? g.standings.map((r) => ({
              ...r,
              player: canonicalPlayerName(r?.player),
            }))
          : [];
        return { originalPlayers: op, standings: st };
      })();
      // Fetch fresh tournament to avoid overwriting other categories
      const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
      const fresh = freshRes?.data?.tournament || freshRes?.data || {};
      const baseCats = Array.isArray(fresh?.tournamentCategories) ? fresh.tournamentCategories.map((c) => ({ ...c })) : [];
      const idx = baseCats.findIndex((c) => String(c?._id) === String(cat._id));
      if (idx >= 0) {
        const curr = { ...(baseCats[idx] || {}) };
        const gs = curr.groupStage && typeof curr.groupStage === "object" ? { ...curr.groupStage } : { groups: [] };
        const groups = Array.isArray(gs.groups) ? gs.groups.map((g) => ({ ...g })) : [];
        let gIdx = groups.findIndex((g) => String(g?.id) === String(gid));
        if (gIdx < 0) {
          groups.push({
            id: gid,
            name: groupName,
            originalPlayers: normalizedSnapshot.originalPlayers,
            standings: normalizedSnapshot.standings,
            matches: { ...(fullMatches || {}) }
          });
          gIdx = groups.length - 1;
        } else {
          const g = { ...(groups[gIdx] || {}) };
          const base = g.matches && typeof g.matches === "object" ? { ...g.matches } : {};
          const merged = { ...base, ...(fullMatches || {}) };
          g.matches = merged;
          if (!g.name) g.name = groupName;
          if (normalizedSnapshot.originalPlayers.length > 0) g.originalPlayers = normalizedSnapshot.originalPlayers;
          if (normalizedSnapshot.standings.length > 0) g.standings = normalizedSnapshot.standings;
          groups[gIdx] = g;
        }
        gs.groups = groups;
        curr.groupStage = gs;
        const bm = bracketMode[cat._id];
        const bmValid = [1, 2, 4, 8].includes(Number(bm)) ? Number(bm) : curr.bracketMode || letters.length;
        curr.bracketMode = bmValid;
        baseCats[idx] = curr;
      }
      // Persist only the merged categories array built from fresh data
      await apiClient.put(`/tournaments/${tournament?._id}`, { tournamentCategories: baseCats });
      // Now persist matches via group endpoint
      await apiClient.put(`/tournaments/${tournament?._id}/categories/${cat?._id}/groups/${gid}/matches`, { matches: fullMatches });
    } catch {
      // Swallow here; callers may retry or ignore
    }
  };

  const saveMatchesOnly = async (changes) => {
    try {
      const cat = selectedCategory;
      if (!cat) return;
      
      // Check which changes are for group matches and which are for elimination matches
      const elimMatches = Array.isArray(cat?.eliminationMatches?.matches) ? cat.eliminationMatches.matches : [];
      const elimMatchIds = new Set(elimMatches.map(m => String(m?.id || "")));
      
      const groupChanges = {};
      const elimChanges = {};
      Object.keys(changes || {}).forEach(mk => {
        if (elimMatchIds.has(mk)) {
          elimChanges[mk] = changes[mk];
        } else {
          groupChanges[mk] = changes[mk];
        }
      });

      // Process group matches (existing logic)
      if (Object.keys(groupChanges).length > 0) {
      const letter = selectedBrackets[cat._id];
      const gid = `group-${String(letter || "").toLowerCase()}`;
      const baseGroup = (selectedCategory?.groupStage?.groups || []).find((g) => g.id === gid) || null;
      const baseMatches = (baseGroup && baseGroup.matches) ? { ...baseGroup.matches } : {};
      const fullPayload = { ...baseMatches };
      Object.keys(groupChanges || {}).forEach((mk) => {
        const orig = baseMatches[mk] || {};
        const ov = groupChanges[mk] || {};
        fullPayload[mk] = { ...orig, ...ov };
      });
      try {
        const keys = Object.keys(groupChanges || {});
        keys.forEach((mk) => {
          const m = fullPayload[mk] || {};
          const toN = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? 0 : n; };
          const gpm = Math.min(Math.max(Number(selectedCategory?.gamesPerMatch ?? 3), 1), 3);
          const g1a = toN(m.game1Player1), g1b = toN(m.game1Player2);
          const g2a = toN(m.game2Player1), g2b = toN(m.game2Player2);
          const g3a = toN(m.game3Player1), g3b = toN(m.game3Player2);
          const sets = [[g1a,g1b],[g2a,g2b],[g3a,g3b]].slice(0,gpm);
          let w1 = 0, w2 = 0;
          sets.forEach(([a,b]) => { if (a>b) w1++; else if (b>a) w2++; });
          m.finalScorePlayer1 = w1;
          m.finalScorePlayer2 = w2;
          const setsToWin = Math.ceil(gpm / 2);
          const anyPoints = sets.some(([a,b]) => (a+b) > 0);
          if (w1 >= setsToWin || w2 >= setsToWin) m.status = "Completed";
          else if (anyPoints) m.status = "Ongoing";
          fullPayload[mk] = m;
        });
        console.log('[QUICK-SAVE] RR fullPayload', fullPayload);
      } catch {}
      // Always upsert group first so newly-added slots/players are persisted before scores/status.
      await upsertGroupAndSaveMatches(cat, gid, fullPayload, baseGroup);
      await putGroupMatchesWithReopen(cat?._id, gid, fullPayload);
      try {
        const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
        const fresh = freshRes?.data?.tournament || freshRes?.data || null;
        if (fresh) setTournament(fresh);
      } catch {}
      broadcastBracketUpdate({ action: "save-group-matches", categoryId: String(cat?._id || ""), groupId: String(gid || "") });
      try {
        setTournament((prev) => {
          const t = prev ? { ...prev } : null;
          if (!t) return prev;
          const cats = Array.isArray(t.tournamentCategories) ? t.tournamentCategories.map((c) => ({ ...c })) : [];
          const ci = cats.findIndex((c) => String(c?._id) === String(cat?._id));
          if (ci < 0) return prev;
          const curr = { ...(cats[ci] || {}) };
          const gs = curr.groupStage && typeof curr.groupStage === "object" ? { ...curr.groupStage } : { groups: [] };
          const groups = Array.isArray(gs.groups) ? gs.groups.map((g) => ({ ...g })) : [];
          const gi = groups.findIndex((g) => String(g?.id) === String(gid));
          if (gi < 0) return prev;
          const g = { ...(groups[gi] || {}) };
          const base = g.matches && typeof g.matches === "object" ? { ...g.matches } : {};
          g.matches = { ...base, ...fullPayload };
          groups[gi] = g;
          gs.groups = groups;
          curr.groupStage = gs;
          cats[ci] = curr;
          const next = { ...t, tournamentCategories: cats };
          return next;
        });
        setSelectedCategory((prev) => {
          const c = prev ? { ...prev } : null;
          if (!c) return prev;
          const gs = c.groupStage && typeof c.groupStage === "object" ? { ...c.groupStage } : { groups: [] };
          const groups = Array.isArray(gs.groups) ? gs.groups.map((g) => ({ ...g })) : [];
          const gi = groups.findIndex((g) => String(g?.id) === String(gid));
          if (gi < 0) return prev;
          const g = { ...(groups[gi] || {}) };
          const base = g.matches && typeof g.matches === "object" ? { ...g.matches } : {};
          g.matches = { ...base, ...fullPayload };
          groups[gi] = g;
          gs.groups = groups;
          const next = { ...c, groupStage: gs };
          return next;
        });
      } catch {}
      try {
        const k = `${cat._id}:${gid}`;
        const changedKeys = Object.keys(groupChanges || {});
        if (changedKeys.length) {
          setMatchEdits((prev) => {
            const next = { ...prev };
            const groupEdits = { ...(next[k] || {}) };
            changedKeys.forEach((mk) => {
              if (groupEdits[mk]) delete groupEdits[mk];
            });
            if (Object.keys(groupEdits).length) next[k] = groupEdits;
            else delete next[k];
            return next;
          });
        }
      } catch {}
      }

      // Process elimination matches
      if (Object.keys(elimChanges).length > 0) {
        // Update elimination matches locally first
        try {
          setTournament((prev) => {
            const t = prev ? { ...prev } : null;
            if (!t) return prev;
            const cats = Array.isArray(t.tournamentCategories) ? t.tournamentCategories.map((c) => ({ ...c })) : [];
            const ci = cats.findIndex((c) => String(c?._id) === String(cat?._id));
            if (ci < 0) return prev;
            const curr = { ...(cats[ci] || {}) };
            const em = Array.isArray(curr.eliminationMatches?.matches) ? curr.eliminationMatches.matches : [];
            const updatedEm = em.map(m => {
              const mk = String(m?.id || "");
              if (elimChanges[mk]) {
                return { ...m, ...elimChanges[mk] };
              }
              return m;
            });
            curr.eliminationMatches = { ...(curr.eliminationMatches || {}), matches: updatedEm };
            cats[ci] = curr;
            const next = { ...t, tournamentCategories: cats };
            return next;
          });
          
          setSelectedCategory((prev) => {
            const c = prev ? { ...prev } : null;
            if (!c) return prev;
            const em = Array.isArray(c.eliminationMatches?.matches) ? c.eliminationMatches.matches : [];
            const updatedEm = em.map(m => {
              const mk = String(m?.id || "");
              if (elimChanges[mk]) {
                return { ...m, ...elimChanges[mk] };
              }
              return m;
            });
            const next = { ...c, eliminationMatches: { ...(c.eliminationMatches || {}), matches: updatedEm } };
            return next;
          });
        } catch {}

        // Now save to backend
        try {
          const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
          const fresh = freshRes?.data?.tournament || freshRes?.data || {};
          const baseCats = Array.isArray(fresh?.tournamentCategories)
            ? fresh.tournamentCategories.map((c) => ({ ...c }))
            : [];
          const mergedCats = baseCats.map((c) => {
            if (String(c?._id || "") !== String(cat?._id || "")) return c;
            const em = Array.isArray(c?.eliminationMatches?.matches) ? c.eliminationMatches.matches : [];
            const updatedEm = em.map(m => {
              const mk = String(m?.id || "");
              if (elimChanges[mk]) {
                return { ...m, ...elimChanges[mk] };
              }
              return m;
            });
            return {
              ...c,
              eliminationMatches: {
                ...(c?.eliminationMatches || {}),
                matches: updatedEm,
              },
            };
          });
          await apiClient.put(`/tournaments/${tournament?._id}`, { tournamentCategories: mergedCats });
          
          broadcastBracketUpdate({ action: "save-elimination", categoryId: String(cat?._id || "") });
          
          // Refresh from backend
          try {
            const freshRes2 = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
            const fresh2 = freshRes2?.data?.tournament || freshRes2?.data || null;
            if (fresh2) setTournament(fresh2);
          } catch {}
        } catch {}
      }
    } catch {}
  };

  const saveMatchNormalized = async (matchKey, nextMatch) => {
    const cat = selectedCategory;
    if (!cat) return;
    const letter = selectedBrackets[cat._id];
    const gid = `group-${String(letter || "").toLowerCase()}`;
    const k = `${cat._id}:${gid}`;
    const toN = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? 0 : n; };
    const gpm = Math.min(Math.max(Number(selectedCategory?.gamesPerMatch ?? 3), 1), 3);
    const baseGroup = (selectedCategory?.groupStage?.groups || []).find((g) => String(g?.id) === String(gid)) || null;
    const baseMatches = (baseGroup && baseGroup.matches && typeof baseGroup.matches === "object") ? { ...baseGroup.matches } : {};
    const latestOverlay = (matchEditsRef.current && matchEditsRef.current[k] && matchEditsRef.current[k][matchKey])
      ? matchEditsRef.current[k][matchKey]
      : ((matchEdits && matchEdits[k] && matchEdits[k][matchKey]) ? matchEdits[k][matchKey] : {});
    const merged = { ...(baseMatches[matchKey] || {}), ...latestOverlay, ...nextMatch };
    const sets = [
      [toN(merged.game1Player1), toN(merged.game1Player2)],
      [toN(merged.game2Player1), toN(merged.game2Player2)],
      [toN(merged.game3Player1), toN(merged.game3Player2)],
    ].slice(0, gpm);
    let w1 = 0;
    let w2 = 0;
    sets.forEach(([a, b]) => { if (a > b) w1 += 1; else if (b > a) w2 += 1; });
    merged.finalScorePlayer1 = w1;
    merged.finalScorePlayer2 = w2;
    const setsToWin = Math.ceil(gpm / 2);
    const anyPoints = sets.some(([a, b]) => (a + b) > 0);
    if (w1 >= setsToWin || w2 >= setsToWin) merged.status = "Completed";
    else if (anyPoints) merged.status = "Ongoing";

    const patchTournamentMatch = () => {
      setTournament((prev) => {
        const t = prev ? { ...prev } : null;
        if (!t) return prev;
        const cats = Array.isArray(t.tournamentCategories) ? t.tournamentCategories.map((c) => ({ ...c })) : [];
        const ci = cats.findIndex((c) => String(c?._id) === String(cat?._id));
        if (ci < 0) return prev;
        const curr = { ...(cats[ci] || {}) };
        const gs = curr.groupStage && typeof curr.groupStage === "object" ? { ...curr.groupStage } : { groups: [] };
        const groups = Array.isArray(gs.groups) ? gs.groups.map((g) => ({ ...g })) : [];
        const gi = groups.findIndex((g) => String(g?.id) === String(gid));
        if (gi < 0) return prev;
        const g = { ...(groups[gi] || {}) };
        const base = g.matches && typeof g.matches === "object" ? { ...g.matches } : {};
        g.matches = { ...base, [matchKey]: { ...(base[matchKey] || {}), ...merged } };
        groups[gi] = g;
        gs.groups = groups;
        curr.groupStage = gs;
        cats[ci] = curr;
        return { ...t, tournamentCategories: cats };
      });
    };

    try {
      try { skipAutoRefreshUntilRef.current = Date.now() + 15000; } catch {}
      patchTournamentMatch();
      await putGroupMatchesWithReopen(cat?._id, gid, { [matchKey]: merged });
      broadcastBracketUpdate({
        action: "save-group-matches",
        categoryId: String(cat?._id || ""),
        groupId: String(gid || ""),
        matchKey: String(matchKey || ""),
      });
      queueMicrotask(() => {
        setMatchEdits((prev) => {
          const next = { ...prev };
          const groupEdits = { ...(next[k] || {}) };
          if (Object.prototype.hasOwnProperty.call(groupEdits, matchKey)) delete groupEdits[matchKey];
          if (Object.keys(groupEdits).length > 0) next[k] = groupEdits;
          else delete next[k];
          matchEditsRef.current = next;
          return next;
        });
      });
    } catch (err) {
      try {
        const msg = err?.response?.data?.message || "Failed to save match";
        console.error("saveMatchNormalized error:", msg);
        toast.error(msg);
      } catch {}
      throw err;
    }
  };

  useEffect(() => {
    // Intentionally no auto-save while editing; changes persist only on explicit Save.
  }, [matchEdits, isEditing, selectedBrackets, selectedCategory, tournament?._id]);

  const handleSave = async (payload) => {
    try {
      const cat = selectedCategory;
      if (!cat) return;
      const playersOnly = Boolean(payload?.playersOnly);
      const adminCorrectionMode = Boolean(payload?.adminCorrectionMode);
      const correctionReason = String(payload?.reason || payload?.correctionReason || "").trim();
      const hasGpm = payload && Object.prototype.hasOwnProperty.call(payload, "gamesPerMatch");
      const n = hasGpm ? Math.min(Math.max(Number(payload?.gamesPerMatch ?? 3), 1), 3) : undefined;
      const sanitizeElimGpm = (obj) => {
        const keys = ['r16','quarters','semis','finals','bronze','elimination'];
        const out = {};
        keys.forEach((k) => {
          const v = Number(obj?.[k]);
          if (Number.isFinite(v)) out[k] = Math.min(Math.max(v, 1), 3);
        });
        return Object.keys(out).length ? out : undefined;
      };
      const elimGpm = sanitizeElimGpm(payload?.eliminationGpm);
      if (playersOnly) {
        try {
          const bm = bracketMode[cat._id];
          const bmValid = [1, 2, 4, 8].includes(Number(bm)) ? Number(bm) : (cat?.bracketMode || 4);
          let user = {};
          try { user = JSON.parse(sessionStorage.getItem("user_session") || localStorage.getItem("user") || "{}"); } catch {}
          const token = user?.token || "";
          const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
          const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`, opts);
          const fresh = freshRes?.data?.tournament || freshRes?.data || {};
          const baseCats = Array.isArray(fresh?.tournamentCategories) ? fresh.tournamentCategories.map((c) => ({ ...c })) : [];
          const idx = baseCats.findIndex((c) => String(c?._id) === String(cat._id));
          if (idx < 0) return;
          const serverCat = baseCats[idx] || {};
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
          const categoryHasLockedMatches = (c) => {
            const groups = Array.isArray(c?.groupStage?.groups) ? c.groupStage.groups : [];
            for (const g of groups) {
              const matches = g?.matches && typeof g.matches === "object" ? g.matches : {};
              for (const mk of Object.keys(matches)) {
                const mm = matches[mk];
                if (hasDupr(mm) || hasScores(mm)) return true;
                const st = String(mm?.status || "").trim().toLowerCase();
                if (st === "ongoing" || st === "completed") return true;
              }
            }
            const elim = Array.isArray(c?.eliminationMatches?.matches) ? c.eliminationMatches.matches : [];
            for (const mm of elim) {
              if (hasDupr(mm) || hasScores(mm)) return true;
              const st = String(mm?.status || "").trim().toLowerCase();
              if (st === "ongoing" || st === "completed") return true;
            }
            return false;
          };
          if (categoryHasLockedMatches(serverCat)) {
            if (!adminCorrectionMode) {
              toast.error("Participant Lock: scores already exist. Enable Admin Correction Mode and provide a reason to proceed.");
              return;
            }
            if (!correctionReason) {
              toast.error("Missing reason for Admin Correction Mode");
              return;
            }
          }
          const currentCat = (Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : [])
            .find((c) => String(c?._id) === String(cat._id)) || cat;
          const groupsRaw = Array.isArray(currentCat?.groupStage?.groups) ? currentCat.groupStage.groups : [];
          const groups = groupsRaw.map((g) => ({
            ...g,
            id: String(g?.id || ""),
            name: String(g?.name || ""),
            originalPlayers: Array.isArray(g?.originalPlayers) ? g.originalPlayers.map((p) => String(p ?? "")) : [],
            standings: Array.isArray(g?.standings) ? g.standings.map((r) => ({ ...r, player: String(r?.player ?? "") })) : [],
            matches: (g?.matches && typeof g.matches === "object") ? g.matches : {},
          }));
          baseCats[idx] = {
            ...serverCat,
            bracketMode: bmValid,
            ...(hasGpm ? { gamesPerMatch: n } : {}),
            ...(elimGpm ? { eliminationGpm: { ...(serverCat?.eliminationGpm || {}), ...elimGpm } } : {}),
            groupStage: { ...(serverCat?.groupStage || {}), groups },
          };
          const res = await apiClient.put(
            `/tournaments/${tournament?._id}`,
            {
              tournamentCategories: baseCats,
              adminCorrectionMode: adminCorrectionMode ? true : undefined,
              reason: adminCorrectionMode ? correctionReason : undefined,
            },
            opts,
          );
          const next = res?.data?.tournament || null;
          if (next) setTournament(next);
          broadcastBracketUpdate({ action: "save-bracket-category", categoryId: String(cat?._id || "") });
          try {
            if (elimGpm) localStorage.setItem(`elimGpm:${tournament?._id}:${cat._id}`, JSON.stringify(elimGpm));
            if (hasGpm) localStorage.setItem(`gpm:${tournament?._id}:${cat._id}`, String(n));
          } catch {}
          toast.success(adminCorrectionMode ? "Saved with Admin Correction Mode." : "Saved.");
        } catch (err) {
          const msg = err?.response?.data?.message || "Save failed";
          toast.error(msg);
          throw err;
        } finally {
          setIsEditing(false);
        }
        return;
      }
      if (hasGpm || elimGpm) {
        const updated = categories.map((c) => {
          if (String(c._id) === String(cat._id)) {
            const bm = bracketMode[cat._id];
            const bmValid = [1, 2, 4, 8].includes(Number(bm)) ? Number(bm) : c.bracketMode;
            const next = { ...c, bracketMode: bmValid };
            if (hasGpm) next.gamesPerMatch = n;
            if (elimGpm) next.eliminationGpm = { ...(c?.eliminationGpm || {}), ...elimGpm };
            return next;
          }
          return c;
        });
        // Save settings only when settings actually changed
        const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
        const fresh = freshRes?.data?.tournament || freshRes?.data || {};
        const baseCats = Array.isArray(fresh?.tournamentCategories) ? fresh.tournamentCategories.map((c) => ({ ...c })) : [];
        const mergedCats = baseCats.map((c) => {
          const u = updated.find((x) => String(x._id) === String(c._id));
          return u ? { ...c, ...u } : c;
        });
        const res = await apiClient.put(`/tournaments/${tournament?._id}`, { tournamentCategories: mergedCats }).catch((err) => {
          const msg = err?.response?.data?.message || "Failed to save settings";
          toast.error(msg);
          throw err;
        });
        const next = res?.data?.tournament || null;
        if (next) {
          const patched = (() => {
            if (!elimGpm) return next;
            try {
              const cats = Array.isArray(next?.tournamentCategories) ? next.tournamentCategories : [];
              const patchedCats = cats.map((c) => {
                if (String(c._id) === String(cat._id)) {
                  return { ...c, eliminationGpm: { ...(c?.eliminationGpm || {}), ...elimGpm } };
                }
                return c;
              });
              return { ...next, tournamentCategories: patchedCats };
            } catch {
              return next;
            }
          })();
          setTournament(patched);
          try {
            if (elimGpm) {
              localStorage.setItem(`elimGpm:${tournament?._id}:${cat._id}`, JSON.stringify(elimGpm));
            }
            if (hasGpm) {
              localStorage.setItem(`gpm:${tournament?._id}:${cat._id}`, String(n));
            }
          } catch {}
          if (elimGpm) toast.success("Saved elimination settings");
          else if (hasGpm) toast.success("Saved settings");
        }
      }
      // Persist current group's match edits if any
      try {
        const letter = selectedBrackets[cat._id];
        const gid = `group-${String(letter || "").toLowerCase()}`;
        const k = `${cat._id}:${gid}`;
        const overlay = matchEdits[k] || {};
        const base = (selectedCategory?.groupStage?.groups || []).find((g) => g.id === gid)?.matches || {};
        const toPersist = {};
        // Only process matches that were actually edited (exist in overlay)
        Object.keys(overlay).forEach((mk) => {
          const orig = base[mk] || {};
          const ov = overlay[mk] || {};
          
          // Normalize original status
          const origStatus = String(orig.status || "").trim();
          const origNorm = origStatus.toLowerCase();
          
          // Merge carefully to preserve all fields including status.
          // If status exists in overlay (was edited), use it; otherwise keep original.
          let requestedStatus = (ov && "status" in ov && ov.status !== null && ov.status !== undefined)
            ? String(ov.status).trim()
            : (orig.status !== null && orig.status !== undefined ? origStatus : undefined);
          
          // New rule: if a match is already Completed, treating it as "Unschedule" should NOT
          // wipe scores or flip the bracket result. We keep the status as Completed and treat
          // unscheduling as a pure schedule-grid action.
          if (origNorm === "completed" && String(requestedStatus || "").trim().toLowerCase() === "unschedule") {
            requestedStatus = origStatus || "Completed";
          }

          const finalStatus = requestedStatus;
          const target = String(finalStatus || "").trim().toLowerCase();
          const isStatusChange =
            ov &&
            "status" in ov &&
            String(ov.status).trim().toLowerCase() !== origNorm &&
            // If we coerced Unschedule back to Completed, don't treat it as a destructive change.
            !(origNorm === "completed" && target === "completed");

          // RULES:
          // - Any time we move TO Scheduled, we clear all game scores so inference will not
          //   treat the match as Ongoing (regardless of previous status).
          // - When moving FROM Completed to Scheduled, we also clear winner/final scores.
          // - Moving to Unschedule from Completed keeps scores/winner (pure schedule change).
          const shouldFullReset =
            isStatusChange &&
            target === "scheduled";

          const shouldReopenOngoing =
            isStatusChange &&
            target === "ongoing" &&
            origNorm === "completed";

          const shouldClearCompletion =
            isStatusChange &&
            target === "scheduled" &&
            origNorm === "completed";
          
          // Build the match object - preserve all original fields, apply overlay, then conditionally clear completion data
          const mergedMatch = { 
            ...orig,  // Start with all original fields (preserves ongoing matches, signatures, etc.)
            ...ov,    // Apply overlay changes (including status if changed)
            // Explicitly set status to ensure it's saved (overlay takes precedence, possibly coerced above)
            status: finalStatus
          };
          
          // Only clear winner/scores for THIS match if we're changing from Completed to Scheduled/Unschedule
          if (shouldClearCompletion) {
            mergedMatch.winner = null;
            mergedMatch.finalScorePlayer1 = 0;
            mergedMatch.finalScorePlayer2 = 0;
          }
          // Re-open a completed match to Ongoing: keep schedule, but clear decisive result fields
          // so backend/status inference won't snap it back to Completed.
          if (shouldReopenOngoing) {
            mergedMatch.game1Player1 = 0;
            mergedMatch.game1Player2 = 0;
            mergedMatch.game2Player1 = 0;
            mergedMatch.game2Player2 = 0;
            mergedMatch.game3Player1 = 0;
            mergedMatch.game3Player2 = 0;
            mergedMatch.finalScorePlayer1 = 0;
            mergedMatch.finalScorePlayer2 = 0;
            mergedMatch.winner = null;
            mergedMatch.refereeNote = "";
            mergedMatch.signatureData = "";
            mergedMatch.gameSignatures = [];
          }
          // When resetting to Scheduled (but NOT Unschedule anymore), fully clear all set scores and referee artifacts
          if (shouldFullReset) {
            mergedMatch.game1Player1 = 0;
            mergedMatch.game1Player2 = 0;
            mergedMatch.game2Player1 = 0;
            mergedMatch.game2Player2 = 0;
            mergedMatch.game3Player1 = 0;
            mergedMatch.game3Player2 = 0;
            mergedMatch.finalScorePlayer1 = 0;
            mergedMatch.finalScorePlayer2 = 0;
            mergedMatch.winner = null;
            mergedMatch.refereeNote = "";
            mergedMatch.signatureData = "";
            mergedMatch.gameSignatures = [];
          }
          
          toPersist[mk] = mergedMatch;
          
          // Debug log for status changes
          if (isStatusChange) {
            console.log(
              `Status change for match ${mk}: ${origStatus} -> ${ov.status} (final: ${finalStatus})` +
              (shouldClearCompletion ? " - clearing winner/scores" : "")
            );
          }
        });
        // Only save if there are actual edits
        if (Object.keys(overlay).length > 0) {
          try {
            // Debug: log what we're sending
            const fullMatches = { ...base };
            Object.keys(toPersist).forEach((mk) => { fullMatches[mk] = toPersist[mk]; });
            console.log('Saving match edits:', { overlay, toPersist, fullMatchesKeys: Object.keys(fullMatches || {}) });
            // Always upsert group first so backend has latest slot map before saving edited matches.
            await upsertGroupAndSaveMatches(
              cat,
              gid,
              fullMatches,
              (selectedCategory?.groupStage?.groups || []).find((g) => g.id === gid) || null
            );
          await putGroupMatchesWithReopen(cat?._id, gid, fullMatches);
            // Optimistic local patch so status/score changes persist immediately in UI
            // even before the follow-up fetch returns.
            try {
              setTournament((prev) => {
                if (!prev || !Array.isArray(prev?.tournamentCategories)) return prev;
                const nextCats = prev.tournamentCategories.map((tc) => {
                  if (String(tc?._id) !== String(cat?._id)) return tc;
                  const groups = Array.isArray(tc?.groupStage?.groups) ? tc.groupStage.groups : [];
                  const nextGroups = groups.map((gr) => {
                    if (String(gr?.id) !== String(gid)) return gr;
                    return { ...gr, matches: { ...(gr?.matches || {}), ...(fullMatches || {}) } };
                  });
                  return { ...tc, groupStage: { ...(tc?.groupStage || {}), groups: nextGroups } };
                });
                return { ...prev, tournamentCategories: nextCats };
              });
              // Give backend a short settle window before polling can overwrite.
              skipAutoRefreshUntilRef.current = Date.now() + 2500;
            } catch {}
            // Clear local edits for this group after successful save
            setMatchEdits((prev) => {
              const nextEdits = { ...prev };
              delete nextEdits[k];
              return nextEdits;
            });
            // Refresh tournament to reflect server state with a small delay to ensure backend has processed
            setTimeout(async () => {
              try {
                const freshRes2 = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
                const fresh2 = freshRes2?.data?.tournament || freshRes2?.data || null;
                if (fresh2) {
                  console.log('Refreshed tournament data after save');
                  setTournament(fresh2);
                }
              } catch {}
            }, 500);
          } catch (saveError) {
            console.error('Failed to save match edits:', saveError);
            // Don't clear edits if save failed
          }
        } else {
          try {
            const fullMatches = { ...base };
            await upsertGroupAndSaveMatches(
              cat,
              gid,
              fullMatches,
              (selectedCategory?.groupStage?.groups || []).find((g) => g.id === gid) || null
            );
            await putGroupMatchesWithReopen(cat?._id, gid, fullMatches);
          } catch {}
          setMatchEdits((prev) => {
            const nextEdits = { ...prev };
            delete nextEdits[k];
            return nextEdits;
          });
        }
      } catch {}
      setIsEditing(false);
    } catch {
      toast.error("Save failed");
      // keep editing state if save failed
    }
  };

  const putGroupMatchesWithReopen = async (categoryId, gid, matches, opts, extraBody = null) => {
    try {
      const payload = { matches, ...(extraBody && typeof extraBody === "object" ? extraBody : {}) };
      return await apiClient.put(`/tournaments/${tournament?._id}/categories/${categoryId}/groups/${gid}/matches`, payload, opts);
    } catch (err) {
      const status = err?.response?.status || err?.status;
      if (status === 409) {
        try {
          await apiClient.post(`/tournaments/${tournament?._id}/categories/${categoryId}/reopen`);
          const payload = { matches, ...(extraBody && typeof extraBody === "object" ? extraBody : {}) };
          return await apiClient.put(`/tournaments/${tournament?._id}/categories/${categoryId}/groups/${gid}/matches`, payload, opts);
        } catch (e2) {
          throw e2;
        }
      }
      throw err;
    }
  };

  const onChangeMatch = (matchKey, field, value) => {
    try {
      const cat = selectedCategory;
      if (!cat) return;
      const letter = selectedBrackets[cat._id];
      const gid = `group-${String(letter || "").toLowerCase()}`;
      const k = `${cat._id}:${gid}`;
      setMatchEdits((prev) => {
        const currentGroup = prev[k] || {};
        const currentMatch = currentGroup[matchKey] || {};
        const numericFields = new Set([
          "game1Player1","game1Player2",
          "game2Player1","game2Player2",
          "game3Player1","game3Player2",
          "finalScorePlayer1","finalScorePlayer2",
          "court"
        ]);
        let nextVal;
        if (numericFields.has(field)) {
          const n = parseInt(value, 10);
          nextVal = Number.isNaN(n) ? 0 : n;
        } else {
          nextVal = value === null || value === undefined ? "" : String(value).trim();
        }
        const catRaw = (Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : [])
          .find((c) => String(c?._id) === String(cat._id));
        const baseGroupRaw = (catRaw?.groupStage?.groups || []).find((g) => String(g?.id) === String(gid)) || null;
        const baseMatchRaw = (baseGroupRaw?.matches && typeof baseGroupRaw.matches === "object")
          ? (baseGroupRaw.matches[matchKey] || {})
          : {};
        const nextMatch = { ...baseMatchRaw, ...currentMatch, [field]: nextVal };
        try {
          const gpm = Math.min(Math.max(Number(selectedCategory?.gamesPerMatch ?? 3), 1), 3);
          const toN = (v) => {
            const n = parseInt(v, 10);
            return Number.isNaN(n) ? 0 : n;
          };
          const g1p1 = toN(nextMatch.game1Player1);
          const g1p2 = toN(nextMatch.game1Player2);
          const g2p1 = toN(nextMatch.game2Player1);
          const g2p2 = toN(nextMatch.game2Player2);
          const g3p1 = toN(nextMatch.game3Player1);
          const g3p2 = toN(nextMatch.game3Player2);
          const sets = [
            [g1p1, g1p2],
            [g2p1, g2p2],
            [g3p1, g3p2],
          ].slice(0, gpm);
          let p1Wins = 0;
          let p2Wins = 0;
          sets.forEach(([a, b]) => {
            if (a > b) p1Wins += 1;
            else if (b > a) p2Wins += 1;
          });
          nextMatch.finalScorePlayer1 = p1Wins;
          nextMatch.finalScorePlayer2 = p2Wins;
          const setsToWin = Math.ceil(gpm / 2);
          const anyPoints = sets.some(([a,b]) => (a+b) > 0);
          if (p1Wins >= setsToWin || p2Wins >= setsToWin) nextMatch.status = "Completed";
          else if (anyPoints) nextMatch.status = "Ongoing";
        } catch {}
        try { skipAutoRefreshUntilRef.current = Date.now() + 15000; } catch {}
        const next = { ...prev, [k]: { ...currentGroup, [matchKey]: nextMatch } };
        matchEditsRef.current = next;
        return next;
      });
    } catch {}
  };

  const togglePublish = async (nextPublished) => {
    try {
      const tId = String(tournament?._id || "").trim();
      if (!tId) return;
      if (isPublishingRef.current) return;
      isPublishingRef.current = true;
      const action = nextPublished ? "publish" : "unpublish";
      await apiClient.put(`/tournaments/${tId}/${action}`);
      setTournament((prev) => (prev ? { ...prev, published: Boolean(nextPublished) } : prev));
      setIsPublished(Boolean(nextPublished));
      toast.success(nextPublished ? "Tournament published." : "Tournament unpublished.");
    } catch (err) {
      const msg = err?.response?.data?.message || "Failed to update publish status.";
      toast.error(msg);
    } finally {
      isPublishingRef.current = false;
    }
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "24px",
          gap: "16px",
        }}
      >
        <div
          style={{
            fontFamily:
              "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif",
            fontSize: "2rem",
            color: "#234255",
            fontWeight: 800,
            letterSpacing: "-0.5px",
          }}
        >
          Brackets
        </div>
        <div style={{ minWidth: 260 }}>
          <select
            value={selectedCategoryId}
            onChange={(e) => setSelectedCategoryId(e.target.value)}
            style={{
              width: "100%",
              padding: "10px 14px",
              border: "1.5px solid #e2e8f0",
              borderRadius: 9999,
              fontSize: "0.95rem",
              backgroundColor: "white",
              color: "#334155",
              cursor: "pointer",
              outline: "none",
              transition: "border-color 0.2s ease, box-shadow 0.2s ease",
            }}
            onFocus={(e) => {
              e.target.style.borderColor = "#29ba9b";
              e.target.style.boxShadow = "0 0 0 3px rgba(41, 186, 155, 0.15)";
            }}
            onBlur={(e) => {
              e.target.style.borderColor = "#e2e8f0";
              e.target.style.boxShadow = "none";
            }}
          >
            {categories.map((c) => (
              <option key={c._id} value={c._id}>
                {[c.division, normalizeSkillLevel(c.skillLevel), c.ageCategory].filter(Boolean).join(" • ")}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button
            onClick={resetSequencesForSelectedCategory}
            style={{
              padding: "10px 16px",
              borderRadius: 9999,
              border: "1.5px solid #e2e8f0",
              background: "#ffffff",
              color: "#0f766e",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reset sequences
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !isPublished;
              const ok = window.confirm(
                next
                  ? "Publish this tournament brackets? This will make brackets visible to all users."
                  : "Unpublish this tournament brackets? This will hide brackets from other users.",
              );
              if (!ok) return;
              togglePublish(next);
            }}
            style={{
              padding: "10px 16px",
              borderRadius: 9999,
              border: "1.5px solid rgba(15, 23, 42, 0.08)",
              background: isPublished ? "#ef4444" : "#059669",
              color: "#ffffff",
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            {isPublished ? "Unpublish" : "Publish"}
          </button>
        </div>
      </div>
      {categories.length === 0 && (
        <div style={{ padding: 16, border: "1px solid #e2e8f0", borderRadius: 12, background: "#ffffff", color: "#334155" }}>
          No categories found for this tournament.
        </div>
      )}
      {selectedCategory && (
        <div style={{ position: "relative", minHeight: 240 }}>
          <CategoryBracketModal
            category={selectedCategory}
            tournamentName={tournament?.name || tournament?.tournamentName || ""}
            tournamentSlug={tournament?.tournamentSlug || tournament?.slug || ""}
            approvedRegistrations={approvedRegsForCategory}
            bracketMode={bracketMode}
            availableBrackets={availableBrackets}
            selectedBrackets={selectedBrackets}
            expectedPerGroupCap={expectedPerGroupCap}
            onAddSlot={(categoryId, groupId) => {
              try {
                const catId = categoryId || selectedCategoryRaw?._id;
                const gid = groupId;
                const cat = (Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : []).find((c) => String(c?._id) === String(catId)) || selectedCategory;
                const g = (cat?.groupStage?.groups || []).find((x) => String(x?.id) === String(gid)) || {};
                const base = Array.isArray(g?.originalPlayers) ? g.originalPlayers : (Array.isArray(g?.standings) ? g.standings.map((s) => s.player) : []);
                const next = [...base, `TBD ${base.length + 1}`];
                updateGroupSlots(catId, gid, next);
              } catch {}
            }}
            onDeleteSlot={(categoryId, groupId, slotIdx) => {
              try {
                const catId = categoryId || selectedCategoryRaw?._id;
                const gid = groupId;
                const idx = Number(slotIdx);
                const cat = (Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : []).find((c) => String(c?._id) === String(catId)) || selectedCategory;
                const g = (cat?.groupStage?.groups || []).find((x) => String(x?.id) === String(gid)) || {};
                const base = Array.isArray(g?.originalPlayers) ? g.originalPlayers : (Array.isArray(g?.standings) ? g.standings.map((s) => s.player) : []);
                if (!Number.isFinite(idx) || idx < 0 || idx >= base.length) return;
                const next = base.filter((_, i) => i !== idx);
                updateGroupSlots(catId, gid, next);
              } catch {}
            }}
            tournamentDates={tournament?.tournamentDates}
            courtAssignmentsByDate={tournament?.courtAssignmentsByDate}
            courtAssignments={tournament?.courtAssignments}
            rrEdits={(() => {
              try {
                const cat = selectedCategory;
                if (!cat) return {};
                const letter = selectedBrackets?.[cat._id];
                const gid = `group-${String(letter || "").toLowerCase()}`;
                const k = `${cat._id}:${gid}`;
                return matchEdits?.[k] || {};
              } catch {
                return {};
              }
            })()}
            getLatestMatchDraft={(matchKey) => {
              try {
                const cat = selectedCategory;
                if (!cat) return null;
                const letter = selectedBrackets?.[cat._id];
                const gid = `group-${String(letter || "").toLowerCase()}`;
                const k = `${cat._id}:${gid}`;
                return matchEditsRef.current?.[k]?.[matchKey] || null;
              } catch {
                return null;
              }
            }}
            onClose={() => {}}
            onRoundRobin={() => {
              setShowRoundRobinMap((prev) => ({ ...prev, [selectedCategory._id]: true }));
              setShowEliminationMap((prev) => ({ ...prev, [selectedCategory._id]: false }));
            }}
            onElimination={() => {
              setShowEliminationMap((prev) => ({ ...prev, [selectedCategory._id]: true }));
              setShowRoundRobinMap((prev) => ({ ...prev, [selectedCategory._id]: false }));
            }}
            onChangeMode={handleChangeMode}
            onSelectBracket={(b) => setSelectedBrackets((prev) => ({ ...prev, [selectedCategory._id]: b }))}
            showRoundRobin={Boolean(showRoundRobinMap[selectedCategory._id])}
            showElimination={Boolean(showEliminationMap[selectedCategory._id])}
            isEditing={isEditing}
            onToggleEdit={handleToggleEdit}
            onSave={handleSave}
            onSaveElimination={async (categoryId, updatedMatches) => {
            try {
              try { skipAutoRefreshUntilRef.current = Date.now() + 12000; } catch {}
              const cat = selectedCategory;
              if (!cat) return;
              const sanitizeRound = (id, title, round) => {
                if (round) return String(round);
                const t = String(title || '').toLowerCase();
                if (t.includes('round of 16') || /\br16\b/.test(t)) return 'Round of 16';
                if (t.includes('final') && !t.includes('semi') && !t.includes('quarter')) return 'Final';
                if (t.includes('bronze')) return 'Bronze';
                if (t.includes('semi')) return 'SF';
                if (t.includes('quarter')) return 'QF';
                const idNorm = String(id || '').toLowerCase();
                if (idNorm.startsWith('round16_') || /^r16[-_]/.test(idNorm)) return 'Round of 16';
                if (String(id || '').toLowerCase() === 'final') return 'Final';
                if (String(id || '').toLowerCase() === 'bronze') return 'Bronze';
                return 'Match';
              };
              const scheduleLookup = (() => {
                const out = new Map();
                const put = (key, value) => {
                  const k = String(key || '').trim();
                  if (!k) return;
                  out.set(k, value);
                  out.set(k.toLowerCase(), value);
                };
                const pushFromEntry = (dateKey, entry) => {
                  const venues = Array.isArray(entry?.venues) && entry.venues.length > 0
                    ? entry.venues
                    : [{ name: String(entry?.venueName || ''), timeSlots: entry?.timeSlots, assignments: entry?.assignments }];
                  venues.forEach((ven) => {
                    const rows = Array.isArray(ven?.assignments) ? ven.assignments : [];
                    rows.forEach((row, r) => {
                      const cells = Array.isArray(row) ? row : [];
                      const slot = Array.isArray(ven?.timeSlots) ? ven.timeSlots[r] : null;
                      const t = slot && typeof slot === 'object' ? String(slot.startTime || '').trim() : (typeof slot === 'string' ? slot : '');
                      cells.forEach((cell, c) => {
                        const rawIds = [
                          cell?.id,
                          cell?.matchId,
                          cell?.match?.id,
                          cell?.match?._id,
                        ].map((x) => String(x || '').trim()).filter(Boolean);
                        if (rawIds.length === 0) return;
                        const catId = String(cell?.categoryId || '').trim();
                        const value = {
                          date: String(dateKey || '').trim(),
                          time: t,
                          court: String(c + 1),
                          status: String(cell?.status || '').trim(),
                        };
                        rawIds.forEach((rid) => {
                          put(rid, value);
                          // Always add category-scoped keys so MXD/MD/WD never share schedule data
                          if (catId && rid) {
                            const base = rid.replace(/-g\d+$/i, '');
                            put(`elim-${catId}-${base}`, value);
                            put(`elim-${catId}-${rid}`, value);
                            const skey = (() => {
                              const s = String(base || '').toLowerCase();
                              if (s.startsWith('round16_')) return `r16-${s.replace('round16_', '')}`;
                              if (s.startsWith('r16-')) return s;
                              if (s.startsWith('quarter')) return `qf${s.replace('quarter', '')}`;
                              if (s.startsWith('qf')) return s;
                              if (s.startsWith('semi')) return `sf${s.replace('semi', '')}`;
                              if (s.startsWith('sf')) return s;
                              if (s === 'final' || s === 'finals') return 'final';
                              if (s === 'bronze') return 'bronze';
                              return '';
                            })();
                            if (skey) put(`elimgen-${catId}-${skey}`, value);
                          }
                        });
                      });
                    });
                  });
                };
                const byDate = tournament?.courtAssignmentsByDate || {};
                Object.keys(byDate || {}).forEach((d) => pushFromEntry(d, byDate[d] || {}));
                const root = tournament?.courtAssignments || null;
                if (root && (Array.isArray(root?.assignments) || (Array.isArray(root?.venues) && root.venues.length > 0))) {
                  pushFromEntry(String(root?.scheduleDate || ''), root);
                }
                return out;
              })();
              const scheduleKeyByMatchId = (id) => {
                const s = String(id || '').toLowerCase();
                if (s.startsWith('round16_')) return `r16-${s.replace('round16_', '')}`;
                if (s.startsWith('r16-')) return s;
                if (s.startsWith('quarter')) return `qf${s.replace('quarter', '')}`;
                if (s.startsWith('qf')) return s;
                if (s.startsWith('semi')) return `sf${s.replace('semi', '')}`;
                if (s.startsWith('sf')) return s;
                if (s === 'final' || s === 'finals') return 'final';
                if (s === 'bronze') return 'bronze';
                return '';
              };
              const scheduleForMatch = (categoryIdValue, m) => {
                const matchId = String(m?.id || '').trim();
                const persistedId = String(m?.persistedId || '').trim();
                const scheduleKey = String(m?.scheduleKey || '').trim() || scheduleKeyByMatchId(matchId);
                const normId = String(matchId || '').toLowerCase().replace(/[-_]/g, '');
                const altId = (() => {
                  if (normId.startsWith('quarter')) return `qf${normId.replace('quarter', '')}`;
                  if (normId.startsWith('qf')) return `quarter${normId.replace('qf', '')}`;
                  if (normId.startsWith('semi')) return `sf${normId.replace('semi', '')}`;
                  if (normId.startsWith('sf')) return `semi${normId.replace('sf', '')}`;
                  if (normId.startsWith('round16')) return `r16-${normId.replace('round16', '')}`;
                  if (normId.startsWith('r16')) return `round16_${normId.replace('r16', '')}`;
                  return '';
                })();
                const catVal = String(categoryIdValue || '').trim();
                // Try category-scoped keys FIRST so MXD/MD/WD never share schedule data
                const categoryScoped = [
                  `elim-${catVal}-${matchId}`,
                  persistedId ? `elim-${catVal}-${persistedId}` : '',
                  altId ? `elim-${catVal}-${altId}` : '',
                  scheduleKey ? `elimgen-${catVal}-${scheduleKey}` : '',
                ].filter(Boolean);
                const generic = [matchId, persistedId, altId, scheduleKey].filter(Boolean);
                const expand = (keys) => {
                  const out = [];
                  keys.forEach((k) => {
                    const s = String(k || '').trim();
                    if (!s) return;
                    out.push(s, `${s}-g1`, `${s}-g2`, `${s}-g3`);
                  });
                  return out;
                };
                for (const key of expand(categoryScoped)) {
                  const hit = scheduleLookup.get(String(key)) || scheduleLookup.get(String(key).toLowerCase());
                  if (hit) return hit;
                }
                for (const key of expand(generic)) {
                  const hit = scheduleLookup.get(String(key)) || scheduleLookup.get(String(key).toLowerCase());
                  if (hit) return hit;
                }
                return null;
              };
              const sanitizeMatch = (m, i) => {
                const p1 = typeof m?.player1 === 'string' ? m.player1 : (m?.player1?.name || 'TBD');
                const p2 = typeof m?.player2 === 'string' ? m.player2 : (m?.player2?.name || 'TBD');
                const id = String(m?.id || `m-${i + 1}`);
                const round = sanitizeRound(m?.id, m?.title, m?.round);
                const sched = scheduleForMatch(categoryId, m);
                const gp = (x) => {
                  const n = Number(x);
                  return Number.isFinite(n) ? n : 0;
                };
                const g1p1 = gp(m?.game1Player1);
                const g1p2 = gp(m?.game1Player2);
                const g2p1 = gp(m?.game2Player1);
                const g2p2 = gp(m?.game2Player2);
                const g3p1 = gp(m?.game3Player1);
                const g3p2 = gp(m?.game3Player2);
                const s1 = typeof m?.score1 === 'number' ? m.score1 : (g1p1 + g2p1 + g3p1);
                const s2 = typeof m?.score2 === 'number' ? m.score2 : (g1p2 + g2p2 + g3p2);
                const fs1 = gp(m?.finalScorePlayer1);
                const fs2 = gp(m?.finalScorePlayer2);
                const hasAnyPoints = (g1p1 + g1p2 + g2p1 + g2p2 + g3p1 + g3p2) > 0;
                const hasFinal = (fs1 + fs2) > 0;
                const hasField = (obj, key) => obj && Object.prototype.hasOwnProperty.call(obj, key);
                const courtEff = String(hasField(sched, 'court') ? (sched?.court || '') : '').trim();
                const dateEff = String(hasField(sched, 'date') ? (sched?.date || '') : '').trim();
                const timeEff = String(hasField(sched, 'time') ? (sched?.time || '') : '').trim();
                const incomingStatus = String(m?.status || '').trim();
                const incomingNorm = incomingStatus.toLowerCase();
                const scheduleStatus = String(sched?.status || '').trim();
                const scheduleNorm = scheduleStatus.toLowerCase();
                const inferredStatus = hasFinal
                  ? 'Completed'
                  : (hasAnyPoints ? 'Ongoing' : ((courtEff || dateEff || timeEff) ? 'Scheduled' : 'Unschedule'));
                let status = incomingStatus || scheduleStatus || inferredStatus;
                // Never let stale "Scheduled" override stronger evidence/status.
                if (incomingNorm === 'scheduled') {
                  if (scheduleNorm && scheduleNorm !== 'scheduled') status = scheduleStatus;
                  else if (inferredStatus !== 'Scheduled') status = inferredStatus;
                } else if (!incomingStatus && scheduleNorm === 'scheduled' && inferredStatus !== 'Scheduled') {
                  status = inferredStatus;
                }
                return {
                  ...m, // Preserve all original fields
                  id,
                  title: m?.title || '',
                  player1: p1,
                  player2: p2,
                  score1: s1,
                  score2: s2,
                  game1Player1: g1p1,
                  game1Player2: g1p2,
                  game2Player1: g2p1,
                  game2Player2: g2p2,
                  game3Player1: g3p1,
                  game3Player2: g3p2,
                  finalScorePlayer1: fs1,
                  finalScorePlayer2: fs2,
                  round,
                  court: courtEff,
                  date: dateEff,
                  time: timeEff,
                  status,
                  persistedId: String(m?.persistedId || ''),
                  scheduleKey: String(m?.scheduleKey || ''),
                  refereeNote: String(m?.refereeNote || "").trim(),
                  signatureData: m?.signatureData || "",
                  gameSignatures: Array.isArray(m?.gameSignatures) ? m.gameSignatures : [],
                  // Team categories: per-game player-vs-player assignment for DUPR logging.
                  game1Team1Player: String(m?.game1Team1Player || ""),
                  game1Team1Player2: String(m?.game1Team1Player2 || ""),
                  game1Team2Player: String(m?.game1Team2Player || ""),
                  game1Team2Player2: String(m?.game1Team2Player2 || ""),
                  game2Team1Player: String(m?.game2Team1Player || ""),
                  game2Team1Player2: String(m?.game2Team1Player2 || ""),
                  game2Team2Player: String(m?.game2Team2Player || ""),
                  game2Team2Player2: String(m?.game2Team2Player2 || ""),
                  game3Team1Player: String(m?.game3Team1Player || ""),
                  game3Team1Player2: String(m?.game3Team1Player2 || ""),
                  game3Team2Player: String(m?.game3Team2Player || ""),
                  game3Team2Player2: String(m?.game3Team2Player2 || ""),
                };
              };
              let savedElimStatusById = new Map();
              const elimUpdatesPayload = {};
              let savedSanitizedMatches = [];
              const updatedCategories = categories.map((c) => {
                if (String(c._id) !== String(categoryId)) return c;
                let sanitized = (updatedMatches || []).map((m, i) => sanitizeMatch(m, i));
              
              // Automatic bracket progression: Update subsequent matches with actual winners/losers
              const updateSubsequentMatches = (matches) => {
                const updatedMatches = [...matches];
                const matchMap = new Map();
                const isBracketPlaceholderName = (val) =>
                  /^(winner|loser)\s+(r16-\d+|qf\d+|sf\d+)$/i.test(String(val || '').trim());
                const isBracketRefText = (val) =>
                  /^(winner|loser)\s+/i.test(String(val || '').trim()) || isBracketPlaceholderName(val);
                
                // Create a map of matches by ID for easy lookup
                updatedMatches.forEach(match => {
                  matchMap.set(match.id, match);
                });
                
                // Function to determine winner/loser based on scores
                const getWinnerLoser = (match) => {
                  if (!match) {
                    return { winner: null, loser: null };
                  }

                  const p1 = String(match.player1 || '').trim();
                  const p2 = String(match.player2 || '').trim();
                  const isBracketPlaceholderName = (val) =>
                    /^(winner|loser)\s+(r16-\d+|qf\d+|sf\d+)$/i.test(String(val || '').trim());
                  const explicitWinner = String(match.winner || '').trim().toLowerCase();
                  if (explicitWinner && !isBracketPlaceholderName(explicitWinner)) {
                    const p1Norm = p1.toLowerCase();
                    const p2Norm = p2.toLowerCase();
                    if (explicitWinner === 'a' || explicitWinner === 'player1' || explicitWinner === p1Norm) {
                      return { winner: p1 || null, loser: p2 || null };
                    }
                    if (explicitWinner === 'b' || explicitWinner === 'player2' || explicitWinner === p2Norm) {
                      return { winner: p2 || null, loser: p1 || null };
                    }
                  }

                  const fs1 = Number(match.finalScorePlayer1 || 0);
                  const fs2 = Number(match.finalScorePlayer2 || 0);
                  if (fs1 > fs2) return { winner: p1 || null, loser: p2 || null };
                  if (fs2 > fs1) return { winner: p2 || null, loser: p1 || null };

                  const g1p1 = Number(match.game1Player1 || 0);
                  const g1p2 = Number(match.game1Player2 || 0);
                  const g2p1 = Number(match.game2Player1 || 0);
                  const g2p2 = Number(match.game2Player2 || 0);
                  const g3p1 = Number(match.game3Player1 || 0);
                  const g3p2 = Number(match.game3Player2 || 0);
                  const hasGameScores = (g1p1 + g1p2 + g2p1 + g2p2 + g3p1 + g3p2) > 0;
                  if (hasGameScores) {
                    let p1Wins = 0;
                    let p2Wins = 0;
                    if (g1p1 > g1p2) p1Wins += 1; else if (g1p2 > g1p1) p2Wins += 1;
                    if (g2p1 > g2p2) p1Wins += 1; else if (g2p2 > g2p1) p2Wins += 1;
                    if (g3p1 > g3p2) p1Wins += 1; else if (g3p2 > g3p1) p2Wins += 1;
                    if (p1Wins > p2Wins) return { winner: p1 || null, loser: p2 || null };
                    if (p2Wins > p1Wins) return { winner: p2 || null, loser: p1 || null };
                  }

                  const score1 = Number(match.score1 || 0);
                  const score2 = Number(match.score2 || 0);
                  if (score1 > score2) {
                    return { winner: p1 || null, loser: p2 || null };
                  } else if (score2 > score1) {
                    return { winner: p2 || null, loser: p1 || null };
                  }
                  return { winner: null, loser: null };
                };
                
                // Update quarter-finals based on Round of 16 results (when 8 groups)
                const r16Matches = updatedMatches.filter(m => m.id && m.id.startsWith('round16_'));
                const r16ToQf = {
                  round16_1: { quarterId: 'quarter1', field: 'player1' },
                  round16_2: { quarterId: 'quarter1', field: 'player2' },
                  round16_3: { quarterId: 'quarter2', field: 'player1' },
                  round16_4: { quarterId: 'quarter2', field: 'player2' },
                  round16_5: { quarterId: 'quarter3', field: 'player1' },
                  round16_6: { quarterId: 'quarter3', field: 'player2' },
                  round16_7: { quarterId: 'quarter4', field: 'player1' },
                  round16_8: { quarterId: 'quarter4', field: 'player2' },
                };
                r16Matches.forEach(r16Match => {
                  const { winner } = getWinnerLoser(r16Match);
                  if (winner) {
                    const mapping = r16ToQf[r16Match.id];
                    if (mapping) {
                      const qfIdx = updatedMatches.findIndex(m => m.id === mapping.quarterId);
                      const current = qfIdx !== -1 ? String(updatedMatches[qfIdx][mapping.field] || '').trim() : '';
                      if (qfIdx !== -1 && (!current || isBracketRefText(current))) {
                        updatedMatches[qfIdx][mapping.field] = winner;
                      }
                    }
                  }
                });

                // Update semi-finals based on quarter-final results
                const qfMatches = updatedMatches.filter(m => m.id && m.id.startsWith('quarter'));
                qfMatches.forEach(qfMatch => {
                  const { winner, loser } = getWinnerLoser(qfMatch);
                  if (winner) {
                    // Update corresponding semi-final match
                    const qfNumber = qfMatch.id.replace('quarter', '');
                    let targetSemiId = '';
                    let targetPlayerField = '';
                    
                    // Map QF winners to SF positions
                    if (qfNumber === '1') { targetSemiId = 'semi1'; targetPlayerField = 'player1'; }
                    else if (qfNumber === '2') { targetSemiId = 'semi1'; targetPlayerField = 'player2'; }
                    else if (qfNumber === '3') { targetSemiId = 'semi2'; targetPlayerField = 'player1'; }
                    else if (qfNumber === '4') { targetSemiId = 'semi2'; targetPlayerField = 'player2'; }
                    
                    const semiMatchIndex = updatedMatches.findIndex(m => m.id === targetSemiId);
                    const current = semiMatchIndex !== -1 ? String(updatedMatches[semiMatchIndex][targetPlayerField] || '').trim() : '';
                    if (semiMatchIndex !== -1 && (!current || isBracketRefText(current))) {
                      updatedMatches[semiMatchIndex][targetPlayerField] = winner;
                    }
                  }
                });
                
                // Update finals and bronze based on semi-final results
                const sfMatches = updatedMatches.filter(m => m.id && m.id.startsWith('semi'));
                sfMatches.forEach(sfMatch => {
                  const { winner, loser } = getWinnerLoser(sfMatch);
                  if (winner && loser) {
                    const sfNumber = sfMatch.id.replace('semi', '');
                    
                    // Update final match
                    const finalMatchIndex = updatedMatches.findIndex(m => m.id === 'final');
                    if (finalMatchIndex !== -1) {
                      const c1 = String(updatedMatches[finalMatchIndex].player1 || '').trim();
                      const c2 = String(updatedMatches[finalMatchIndex].player2 || '').trim();
                      if (sfNumber === '1' && (!c1 || isBracketRefText(c1))) {
                        updatedMatches[finalMatchIndex].player1 = winner;
                      } else if (sfNumber === '2' && (!c2 || isBracketRefText(c2))) {
                        updatedMatches[finalMatchIndex].player2 = winner;
                      }
                    }
                    
                    // Update bronze match
                    const bronzeMatchIndex = updatedMatches.findIndex(m => m.id === 'bronze');
                    if (bronzeMatchIndex !== -1) {
                      const c1 = String(updatedMatches[bronzeMatchIndex].player1 || '').trim();
                      const c2 = String(updatedMatches[bronzeMatchIndex].player2 || '').trim();
                      if (sfNumber === '1' && (!c1 || isBracketRefText(c1))) {
                        updatedMatches[bronzeMatchIndex].player1 = loser;
                      } else if (sfNumber === '2' && (!c2 || isBracketRefText(c2))) {
                        updatedMatches[bronzeMatchIndex].player2 = loser;
                      }
                    }
                  }
                });
                
                return updatedMatches;
              };
              
              // Save exactly what the user entered — no auto-propagation for team (or singles).
              // Team event and novice: kung ano nilagay, yun ang masasave.
              try {
                const catType = getCategoryType(c?.division || c?.name || "");
                if (catType === "doubles") {
                  sanitized = updateSubsequentMatches(sanitized);
                }
              } catch {}
              savedSanitizedMatches = Array.isArray(sanitized) ? sanitized : [];
              const statusPairs = [];
              (sanitized || []).forEach((m) => {
                const st = String(m?.status || "").trim();
                if (!st) return;
                elimIdAliases(m?.id).forEach((k) => statusPairs.push([k, st]));
                const norm = st.toLowerCase();
                const statusEff = norm === 'unschedule' || norm === 'unscheduled'
                  ? 'Unscheduled'
                  : (norm === 'scheduled' ? 'Scheduled' : (norm === 'ongoing' ? 'Ongoing' : (norm === 'completed' ? 'Completed' : st)));
                const idLow = String(m?.id || '').trim().toLowerCase();
                const alias = (() => {
                  if (idLow.startsWith('round16_')) return `r16-${idLow.replace('round16_', '')}`;
                  if (idLow.startsWith('r16-')) return idLow;
                  if (idLow.startsWith('quarter')) return `qf${idLow.replace('quarter', '')}`;
                  if (idLow.startsWith('qf')) return idLow;
                  if (idLow.startsWith('semi')) return `sf${idLow.replace('semi', '')}`;
                  if (idLow.startsWith('sf')) return idLow;
                  if (idLow === 'final' || idLow === 'finals') return 'final';
                  if (idLow === 'bronze') return 'bronze';
                  return idLow;
                })();
                const catVal = String(categoryId || '').trim();
                if (catVal && alias) {
                  elimUpdatesPayload[catVal] = elimUpdatesPayload[catVal] || {};
                  elimUpdatesPayload[catVal][alias] = { 
                    status: statusEff,
                    date: statusEff === 'Unscheduled' ? '' : String(m?.date || ''),
                    time: statusEff === 'Unscheduled' ? '' : String(m?.time || ''),
                    court: statusEff === 'Unscheduled' ? '' : String(m?.court || ''),
                  };
                }
              });
              savedElimStatusById = new Map(statusPairs);
              elimStatusOverridesRef.current[String(categoryId || "")] = Object.fromEntries(statusPairs);
              elimStatusOverrideUntilRef.current[String(categoryId || "")] = Date.now() + ELIM_STATUS_OVERRIDE_TTL_MS;
              try {
                const tId = String(tournament?._id || "").trim();
                const cId = String(categoryId || "").trim();
                if (tId && cId) {
                  localStorage.setItem(`elimStatus:${tId}:${cId}`, JSON.stringify(Object.fromEntries(savedElimStatusById.entries())));
                  localStorage.setItem(`elimStatusTs:${tId}:${cId}`, String(Date.now()));
                }
              } catch {}
                
                return {
                  ...c,
                  eliminationMatches: { matches: sanitized }
                };
              });
              // Optimistic local update: immediately reflect newly saved elimination statuses/players
              // so UI doesn't temporarily show stale "Scheduled" before backend refresh settles.
              try {
                setTournament((prev) => {
                  if (!prev || !Array.isArray(prev?.tournamentCategories)) return prev;
                  const nextCats = prev.tournamentCategories.map((c) => {
                    const u = updatedCategories.find((x) => String(x?._id) === String(c?._id));
                    return u ? { ...c, ...u } : c;
                  });
                  return { ...prev, tournamentCategories: nextCats };
                });
              } catch {}
              // RR-style persistence: fetch fresh tournament, patch only selected category elimination data, save once.
              const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
              const fresh = freshRes?.data?.tournament || freshRes?.data || {};
              const baseCats = Array.isArray(fresh?.tournamentCategories)
                ? fresh.tournamentCategories.map((c) => ({ ...c }))
                : [];
              const mergedCats = baseCats.map((c) => {
                if (String(c?._id || "") !== String(categoryId || "")) return c;
                return {
                  ...c,
                  eliminationMatches: {
                    ...(c?.eliminationMatches || {}),
                    matches: savedSanitizedMatches || [],
                  },
                };
              });
              const res = await apiClient.put(`/tournaments/${tournament?._id}`, {
                tournamentCategories: mergedCats,
                eliminationUpdates: elimUpdatesPayload,
              });
              const next = res?.data?.tournament || null;
              if (next) {
                const patchedNext = {
                  ...next,
                  tournamentCategories: (Array.isArray(next?.tournamentCategories) ? next.tournamentCategories : []).map((cat) => {
                    if (String(cat?._id || "") !== String(categoryId || "")) return cat;
                    const em = Array.isArray(cat?.eliminationMatches?.matches) ? cat.eliminationMatches.matches : [];
                    const manualMap = elimStatusOverridesRef.current[String(categoryId || "")] || {};
                    const patched = em.map((m) => {
                      const st = (() => {
                        const ids = elimIdAliases(m?.id);
                        for (const k of ids) {
                          const hit = String(manualMap[k] || "").trim() || savedElimStatusById.get(k);
                          if (hit) return hit;
                        }
                        return "";
                      })();
                      return st ? { ...m, status: st } : m;
                    });
                    return { ...cat, eliminationMatches: { ...(cat?.eliminationMatches || {}), matches: patched } };
                  })
                };
                setTournament(patchedNext);
              }
              broadcastBracketUpdate({ action: "save-elimination", categoryId: String(categoryId || "") });
              try { skipAutoRefreshUntilRef.current = Date.now() + 3000; } catch {}
              setTimeout(async () => {
                try {
                  const freshRes2 = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
                  const fresh2 = freshRes2?.data?.tournament || freshRes2?.data || null;
                  if (fresh2) {
                    const savedCat = (updatedCategories || []).find(
                      (c) => String(c?._id || "") === String(categoryId || "")
                    );
                    if (!savedCat) {
                      setTournament(fresh2);
                      return;
                    }
                    const patchedFresh = {
                      ...fresh2,
                      tournamentCategories: (Array.isArray(fresh2?.tournamentCategories) ? fresh2.tournamentCategories : []).map((cat) => {
                        if (String(cat?._id || "") !== String(categoryId || "")) return cat;
                        return {
                          ...cat,
                          eliminationMatches: {
                            ...(cat?.eliminationMatches || {}),
                            matches: savedSanitizedMatches,
                          },
                        };
                      }),
                    };
                    setTournament(patchedFresh);
                  }
                } catch {}
              }, 200);
            } catch (err) {
              try {
                const msg = err?.response?.data?.message || "Failed to save elimination changes";
                toast.error(msg);
              } catch {}
              console.error("onSaveElimination failed:", err);
              throw err;
            }
          }}
          onChangeMatch={onChangeMatch}
          onQuickSave={saveMatchesOnly}
          onQuickSaveNormalized={saveMatchNormalized}
          onUnlockResult={async ({ groupId, matchKey, reason }) => {
            try {
              const cat = selectedCategory;
              if (!tournament?._id || !cat?._id) return;
              const gid = String(groupId || "").trim();
              const mk = String(matchKey || "").trim();
              const rsn = String(reason || "").trim();
              if (!gid || !mk || !rsn) return;
              await apiClient.post(
                `/tournaments/${tournament._id}/categories/${cat._id}/groups/${gid}/matches/${mk}/unlock-result`,
                { reason: rsn },
              );
              try {
                const freshRes = await apiClient.get(`/tournaments/${tournament._id}?ts=${Date.now()}`);
                const fresh = freshRes?.data?.tournament || freshRes?.data || null;
                if (fresh) setTournament(fresh);
              } catch {}
              toast.success("Unlocked. You can now re-enter the correct score/status.");
            } catch (err) {
              try {
                const msg = err?.response?.data?.message || "Failed to unlock result";
                toast.error(msg);
              } catch {}
            }
          }}
          onDiscardRoundRobinEdit={(matchKey) => {
            try {
              const cat = selectedCategory;
              if (!cat) return;
              const letter = selectedBrackets?.[cat._id];
              const gid = `group-${String(letter || "").toLowerCase()}`;
              const k = `${cat._id}:${gid}`;
              setMatchEdits((prev) => {
                const next = { ...prev };
                const groupEdits = { ...(next[k] || {}) };
                if (!Object.prototype.hasOwnProperty.call(groupEdits, matchKey)) return prev;
                delete groupEdits[matchKey];
                if (Object.keys(groupEdits).length > 0) next[k] = groupEdits;
                else delete next[k];
                matchEditsRef.current = next;
                return next;
              });
            } catch {}
          }}
            approvedOptions={Array.from(new Set([...(swapAllowedIdsExtended || []), ...(approvedPlayerIds || []).map(String)]))}
            // Use all known players for this category (approved + any bracket-derived),
            // so the swap dropdown can show every eligible player, not just those
            // already slotted in a specific group.
            fallbackPlayers={extendedFallbackPlayers}
            onSubmitPoints={onSubmitPoints}
            canSubmitPoints={canSubmitPoints}
            handleStandingChange={async (categoryId, bracketLetter, index, field, value, groupIdOverride) => {
            try {
              const catId = categoryId || selectedCategory?._id;
              const letter = bracketLetter || selectedBrackets?.[catId];
              const gid = String(groupIdOverride || `group-${String(letter || "").toLowerCase()}`);
              // Derive current standings: use display source (selectedCategory + localStorage) when tournament group is empty
              const cat = (Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : [])
                .find((c) => String(c._id) === String(catId));
              const group = (cat?.groupStage?.groups || []).find((g) => String(g?.id) === String(gid));
              const displayGroup = (selectedCategory?.groupStage?.groups || []).find((g) => String(g?.id) === String(gid));
              let lsPlayers = [];
              try {
                const lsKey = `rrPlayers:${tournament?._id}:${catId}:${gid}`;
                const lsRaw = localStorage.getItem(lsKey);
                const parsed = JSON.parse(lsRaw || "null");
                if (Array.isArray(parsed)) lsPlayers = parsed;
              } catch {}
              const effectiveOriginalPlayers = (Array.isArray(displayGroup?.originalPlayers) && displayGroup.originalPlayers.length > 0)
                ? displayGroup.originalPlayers
                : (Array.isArray(group?.originalPlayers) && group.originalPlayers.length > 0)
                  ? group.originalPlayers
                  : (lsPlayers.length > 0 ? lsPlayers : []);
              const effectiveStandings = (Array.isArray(displayGroup?.standings) && displayGroup.standings.length > 0)
                ? displayGroup.standings
                : (Array.isArray(group?.standings) && group.standings.length > 0)
                  ? group.standings
                  : effectiveOriginalPlayers.map((p) => ({
                      player: String(p || ""),
                      wins: 0, losses: 0, pointsFor: 0, pointsAgainst: 0, pointDifferential: 0, rankPoints: 0, qualified: false,
                    }));
              const base = effectiveStandings;
              const hasScores = (() => {
                const matches = group?.matches || {};
                return Object.values(matches).some((m) => {
                  const sets = [
                    parseInt(m?.game1Player1) || 0,
                    parseInt(m?.game1Player2) || 0,
                    parseInt(m?.game2Player1) || 0,
                    parseInt(m?.game2Player2) || 0,
                    parseInt(m?.game3Player1) || 0,
                    parseInt(m?.game3Player2) || 0,
                  ];
                  const anySetPoints = sets.some((v) => v > 0);
                  const fs1 = parseInt(m?.finalScorePlayer1) || 0;
                  const fs2 = parseInt(m?.finalScorePlayer2) || 0;
                  const hasFinal = (fs1 + fs2) > 0;
                  return anySetPoints || hasFinal;
                });
              })();
              if (hasScores) return;
              const oldPlayer = (() => {
                const byStandings = String(base?.[index]?.player || "");
                if (byStandings) return byStandings;
                const oldPlayerValue = String(effectiveOriginalPlayers?.[index] || "");
                return oldPlayerValue;
              })();
              const baseNames = effectiveOriginalPlayers.length > 0
                ? effectiveOriginalPlayers.map((n) => String(n || ""))
                : base.map((r) => String(r?.player || ""));
              const next = baseNames.map((name, idx) => ({
                player: idx === index
                  ? (field === "player" && value && typeof value === "object"
                      ? canonicalPlayerName(`${String(value.firstName || "")} ${String(value.lastName || "")}`.trim())
                      : canonicalPlayerName(String(value || "")))
                  : canonicalPlayerName(String(name || "")),
                wins: Number(base?.[idx]?.wins || 0),
                losses: Number(base?.[idx]?.losses || 0),
                pointsFor: Number(base?.[idx]?.pointsFor || 0),
                pointsAgainst: Number(base?.[idx]?.pointsAgainst || 0),
                pointDifferential: Number(base?.[idx]?.pointDifferential || 0),
                rankPoints: Number(base?.[idx]?.rankPoints || 0),
                qualified: Boolean(base?.[idx]?.qualified)
              }));
              console.log("SWAP DEBUG - Next standings for target group", gid, ":", next);
              const swapPlayerName = canonicalPlayerName((value && typeof value === "object")
                ? `${String(value.firstName || "")} ${String(value.lastName || "")}`.trim()
                : String(value || ""));
              const normalizedSwapName = normalizeName(swapPlayerName);
              const normalizedOldPlayer = normalizeName(oldPlayer);
              // Find if swapPlayerName exists in any group (standings or originalPlayers) to perform a swap
              let swapInfo = null;
              let metadataAvailable = false;
              
              const hasSlotMeta = value && typeof value === "object" && value.groupId && Number.isFinite(Number(value.slotIdx));
              if (hasSlotMeta) {
                // Use the provided metadata for precise swap targeting
                metadataAvailable = true;
                swapInfo = { 
                  gid: String(value.groupId), 
                  idx: Number(value.slotIdx),
                  positionId: generatePositionId(catId, value.groupId, value.slotIdx)
                };
              } else {
                // Fallback: search by name; use display groups (selectedCategory) so we find slots when tournament groups are empty
                const groupsToSearch = Array.isArray(selectedCategory?.groupStage?.groups) && selectedCategory.groupStage.groups.some((g) => (g?.originalPlayers?.length || g?.standings?.length))
                  ? selectedCategory.groupStage.groups
                  : (Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : []);
                for (const g of groupsToSearch) {
                  const arr = Array.isArray(g?.standings) ? g.standings : [];
                  let j = arr.findIndex((r) => normalizeName(r?.player) === normalizedSwapName);
                  if (j < 0) {
                    const op = Array.isArray(g?.originalPlayers) ? g.originalPlayers : [];
                    j = op.findIndex((n) => normalizeName(n) === normalizedSwapName);
                  }
                  if (j >= 0) {
                    swapInfo = {
                      gid: String(g.id || ""),
                      idx: j,
                      positionId: generatePositionId(catId, g.id, j)
                    };
                    break;
                  }
                }
              }

              // Hard guard: if we cannot resolve a concrete source slot (swapInfo),
              // NEVER perform a swap. This prevents any player from "disappearing"
              // due to ambiguous name matches or stale display groups.
              if (!swapInfo && normalizedSwapName && normalizedSwapName !== normalizedOldPlayer) {
                const groupsToCheck = Array.isArray(selectedCategory?.groupStage?.groups) && selectedCategory.groupStage.groups.length > 0
                  ? selectedCategory.groupStage.groups
                  : (Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : []);
                const existsSomewhere = groupsToCheck.some((g) => {
                  const op = Array.isArray(g?.originalPlayers) ? g.originalPlayers : [];
                  const st = Array.isArray(g?.standings) ? g.standings.map((r) => r?.player) : [];
                  return [...op, ...st].some((n) => normalizeName(n) === normalizedSwapName);
                });
                if (existsSomewhere) {
                  toast.error("Swap source slot not found. Please select the player again.");
                  return;
                }
                // If the player doesn't exist anywhere yet (pure insert), also block
                // destructive replacement: let the user pick an explicit empty slot.
                toast.error("Cannot determine swap source. Please clear the slot first, then add the player.");
                return;
              }
              
              // Check if this is a same-player "swap" (which doesn't make sense)
              if (normalizedSwapName === normalizedOldPlayer && swapInfo) {
                // This is a same-player swap attempt - show debug info but don't perform the swap
                setTimeout(() => {
                  setSwapDebugInfo({
                    operation: "SAME PLAYER DETECTED - No Swap Performed",
                    sourcePosition: swapInfo ? `Category: ${catId}, Group: ${swapInfo.gid}, Slot: ${swapInfo.idx}` : "Unknown",
                    targetPosition: `Category: ${catId}, Group: ${gid}, Slot: ${index}`,
                    playerMoving: swapPlayerName || "Unknown",
                    playerReplaced: oldPlayer || "Unknown", 
                    swapType: "Invalid - Same Player",
                    positionId: swapInfo?.positionId || "None",
                    metadataAvailable: metadataAvailable,
                    isSamePlayer: true,
                    rawValue: JSON.stringify(value), // Add raw value for debugging
                    rawOldPlayer: oldPlayer // Add old player for debugging
                  });
                  setShowSwapDebug(true);
                }, 100);
                return; // Exit early - no swap needed for same player
              }
              
              // Show debug information after the swap operation is complete
              // We'll use setTimeout to avoid blocking the UI interaction
              setTimeout(() => {
                setSwapDebugInfo({
                  operation: "Player Swap Attempt",
                  sourcePosition: swapInfo ? `Category: ${catId}, Group: ${swapInfo.gid}, Slot: ${swapInfo.idx}` : "Unknown",
                  targetPosition: `Category: ${catId}, Group: ${gid}, Slot: ${index}`,
                  playerMoving: swapPlayerName || "Unknown",
                  playerReplaced: oldPlayer || "Unknown", 
                  swapType: swapInfo ? (swapInfo.gid !== gid ? "Cross-Bracket" : "Same-Bracket") : "No Swap",
                  positionId: swapInfo?.positionId || "None",
                  metadataAvailable: metadataAvailable,
                  isSamePlayer: swapPlayerName === oldPlayer,
                  rawValue: JSON.stringify(value), // Add raw value for debugging
                  rawOldPlayer: oldPlayer // Add old player for debugging
                });
                setShowSwapDebug(true);
              }, 100); // Small delay to allow UI to update first
              
              // Add debug logging to see what's happening with state updates
              console.log("SWAP DEBUG - Before state update:", {
                categoryId: catId,
                groupId: gid,
                slotIndex: index,
                newPlayer: swapPlayerName,
                oldPlayer,
                swapInfo,
                hasSwapInfo: !!swapInfo
              });
              // Optimistically update local tournament state (update UI immediately)
              setTournament((prev) => {
                console.log("SWAP DEBUG - Optimistic state update starting");
                try {
                  if (!prev) return prev;
                  
                  // Create a deep clone using JSON parse/stringify to avoid reference issues
                  const t = JSON.parse(JSON.stringify(prev));
                  
                  const cIdx = t.tournamentCategories?.findIndex((c) => String(c._id) === String(catId));
                  if (cIdx < 0) return prev;
                  
                  const gIdx = t.tournamentCategories[cIdx]?.groupStage?.groups?.findIndex((g) => String(g?.id) === String(gid));
                  if (gIdx < 0) return prev;
                  
                  // Update current group
                  t.tournamentCategories[cIdx].groupStage.groups[gIdx].standings = next;
                  t.tournamentCategories[cIdx].groupStage.groups[gIdx].originalPlayers = (next || []).map((r) => String(r.player || "").trim());
                  try {
                    const lsKeyTarget = `rrPlayers:${tournament?._id}:${catId}:${gid}`;
                    localStorage.setItem(lsKeyTarget, JSON.stringify((next || []).map((r) => String(r.player || "").trim())));
                  } catch {}
                  
                  // Apply optimistic swap in other affected group if needed
                  if (swapInfo && swapInfo.gid !== gid) {
                    const ogIdx = t.tournamentCategories[cIdx]?.groupStage?.groups?.findIndex((gr) => String(gr?.id) === String(swapInfo.gid));
                    if (ogIdx >= 0) {
                      const onext = t.tournamentCategories[cIdx].groupStage.groups[ogIdx].standings.map((row, i) => {
                        if (i !== swapInfo.idx) return { ...row, player: String(row?.player || "") };
                        return { ...row, player: String(oldPlayer || "") };
                      });
                      t.tournamentCategories[cIdx].groupStage.groups[ogIdx].standings = onext;
                      t.tournamentCategories[cIdx].groupStage.groups[ogIdx].originalPlayers = (onext || []).map((r) => String(r.player || "").trim());
                      try {
                        const lsKeySource = `rrPlayers:${tournament?._id}:${catId}:${swapInfo.gid}`;
                        localStorage.setItem(lsKeySource, JSON.stringify((onext || []).map((r) => String(r.player || "").trim())));
                      } catch {}
                    }
                  } else if (swapInfo && swapInfo.gid === gid && swapInfo.idx !== index) {
                    const onext = t.tournamentCategories[cIdx].groupStage.groups[gIdx].standings.map((row, i) => {
                      if (i === swapInfo.idx) return { ...row, player: String(oldPlayer || "") };
                      return { ...row, player: String(row?.player || "") };
                    });
                    t.tournamentCategories[cIdx].groupStage.groups[gIdx].standings = onext;
                    t.tournamentCategories[cIdx].groupStage.groups[gIdx].originalPlayers = onext.map((r) => String(r.player || "").trim());
                    try {
                      const lsKeyWithin = `rrPlayers:${tournament?._id}:${catId}:${gid}`;
                      localStorage.setItem(lsKeyWithin, JSON.stringify(onext.map((r) => String(r.player || "").trim())));
                    } catch {}
                  }
                  
                  console.log("SWAP DEBUG - Optimistic state update completed", {
                    updatedGroups: t.tournamentCategories?.[cIdx]?.groupStage?.groups,
                    groupB: t.tournamentCategories?.[cIdx]?.groupStage?.groups?.find(g => g.id === 'group-b')?.standings,
                    groupC: t.tournamentCategories?.[cIdx]?.groupStage?.groups?.find(g => g.id === 'group-c')?.standings
                  });
                  return t;
                } catch (error) {
                  console.log("SWAP DEBUG - Optimistic state update failed", error);
                  return prev;
                }
              });
              // Prevent auto-refresh from overwriting optimistic UI for a short period
              try { skipAutoRefreshUntilRef.current = Date.now() + 8000; } catch {}
              // Persist only affected groups (non-blocking; settle regardless of result)
              const groupsAll = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
              const putPromises = [];
              // Prepare auth header if available
              let user = {};
              try { user = JSON.parse(sessionStorage.getItem("user_session") || localStorage.getItem("user") || "{}"); } catch {}
              const token = user?.token || "";
              const opts = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
              // Persist originalPlayers and standings into tournamentCategories. Prefer a fresh
              // fetch so we don't overwrite other categories; if that fails, fall back to
              // in-memory tournament so this category's changes still persist.
              let baseCats = [];
              try {
                const freshForPersistRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`, opts);
                const freshForPersist = freshForPersistRes?.data?.tournament || freshForPersistRes?.data || {};
                baseCats = Array.isArray(freshForPersist?.tournamentCategories) ? freshForPersist.tournamentCategories.map((c) => ({ ...c })) : [];
              } catch {
                baseCats = Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories.map((c) => ({ ...c })) : [];
              }
              const cIdxPersist = baseCats.findIndex((c) => String(c?._id) === String(catId));
              if (cIdxPersist >= 0) {
                const normId = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '-');
                const serverCat = baseCats[cIdxPersist] || {};
                const uiGroups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : (Array.isArray(serverCat?.groupStage?.groups) ? serverCat.groupStage.groups : []);
                const groupsPersist = uiGroups.map((g) => ({ ...g }));
                let gIdxPersist = groupsPersist.findIndex((g) => normId(g?.id) === normId(gid));
                if (gIdxPersist < 0) {
                  groupsPersist.push({ id: gid, name: `Group ${gid}`, standings: [], originalPlayers: [], matches: {} });
                  gIdxPersist = groupsPersist.length - 1;
                }
                let targetStandings = next || [];
                let targetPlayersPersist = (next || []).map((r) => String(r.player || "").trim());
                if (swapInfo && swapInfo.gid === gid && swapInfo.idx !== index) {
                  targetPlayersPersist = targetPlayersPersist.map((name, idx) => (idx === swapInfo.idx ? String(oldPlayer || "") : String(name || "")));
                  targetStandings = next.map((r, i) => (i === swapInfo.idx ? { ...r, player: String(oldPlayer || "") } : r));
                }
                groupsPersist[gIdxPersist].originalPlayers = targetPlayersPersist;
                groupsPersist[gIdxPersist].standings = targetStandings;
                if (swapInfo && swapInfo.gid && swapInfo.gid !== gid) {
                  let ogIdxPersist = groupsPersist.findIndex((gr) => normId(gr?.id) === normId(swapInfo.gid));
                  if (ogIdxPersist < 0) {
                    groupsPersist.push({ id: swapInfo.gid, name: `Group ${swapInfo.gid}`, standings: [], originalPlayers: [], matches: {} });
                    ogIdxPersist = groupsPersist.length - 1;
                  }
                  const otherBase = Array.isArray(groupsPersist[ogIdxPersist]?.standings) ? groupsPersist[ogIdxPersist].standings : [];
                  const otherBaseNames = Array.isArray(groupsPersist[ogIdxPersist]?.originalPlayers)
                    ? groupsPersist[ogIdxPersist].originalPlayers.map((n) => String(n || ""))
                    : otherBase.map((r) => String(r?.player || ""));
                  const otherNextPlayers = otherBaseNames.map((name, idx) => (idx === swapInfo.idx ? String(oldPlayer || "") : String(name || "")));
                  const otherNext = otherBase.map((r, idx) => ({
                    ...r,
                    player: idx === swapInfo.idx ? String(oldPlayer || "") : String(r?.player || ""),
                  }));
                  groupsPersist[ogIdxPersist].originalPlayers = otherNextPlayers;
                  groupsPersist[ogIdxPersist].standings = otherNext;
                }
                const catPersist = { ...serverCat, groupStage: { ...(serverCat?.groupStage || {}), groups: groupsPersist } };
                baseCats[cIdxPersist] = catPersist;
                putPromises.push(apiClient.put(`/tournaments/${tournament?._id}`, { tournamentCategories: baseCats }, opts));
              }
              // Persist only via the full PUT tournamentCategories above. Skip per-group
              // PUT .../groups/:groupId/standings — that can 404 if the server has no such group yet.
              const apiResults = await Promise.allSettled(putPromises);
              const allOk = putPromises.length > 0 && apiResults.every((r) => r.status === "fulfilled");
              if (!allOk) {
                if (putPromises.length === 0) {
                  toast.error("Could not save bracket. Category or group not found.");
                } else {
                  const firstRejection = apiResults.find((r) => r.status === "rejected");
                  const msg = firstRejection?.reason?.response?.data?.message || "Bracket changes could not be saved. Try again.";
                  toast.error(msg);
                }
              } else {
                toast.success("Bracket changes saved.");
                try {
                  const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`, opts);
                  const fresh = freshRes?.data?.tournament || freshRes?.data || null;
                  if (fresh) setTournament(fresh);
                } catch {}
                broadcastBracketUpdate({ action: "save-bracket-layout", categoryId: String(categoryId || "") });
              }
            } catch (err) {
              const msg = err?.response?.data?.message || "Failed to save bracket changes.";
              toast.error(msg);
            }
            }}
          />
          {isBracketSettling && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                zIndex: 30,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(255, 255, 255, 0.82)",
                backdropFilter: "blur(2px)",
                borderRadius: 20,
              }}
            >
              <div
                style={{
                  minWidth: 220,
                  padding: "18px 22px",
                  borderRadius: 18,
                  background: "#ffffff",
                  boxShadow: "0 10px 30px rgba(15, 23, 42, 0.10)",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: "50%",
                    border: "3px solid rgba(41, 186, 155, 0.18)",
                    borderTopColor: "#29ba9b",
                    animation: "brackets-spin 0.9s linear infinite",
                  }}
                />
                <div style={{ fontWeight: 700, color: "#234255", fontSize: "0.95rem" }}>
                  Inaayos ang bracket view...
                </div>
                <div style={{ color: "#64748b", fontSize: "0.82rem", textAlign: "center" }}>
                  Sandali lang po habang sini-sync ang latest na schedule at scores.
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <style>{`
        @keyframes brackets-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
