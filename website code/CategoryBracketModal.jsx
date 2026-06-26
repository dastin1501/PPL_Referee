import React from "react";
import PlayerSearchDropdown from "./PlayerSearchDropdown";
import { resolveFileUrl } from "../config/constants";

export default function CategoryBracketModal({
  category,
  tournamentName,
  tournamentSlug,
  bracketMode,
  availableBrackets,
  selectedBrackets,
  expectedPerGroupCap,
  onAddSlot,
  onDeleteSlot,
  tournamentDates,
  courtAssignments,
  courtAssignmentsByDate,
  rrEdits,
  getLatestMatchDraft,
  onClose,
  onRoundRobin,
  onElimination,
  onChangeMode,
  onSelectBracket,
  showRoundRobin,
  showElimination,
  isEditing,
  onToggleEdit,
  onSave,
  onSaveElimination,
  onChangeMatch,
  onQuickSave,
  onQuickSaveNormalized,
  onUnlockResult,
  onDiscardRoundRobinEdit,
  approvedOptions,
  fallbackPlayers,
  approvedRegistrations,
  handleStandingChange,
  onSubmitPoints,
  canSubmitPoints,
}) {
  if (!category) return null;

  const playerNameById = React.useMemo(() => {
    const map = new Map();
    (Array.isArray(fallbackPlayers) ? fallbackPlayers : []).forEach((p) => {
      const id = String(p?.pplId || p?._id || "").trim();
      const name = String(
        (p?.name || `${p?.firstName || ""} ${p?.lastName || ""}`.trim() || "")
      ).trim();
      if (id && name) map.set(id, name);
    });
    return map;
  }, [fallbackPlayers]);

  const resolveSlotLabel = React.useCallback((raw) => {
    const s = String(raw ?? "").trim();
    if (!s) return "";
    // Preserve bracket reference placeholders (Winner QF1, Loser SF2, A1, etc.)
    if (/^(winner|loser)\s+/i.test(s)) return s;
    if (/^[A-H]\d+$/i.test(s)) return s;
    if (/^tbd$/i.test(s)) return "TBD";
    if (s.includes("/")) {
      const parts = s.split("/").map((x) => String(x || "").trim()).filter(Boolean);
      const resolved = parts.map((part) => playerNameById.get(part) || part);
      return resolved.join(" / ");
    }
    return playerNameById.get(s) || s;
  }, [playerNameById]);

  const [showRefPanel, setShowRefPanel] = React.useState(false);
  const [refNote, setRefNote] = React.useState("");
  const [signatureData, setSignatureData] = React.useState(null);
  const [refMatchKey, setRefMatchKey] = React.useState(null);
  const [refMatchTitle, setRefMatchTitle] = React.useState("");
  const [refGroupId, setRefGroupId] = React.useState(null);
  const [unlockReason, setUnlockReason] = React.useState("");
  const approvedPlayerAllowList = React.useMemo(() => {
    const regs = Array.isArray(approvedRegistrations) ? approvedRegistrations : [];
    const allow = new Set();
    const add = (p) => {
      if (!p) return;
      if (typeof p === "string") {
        const s = String(p).trim();
        if (s) allow.add(s);
        return;
      }
      const id = p?._id || p?.id;
      const pplId = p?.pplId;
      if (id) allow.add(String(id));
      if (pplId) allow.add(String(pplId));
    };
    regs.forEach((r) => {
      add(r?.player || r?.primaryPlayer);
      add(r?.partner);
      (Array.isArray(r?.teamMembers) ? r.teamMembers : []).forEach(add);
    });
    return Array.from(allow);
  }, [approvedRegistrations]);
  const canvasRef = React.useRef(null);
  const drawingRef = React.useRef(false);
  const hasStrokeRef = React.useRef(false);
  const saveRefData = async (sig, note) => {
    if (!refMatchKey || !onQuickSave) return;
    setRefNote(note);
    setSignatureData(sig || null);
    await onQuickSave({ [refMatchKey]: { refereeNote: String(note || "").trim(), signatureData: sig || "" } });
  };
  const resizeCanvas = React.useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    const w = Math.min(window.innerWidth * 0.45, 600);
    const h = Math.min(window.innerHeight * 0.5, 260);
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = "#111827"; ctx.lineWidth = 2; ctx.lineCap = "round";
    if (signatureData) {
      const img = new Image();
      img.onload = () => { ctx.drawImage(img, 0, 0, w, h); };
      img.src = signatureData;
    }
  }, [signatureData]);
  React.useEffect(() => {
    if (!showRefPanel) return;
    resizeCanvas();
    const onWinResize = () => resizeCanvas();
    window.addEventListener("resize", onWinResize);
    return () => window.removeEventListener("resize", onWinResize);
  }, [showRefPanel, resizeCanvas]);
  const point = (e) => {
    const c = canvasRef.current;
    if (!c) return { x: 0, y: 0 };
    const rect = c.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const start = (e) => {
    if (!showRefPanel) return;
    drawingRef.current = true;
    const p = point(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.beginPath(); ctx.moveTo(p.x, p.y);
  };
  const move = (e) => {
    if (!showRefPanel || !drawingRef.current) return;
    const p = point(e);
    const ctx = canvasRef.current.getContext("2d");
    ctx.lineTo(p.x, p.y); ctx.stroke(); hasStrokeRef.current = true;
  };
  const end = () => { drawingRef.current = false; };
  const clearSig = () => { hasStrokeRef.current = false; resizeCanvas(); };
  const saveSig = () => {
    if (!canvasRef.current) return;
    const url = canvasRef.current.toDataURL("image/png");
    saveRefData(url, refNote);
    setShowRefPanel(false);
  };

  const currentMode = bracketMode?.[category._id] ?? category.bracketMode ?? (category.groupStage?.groups?.length || 1);
  const brackets = availableBrackets?.[category._id] || ["A", "B", "C", "D", "E", "F", "G", "H"].slice(0, Number(currentMode) || 1);
  const selectedLetter = selectedBrackets?.[category._id];
  const gid = `group-${String(selectedLetter || "").toLowerCase()}`;
  const group = Array.isArray(category.groupStage?.groups)
    ? category.groupStage.groups.find((g) => g.id === gid)
    : null;

  const fallbackPlayersLocal = React.useMemo(() => {
    const groups = Array.isArray(category?.groupStage?.groups) ? category.groupStage.groups : [];
    const out = [];
    groups.forEach((g) => {
      const basePlayers = Array.isArray(g?.originalPlayers) && g.originalPlayers.length > 0
        ? g.originalPlayers
        : (Array.isArray(g?.standings) ? g.standings.map((s) => s.player) : []);
      (basePlayers || []).forEach((name, idx) => {
        const s = String(name || "").trim();
        if (!s) return;
        const lower = s.toLowerCase();
        if (lower === "tbd") return;
        if (lower === "unknown" || lower === "unknown player") return;
        if (lower === "undefined undefined") return;
        const parts = s.split(/\s+/);
        const fn = parts[0] || s;
        const ln = parts.slice(1).join(" ");
        const letter = String(g?.id || "").split("-").pop()?.toUpperCase() || "";
        out.push({
          _id: (`${fn} ${ln}`).toLowerCase().trim(),
          pplId: undefined,
          firstName: fn,
          lastName: ln,
          gender: "N/A",
          groupId: g?.id,
          slotIdx: idx,
          groupLabel: letter ? `Bracket ${letter}` : undefined,
        });
      });
    });
    return out;
  }, [category]);

  const mergedFallbackPlayers = React.useMemo(() => {
    const normalize = (fn, ln) => `${String(fn||'').trim()} ${String(ln||'').trim()}`.toLowerCase().replace(/\s+/g, ' ').trim();
    const byName = new Map();
    const prefer = (existing, candidate) => {
      const hasIdExisting = Boolean(existing?.pplId);
      const hasIdCandidate = Boolean(candidate?.pplId);
      const hasGenderExisting = existing?.gender && existing.gender !== 'N/A';
      const hasGenderCandidate = candidate?.gender && candidate.gender !== 'N/A';
      if (!hasIdExisting && hasIdCandidate) return candidate;
      if (!hasGenderExisting && hasGenderCandidate) return candidate;
      return existing;
    };
    const add = (p) => {
      const key = normalize(p.firstName, p.lastName);
      if (!key) return;
      const next = byName.has(key) ? prefer(byName.get(key), p) : p;
      // Preserve slot metadata if available
      byName.set(key, { ...next, groupId: next.groupId ?? p.groupId, slotIdx: next.slotIdx ?? p.slotIdx, groupLabel: next.groupLabel ?? p.groupLabel });
    };
    (Array.isArray(fallbackPlayers) ? fallbackPlayers : []).forEach(add);
    (fallbackPlayersLocal || []).forEach(add);
    return Array.from(byName.values());
  }, [fallbackPlayers, fallbackPlayersLocal]);

  const divisionLower = String(category?.division || '').toLowerCase();
  const isTeamCategory = /\bteam\b/.test(divisionLower);
  const isDoubles = divisionLower.includes('double') || (divisionLower.includes('open gender') && !divisionLower.includes('single'));
  const isPairSlot = isTeamCategory || isDoubles;
  const canonicalSlotLabel = React.useCallback((raw) => {
    return String(raw || "").replace(/\s*\/\s*/g, " / ").replace(/\s+/g, " ").trim();
  }, []);
  const normalizeCanonicalSlotLabel = React.useCallback((raw) => canonicalSlotLabel(raw).toLowerCase(), [canonicalSlotLabel]);
  const normalizeSlotKey = React.useCallback((s) => String(s || "").trim().toLowerCase().replace(/\s+/g, " "), []);
  const pairSlotFallbackPlayers = React.useMemo(() => {
    if (!isPairSlot) return [];
    const regs = Array.isArray(approvedRegistrations) ? approvedRegistrations : [];
    const labels = [];
    const push = (label) => {
      const v = canonicalSlotLabel(label);
      if (!v) return;
      const low = v.toLowerCase();
      if (low === "tbd") return;
      if (low === "unknown" || low === "unknown player") return;
      labels.push(v);
    };
    regs.forEach((reg) => {
      if (isTeamCategory) {
        if (reg?.teamName) push(reg.teamName);
        const members = Array.isArray(reg?.teamMembers) ? reg.teamMembers : [];
        const names = members
          .slice(0, 2)
          .map((m) => (`${m?.firstName || ""} ${m?.lastName || ""}`.trim() || String(m?.name || "").trim()))
          .filter(Boolean);
        if (names.length >= 2) push(names.join(" / "));
      } else {
        const p1 = reg?.player || reg?.primaryPlayer || {};
        const p2 = reg?.partner || {};
        const n1 = (`${p1?.firstName || ""} ${p1?.lastName || ""}`.trim() || String(p1?.name || "").trim() || String(reg?.playerName || "").trim());
        const n2 = (`${p2?.firstName || ""} ${p2?.lastName || ""}`.trim() || String(p2?.name || "").trim() || String(reg?.partnerName || "").trim());
        if (n1 && n2) push(`${n1} / ${n2}`);
      }
    });
    const seen = new Set();
    return labels
      .filter((s) => {
        const k = normalizeCanonicalSlotLabel(s);
        if (!k || seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .map((label) => ({
        _id: normalizeCanonicalSlotLabel(label),
        pplId: undefined,
        firstName: label,
        lastName: "",
        gender: "N/A",
      }));
  }, [approvedRegistrations, canonicalSlotLabel, isPairSlot, isTeamCategory, normalizeCanonicalSlotLabel]);
  const teamRosterBySlot = React.useMemo(() => {
    if (!isTeamCategory) return new Map();
    const regs = Array.isArray(approvedRegistrations) ? approvedRegistrations : [];
    const out = new Map();
    const pushUnique = (arr, name) => {
      const n = String(name || "").trim();
      if (!n) return;
      const exists = arr.some((x) => normalizeSlotKey(x) === normalizeSlotKey(n));
      if (!exists) arr.push(n);
    };
    regs.forEach((reg) => {
      const teamMembers = Array.isArray(reg?.teamMembers) ? reg.teamMembers : [];
      const names = [];
      teamMembers.forEach((m) => {
        const full = `${m?.firstName || ""} ${m?.lastName || ""}`.trim() || String(m?.name || "").trim();
        pushUnique(names, full);
      });
      if (names.length === 0) {
        const p1 = reg?.player || reg?.primaryPlayer || {};
        const p2 = reg?.partner || {};
        pushUnique(names, `${p1?.firstName || ""} ${p1?.lastName || ""}`.trim() || p1?.name || reg?.playerName || "");
        pushUnique(names, `${p2?.firstName || ""} ${p2?.lastName || ""}`.trim() || p2?.name || reg?.partnerName || "");
      }
      const slotCandidates = [
        reg?.teamName,
        reg?.player?.teamName,
        reg?.playerName,
      ].map((v) => String(v || "").trim()).filter(Boolean);
      if (teamMembers.length >= 2) {
        const firstTwo = teamMembers
          .slice(0, 2)
          .map((m) => `${m?.firstName || ""} ${m?.lastName || ""}`.trim() || String(m?.name || "").trim())
          .filter(Boolean)
          .join(" / ");
        if (firstTwo) slotCandidates.push(firstTwo);
      }
      slotCandidates.forEach((slot) => {
        const key = normalizeSlotKey(slot);
        if (!key) return;
        const existing = out.get(key) || [];
        const next = [...existing];
        names.forEach((n) => pushUnique(next, n));
        out.set(key, next);
      });
    });
    return out;
  }, [approvedRegistrations, isTeamCategory, normalizeSlotKey]);
  const getTeamOptionsForSlot = React.useCallback((slotLabel) => {
    if (!isTeamCategory) return [];
    const key = normalizeSlotKey(slotLabel);
    const fromRoster = (teamRosterBySlot.get(key) || []).filter(Boolean);
    if (fromRoster.length > 0) return fromRoster;
    const slashParts = String(slotLabel || "")
      .split("/")
      .map((x) => String(x || "").trim())
      .filter(Boolean);
    return slashParts;
  }, [isTeamCategory, normalizeSlotKey, teamRosterBySlot]);
  const formatTeamName = (s) => {
    const raw = String(s || '').trim();
    if (!raw) return '';
    const parts = raw.split('/').map((x) => String(x || '').trim()).filter((x) => x.length > 0);
    if (parts.length >= 2) return `${parts[0]} / ${parts[1]}`;
    if (parts.length === 1) return `${parts[0]} / ?`;
    return raw;
  };
  const formatTeamLabel = (s, fallback) => {
    const raw = String(s || "").trim();
    if (!raw) return fallback;
    const first = raw.split("/")[0];
    const clean = String(first || "").trim();
    return clean || fallback;
  };
  const [gamesPerMatch, setGamesPerMatch] = React.useState(() => {
    const n = Number(category?.gamesPerMatch ?? 3);
    return n >= 1 && n <= 3 ? n : 3;
  });
  const [teamMatchDropdownOpenRR, setTeamMatchDropdownOpenRR] = React.useState({});
  const [teamMatchDropdownOpenElim, setTeamMatchDropdownOpenElim] = React.useState({});
  const [teamMatchEditingElim, setTeamMatchEditingElim] = React.useState({});
  const [elimEdits, setElimEdits] = React.useState({});
  const [savingElim, setSavingElim] = React.useState(false);
  const [savingRoundRobinByMatch, setSavingRoundRobinByMatch] = React.useState({});
  const [localElimMatches, setLocalElimMatches] = React.useState(null);
  const [rrRowEditingKey, setRrRowEditingKey] = React.useState(null);
  const [localRrDraftByKey, setLocalRrDraftByKey] = React.useState({});
  const localRrDraftRef = React.useRef({});
  const [editScope, setEditScope] = React.useState(null); // 'standings' | 'schedule' | null
  const [participantAdminCorrectionMode, setParticipantAdminCorrectionMode] = React.useState(false);
  const [participantCorrectionReason, setParticipantCorrectionReason] = React.useState("");
  const shouldIgnoreToggleClick = React.useCallback((target) => {
    try {
      const el = target && typeof target.closest === "function" ? target : null;
      if (!el) return false;
      return Boolean(el.closest("input,select,button,textarea,a,label,option"));
    } catch {
      return false;
    }
  }, []);
  React.useEffect(() => {
    const n = Number(category?.gamesPerMatch ?? 3);
    setGamesPerMatch(n >= 1 && n <= 3 ? n : 3);
  }, [category?._id, category?.gamesPerMatch]);
  React.useEffect(() => {
    if (!isEditing) {
      setEditScope(null);
      setParticipantAdminCorrectionMode(false);
      setParticipantCorrectionReason("");
    }
  }, [isEditing]);
  React.useEffect(() => {
    if (!showRefPanel) {
      setUnlockReason("");
      setRefGroupId(null);
    }
  }, [showRefPanel]);
  React.useEffect(() => {
    // When switching category or group stage changes, reset localElimMatches!
    setLocalElimMatches(null);
    setTeamMatchDropdownOpenRR({});
    setTeamMatchDropdownOpenElim({});
    setTeamMatchEditingElim({});
    setLocalRrDraftByKey({});
    localRrDraftRef.current = {};
    setRrRowEditingKey(null);
  }, [category?._id, category?.groupStage]);

  const clearLocalRrDraft = React.useCallback((matchKey) => {
    if (!matchKey) return;
    setLocalRrDraftByKey((prev) => {
      if (!prev[matchKey]) return prev;
      const next = { ...prev };
      delete next[matchKey];
      return next;
    });
    if (localRrDraftRef.current[matchKey]) {
      const nextRef = { ...localRrDraftRef.current };
      delete nextRef[matchKey];
      localRrDraftRef.current = nextRef;
    }
  }, []);

  const beginLocalRrDraft = React.useCallback((matchKey, snapshot) => {
    if (!matchKey || !snapshot) return;
    const copy = { ...snapshot };
    setLocalRrDraftByKey((prev) => ({ ...prev, [matchKey]: copy }));
    localRrDraftRef.current = { ...localRrDraftRef.current, [matchKey]: copy };
  }, []);

  const handleRrMatchFieldChange = React.useCallback((matchKey, field, value) => {
    if (isTeamCategory && rrRowEditingKey === matchKey) {
      const numericFields = new Set([
        "game1Player1", "game1Player2",
        "game2Player1", "game2Player2",
        "game3Player1", "game3Player2",
        "finalScorePlayer1", "finalScorePlayer2",
        "court",
      ]);
      let nextVal;
      if (numericFields.has(field)) {
        const n = parseInt(value, 10);
        nextVal = Number.isNaN(n) ? 0 : n;
      } else {
        nextVal = value === null || value === undefined ? "" : String(value).trim();
      }
      setLocalRrDraftByKey((prev) => {
        const cur = prev[matchKey] || {};
        const nextMatch = { ...cur, [field]: nextVal };
        localRrDraftRef.current = { ...localRrDraftRef.current, [matchKey]: nextMatch };
        return { ...prev, [matchKey]: nextMatch };
      });
    }
    if (onChangeMatch) onChangeMatch(matchKey, field, value);
  }, [isTeamCategory, rrRowEditingKey, onChangeMatch]);
  // React.useEffect(() => {
  //   // If server data changed, prefer fresh source again.
  //   setLocalElimMatches(null);
  // }, [category?.eliminationMatches?.matches]);
  const isStandingsEditing = Boolean(isEditing && editScope === "standings");
  const isScheduleEditing = Boolean(isEditing && editScope === "schedule");
  const columnsTemplate = React.useMemo(() => {
    if (isScheduleEditing) {
      const base = ['110px','2.4fr','100px','70px','110px','100px'];
      const gameCols = Array.from({ length: gamesPerMatch }, () => '90px');
      return [...base, ...gameCols, '110px'].join(' ');
    }
    const base = ['120px','5fr','90px','70px','90px','90px'];
    const gameCols = Array.from({ length: gamesPerMatch }, () => '70px');
    return [...base, ...gameCols, '100px'].join(' ');
  }, [gamesPerMatch, isScheduleEditing]);

  const toMinutes = (t) => {
    const s = String(t || '').trim().toLowerCase();
    if (!s) return 0;
    const hasAm = /am$/.test(s);
    const hasPm = /pm$/.test(s);
    const base = s.replace(/\s*(am|pm)$/,'');
    const parts = base.split(':');
    let h = parseInt(parts[0]) || 0;
    const m = parseInt(parts[1]) || 0;
    if (hasPm && h < 12) h += 12;
    if (hasAm && h === 12) h = 0;
    return h * 60 + m;
  };
  const firstYmd = (() => {
    try {
      const dates = tournamentDates || [];
      if (Array.isArray(dates) && dates.length > 0) {
        const d = new Date(dates[0]);
        if (!isNaN(d)) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${y}-${m}-${dd}`;
        }
      }
    } catch {}
    return "";
  })();
  const toTimeValue = (md) => {
    const raw = md?.time || md?.mdTime || md?.wdTime || md?.xdTime || "";
    const s = String(raw).trim();
    if (!s) return Number.POSITIVE_INFINITY;
    return toMinutes(s);
  };
  const toDateValue = (md) => {
    const d = md?.date || md?.mdDate || md?.wdDate || md?.xdDate || "";
    const s = String(d).trim();
    if (!s) return Number.POSITIVE_INFINITY;
    const dt = new Date(s);
    return isNaN(dt) ? Number.POSITIVE_INFINITY : dt.getTime();
  };
  const toCourtValue = (md) => {
    const c = md?.court;
    const s = String(c ?? '').trim();
    return s;
  };
  const defaultElimGpm = React.useMemo(() => ({ r16: 1, quarters: 1, semis: 3, finals: 3, bronze: 3, elimination: 3 }), []);
  const [elimGpmLocal, setElimGpmLocal] = React.useState(() => {
    const base = (category?.eliminationGpm && typeof category.eliminationGpm === 'object') ? category.eliminationGpm : {};
    return { ...defaultElimGpm, ...base };
  });
  const [playersEdits, setPlayersEdits] = React.useState({});
  React.useEffect(() => {
    const base = (category?.eliminationGpm && typeof category.eliminationGpm === 'object') ? category.eliminationGpm : {};
    setElimGpmLocal({ ...defaultElimGpm, ...base });
    setPlayersEdits({});
    setParticipantAdminCorrectionMode(false);
    setParticipantCorrectionReason("");
  }, [category?._id, category?.eliminationGpm]);
  const makeGroupKey = (d, t, c, k) => {
    const hasD = Number.isFinite(d);
    const hasT = Number.isFinite(t);
    const hasC = Boolean(String(c || '').trim());
    if (hasD && hasT && hasC) return `${d}-${t}-${c}`;
    if (hasD && hasT) return `${d}-${t}`;
    if (hasT) return `t-${t}`;
    return `k-${k}`;
  };

  const calculateStandings = (matches, players, preserveOrder = true) => {
    const standings = {};
    players.forEach((player) => {
      standings[player] = {
        player,
        wins: 0,
        losses: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        pointDifferential: 0,
      };
    });
    Object.values(matches || {}).forEach((match) => {
      const player1Name = match.player1;
      const player2Name = match.player2;
      const validP1 = player1Name && players.includes(player1Name);
      const validP2 = player2Name && players.includes(player2Name);
      if (!validP1 || !validP2) return;
      if (!standings[player1Name]) {
        standings[player1Name] = {
          player: player1Name,
          wins: 0,
          losses: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          pointDifferential: 0,
        };
      }
      if (!standings[player2Name]) {
        standings[player2Name] = {
          player: player2Name,
          wins: 0,
          losses: 0,
          pointsFor: 0,
          pointsAgainst: 0,
          pointDifferential: 0,
        };
      }
      const gamesCount = Math.min(Math.max(Number(gamesPerMatch), 1), 3);
      const setsP1 = [
        parseInt(match.game1Player1) || 0,
        parseInt(match.game2Player1) || 0,
        parseInt(match.game3Player1) || 0,
      ];
      const setsP2 = [
        parseInt(match.game1Player2) || 0,
        parseInt(match.game2Player2) || 0,
        parseInt(match.game3Player2) || 0,
      ];
      const fs1 = parseInt(match.finalScorePlayer1) || 0;
      const fs2 = parseInt(match.finalScorePlayer2) || 0;
      let p1Wins = 0;
      let p2Wins = 0;
      // Prefer computing wins from set scores when any set has points
      const anySetPoints = setsP1.slice(0, gamesCount).some((v, i) => v || setsP2[i]);
      if (anySetPoints) {
        for (let i = 0; i < gamesCount; i++) {
          if (setsP1[i] > setsP2[i]) p1Wins++;
          else if (setsP2[i] > setsP1[i]) p2Wins++;
        }
      } else {
        // Fallback to saved final scores only if they look like wins (<= gamesCount)
        if (fs1 + fs2 > 0 && fs1 <= gamesCount && fs2 <= gamesCount) {
          p1Wins = fs1;
          p2Wins = fs2;
        }
      }
      let hasAnyScore = 0;
      for (let i = 0; i < gamesCount; i++) hasAnyScore += (setsP1[i] + setsP2[i]);
      const hasFinal = fs1 + fs2 > 0;
      if (!hasAnyScore && !hasFinal) return;
      let p1Pts = 0, p2Pts = 0;
      for (let i = 0; i < gamesCount; i++) {
        p1Pts += setsP1[i];
        p2Pts += setsP2[i];
      }
      standings[player1Name].wins += p1Wins;
      standings[player1Name].losses += p2Wins;
      standings[player2Name].wins += p2Wins;
      standings[player2Name].losses += p1Wins;
      standings[player1Name].pointsFor += p1Pts;
      standings[player1Name].pointsAgainst += p2Pts;
      standings[player2Name].pointsFor += p2Pts;
      standings[player2Name].pointsAgainst += p1Pts;
      standings[player1Name].pointDifferential = standings[player1Name].pointsFor - standings[player1Name].pointsAgainst;
      standings[player2Name].pointDifferential = standings[player2Name].pointsFor - standings[player2Name].pointsAgainst;
    });
    if (preserveOrder) {
      return players.map((p) => standings[p]).filter(Boolean);
    } else {
      return Object.values(standings).sort((a, b) => {
        if (b.wins !== a.wins) return b.wins - a.wins;
        if (b.pointsFor !== a.pointsFor) return b.pointsFor - a.pointsFor;
        if (a.pointsAgainst !== b.pointsAgainst) return a.pointsAgainst - b.pointsAgainst;
        return b.pointDifferential - a.pointDifferential;
      });
    }
  };

  return (
    <div style={{
      background: "white",
      borderRadius: 16,
      width: "min(1800px, 98vw)",
      maxHeight: "90vh",
      overflow: "auto",
      boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)",
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: "1px solid #e2e8f0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 700, color: "#234255" }}>
          <span>{category.division}</span>
          <span style={{ color: "#64748b" }}>|</span>
          <span style={{ color: "#059669" }}>{category.skillLevel}</span>
          {category.ageCategory && (<><span style={{ color: "#64748b" }}>|</span><span>{category.ageCategory}</span></>)}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={onClose} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}>Close</button>
        </div>
      </div>
      <div style={{ padding: 16 }}>
        <div style={{ display: "flex", gap: 12, marginBottom: 12, justifyContent: "center" }}>
          <button style={{ padding: "10px 20px", backgroundColor: "#3b82f6", color: "white", border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer" }} onClick={onRoundRobin}>Round Robin</button>
          <button style={{ padding: "10px 20px", backgroundColor: "#f59e0b", color: "white", border: "none", borderRadius: 8, fontWeight: 600, cursor: "pointer" }} onClick={onElimination}>Elimination Draw</button>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "center", marginBottom: 16 }}>
          <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "#64748b" }}>Brackets:</span>
          <select value={currentMode} onChange={(e) => onChangeMode(parseInt(e.target.value))} style={{ padding: "6px 12px", border: "2px solid #cbd5e1", borderRadius: 8, fontWeight: 600 }}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={4}>4</option>
            <option value={8}>8</option>
          </select>
          {brackets.map((b) => (
            <button key={b} style={{ padding: "8px 16px", backgroundColor: "#3b82f6", color: "white", border: "none", borderRadius: 6, fontWeight: 600 }} onClick={() => onSelectBracket(b)}>Bracket {b}</button>
          ))}
        </div>
        {showRoundRobin && !showElimination && (
          <div>
            {selectedLetter && group ? (
              <>
              <div style={{ background: 'white', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden', marginBottom: 16 }}>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 8, background: '#f8fafc' }}>
                  <button
                    type="button"
                    onClick={() => {
                      setEditScope("standings");
                      onToggleEdit && onToggleEdit();
                    }}
                    title="Edit Standings Names"
                    style={{
                      padding: '8px 12px',
                      borderRadius: 8,
                      border: '1px solid #e5e7eb',
                      background: isEditing ? '#ef4444' : '#f8fafc',
                      color: isEditing ? 'white' : '#334155',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    {isEditing ? 'Cancel' : 'Edit'}
                  </button>
                  {isEditing && (
                    <button
                      type="button"
                      disabled={participantAdminCorrectionMode && !participantCorrectionReason.trim()}
                      onClick={async () => {
                        if (!onSave) return;
                        try {
                          await onSave({
                            playersOnly: true,
                            gamesPerMatch,
                            adminCorrectionMode: participantAdminCorrectionMode ? true : undefined,
                            reason: participantAdminCorrectionMode ? participantCorrectionReason.trim() : undefined,
                          });
                        } finally {
                          setEditScope(null);
                          onToggleEdit && onToggleEdit();
                        }
                      }}
                      title="Save Bracket Settings"
                      style={{
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: '1px solid #10b981',
                        background: participantAdminCorrectionMode && !participantCorrectionReason.trim() ? '#9ca3af' : '#10b981',
                        color: 'white',
                        fontWeight: 600,
                        cursor: participantAdminCorrectionMode && !participantCorrectionReason.trim() ? 'not-allowed' : 'pointer',
                        opacity: participantAdminCorrectionMode && !participantCorrectionReason.trim() ? 0.7 : 1
                      }}
                    >
                      Save
                    </button>
                  )}
                </div>
                {isEditing && editScope === "standings" && (
                  <div style={{ padding: '14px 16px', borderBottom: '1px solid #e2e8f0', background: '#fff7ed' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', fontWeight: 800, color: '#0f172a' }}>
                      <input
                        type="checkbox"
                        checked={participantAdminCorrectionMode}
                        onChange={(e) => {
                          const next = !!e.target.checked;
                          setParticipantAdminCorrectionMode(next);
                          if (!next) setParticipantCorrectionReason("");
                        }}
                      />
                      Admin Correction Mode
                    </label>
                    <div style={{ marginTop: 8, color: '#9a3412', fontWeight: 600, fontSize: '0.85rem', lineHeight: 1.4 }}>
                      Use only when participant lock applies because scores already exist. Requires a reason and will be logged for audit.
                    </div>
                    {participantAdminCorrectionMode && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontWeight: 700, color: '#7c2d12', marginBottom: 8 }}>Reason</div>
                        <input
                          value={participantCorrectionReason}
                          onChange={(e) => setParticipantCorrectionReason(e.target.value)}
                          placeholder="Enter reason for this correction..."
                          style={{
                            width: '100%',
                            padding: '12px 14px',
                            border: '2px solid #fdba74',
                            borderRadius: 10,
                            outline: 'none',
                            fontWeight: 600,
                            color: '#0f172a',
                            background: 'white',
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
                <div style={{
                  background: 'linear-gradient(135deg, #234255 0%, #29ba9b 100%)',
                  color: 'white',
                  padding: '18px 16px',
                  display: 'grid',
                  gridTemplateColumns: '60px 1fr 120px 120px',
                  gap: 12,
                  fontWeight: 600,
                  textAlign: 'center'
                }}>
                  <div>Rank</div>
                  <div style={{ textAlign: 'left' }}>Player</div>
                  <div>Wins<br/>(W-L)</div>
                  <div>Points<br/>(PF-PA)</div>
                </div>
                {(() => {
                  const basePlayers = group.originalPlayers || (group.standings || []).map((s) => s.player || s.name) || [];
                  const override = playersEdits[group.id];
                  const players = (Array.isArray(override) ? override : basePlayers).filter((p) => {
                    const s = String(p || '').trim();
                    if (!s) return false;
                    const lower = s.toLowerCase();
                    if (lower === 'tbd') return false;
                    if (lower === 'unknown' || lower === 'unknown player') return false;
                    if (lower === 'undefined undefined') return false;
                    return true;
                  });
                  const enhanced = {};
                  const overlay = (rrEdits && typeof rrEdits === 'object') ? rrEdits : {};
                  Object.keys(group.matches || {}).forEach((key) => {
                    const parts = String(key).split('-');
                    const i = parseInt(parts[0]);
                    const off = parseInt(parts[1]);
                    const j = i + 1 + (isNaN(off) ? 0 : off);
                    const m = group.matches[key] || {};
                    const o = overlay[key] || {};
                    enhanced[key] = { ...m, ...o, player1: players[i], player2: players[j] };
                  });
                  Object.keys(overlay || {}).forEach((key) => {
                    if (enhanced[key]) return;
                    const parts = String(key).split('-');
                    const i = parseInt(parts[0]);
                    const off = parseInt(parts[1]);
                    const j = i + 1 + (isNaN(off) ? 0 : off);
                    const o = overlay[key] || {};
                    enhanced[key] = { ...o, player1: players[i], player2: players[j] };
                  });
                  const hasScores = (() => {
                    const gamesCount = Math.min(Math.max(Number(gamesPerMatch), 1), 3);
                    return Object.values(enhanced).some((match) => {
                      const sets = [
                        parseInt(match.game1Player1) || 0,
                        parseInt(match.game1Player2) || 0,
                        parseInt(match.game2Player1) || 0,
                        parseInt(match.game2Player2) || 0,
                        parseInt(match.game3Player1) || 0,
                        parseInt(match.game3Player2) || 0,
                      ];
                      const anySetPoints = sets.slice(0, gamesCount).some((v) => v > 0);
                      const fs1 = parseInt(match.finalScorePlayer1) || 0;
                      const fs2 = parseInt(match.finalScorePlayer2) || 0;
                      const hasFinal = (fs1 + fs2) > 0;
                      return anySetPoints || hasFinal;
                    });
                  })();
                  const allowEditing = isStandingsEditing && !hasScores;
                  const current = calculateStandings(enhanced, players, true);
                  const slotList = Array.isArray(override) ? override : (Array.isArray(basePlayers) ? basePlayers : []);
                  const canAddSlot = allowEditing && Number.isFinite(Number(expectedPerGroupCap)) && slotList.length < Number(expectedPerGroupCap);
                  return current.map((row, idx) => (
                    <div key={`st-${group.id}-${row.player}`} style={{
                      display: 'grid',
                      gridTemplateColumns: allowEditing ? '60px 1fr 120px 120px 110px' : '60px 1fr 120px 120px',
                      gap: 12,
                      padding: '20px 16px',
                      borderTop: '1px solid #e2e8f0',
                      alignItems: 'center'
                    }}>
                      <div style={{ textAlign: 'center', fontWeight: 700, color: '#29ba9b' }}>{idx + 1}</div>
                      <div style={{ color: '#334155' }}>
                        {allowEditing ? (
                          <div style={{ minWidth: 200 }}>
                            <PlayerSearchDropdown
                              gender={isPairSlot ? 'all' : (divisionLower.includes('men') ? 'male' : (divisionLower.includes('women') ? 'female' : 'all'))}
                              selectedPlayer={null}
                              onPlayerSelect={(p) => {
                                const normalize = (s) => normalizeCanonicalSlotLabel(s || '');
                                const candidateLabel = p
                                  ? (isPairSlot
                                    ? canonicalSlotLabel(`${p.firstName || ""} ${p.lastName || ""}`.trim())
                                    : String(`${p.firstName || ""} ${p.lastName || ""}`.trim()))
                                  : "";
                                const plist = group.originalPlayers || (group.standings || []).map((s) => s.player) || [];
                                const origIdx = plist.findIndex((pn) => normalize(pn) === normalize(row.player));
                                const sIdx = origIdx >= 0 ? origIdx : idx;
                                const findPlayerPosition = (player) => {
                                  if (!player) return null;
                                  
                                  const normalizedSearchName = normalize(candidateLabel);
                                  
                                  const allGroups = Array.isArray(category?.groupStage?.groups) ? category.groupStage.groups : [];
                                  for (const grp of allGroups) {
                                    const eff = Array.isArray(playersEdits?.[grp.id])
                                      ? playersEdits[grp.id]
                                      : (Array.isArray(grp?.originalPlayers)
                                        ? grp.originalPlayers
                                        : (((Array.isArray(grp?.standings) ? grp.standings.map((s) => s.player) : []) || [])));
                                    const pos = eff.findIndex((name) => normalize(name) === normalizedSearchName);
                                    if (pos >= 0) return { groupId: grp?.id, slotIdx: pos };
                                  }
                                  return null;
                                };
                                
                                const actualPosition = p ? findPlayerPosition(p) : null;
                                const playerWithMetadata = p ? {
                                  ...p,
                                  groupId: actualPosition?.groupId || group?.id, // Use actual position if found, otherwise fallback
                                  slotIdx: actualPosition?.slotIdx ?? sIdx
                                } : null;
                                
                                const newName = candidateLabel;
                                if (newName) {
                                  setPlayersEdits((prev) => {
                                    const currentBase = Array.isArray(prev?.[group.id])
                                      ? prev[group.id]
                                      : (Array.isArray(group.originalPlayers) ? group.originalPlayers : ((group.standings || []).map((s) => s.player) || []));
                                    const nextTarget = currentBase.map((nm, i) => (i === sIdx ? newName : nm));
                                    let out = { ...prev, [group.id]: nextTarget };
                                    if (actualPosition?.groupId && actualPosition.groupId !== group.id && typeof actualPosition.slotIdx === "number") {
                                      const allGroups = Array.isArray(category?.groupStage?.groups) ? category.groupStage.groups : [];
                                      const sourceGroup = allGroups.find((gr) => String(gr?.id) === String(actualPosition.groupId)) || {};
                                      const sourceBase = Array.isArray(prev?.[sourceGroup.id])
                                        ? prev[sourceGroup.id]
                                        : (Array.isArray(sourceGroup?.originalPlayers) ? sourceGroup.originalPlayers : ((Array.isArray(sourceGroup?.standings) ? sourceGroup.standings.map((s) => s.player) : []) || []));
                                      const nextSource = sourceBase.map((nm, i) => (i === actualPosition.slotIdx ? row.player : nm));
                                      out[actualPosition.groupId] = nextSource;
                                    } else if (actualPosition?.groupId === group.id && typeof actualPosition.slotIdx === "number" && actualPosition.slotIdx !== sIdx) {
                                      const nextWithin = nextTarget.map((nm, i) => (i === actualPosition.slotIdx ? row.player : nm));
                                      out[group.id] = nextWithin;
                                    }
                                    return out;
                                  });
                                }
                                
                                handleStandingChange && handleStandingChange(category._id, selectedBrackets?.[category._id], sIdx, 'player', playerWithMetadata || null, group?.id);
                              }}
                              placeholder={`Change player... (current: ${row.player})`}
                              // For bracket swaps we rely on names already in the bracket + fallbackPlayers.
                              // Do not hard-restrict by allowedPlayerIds here, to avoid hiding valid approved players
                              // whose IDs/PPLIDs may not align perfectly with the schedule/bracket data.
                              fallbackPlayers={isPairSlot ? pairSlotFallbackPlayers : mergedFallbackPlayers}
                              allowedPlayerIds={isPairSlot ? undefined : approvedPlayerAllowList}
                              fetchFromApi={!isPairSlot}
                              bracketType={(isTeamCategory ? 'team' : (isDoubles ? 'doubles' : (divisionLower.includes('single') ? 'singles' : undefined)))}
                              ageCategory={category?.ageCategory}
                              tournamentYear={(function(){ try { const d = new Date((tournamentDates || [])[0]); return isNaN(d) ? undefined : d.getFullYear(); } catch(_) { return undefined; } })()}
                            />
                          </div>
                        ) : (
                          row.player
                        )}
                      </div>
                      <div style={{ textAlign: 'center', color: '#334155' }}>{Number(row.wins ?? 0)} - {Number(row.losses ?? 0)}</div>
                      <div style={{ textAlign: 'center', color: '#334155' }}>{Number(row.pointsFor ?? 0)} - {Number(row.pointsAgainst ?? 0)}</div>
                      {allowEditing ? (
                        <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
                          <button
                            type="button"
                            onClick={() => onDeleteSlot && onDeleteSlot(category._id, group.id, idx)}
                            style={{
                              padding: '6px 10px',
                              borderRadius: 8,
                              border: '1px solid #e5e7eb',
                              background: '#fff',
                              color: '#ef4444',
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                            title="Delete slot"
                          >
                            Delete
                          </button>
                        </div>
                      ) : null}
                    </div>
                  )).concat(
                    canAddSlot ? (
                      <div key={`add-slot-${group.id}`} style={{
                        display: 'flex',
                        justifyContent: 'flex-end',
                        padding: '12px 16px',
                        borderTop: '1px solid #e2e8f0',
                        background: '#f8fafc'
                      }}>
                        <button
                          type="button"
                          onClick={() => onAddSlot && onAddSlot(category._id, group.id)}
                          style={{
                            padding: '8px 12px',
                            borderRadius: 10,
                            border: '1px solid #10b981',
                            background: '#10b981',
                            color: 'white',
                            fontWeight: 800,
                            cursor: 'pointer'
                          }}
                          title="Add slot"
                        >
                          + Add slot
                        </button>
                      </div>
                    ) : null
                  );
                })()}
              </div>

              <div style={{ background: 'white', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <h4 style={{ margin: 0, color: '#334155' }}>Match Schedule</h4>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginRight: 8 }}>
                      <span style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 600 }}>Games per match:</span>
                      <select
                        value={gamesPerMatch}
                        onChange={(e) => {
                          const next = Math.min(Math.max(Number(e.target.value || 3), 1), 3);
                          setGamesPerMatch(next);
                        }}
                        style={{ padding: '6px 10px', border: '2px solid #e5e7eb', borderRadius: 6, fontWeight: 600, background: '#fff', color: '#334155' }}
                      >
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                        <option value={3}>3</option>
                      </select>
                    </div>
                  </div>
                </div>
                <div style={{ padding: 16 }}>
                <div style={{ overflowX: isScheduleEditing ? 'auto' : 'visible' }}>
                  <div style={{
                    display: 'grid',
                    gridTemplateColumns: columnsTemplate,
                    minWidth: isScheduleEditing ? '1020px' : 'auto',
                    gap: 0,
                    background: 'linear-gradient(135deg, #234255 0%, #29ba9b 100%)',
                    borderRadius: 8,
                    fontSize: '0.75rem',
                    fontWeight: 600,
                    color: 'white',
                    marginBottom: 16,
                    textAlign: 'center',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
                  }}>
                    <div style={{ padding: '16px 10px' }}>Match</div>
                    <div style={{ padding: '16px 10px' }}>Players</div>
                    <div style={{ padding: '16px 10px' }}>Time</div>
                    <div style={{ padding: '16px 10px' }}>Court</div>
                    <div style={{ padding: '16px 10px' }}>Date</div>
                    <div style={{ padding: '16px 10px' }}>Status</div>
                    {Array.from({ length: gamesPerMatch }).map((_, idx) => (
                      <div key={`h-g-${idx}`} style={{ padding: '16px 10px' }}>{`Game ${idx + 1}`}</div>
                    ))}
                    <div style={{ padding: '16px 10px' }}>Final Score</div>
                  </div>
                  {(() => {
                    const playersList = group.originalPlayers || (group.standings || []).map((s) => s.player);
                    const allMatches = [];
                    for (let i = 0; i < (playersList?.length || 0); i++) {
                      for (let j = i + 1; j < (playersList?.length || 0); j++) {
                        const k = `${i}-${(j - i - 1)}`;
                        const md = group.matches?.[k] || {};
                        const dMillis = toDateValue(md);
                        const tMins = toTimeValue(md);
                    const cStr = toCourtValue(md);
                    allMatches.push({ k, d: dMillis, t: tMins, c: cStr });
                      }
                    }
                allMatches.sort((a, b) => (a.d - b.d) || (a.t - b.t));
                    const groupOrder = new Map();
                    const seenPerGroup = new Map();
                    const ordByKey = new Map();
                    const suffixByKey = new Map();
                    let nextRank = 1;
                    for (const e of allMatches) {
                  const gk = makeGroupKey(e.d, e.t, e.c, e.k);
                      if (!groupOrder.has(gk)) groupOrder.set(gk, nextRank++);
                      const count = (seenPerGroup.get(gk) || 0) + 1;
                      seenPerGroup.set(gk, count);
                      ordByKey.set(e.k, groupOrder.get(gk));
                      suffixByKey.set(e.k, count);
                    }
                    return allMatches.map((e) => {
                      const parts = String(e.k).split('-');
                      const i = parseInt(parts[0]);
                      const off = parseInt(parts[1]);
                      const j = i + 1 + off;
                      
                      const p1Rank = `${selectedLetter}${i+1}`;
                      const p2Rank = `${selectedLetter}${j+1}`;
                      
                      const playerName = playersList?.[i] || p1Rank;
                      const opponentName = playersList?.[j] || p2Rank;
                      
                      const key = String(e.k);
                      const baseMatch = group.matches?.[key] || {};
                      const overlayMatch = (rrEdits && typeof rrEdits === 'object') ? (rrEdits[key] || {}) : {};
                      const localDraft = (isTeamCategory && rrRowEditingKey === key && localRrDraftByKey[key])
                        ? localRrDraftByKey[key]
                        : {};
                      const matchData = { ...baseMatch, ...overlayMatch, ...localDraft };
                      const baseOrd = ordByKey.get(key) || (i + 1);
                      const suffixOrd = suffixByKey.get(key) || 1;
                  const totalAtGroup = seenPerGroup.get(makeGroupKey(toDateValue(matchData), toTimeValue(matchData), toCourtValue(matchData), key)) || 1;
                      const matchNumber = totalAtGroup > 1 ? `G${baseOrd}.${suffixOrd}` : `G${baseOrd}`;
                      const matchLabel = `${matchNumber} • ${p1Rank} vs ${p2Rank}`;
                      const matchBadge = String(matchNumber || '').trim();
                      const matchVs = `${p1Rank} vs ${p2Rank}`;
                      
                      let timeValue = String(matchData.time || matchData.mdTime || '').trim();
                      let courtValue = String(matchData.court || '').trim();
                      let dateValue = String(matchData.date || matchData.mdDate || '').trim();
                      const hasSchedule = Boolean(
                        dateValue && timeValue && courtValue &&
                        dateValue !== '' && timeValue !== '' && courtValue !== ''
                      );
                      
                      if (matchData.status === 'Scheduled' && !hasSchedule) {
                        console.warn(`[BRACKETS] Match ${key} is "Scheduled" but missing schedule data:`, {
                          date: matchData.date,
                          mdDate: matchData.mdDate,
                          time: matchData.time,
                          mdTime: matchData.mdTime,
                          court: matchData.court,
                          status: matchData.status
                        });
                      }
                      const statusRaw = String(matchData.status || '').trim();
                      const statusLow = statusRaw.toLowerCase();
                      const effectiveStatus = (() => {
                        if (statusLow === 'completed') return 'Completed';
                        if (statusLow === 'ongoing') return 'Ongoing';
                        if (hasSchedule) return 'Scheduled';
                        if (statusLow === 'scheduled') return 'Unschedule';
                        if (statusRaw) return statusLow === 'unschedule' ? 'Unschedule' : statusRaw;
                        return 'Unschedule';
                      })();
                      const isOngoing = statusLow === 'ongoing';
                      const isCompleted = statusLow === 'completed';
                      const gpm = Math.min(Math.max(Number(category?.gamesPerMatch ?? gamesPerMatch ?? 3), 1), 3);
                      const fs1 = Number(matchData.finalScorePlayer1 ?? 0);
                      const fs2 = Number(matchData.finalScorePlayer2 ?? 0);
                      const set1P1 = String(matchData.game1Player1 ?? '0');
                      const set1P2 = String(matchData.game1Player2 ?? '0');
                      const set2P1 = matchData.game2Player1 || '0';
                      const set2P2 = matchData.game2Player2 || '0';
                      const set3P1 = matchData.game3Player1 || '0';
                      const set3P2 = matchData.game3Player2 || '0';
                      const toNum = (v) => {
                        const n = parseInt(v, 10);
                        return Number.isNaN(n) ? 0 : n;
                      };
                      const setsNum = [
                        [toNum(set1P1), toNum(set1P2)],
                        [toNum(set2P1), toNum(set2P2)],
                        [toNum(set3P1), toNum(set3P2)],
                      ].slice(0, gpm);
                      let winsP1 = 0, winsP2 = 0;
                      const anySetPts = setsNum.some(([a,b]) => a || b);
                      if (anySetPts) {
                        setsNum.forEach(([a,b]) => { if (a>b) winsP1++; else if (b>a) winsP2++; });
                      } else if (fs1 + fs2 > 0 && fs1 <= gpm && fs2 <= gpm) {
                        winsP1 = fs1; winsP2 = fs2;
                      }
                      const finalP1 = String(winsP1);
                      const finalP2 = String(winsP2);
                      const gameSignatures = Array.isArray(matchData.gameSignatures) ? matchData.gameSignatures : [];
                      const rrDropdownKey = `${String(group?.id || "")}:${String(key || "")}`;
                      const rrDropdownOpen = Boolean(teamMatchDropdownOpenRR[rrDropdownKey]);
                    const editingThisRow = Boolean(isScheduleEditing || rrRowEditingKey === key);
                      return (
                        <React.Fragment key={`rr-${key}`}>
                        <div
                        onClick={(e) => {
                          if (!isTeamCategory) return;
                          if (shouldIgnoreToggleClick(e.target)) return;
                          if (rrRowEditingKey === key) return;
                          setTeamMatchDropdownOpenRR((prev) => ({ ...prev, [rrDropdownKey]: !Boolean(prev[rrDropdownKey]) }));
                        }}
                        style={{
                          display: 'grid',
                          gridTemplateColumns: columnsTemplate,
                          minWidth: isEditing ? '1020px' : 'auto',
                          gap: 0,
                          padding: '12px 10px',
                          borderRadius: 8,
                          fontSize: '0.8rem',
                          marginBottom: 16,
                          background: isOngoing ? '#fff7ed' : 'white',
                          border: isOngoing ? '2px solid #f97316' : (isCompleted ? '1px solid #10b981' : '1px solid #e2e8f0'),
                          boxShadow: isOngoing ? '0 2px 8px rgba(249, 115, 22, 0.2)' : '0 2px 4px rgba(0,0,0,0.05)',
                          cursor: isTeamCategory ? 'pointer' : 'default',
                          position: 'relative'
                        }}>
                          {!editingThisRow && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                const rrDropdownKey = `${String(group?.id || "")}:${String(key || "")}`;
                                setTeamMatchDropdownOpenRR((prev) => ({ ...prev, [rrDropdownKey]: true }));
                                setSavingRoundRobinByMatch((prev) => {
                                  if (!prev[key]) return prev;
                                  const nextState = { ...prev };
                                  delete nextState[key];
                                  return nextState;
                                });
                                const snapshot = { ...baseMatch, ...overlayMatch };
                                beginLocalRrDraft(key, snapshot);
                                setRrRowEditingKey(key);
                              }}
                              style={{
                                position: 'absolute',
                                top: 8,
                                right: 8,
                                cursor: 'pointer',
                                padding: 2,
                                background: 'transparent',
                                border: 'none',
                                borderRadius: 0,
                                boxShadow: 'none',
                              }}
                              title="Edit this match"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="m18.5 2.5 a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                              </svg>
                            </button>
                          )}
                          <div style={{ margin: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, textAlign: 'center' }}>
                            <div style={{
                              background: 'linear-gradient(135deg, #234255, #29ba9b)',
                              color: 'white',
                              borderRadius: 4,
                              fontWeight: 700,
                              fontSize: '0.7rem',
                              boxShadow: '0 1px 2px rgba(59,130,246,0.3)',
                              padding: '4px 8px',
                              lineHeight: 1
                            }}>{matchBadge}</div>
                            <div style={{ fontWeight: 600, fontSize: '0.72rem', color: '#234255', whiteSpace: 'nowrap' }}>{matchVs}</div>
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '0 8px', gap: 4, minWidth: 140 }}>
                            <div
                              title={String(playerName || '')}
                              style={{
                                fontWeight: 600,
                                color: '#1f2937',
                                fontSize: '0.8rem',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: '100%',
                                textAlign: 'center',
                              }}
                            >
                              {isDoubles ? formatTeamName(playerName) : playerName}
                            </div>
                            <div style={{ fontWeight: 800, color: '#ef4444', fontSize: '0.85rem' }}>VS</div>
                            <div
                              title={String(opponentName || '')}
                              style={{
                                fontWeight: 600,
                                color: '#1f2937',
                                fontSize: '0.8rem',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: '100%',
                                textAlign: 'center',
                              }}
                            >
                              {isDoubles ? formatTeamName(opponentName) : opponentName}
                            </div>
                          </div>
                          <>
                              <div style={{ textAlign: 'center', fontWeight: 500, color: '#374151' }}>
                                {hasSchedule ? timeValue : <span style={{ color: '#ef4444', fontWeight: 700 }}>-</span>}
                              </div>
                              <div style={{ textAlign: 'center', fontWeight: 500, color: '#374151' }}>
                                {hasSchedule ? courtValue : <span style={{ color: '#ef4444', fontWeight: 700 }}>-</span>}
                              </div>
                              <div style={{ textAlign: 'center', fontWeight: 500, color: '#374151' }}>
                                {hasSchedule ? dateValue : <span style={{ color: '#ef4444', fontWeight: 700 }}>-</span>}
                              </div>
                          </>
                          <div style={{ textAlign: 'center', fontWeight: 700 }}>
                            {editingThisRow ? (
                              <select
                                value={effectiveStatus}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  if (onChangeMatch) onChangeMatch(key, 'status', val);
                                  if (val === 'Scheduled' || val === 'Unschedule') {
                                    if (onChangeMatch) {
                                      onChangeMatch(key, 'game1Player1', 0);
                                      onChangeMatch(key, 'game1Player2', 0);
                                      onChangeMatch(key, 'game2Player1', 0);
                                      onChangeMatch(key, 'game2Player2', 0);
                                      onChangeMatch(key, 'game3Player1', 0);
                                      onChangeMatch(key, 'game3Player2', 0);
                                      onChangeMatch(key, 'finalScorePlayer1', 0);
                                      onChangeMatch(key, 'finalScorePlayer2', 0);
                                      onChangeMatch(key, 'refereeNote', '');
                                      onChangeMatch(key, 'signatureData', '');
                                    }
                                  }
                                }}
                                style={{ 
                                  width: '100%', 
                                  padding: '6px 8px', 
                                  border: '2px solid #e5e7eb', 
                                  borderRadius: 6, 
                                  fontSize: '0.75rem', 
                                  textAlign: 'center',
                                  fontWeight: 700,
                                  backgroundColor: '#fff'
                                }}
                              >
                                <option value="Scheduled">Scheduled</option>
                                <option value="Ongoing">Ongoing</option>
                                <option value="Completed">Completed</option>
                                <option value="Unschedule">Unschedule</option>
                              </select>
                            ) : (
                              <span style={{ color: (() => {
                                if (isOngoing) return '#f97316';
                                if (isCompleted) return '#10b981';
                                return hasSchedule ? '#10b981' : '#ef4444';
                              })() }}>
                                {isOngoing ? 'Ongoing' : (isCompleted ? 'Completed' : (hasSchedule ? 'Scheduled' : 'Unschedule'))}
                              </span>
                            )}
                          </div>
                          {(() => {
                            const sets = [
                              { p1: set1P1, p2: set1P2, k1: 'game1Player1', k2: 'game1Player2', sig: gameSignatures[0] },
                              { p1: set2P1, p2: set2P2, k1: 'game2Player1', k2: 'game2Player2', sig: gameSignatures[1] },
                              { p1: set3P1, p2: set3P2, k1: 'game3Player1', k2: 'game3Player2', sig: gameSignatures[2] },
                            ];
                            return sets.slice(0, gamesPerMatch).map((s, idx) => {
                              const sigUrl = s.sig ? resolveFileUrl(String(s.sig)) : null;
                              return (
                                <div key={`set-${key}-${idx}`} style={{ textAlign: 'center' }}>
                                  <div style={{ fontWeight: 600, color: '#1f2937', marginBottom: sigUrl ? 4 : 0 }}>
                                  {editingThisRow ? (
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
                                        <input
                                          type="number"
                                          value={s.p1}
                                          min="0"
                                          step="1"
                                          disabled={isTeamCategory}
                                          onChange={(e) => onChangeMatch && onChangeMatch(key, s.k1, e.target.value)}
                                          style={{
                                            width: 52,
                                            padding: '4px 6px',
                                            border: isTeamCategory ? 'none' : '2px solid #e5e7eb',
                                            borderRadius: 6,
                                            fontSize: '0.85rem',
                                            textAlign: 'center',
                                            boxSizing: 'border-box',
                                            background: isTeamCategory ? 'transparent' : '#fff',
                                            color: '#0f172a'
                                          }}
                                        />
                                        <input
                                          type="number"
                                          value={s.p2}
                                          min="0"
                                          step="1"
                                          disabled={isTeamCategory}
                                          onChange={(e) => onChangeMatch && onChangeMatch(key, s.k2, e.target.value)}
                                          style={{
                                            width: 52,
                                            padding: '4px 6px',
                                            border: isTeamCategory ? 'none' : '2px solid #e5e7eb',
                                            borderRadius: 6,
                                            fontSize: '0.85rem',
                                            textAlign: 'center',
                                            boxSizing: 'border-box',
                                            background: isTeamCategory ? 'transparent' : '#fff',
                                            color: '#0f172a'
                                          }}
                                        />
                                      </div>
                                    ) : (<><span>{s.p1}</span>-<span>{s.p2}</span></>)}
                                  </div>
                                  {!editingThisRow && idx >= 1 && (
                                    <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: 2 }}>
                                      {(() => {
                                        const tStart = idx === 1 ? String(matchData?.mdTime2 || '') : String(matchData?.mdTime3 || '');
                                        const tEnd = idx === 1 ? String(matchData?.mdEnd2 || '') : String(matchData?.mdEnd3 || '');
                                        return tStart && tEnd ? `${tStart} - ${tEnd}` : '';
                                      })()}
                                    </div>
                                  )}
                                  {/* signature preview hidden; open via Ref Panel */}
                                </div>
                              );
                            });
                          })()}
                          <div style={{ textAlign: 'center' }}>
                            <div style={{ fontWeight: 700, color: '#059669' }}>{finalP1}-{finalP2}</div>
                            <button
                              type="button"
                              onClick={() => {
                                setRefMatchKey(key);
                                setRefGroupId(group?.id || null);
                                setRefMatchTitle(`${matchBadge}: ${playerName} vs ${opponentName}`);
                                setRefNote(String(matchData?.refereeNote || '').trim());
                                setSignatureData(String(matchData?.signatureData || '').trim() || null);
                                setShowRefPanel(true);
                              }}
                              style={{
                                marginTop: 8,
                                padding: '6px 10px',
                                borderRadius: 10,
                                border: '1px solid #334155',
                                background: '#334155',
                                color: '#fff',
                                fontWeight: 700,
                                cursor: 'pointer',
                                width: 'fit-content',
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}
                              title="Open Referee Note & Signature"
                            >
                              Ref Panel
                            </button>
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', padding: '0 10px 12px 10px' }}>
                          {editingThisRow ? (
                            <>
                              <button
                                type="button"
                                onClick={() => {
                                  if (typeof onDiscardRoundRobinEdit === "function") {
                                    onDiscardRoundRobinEdit(key);
                                  }
                                  clearLocalRrDraft(key);
                                  setSavingRoundRobinByMatch((prev) => {
                                    if (!prev[key]) return prev;
                                    const nextState = { ...prev };
                                    delete nextState[key];
                                    return nextState;
                                  });
                                  setRrRowEditingKey(null);
                                }}
                                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #6b7280', background: '#6b7280', color: '#fff', fontWeight: 700, cursor: 'pointer' }}
                              >
                                Cancel
                              </button>
                              <button
                                type="button"
                                onClick={async () => {
                                  if (savingRoundRobinByMatch[key]) return;
                                  const savingKey = key;
                                  setSavingRoundRobinByMatch((prev) => ({ ...prev, [key]: true }));
                                  const payload = {};
                                  const toN = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? 0 : n; };
                                  const overlay = (rrEdits && typeof rrEdits === 'object') ? (rrEdits[key] || {}) : {};
                                  const localDraft = localRrDraftRef.current[key] || null;
                                  const latestDraft = typeof getLatestMatchDraft === 'function' ? getLatestMatchDraft(key) : null;
                                  const liveDraft = isTeamCategory ? (localDraft || overlay || latestDraft) : (overlay || latestDraft || localDraft);
                                  const merged = { ...matchData, ...overlay, ...(liveDraft || {}) };
                                  const g1p1N = toN(merged?.game1Player1);
                                  const g1p2N = toN(merged?.game1Player2);
                                  const g2p1N = toN(merged?.game2Player1);
                                  const g2p2N = toN(merged?.game2Player2);
                                  const g3p1N = toN(merged?.game3Player1);
                                  const g3p2N = toN(merged?.game3Player2);
                                  let w1 = 0; let w2 = 0;
                                  const gpmEff = Math.min(Math.max(Number(category?.gamesPerMatch ?? gamesPerMatch ?? 3), 1), 3);
                                  [[g1p1N,g1p2N],[g2p1N,g2p2N],[g3p1N,g3p2N]].slice(0,gpmEff).forEach(([a,b]) => { if (a>b) w1++; else if (b>a) w2++; });
                                  const anyPoints = [g1p1N,g1p2N,g2p1N,g2p2N,g3p1N,g3p2N].slice(0, gpmEff*2).some((n) => n > 0);
                                  const setsToWin = Math.ceil(gpmEff / 2);
                                  const autoStatus =
                                    (w1 >= setsToWin || w2 >= setsToWin)
                                      ? "Completed"
                                      : (anyPoints ? "Ongoing" : (String(merged?.status || "").trim() || "Unschedule"));
                                  const next = {
                                    ...matchData, // Preserve ALL existing fields!
                                    player1: playerName,
                                    player1Name: playerName,
                                    player2: opponentName,
                                    player2Name: opponentName,
                                    game1Player1: g1p1N,
                                    game1Player2: g1p2N,
                                    game2Player1: g2p1N,
                                    game2Player2: g2p2N,
                                    game3Player1: g3p1N,
                                    game3Player2: g3p2N,
                                    game1Team1Player: String(merged.game1Team1Player || ''),
                                    game1Team1Player2: String(merged.game1Team1Player2 || ''),
                                    game1Team2Player: String(merged.game1Team2Player || ''),
                                    game1Team2Player2: String(merged.game1Team2Player2 || ''),
                                    game2Team1Player: String(merged.game2Team1Player || ''),
                                    game2Team1Player2: String(merged.game2Team1Player2 || ''),
                                    game2Team2Player: String(merged.game2Team2Player || ''),
                                    game2Team2Player2: String(merged.game2Team2Player2 || ''),
                                    game3Team1Player: String(merged.game3Team1Player || ''),
                                    game3Team1Player2: String(merged.game3Team1Player2 || ''),
                                    game3Team2Player: String(merged.game3Team2Player || ''),
                                    game3Team2Player2: String(merged.game3Team2Player2 || ''),
                                    finalScorePlayer1: w1,
                                    finalScorePlayer2: w2,
                                    status: autoStatus,
                                    matchId: matchBadge,
                                    matchKey: key
                                  };
                                  payload[key] = next;
                                  try {
                                    if (typeof onQuickSaveNormalized === 'function') {
                                      await onQuickSaveNormalized(key, next);
                                    } else if (onQuickSave) {
                                      await onQuickSave(payload);
                                    }
                                    clearLocalRrDraft(savingKey);
                                    setRrRowEditingKey((prev) => (prev === savingKey ? null : prev));
                                  } catch {
                                    // Keep editor open on failure so user can retry without re-entering data.
                                  } finally {
                                    setSavingRoundRobinByMatch((prev) => {
                                      const nextState = { ...prev };
                                      delete nextState[key];
                                      return nextState;
                                    });
                                  }
                                }}
                                disabled={Boolean(savingRoundRobinByMatch[key])}
                                style={{ padding: '6px 10px', borderRadius: 8, border: '1px solid #10b981', background: '#10b981', color: '#fff', fontWeight: 700, cursor: savingRoundRobinByMatch[key] ? 'not-allowed' : 'pointer', opacity: savingRoundRobinByMatch[key] ? 0.7 : 1 }}
                                title="Save this match"
                              >
                                {savingRoundRobinByMatch[key] ? 'Saving...' : 'Save'}
                              </button>
                            </>
                          ) : (
                            null
                          )}
                        </div>
                        {isTeamCategory && (rrDropdownOpen || rrRowEditingKey === key) ? (
                          <div style={{ marginTop: -8, marginBottom: 16, padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'stretch' }}>
                              <div style={{ display: 'grid', gap: 8 }}>
                                {Array.from({ length: gamesPerMatch }).map((_, gameIdx) => (
                                  <div key={`team-label-${key}-${gameIdx + 1}`} style={{ border: 'none', borderRadius: 0, background: 'transparent', padding: 8, display: 'flex', alignItems: 'center', fontSize: '0.72rem', fontWeight: 700, color: '#334155' }}>
                                    Game {gameIdx + 1}
                                  </div>
                                ))}
                              </div>
                              <div style={{ display: 'grid', gap: 8 }}>
                              {Array.from({ length: gamesPerMatch }).map((_, gameIdx) => {
                                const gameNo = gameIdx + 1;
                                const team1Player1Key = `game${gameNo}Team1Player`;
                                const team1Player2Key = `game${gameNo}Team1Player2`;
                                const team2Player1Key = `game${gameNo}Team2Player`;
                                const team2Player2Key = `game${gameNo}Team2Player2`;
                                const team1Pick1 = String(matchData?.[team1Player1Key] || '').trim();
                                const team1Pick2 = String(matchData?.[team1Player2Key] || '').trim();
                                const team2Pick1 = String(matchData?.[team2Player1Key] || '').trim();
                                const team2Pick2 = String(matchData?.[team2Player2Key] || '').trim();
                                const team1Options = getTeamOptionsForSlot(playerName);
                                const team2Options = getTeamOptionsForSlot(opponentName);
                                const isTeamNameOnly = (pick, teamSlotName) => {
                                  const pv = String(pick || '').trim().toLowerCase();
                                  if (!pv) return true;
                                  const tv = String(formatTeamLabel(teamSlotName, "") || "").trim().toLowerCase();
                                  return Boolean(tv && pv === tv);
                                };
                                const t1p1Unselected = isTeamNameOnly(team1Pick1, playerName);
                                const t1p2Unselected = isTeamNameOnly(team1Pick2, playerName);
                                const t2p1Unselected = isTeamNameOnly(team2Pick1, opponentName);
                                const t2p2Unselected = isTeamNameOnly(team2Pick2, opponentName);
                                return (
                                  <div key={`team-pick-${key}-${gameNo}`} style={{ border: 'none', borderRadius: 0, background: 'transparent', padding: 8, display: 'grid', gridTemplateColumns: '1fr 60px', gap: 8, alignItems: 'center' }}>
                                    {rrRowEditingKey === key ? (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                          <select
                                            value={team1Pick1}
                                            onChange={(e) => handleRrMatchFieldChange(key, team1Player1Key, String(e.target.value || ''))}
                                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t1p1Unselected ? '#dc2626' : '#0f172a', fontWeight: t1p1Unselected ? 700 : 500 }}
                                          >
                                            <option value="">{formatTeamLabel(playerName, "Team 1 - P1")}</option>
                                            {team1Options.map((opt) => (
                                              <option key={`${team1Player1Key}-${opt}`} value={opt}>{opt}</option>
                                            ))}
                                          </select>
                                          <select
                                            value={team1Pick2}
                                            onChange={(e) => handleRrMatchFieldChange(key, team1Player2Key, String(e.target.value || ''))}
                                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t1p2Unselected ? '#dc2626' : '#0f172a', fontWeight: t1p2Unselected ? 700 : 500 }}
                                          >
                                            <option value="">{formatTeamLabel(playerName, "Team 1 - P2")}</option>
                                            {team1Options.map((opt) => (
                                              <option key={`${team1Player2Key}-${opt}`} value={opt}>{opt}</option>
                                            ))}
                                          </select>
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                          <select
                                            value={team2Pick1}
                                            onChange={(e) => handleRrMatchFieldChange(key, team2Player1Key, String(e.target.value || ''))}
                                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t2p1Unselected ? '#dc2626' : '#0f172a', fontWeight: t2p1Unselected ? 700 : 500 }}
                                          >
                                            <option value="">{formatTeamLabel(opponentName, "Team 2 - P1")}</option>
                                            {team2Options.map((opt) => (
                                              <option key={`${team2Player1Key}-${opt}`} value={opt}>{opt}</option>
                                            ))}
                                          </select>
                                          <select
                                            value={team2Pick2}
                                            onChange={(e) => handleRrMatchFieldChange(key, team2Player2Key, String(e.target.value || ''))}
                                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t2p2Unselected ? '#dc2626' : '#0f172a', fontWeight: t2p2Unselected ? 700 : 500 }}
                                          >
                                            <option value="">{formatTeamLabel(opponentName, "Team 2 - P2")}</option>
                                            {team2Options.map((opt) => (
                                              <option key={`${team2Player2Key}-${opt}`} value={opt}>{opt}</option>
                                            ))}
                                          </select>
                                        </div>
                                      </div>
                                    ) : (
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        <div style={{ fontSize: '0.72rem', color: '#475569' }}>{[team1Pick1 || '-', team1Pick2 || '-'].join(' / ')}</div>
                                        <div style={{ fontSize: '0.72rem', color: '#475569' }}>{[team2Pick1 || '-', team2Pick2 || '-'].join(' / ')}</div>
                                      </div>
                                    )}
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                      {rrRowEditingKey === key ? (
                                        <>
                                          <input
                                            type="number"
                                            min="0"
                                            step="1"
                                            value={String(matchData?.[`game${gameNo}Player1`] ?? "0")}
                                            onChange={(e) => handleRrMatchFieldChange(key, `game${gameNo}Player1`, e.target.value)}
                                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', textAlign: 'center' }}
                                          />
                                          <input
                                            type="number"
                                            min="0"
                                            step="1"
                                            value={String(matchData?.[`game${gameNo}Player2`] ?? "0")}
                                            onChange={(e) => handleRrMatchFieldChange(key, `game${gameNo}Player2`, e.target.value)}
                                            style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', textAlign: 'center' }}
                                          />
                                        </>
                                      ) : (
                                        <>
                                          <div style={{ fontSize: '0.72rem', color: '#0f172a', textAlign: 'center', fontWeight: 700 }}>{String(matchData?.[`game${gameNo}Player1`] ?? "0")}</div>
                                          <div style={{ fontSize: '0.72rem', color: '#0f172a', textAlign: 'center', fontWeight: 700 }}>{String(matchData?.[`game${gameNo}Player2`] ?? "0")}</div>
                                        </>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                              </div>
                            </div>
                          </div>
                        ) : null}
                        </React.Fragment>
                      );
                    });
                  })()}
                  </div>
                </div>
              </div>
              </>
            ) : (
              <div style={{ textAlign: 'center', padding: 24, color: '#64748b' }}>Select a bracket to view data</div>
            )}
          </div>
        )}

        {showElimination && (
          <div style={{ background: 'white', borderRadius: 16, border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden', marginTop: 16 }}>
            <div style={{ background: 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)', color: 'white', padding: '18px 24px', fontSize: '1.1rem', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                  <polyline points="7.5,4.21 12,6.81 16.5,4.21"/>
                  <polyline points="7.5,19.79 7.5,14.6 3,12"/>
                  <polyline points="21,12 16.5,14.6 16.5,19.79"/>
                  <polyline points="3.27,6.96 12,12.01 20.73,6.96"/>
                  <line x1="12" y1="22.08" x2="12" y2="12"/>
                </svg>
                Elimination Draw - Knockout Stage
              </div>
              {canSubmitPoints && (
                <button
                  onClick={() => onSubmitPoints && onSubmitPoints(category)}
                  style={{ padding: '8px 12px', background: '#059669', color: 'white', borderRadius: 8, border: 'none', fontWeight: 700, cursor: 'pointer' }}
                >
                  Submit Points
                </button>
              )}
            </div>
            <div style={{ padding: 16 }}>
              {(() => {
                const lettersAll = ['A','B','C','D','E','F','G','H'];
                const modeVal = Number(bracketMode?.[category._id] ?? category.bracketMode ?? 1);
                const letters = lettersAll.slice(0, Math.max(modeVal, 1));
                const persistedElimination = (Array.isArray(localElimMatches) && localElimMatches.length > 0) ? localElimMatches : (Array.isArray(category?.eliminationMatches?.matches) ? category.eliminationMatches.matches : []);
                const byIdOrTitle = (list, id, title) => {
                  const t = String(title || '').toLowerCase();
                  let found = (list || []).find(m => String(m.id || '').toLowerCase() === String(id || '').toLowerCase());
                  if (!found) {
                    if (t) {
                      found = (list || []).find(m => String(m.title || '').toLowerCase() === t);
                    }
                  }
                  return found;
                };
                const gp = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
                const rrCompleted = (() => {
                  try {
                    const groups = Array.isArray(category?.groupStage?.groups) ? category.groupStage.groups : [];
                    if (groups.length === 0) return false;
                    for (const g of groups) {
                      const matches = g?.matches && typeof g.matches === "object" ? g.matches : {};
                      const keys = Object.keys(matches || {});
                      if (keys.length === 0) return false;
                      for (const k of keys) {
                        const md = matches[k] || {};
                        const s = String(md?.status || "").toLowerCase();
                        if (s !== "completed") return false;
                      }
                    }
                    return true;
                  } catch {
                    return false;
                  }
                })();
                const makeMatch = (id, scheduleKey, title, p1, p2, providedPrev) => {
                  const prev = providedPrev || byIdOrTitle(persistedElimination, id, title) || {};
                  const prevP1 = (typeof prev.player1 === 'string' ? prev.player1 : (prev.player1?.name)) || '';
                  const prevP2 = (typeof prev.player2 === 'string' ? prev.player2 : (prev.player2?.name)) || '';
                  const hasPrev = Boolean(prevP1 || prevP2);
                  const hasAnyRoundRobinScoreData = (() => {
                    try {
                      const groups = Array.isArray(category?.groupStage?.groups) ? category.groupStage.groups : [];
                      for (const g of groups) {
                        const matches = g?.matches && typeof g.matches === "object" ? g.matches : {};
                        for (const k of Object.keys(matches || {})) {
                          const m = matches[k] || {};
                          const nums = [
                            Number(m?.game1Player1) || 0, Number(m?.game1Player2) || 0,
                            Number(m?.game2Player1) || 0, Number(m?.game2Player2) || 0,
                            Number(m?.game3Player1) || 0, Number(m?.game3Player2) || 0,
                            Number(m?.finalScorePlayer1) || 0, Number(m?.finalScorePlayer2) || 0,
                          ];
                          if (nums.some((n) => n > 0)) return true;
                        }
                      }
                      return false;
                    } catch {
                      return false;
                    }
                  })();
                  // Always use computed seeds from current group standings!
                  const useSeeds = true;
                  const displayP1 = useSeeds ? (p1 || '') : prevP1;
                  const displayP2 = useSeeds ? (p2 || '') : prevP2;
                  return {
                    ...prev, // Preserve ALL existing fields (including team-player dropdowns, etc.)
                    id,
                    scheduleKey,
                    persistedId: prev?.id ? String(prev.id) : "",
                    title,
                    player1: displayP1 || 'TBD',
                    player2: displayP2 || 'TBD',
                    game1Player1: gp(prev.game1Player1),
                    game1Player2: gp(prev.game1Player2),
                    game2Player1: gp(prev.game2Player1),
                    game2Player2: gp(prev.game2Player2),
                    game3Player1: gp(prev.game3Player1),
                    game3Player2: gp(prev.game3Player2),
                    finalScorePlayer1: gp(prev.finalScorePlayer1),
                    finalScorePlayer2: gp(prev.finalScorePlayer2),
                    score1: gp(prev.score1),
                    score2: gp(prev.score2),
                    winner: String(prev.winner || '').trim(),
                    status: String(prev.status || '').trim(),
                    court: String(prev.court || ''),
                    date: String(prev.date || ''),
                    time: String(prev.time || '')
                  };
                };
                const computeBracketStandings = (letter) => {
                  const gid = `group-${String(letter || '').toLowerCase()}`;
                  const g = category.groupStage?.groups?.find((x) => x.id === gid);
                  if (!g) return [];
                  const rawPlayers =
                    (Array.isArray(g?.originalPlayers) && g.originalPlayers.length > 0)
                      ? g.originalPlayers
                      : (Array.isArray(g?.standings) ? g.standings.map((s) => s.player) : []);
                  const players = (Array.isArray(rawPlayers) ? rawPlayers : []).map(resolveSlotLabel).filter(Boolean);
                  const enhanced = {};
                  Object.keys(g.matches || {}).forEach((key) => {
                    const parts = String(key).split('-');
                    const i = parseInt(parts[0]);
                    const off = parseInt(parts[1]);
                    const j = i + 1 + (isNaN(off) ? 0 : off);
                    const m = g.matches[key] || {};
                    const p1 = resolveSlotLabel(m?.player1Name || m?.player1 || players[i]);
                    const p2 = resolveSlotLabel(m?.player2Name || m?.player2 || players[j]);
                    enhanced[key] = { ...m, player1: p1, player2: p2 };
                  });
                  const hasMatchData = Object.keys(enhanced).length > 0;
                  if (hasMatchData) {
                    // Seeding priority: most wins -> most win points (pointsFor) -> least lose points (pointsAgainst)
                    const standings = calculateStandings(enhanced, players, false);
                    return Array.isArray(standings) ? standings : [];
                  }
                  // Fallback only when no match data exists.
                  const st = Array.isArray(g?.standings) ? g.standings : [];
                  const toNum = (v) => {
                    const n = Number(v);
                    return Number.isFinite(n) ? n : 0;
                  };
                  return [...st].sort((a, b) => {
                    const aWins = toNum(a?.wins);
                    const bWins = toNum(b?.wins);
                    if (bWins !== aWins) return bWins - aWins;
                    const aPts = toNum(a?.pointsFor ?? a?.rankPoints ?? a?.points ?? a?.gamesWon);
                    const bPts = toNum(b?.pointsFor ?? b?.rankPoints ?? b?.points ?? b?.gamesWon);
                    if (bPts !== aPts) return bPts - aPts;
                    const aAgainst = toNum(a?.pointsAgainst);
                    const bAgainst = toNum(b?.pointsAgainst);
                    if (aAgainst !== bAgainst) return aAgainst - bAgainst;
                    return 0;
                  });
                };
                const toEntry = (s) => s ? { name: (s.player || s.name), points: (s.wins ?? s.points ?? s.gamesWon ?? 0), pointDifferential: s.pointDifferential ?? 0 } : null;
                const normalizeSlug = (v) =>
                  String(v || "")
                    .trim()
                    .toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .replace(/^-+|-+$/g, "");
                const effectiveTournamentSlug = normalizeSlug(tournamentSlug || tournamentName);
                const isPplLuzonOpen = effectiveTournamentSlug.includes("luzon-2026");
                const topPlayers = {};
                letters.forEach((L) => {
                  const st = computeBracketStandings(L);
                  topPlayers[L] = {
                    first: toEntry(st[0]) || null,
                    second: toEntry(st[1]) || null,
                    third: toEntry(st[2]) || null,
                    fourth: toEntry(st[3]) || null,
                  };
                });
                let baseMatches = [];
                if (letters.length === 1) {
                  const A = topPlayers.A || {};
                  baseMatches = [
                    makeMatch('final', 'final', 'Final: A1 vs A2', A.first?.name || 'A1', A.second?.name || 'A2'),
                    makeMatch('bronze', 'bronze', 'Battle for Bronze: A3 vs A4', A.third?.name || 'A3', A.fourth?.name || 'A4'),
                  ];
                } else if (letters.length === 2) {
                  const A = topPlayers.A || {}, B = topPlayers.B || {};
                  baseMatches = [
                    makeMatch('semi1', 'sf1', 'Semi-Final 1: A1 vs B2', A.first?.name || 'A1', B.second?.name || 'B2' ),
                    makeMatch('semi2', 'sf2', 'Semi-Final 2: B1 vs A2', B.first?.name || 'B1', A.second?.name || 'A2' ),
                    makeMatch('bronze', 'bronze', 'Battle for Bronze', 'Loser SF1', 'Loser SF2'),
                    makeMatch('final', 'final', 'Battle for Gold', 'Winner SF1', 'Winner SF2'),
                  ];
                } else if (letters.length === 4) {
                  const defaultQuarterFinals = [
                    makeMatch('quarter1', 'qf1', 'Quarter-Final 1: A1 vs D2', topPlayers.A?.first?.name || 'A1', topPlayers.D?.second?.name || 'D2'),
                    makeMatch('quarter2', 'qf2', 'Quarter-Final 2: B1 vs C2', topPlayers.B?.first?.name || 'B1', topPlayers.C?.second?.name || 'C2'),
                    makeMatch('quarter3', 'qf3', 'Quarter-Final 3: C1 vs B2', topPlayers.C?.first?.name || 'C1', topPlayers.B?.second?.name || 'B2'),
                    makeMatch('quarter4', 'qf4', 'Quarter-Final 4: D1 vs A2', topPlayers.D?.first?.name || 'D1', topPlayers.A?.second?.name || 'A2'),
                  ];
                  const pplLuzonOpenQuarterFinals = [
                    makeMatch('quarter1', 'qf1', 'Quarter-Final 1: A1 vs D2', topPlayers.A?.first?.name || 'A1', topPlayers.D?.second?.name || 'D2'),
                    makeMatch('quarter2', 'qf2', 'Quarter-Final 2: B1 vs C2', topPlayers.B?.first?.name || 'B1', topPlayers.C?.second?.name || 'C2'),
                    makeMatch('quarter3', 'qf3', 'Quarter-Final 3: C1 vs B2', topPlayers.C?.first?.name || 'C1', topPlayers.B?.second?.name || 'B2'),
                    makeMatch('quarter4', 'qf4', 'Quarter-Final 4: D1 vs A2', topPlayers.D?.first?.name || 'D1', topPlayers.A?.second?.name || 'A2'),
                  ];
                  baseMatches = [
                    ...(isPplLuzonOpen ? pplLuzonOpenQuarterFinals : defaultQuarterFinals),
                    makeMatch('semi1', 'sf1', 'Semi-Final 1', 'Winner QF1', 'Winner QF2'),
                    makeMatch('semi2', 'sf2', 'Semi-Final 2', 'Winner QF3', 'Winner QF4'),
                    makeMatch('bronze', 'bronze', 'Battle for Bronze', 'Loser SF1', 'Loser SF2'),
                    makeMatch('final', 'final', 'Battle for Gold', 'Winner SF1', 'Winner SF2'),
                  ];
                } else if (letters.length === 8) {
                  const defaultRound16 = [
                    makeMatch('round16_1', 'r16-1', 'Round of 16 - 1: A1 vs H2', topPlayers.A?.first?.name || 'A1', topPlayers.H?.second?.name || 'H2'),
                    makeMatch('round16_2', 'r16-2', 'Round of 16 - 2: B1 vs G2', topPlayers.B?.first?.name || 'B1', topPlayers.G?.second?.name || 'G2'),
                    makeMatch('round16_3', 'r16-3', 'Round of 16 - 3: C1 vs F2', topPlayers.C?.first?.name || 'C1', topPlayers.F?.second?.name || 'F2'),
                    makeMatch('round16_4', 'r16-4', 'Round of 16 - 4: D1 vs E2', topPlayers.D?.first?.name || 'D1', topPlayers.E?.second?.name || 'E2'),
                    makeMatch('round16_5', 'r16-5', 'Round of 16 - 5: E1 vs D2', topPlayers.E?.first?.name || 'E1', topPlayers.D?.second?.name || 'D2'),
                    makeMatch('round16_6', 'r16-6', 'Round of 16 - 6: F1 vs C2', topPlayers.F?.first?.name || 'F1', topPlayers.C?.second?.name || 'C2'),
                    makeMatch('round16_7', 'r16-7', 'Round of 16 - 7: G1 vs B2', topPlayers.G?.first?.name || 'G1', topPlayers.B?.second?.name || 'B2'),
                    makeMatch('round16_8', 'r16-8', 'Round of 16 - 8: H1 vs A2', topPlayers.H?.first?.name || 'H1', topPlayers.A?.second?.name || 'A2'),
                  ];
                  const pplLuzonOpenRound16 = [
                    makeMatch('round16_1', 'r16-1', 'Round of 16 - 1: A1 vs H2', topPlayers.A?.first?.name || 'A1', topPlayers.H?.second?.name || 'H2'),
                    makeMatch('round16_2', 'r16-2', 'Round of 16 - 2: E1 vs D2', topPlayers.E?.first?.name || 'E1', topPlayers.D?.second?.name || 'D2'),
                    makeMatch('round16_3', 'r16-3', 'Round of 16 - 3: C1 vs F2', topPlayers.C?.first?.name || 'C1', topPlayers.F?.second?.name || 'F2'),
                    makeMatch('round16_4', 'r16-4', 'Round of 16 - 4: G1 vs B2', topPlayers.G?.first?.name || 'G1', topPlayers.B?.second?.name || 'B2'),
                    makeMatch('round16_5', 'r16-5', 'Round of 16 - 5: H1 vs A2', topPlayers.H?.first?.name || 'H1', topPlayers.A?.second?.name || 'A2'),
                    makeMatch('round16_6', 'r16-6', 'Round of 16 - 6: D1 vs E2', topPlayers.D?.first?.name || 'D1', topPlayers.E?.second?.name || 'E2'),
                    makeMatch('round16_7', 'r16-7', 'Round of 16 - 7: F1 vs C2', topPlayers.F?.first?.name || 'F1', topPlayers.C?.second?.name || 'C2'),
                    makeMatch('round16_8', 'r16-8', 'Round of 16 - 8: B1 vs G2', topPlayers.B?.first?.name || 'B1', topPlayers.G?.second?.name || 'G2'),
                  ];
                  baseMatches = [
                    ...(isPplLuzonOpen ? pplLuzonOpenRound16 : defaultRound16),
                    makeMatch('quarter1', 'qf1', 'Quarter-Final 1', 'Winner R16-1', 'Winner R16-2'),
                    makeMatch('quarter2', 'qf2', 'Quarter-Final 2', 'Winner R16-3', 'Winner R16-4'),
                    makeMatch('quarter3', 'qf3', 'Quarter-Final 3', 'Winner R16-5', 'Winner R16-6'),
                    makeMatch('quarter4', 'qf4', 'Quarter-Final 4', 'Winner R16-7', 'Winner R16-8'),
 
                    makeMatch('semi1', 'sf1', 'Semi-Final 1', 'Winner QF1', 'Winner QF2'),
                    makeMatch('semi2', 'sf2', 'Semi-Final 2', 'Winner QF3', 'Winner QF4'),
                    
                    makeMatch('bronze', 'bronze', 'Battle for Bronze', 'Loser SF1', 'Loser SF2'),
                    makeMatch('final', 'final', 'Battle for Gold', 'Winner SF1', 'Winner SF2'),
                  ];
                }

                // Merge with existing saved matches to preserve all saved data (scores, team players, etc.)!
                if (category?.eliminationMatches?.matches && Array.isArray(category.eliminationMatches.matches)) {
                  const savedMatchesMap = new Map(category.eliminationMatches.matches.map(m => [String(m.id), m]));
                  baseMatches = baseMatches.map(generatedMatch => {
                    const existingMatch = savedMatchesMap.get(String(generatedMatch.id));
                    if (existingMatch) {
                      // If there's an existing saved match for this id, use makeMatch with existingMatch as prev, but use generated player1/player2!
                      return makeMatch(
                        generatedMatch.id,
                        generatedMatch.scheduleKey,
                        generatedMatch.title,
                        generatedMatch.player1,
                        generatedMatch.player2,
                        existingMatch // This is the prev!
                      );
                    }
                    return generatedMatch;
                  });
                }

                // Resolve bracket progression: replace placeholders (Winner QF1, Loser SF1, etc.) with actual names from completed source matches
                const resolveBracketProgression = (matches, edits) => {
                  const idToIdx = {};
                  (matches || []).forEach((m, i) => {
                    if (m?.id) idToIdx[String(m.id)] = i;
                  });
                  const normId = (id) => {
                    const s = String(id || '').toLowerCase().replace(/[-_]/g, '');
                    return s === 'finals' ? 'final' : s;
                  };
                  const isBracketPlaceholderName = (val) =>
                    /^(winner|loser)\s+(r16-\d+|qf\d+|sf\d+)$/i.test(String(val || '').trim());
                  const getEffectiveMatch = (idx) => {
                    const base = matches[idx] || {};
                    const e = edits[idx] || {};
                    return { ...base, ...e };
                  };
                  const getWinnerLoser = (m) => {
                    if (!m) return { winner: null, loser: null };
                    const toName = (v) => (typeof v === 'string' ? v : (v?.name || ''));
                    const p1 = String(toName(m.player1) || '').trim();
                    const p2 = String(toName(m.player2) || '').trim();
                    const explicitWinner = String(m.winner || '').trim();
                    if (explicitWinner && !isBracketPlaceholderName(explicitWinner)) {
                      const normWinner = explicitWinner.toLowerCase();
                      const normP1 = p1.toLowerCase();
                      const normP2 = p2.toLowerCase();
                      if (normWinner === 'a' || normWinner === 'player1' || normWinner === normP1) {
                        return { winner: p1 || null, loser: p2 || null };
                      }
                      if (normWinner === 'b' || normWinner === 'player2' || normWinner === normP2) {
                        return { winner: p2 || null, loser: p1 || null };
                      }
                      if (p1 && p2) {
                        if (normP1.includes(normWinner) || normWinner.includes(normP1)) return { winner: p1, loser: p2 };
                        if (normP2.includes(normWinner) || normWinner.includes(normP2)) return { winner: p2, loser: p1 };
                      }
                    }
                    const s1 = Number(m.score1 ?? (m.game1Player1 || 0) + (m.game2Player1 || 0) + (m.game3Player1 || 0));
                    const s2 = Number(m.score2 ?? (m.game1Player2 || 0) + (m.game2Player2 || 0) + (m.game3Player2 || 0));
                    const fs1 = Number(m.finalScorePlayer1 ?? 0);
                    const fs2 = Number(m.finalScorePlayer2 ?? 0);
                    if (fs1 > fs2) return { winner: p1 || null, loser: p2 || null };
                    if (fs2 > fs1) return { winner: p2 || null, loser: p1 || null };
                    const g1p1 = Number(m.game1Player1 || 0);
                    const g1p2 = Number(m.game1Player2 || 0);
                    const g2p1 = Number(m.game2Player1 || 0);
                    const g2p2 = Number(m.game2Player2 || 0);
                    const g3p1 = Number(m.game3Player1 || 0);
                    const g3p2 = Number(m.game3Player2 || 0);
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
                    if (s1 > s2) return { winner: p1 || null, loser: p2 || null };
                    if (s2 > s1) return { winner: p2 || null, loser: p1 || null };
                    return { winner: null, loser: null };
                  };
                  const parsePlaceholder = (str) => {
                    const s = String(str || '').trim();
                    const wR16 = s.match(/^Winner\s+R16-(\d+)$/i);
                    if (wR16) return { sourceId: `round16_${wR16[1]}`, type: 'winner' };
                    const wQF = s.match(/^Winner\s+QF(\d+)$/i);
                    if (wQF) return { sourceId: `quarter${wQF[1]}`, type: 'winner' };
                    const wSF = s.match(/^Winner\s+SF(\d+)$/i);
                    if (wSF) return { sourceId: `semi${wSF[1]}`, type: 'winner' };
                    const lSF = s.match(/^Loser\s+SF(\d+)$/i);
                    if (lSF) return { sourceId: `semi${lSF[1]}`, type: 'loser' };
                    return null;
                  };
                  const winnersMap = new Map();
                  const participantsMap = new Map();
                  const pickW = (k) => winnersMap.get(normId(k));
                  (matches || []).forEach((m, idx) => {
                    const effective = getEffectiveMatch(idx);
                    const id = normId(effective?.id || m?.id || '');
                    let p1 = String((effective?.player1 ?? m?.player1) || '').trim();
                    let p2 = String((effective?.player2 ?? m?.player2) || '').trim();
                    if (id.startsWith('quarter')) {
                      const qfIdx = parseInt(id.replace('quarter', ''), 10) || 0;
                      if (qfIdx >= 1 && qfIdx <= 4) {
                        const rA = pickW(`round16_${(qfIdx - 1) * 2 + 1}`);
                        const rB = pickW(`round16_${(qfIdx - 1) * 2 + 2}`);
                        p1 = rA || p1;
                        p2 = rB || p2;
                      }
                    } else if (id === 'semi1') {
                      p1 = pickW('quarter1') || p1;
                      p2 = pickW('quarter2') || p2;
                    } else if (id === 'semi2') {
                      p1 = pickW('quarter3') || p1;
                      p2 = pickW('quarter4') || p2;
                    } else if (id === 'final') {
                      p1 = pickW('semi1') || p1;
                      p2 = pickW('semi2') || p2;
                    }
                    participantsMap.set(id, [p1, p2]);
                    const { winner } = getWinnerLoser({ ...effective, player1: p1, player2: p2 });
                    if (winner && !isBracketPlaceholderName(winner)) winnersMap.set(id, winner);
                  });
                  return matches.map((m, idx) => {
                    const id = normId(m?.id || '');
                    let p1 = String(m.player1 || '').trim();
                    let p2 = String(m.player2 || '').trim();
                    const resolveOne = (val) => {
                      const parsed = parsePlaceholder(val);
                      if (!parsed) return val;
                      const srcIdx = idToIdx[parsed.sourceId];
                      if (srcIdx == null) return val;
                      const src = getEffectiveMatch(srcIdx);
                      const { winner, loser } = getWinnerLoser(src);
                      const resolved = parsed.type === 'winner' ? winner : loser;
                      return (resolved && resolved !== 'TBD' && !isBracketPlaceholderName(resolved)) ? resolved : val;
                    };
                    p1 = resolveOne(p1);
                    p2 = resolveOne(p2);
                    if (id === 'semi1') {
                      p1 = pickW('quarter1') || p1;
                      p2 = pickW('quarter2') || p2;
                    } else if (id === 'semi2') {
                      p1 = pickW('quarter3') || p1;
                      p2 = pickW('quarter4') || p2;
                    } else if (id === 'final') {
                      p1 = pickW('semi1') || p1;
                      p2 = pickW('semi2') || p2;
                    } else if (id === 'bronze') {
                      const s1 = participantsMap.get('semi1') || [];
                      const s2 = participantsMap.get('semi2') || [];
                      const s1a = pickW('quarter1') || s1[0] || p1;
                      const s1b = pickW('quarter2') || s1[1] || p1;
                      const s2a = pickW('quarter3') || s2[0] || p2;
                      const s2b = pickW('quarter4') || s2[1] || p2;
                      const w1 = pickW('semi1');
                      const w2 = pickW('semi2');
                      const l1 = [s1a, s1b].find((x) => x && x !== w1) || p1;
                      const l2 = [s2a, s2b].find((x) => x && x !== w2) || p2;
                      p1 = l1;
                      p2 = l2;
                    } else if (id.startsWith('quarter')) {
                      const qfIdx = parseInt(id.replace('quarter', ''), 10) || 0;
                      if (qfIdx >= 1 && qfIdx <= 4) {
                        const rA = pickW(`round16_${(qfIdx - 1) * 2 + 1}`);
                        const rB = pickW(`round16_${(qfIdx - 1) * 2 + 2}`);
                        p1 = rA || p1;
                        p2 = rB || p2;
                      }
                    }
                    return { ...m, player1: p1 || 'TBD', player2: p2 || 'TBD' };
                  });
                };
                const effectiveBaseMatches = Array.isArray(localElimMatches) && localElimMatches.length > 0
                  ? localElimMatches
                  : baseMatches;
                const displayMatches = resolveBracketProgression(effectiveBaseMatches, elimEdits);
                const findSchedule = (candidates) => {
                  // Build schedule lookup map just like in Brackets.jsx
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
                    const byDate = courtAssignmentsByDate || {};
                    Object.keys(byDate || {}).forEach((d) => pushFromEntry(d, byDate[d] || {}));
                    const root = courtAssignments || null;
                    if (root && (Array.isArray(root?.assignments) || (Array.isArray(root?.venues) && root.venues.length > 0))) {
                      pushFromEntry(String(root?.scheduleDate || ''), root);
                    }
                    return out;
                  })();
                  
                  // Check all candidate keys in order
                  const expand = (keys) => {
                    const out = [];
                    keys.forEach((k) => {
                      const s = String(k || '').trim();
                      if (!s) return;
                      out.push(s, `${s}-g1`, `${s}-g2`, `${s}-g3`);
                    });
                    return out;
                  };
                  
                  for (const key of expand(candidates)) {
                    const hit = scheduleLookup.get(String(key)) || scheduleLookup.get(String(key).toLowerCase());
                    if (hit) return hit;
                  }
                  
                  return null;
                };
                const getEditVal = (idx, key, fallback) => {
                  const e = elimEdits[idx];
                  const v = e && key in e ? e[key] : undefined;
                  return v !== undefined ? v : fallback;
                };
                const setEditVal = (idx, key, val) => {
                  setElimEdits((prev) => {
                    const base = effectiveBaseMatches[idx] || {};
                    const entry = { ...base, ...(prev[idx] || {}), [key]: val };
                    return { ...prev, [idx]: entry };
                  });
                };
                const computeWins = (g1p1,g1p2,g2p1,g2p2,g3p1,g3p2) => {
                  let p1 = 0, p2 = 0;
                  if (g1p1 > g1p2) p1++; else if (g1p2 > g1p1) p2++;
                  if (g2p1 > g2p2) p1++; else if (g2p2 > g2p1) p2++;
                  if (g3p1 > g3p2) p1++; else if (g3p2 > g3p1) p2++;
                  return { p1, p2 };
                };
                const makeElimIdAliases = (id) => {
                  const s = String(id || '').trim().toLowerCase();
                  const out = new Set();
                  const push = (v) => { const t = String(v || '').trim(); if (t) out.add(t); };
                  push(s);
                  if (s.startsWith('quarter')) push(`qf${s.replace('quarter','')}`);
                  if (s.startsWith('qf')) push(`quarter${s.replace('qf','')}`);
                  if (s.startsWith('semi')) push(`sf${s.replace('semi','')}`);
                  if (s.startsWith('sf')) push(`semi${s.replace('sf','')}`);
                  if (s.startsWith('round16_')) push(`r16-${s.replace('round16_','')}`);
                  if (s.startsWith('r16-')) push(`round16_${s.replace('r16-','')}`);
                  if (s === 'finals') push('final');
                  if (s === 'final') push('finals');
                  return Array.from(out);
                };
                const makeElimCandidates = (catId, m) => {
                  const baseId = String(m?.id || '').trim();
                  const pid = String(m?.persistedId || '').trim();
                  const sk = String(m?.scheduleKey || '').trim();
                  const ids = new Set();
                  const add = (v) => { const t = String(v || '').trim(); if (t) ids.add(t); };
                  makeElimIdAliases(baseId).forEach((alias) => add(`elim-${catId}-${alias}`));
                  if (pid) makeElimIdAliases(pid).forEach((alias) => add(`elim-${catId}-${alias}`));
                  if (sk) add(`elimgen-${catId}-${sk}`);
                  const withGames = new Set();
                  Array.from(ids).forEach((k) => {
                    withGames.add(k);
                    withGames.add(`${k}-g1`);
                    withGames.add(`${k}-g2`);
                    withGames.add(`${k}-g3`);
                  });
                  return Array.from(withGames);
                };
                const saveOne = async (idx) => {
                  if (savingElim) return;
                  const stageOf = (title) => {
                    const s = String(title || '').toLowerCase();
                    if (s.includes('bronze')) return 'bronze';
                    if (s.includes('round of 16') || /\br16\b/.test(s)) return 'r16';
                    if (s.includes('quarter')) return 'quarters';
                    if (s.includes('semi')) return 'semis';
                    if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 'finals';
                    return 'elimination';
                  };
                  const gpmForMatch = (m) => {
                    const stage = stageOf(m?.title || m?.round);
                    const cfg = {
                      ...defaultElimGpm,
                      ...(category?.eliminationGpm && typeof category.eliminationGpm === 'object' ? category.eliminationGpm : {}),
                      ...(elimGpmLocal && typeof elimGpmLocal === 'object' ? elimGpmLocal : {})
                    };
                    return Math.min(Math.max(Number(cfg?.[stage] ?? cfg?.elimination ?? 3), 1), 3);
                  };
                  const next = effectiveBaseMatches.map((m, i) => {
                    const e = elimEdits[i] || {};
                    const isEditedRow = i === idx;
                    const g1p1 = gp(e.game1Player1 ?? m.game1Player1);
                    const g1p2 = gp(e.game1Player2 ?? m.game1Player2);
                    const g2p1 = gp(e.game2Player1 ?? m.game2Player1);
                    const g2p2 = gp(e.game2Player2 ?? m.game2Player2);
                    const g3p1 = gp(e.game3Player1 ?? m.game3Player1);
                    const g3p2 = gp(e.game3Player2 ?? m.game3Player2);
                    const wins = computeWins(g1p1,g1p2,g2p1,g2p2,g3p1,g3p2);
                    const s1 = g1p1 + g2p1 + g3p1;
                    const s2 = g1p2 + g2p2 + g3p2;
                    const gpmEff = gpmForMatch(m);
                    const needToWin = Math.ceil(gpmEff / 2);
                    let p1w = 0; let p2w = 0;
                    [1,2,3].slice(0, gpmEff).forEach((n) => {
                      const a = n === 1 ? g1p1 : (n === 2 ? g2p1 : g3p1);
                      const b = n === 1 ? g1p2 : (n === 2 ? g2p2 : g3p2);
                      if (a > b) p1w += 1; else if (b > a) p2w += 1;
                    });
                    const hasFinal = (wins.p1 + wins.p2) > 0;
                    const anyPoints = [1,2,3].slice(0, gpmEff).some((n) => {
                      const a = n === 1 ? g1p1 : (n === 2 ? g2p1 : g3p1);
                      const b = n === 1 ? g1p2 : (n === 2 ? g2p2 : g3p2);
                      return (a + b) > 0;
                    });
                    const sched = findSchedule(makeElimCandidates(category._id, m));
                    const dateEff = String(e.date ?? m.date ?? sched?.date ?? '').trim();
                    const timeEff = String(e.time ?? m.time ?? sched?.time ?? '').trim();
                    const courtEff = String(e.court ?? m.court ?? sched?.court ?? '').trim();
                    const autoStatus = hasFinal || (p1w >= needToWin) || (p2w >= needToWin)
                      ? 'Completed'
                      : (anyPoints ? 'Ongoing' : ((dateEff || timeEff || courtEff) ? 'Scheduled' : 'Unschedule'));
                    const prevStatus = String(m.status || '').trim();
                    const hasManualStatus = Object.prototype.hasOwnProperty.call(e, "status");
                    // IMPORTANT: only the edited row can change status on this save action.
                    // Other elimination matches must retain their current status.
                    const status = isEditedRow
                      ? (hasManualStatus ? String(e.status || '').trim() : autoStatus)
                      : (prevStatus || autoStatus);
                    const game1Team1Player = String(e.game1Team1Player ?? m.game1Team1Player ?? '');
                    const game1Team1Player2 = String(e.game1Team1Player2 ?? m.game1Team1Player2 ?? '');
                    const game1Team2Player = String(e.game1Team2Player ?? m.game1Team2Player ?? '');
                    const game1Team2Player2 = String(e.game1Team2Player2 ?? m.game1Team2Player2 ?? '');
                    const game2Team1Player = String(e.game2Team1Player ?? m.game2Team1Player ?? '');
                    const game2Team1Player2 = String(e.game2Team1Player2 ?? m.game2Team1Player2 ?? '');
                    const game2Team2Player = String(e.game2Team2Player ?? m.game2Team2Player ?? '');
                    const game2Team2Player2 = String(e.game2Team2Player2 ?? m.game2Team2Player2 ?? '');
                    const game3Team1Player = String(e.game3Team1Player ?? m.game3Team1Player ?? '');
                    const game3Team1Player2 = String(e.game3Team1Player2 ?? m.game3Team1Player2 ?? '');
                    const game3Team2Player = String(e.game3Team2Player ?? m.game3Team2Player ?? '');
                    const game3Team2Player2 = String(e.game3Team2Player2 ?? m.game3Team2Player2 ?? '');
                    return {
                      ...m,
                      game1Player1: g1p1, game1Player2: g1p2,
                      game2Player1: g2p1, game2Player2: g2p2,
                      game3Player1: g3p1, game3Player2: g3p2,
                      game1Team1Player, game1Team1Player2,
                      game1Team2Player, game1Team2Player2,
                      game2Team1Player, game2Team1Player2,
                      game2Team2Player, game2Team2Player2,
                      game3Team1Player, game3Team1Player2,
                      game3Team2Player, game3Team2Player2,
                      finalScorePlayer1: wins.p1,
                      finalScorePlayer2: wins.p2,
                      score1: s1, score2: s2,
                      date: dateEff,
                      time: timeEff,
                      court: courtEff,
                      status
                    };
                  });
                  try {
                    setSavingElim(true);
                    if (onSaveElimination) {
                      // Await parent save to avoid race conditions between rapid consecutive saves.
                      await onSaveElimination(category._id, next);
                    }
                    // Keep a local canonical snapshot so consecutive saves don't regress to stale props.
                    setLocalElimMatches(next);
                    // On successful save, clear pending edits and exit edit mode.
                    setElimEdits({});
                    setTeamMatchEditingElim((prev) => ({ ...prev, [idx]: false }));
                  } finally {
                    setSavingElim(false);
                  }
                };
                return (
                  <div style={{ display: 'grid', gap: 16 }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
                      <div style={{ fontWeight: 700, color: '#334155' }}>Games per match:</div>
                      {(() => {
                        const count = letters.length;
                        const stagesByCount = {
                          1: ['finals','bronze'],
                          2: ['semis','finals','bronze'],
                          4: ['quarters','semis','finals','bronze'],
                          8: ['r16','quarters','semis','finals','bronze']
                        };
                        const order = ['r16','quarters','semis','finals','bronze'];
                        const labels = { r16: 'R16', quarters: 'Quarters', semis: 'Semis', finals: 'Finals', bronze: 'Bronze' };
                        const visible = new Set(stagesByCount[count] || stagesByCount[1]);
                        const base = order.filter((k) => visible.has(k));
                        const withCombo = (() => {
                          if (base.includes('finals') && base.includes('bronze')) {
                            return base.filter((k) => k !== 'finals' && k !== 'bronze').concat(['finals_bronze']);
                          }
                          return base;
                        })();
                        return withCombo.map((k) => {
                          if (k === 'finals_bronze') return { k, label: 'Finals & Bronze' };
                          return { k, label: labels[k] };
                        });
                      })().map(({ k, label }) => (
                        <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ color: '#64748b', fontWeight: 600 }}>{label}</span>
                          <select
                            value={(() => {
                              if (k === 'finals_bronze') {
                                const v = Number(elimGpmLocal?.finals ?? elimGpmLocal?.bronze ?? 3);
                                return Math.min(Math.max(v || 3, 1), 3);
                              }
                              return elimGpmLocal[k];
                            })()}
                            onChange={(e) => {
                              const val = Math.min(Math.max(parseInt(e.target.value) || 1, 1), 3);
                              if (k === 'finals_bronze') {
                                setElimGpmLocal((prev) => ({ ...prev, finals: val, bronze: val }));
                              } else {
                                setElimGpmLocal((prev) => ({ ...prev, [k]: val }));
                              }
                            }}
                            style={{ padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 6, fontWeight: 700 }}
                          >
                            <option value={1}>1</option>
                            <option value={2}>2</option>
                            <option value={3}>3</option>
                          </select>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => onSave && onSave({ eliminationGpm: elimGpmLocal })}
                        style={{ padding: '6px 10px', borderRadius: 8, background: '#29ba9b', color: 'white', fontWeight: 700, border: 'none' }}
                      >
                        Save Settings
                      </button>
                    </div>
                    {displayMatches.map((m, idx) => {
                      const t = String(m.title || '').toLowerCase();
                      const isBronze = t.includes('bronze');
                      const isChampionship = t.includes('gold') || (t.includes('final') && !t.includes('semi') && !t.includes('quarter'));
                      const badgeText = isChampionship ? 'CHAMPIONSHIP' : (isBronze ? 'BRONZE BATTLE' : '');
                      const badgeBg = isChampionship ? '#f59e0b' : (isBronze ? '#9a5b27' : 'transparent');
                      const badgeBorder = isChampionship ? '#f59e0b' : (isBronze ? '#9a5b27' : '#e2e8f0');
                      const sched = findSchedule(makeElimCandidates(category._id, m));
                      const courtText = (m.court || sched?.court) ? `Court: ${m.court || sched.court}` : 'Court: -';
                      const dateTimeText = (() => {
                        const d = String(m.date || sched?.date || '').trim();
                        const tm = String(m.time || sched?.time || '').trim();
                        if (d && tm) return `${d} • ${tm}`;
                        if (d) return d;
                        if (tm) return tm;
                        return 'TBD';
                      })();
                      const stageOf = (title) => {
                        const s = String(title || '').toLowerCase();
                        if (s.includes('bronze')) return 'bronze';
                        if (s.includes('round of 16') || /\br16\b/.test(s)) return 'r16';
                        if (s.includes('quarter')) return 'quarters';
                        if (s.includes('semi')) return 'semis';
                        if (s.includes('final') && !s.includes('semi') && !s.includes('quarter')) return 'finals';
                        return 'elimination';
                      };
                      const stage = stageOf(m?.title || m?.round);
                      const cfg = {
                        ...defaultElimGpm,
                        ...(category?.eliminationGpm && typeof category.eliminationGpm === 'object' ? category.eliminationGpm : {}),
                        ...(elimGpmLocal && typeof elimGpmLocal === 'object' ? elimGpmLocal : {})
                      };
                      const gpmEff = Math.min(Math.max(Number(cfg?.[stage] ?? cfg?.elimination ?? 3), 1), 3);
                      const gp = (n, side) => Number(m[`game${n}Player${side}`]) || 0;
                      const anyPoints = [1,2,3].slice(0, gpmEff).some((n) => (gp(n,1) + gp(n,2)) > 0);
                      let p1w = 0; let p2w = 0;
                      [1,2,3].slice(0, gpmEff).forEach((n) => {
                        const a = gp(n,1); const b = gp(n,2);
                        if (a > b) p1w += 1; else if (b > a) p2w += 1;
                      });
                      const fs1 = Number(m.finalScorePlayer1 || 0);
                      const fs2 = Number(m.finalScorePlayer2 || 0);
                      const hasFinal = (fs1 + fs2) > 0;
                      const needToWin = Math.ceil(gpmEff / 2);
                      const isCompleted = hasFinal || (p1w >= needToWin) || (p2w >= needToWin);
                      const hasSchedule = dateTimeText !== 'TBD' || String(sched?.court || '').trim();
                      const autoStatus = isCompleted ? 'Completed' : (anyPoints ? 'Ongoing' : (hasSchedule ? 'Scheduled' : 'Unschedule'));
                      const modelStatus = String(m.status || '').trim();
                      const editStatus = String(getEditVal(idx, 'status', '') || '').trim();
                      const prefer = editStatus || modelStatus;
                      const statusText = (() => {
                        const pl = String(prefer || '').trim().toLowerCase();
                        if (!prefer) return autoStatus || 'Unschedule';
                        if (pl === 'unschedule' || pl === 'unscheduled') {
                          return hasSchedule ? (autoStatus || 'Scheduled') : 'Unschedule';
                        }
                        if (pl === 'scheduled' && !hasSchedule) return 'Unschedule';
                        return prefer;
                      })();
                      const statusNorm = String(statusText || '').trim().toLowerCase();
                      const statusStyle = (() => {
                        if (statusNorm === 'completed') return { background: '#16a34a', color: '#fff' };
                        if (statusNorm === 'ongoing') return { background: '#f59e0b', color: '#fff' };
                        if (statusNorm === 'scheduled') return { background: '#3b82f6', color: '#fff' };
                        return { background: '#e5e7eb', color: '#374151' };
                      })();
                      const elimDropdownOpen = Boolean(teamMatchDropdownOpenElim[idx]);
                      return (
                        <div
                          key={idx}
                          onClick={(e) => {
                            if (!isTeamCategory) return;
                            if (shouldIgnoreToggleClick(e.target)) return;
                            setTeamMatchDropdownOpenElim((prev) => ({ ...prev, [idx]: !Boolean(prev[idx]) }));
                          }}
                          style={{ background: '#fff', border: `1px solid ${badgeBorder}`, borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: 12, position: 'relative', cursor: isTeamCategory ? 'pointer' : 'default' }}
                        >
                          <div style={{ position: 'absolute', top: -22, right: 8, display: 'flex', gap: 4, background: '#fff', padding: 4, borderRadius: 6, boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                            {teamMatchEditingElim[idx] ? (
                              <>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setTeamMatchEditingElim((prev) => ({ ...prev, [idx]: false }));
                                  }}
                                  style={{ cursor: 'pointer', padding: '4px 8px', background: '#6b7280', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 500 }}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => saveOne(idx)}
                                  disabled={savingElim}
                                  style={{ cursor: savingElim ? 'not-allowed' : 'pointer', opacity: savingElim ? 0.7 : 1, padding: '4px 8px', background: '#10b981', color: '#fff', border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 500 }}
                                >
                                  {savingElim ? 'Saving...' : 'Save'}
                                </button>
                              </>
                            ) : (
                              <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation(); // Prevent toggling dropdown twice
                      setTeamMatchDropdownOpenElim((prev) => ({ ...prev, [idx]: true }));
                      setTeamMatchEditingElim((prev) => ({ ...prev, [idx]: true }));
                    }}
                    style={{ cursor: 'pointer', padding: 2, background: 'transparent', border: 'none', borderRadius: 4 }}
                    title="Edit"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="m18.5 2.5 a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                            )}
                          </div>
                          {badgeText ? (
                            <div style={{ position: 'absolute', top: -22, left: '50%', transform: 'translateX(-50%)', background: badgeBg, color: '#fff', fontWeight: 700, fontSize: 12, padding: '6px 12px', borderRadius: 999, border: `2px solid ${badgeBg}` }}>
                              {badgeText}
                            </div>
                          ) : null}
                          <div style={{ display: 'flex', gap: 12, alignItems: 'stretch' }}>
                            <div style={{ width: 40, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1e293b', fontWeight: 700 }}>
                              {idx + 1}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ color: '#334155', fontWeight: 700, marginBottom: 8 }}>{m.title}</div>
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', borderTop: '1px solid #f1f5f9', borderBottom: '1px solid #f1f5f9' }}>
                                <div style={{ display: 'flex', alignItems: 'center', padding: '12px' }}>
                                  <span style={{ fontWeight: 600, color: '#1e293b', fontSize: 16 }}>{m.player1 || m.p1 || 'TBD'}</span>
                                </div>
                                <div style={{ display: 'flex', borderLeft: '1px solid #e2e8f0' }}>
                                  {Array.from({ length: gpmEff }).map((_, idxG) => {
                                    const g = idxG + 1;
                                    const key = `game${g}Player1`;
                                    const val = getEditVal(idx, key, m[key]);
                                    return (
                                      <div key={g} style={{ padding: 12, minWidth: 50, textAlign: 'center', fontWeight: 600, color: '#64748b', borderRight: g < gpmEff ? '1px solid #e2e8f0' : 'none' }}>
                                        {teamMatchEditingElim[idx] ? (
                                          <input
                                            type="number"
                                            value={val}
                                            disabled={isTeamCategory}
                                            onChange={(e) => setEditVal(idx, key, Number(e.target.value) || 0)}
                                            style={{
                                              width: 40,
                                              textAlign: 'center',
                                              border: isTeamCategory ? 'none' : '1px solid #d1d5db',
                                              borderRadius: 4,
                                              padding: 2,
                                              fontSize: 14,
                                              background: isTeamCategory ? 'transparent' : '#fff',
                                              color: '#0f172a'
                                            }}
                                          />
                                        ) : (
                                          val || 0
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', padding: '12px' }}>
                                  <span style={{ fontWeight: 600, color: '#1e293b', fontSize: 16 }}>{m.player2 || m.p2 || 'TBD'}</span>
                                </div>
                                <div style={{ display: 'flex', borderLeft: '1px solid #e2e8f0' }}>
                                  {Array.from({ length: gpmEff }).map((_, idxG) => {
                                    const g = idxG + 1;
                                    const key = `game${g}Player2`;
                                    const val = getEditVal(idx, key, m[key]);
                                    return (
                                      <div key={g} style={{ padding: 12, minWidth: 50, textAlign: 'center', fontWeight: 600, color: '#64748b', borderRight: g < gpmEff ? '1px solid #e2e8f0' : 'none' }}>
                                        {teamMatchEditingElim[idx] ? (
                                          <input
                                            type="number"
                                            value={val}
                                            disabled={isTeamCategory}
                                            onChange={(e) => setEditVal(idx, key, Number(e.target.value) || 0)}
                                            style={{
                                              width: 40,
                                              textAlign: 'center',
                                              border: isTeamCategory ? 'none' : '1px solid #d1d5db',
                                              borderRadius: 4,
                                              padding: 2,
                                              fontSize: 14,
                                              background: isTeamCategory ? 'transparent' : '#fff',
                                              color: '#0f172a'
                                            }}
                                          />
                                        ) : (
                                          val || 0
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 8 }}>
                                <div style={{ color: '#64748b', fontSize: 12 }}>{courtText}</div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                  <div style={{ color: '#64748b', fontSize: 12 }}>{dateTimeText}</div>
                                  {teamMatchEditingElim[idx] ? (
                                    <select
                                      value={String(getEditVal(idx, 'status', statusText) || 'Unschedule')}
                                      onChange={(e) => setEditVal(idx, 'status', String(e.target.value || 'Unschedule'))}
                                      style={{ padding: '2px 8px', borderRadius: 8, border: '1px solid #cbd5e1', fontWeight: 700, fontSize: 12, color: '#334155', background: '#fff' }}
                                    >
                                      <option value="Unschedule">Unschedule</option>
                                      <option value="Scheduled">Scheduled</option>
                                      <option value="Ongoing">Ongoing</option>
                                      <option value="Completed">Completed</option>
                                    </select>
                                  ) : (
                                    <span style={{ padding: '2px 8px', borderRadius: 12, fontWeight: 700, fontSize: 12, ...statusStyle }}>
                                      {statusText}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <div style={{ textAlign: 'center', marginTop: 12 }}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRefMatchKey(m?.id || `elim-${idx}`);
                                    setRefGroupId(null);
                                    setRefMatchTitle(`${m.title || 'Elimination Match'}: ${m.player1 || m.p1 || 'TBD'} vs ${m.player2 || m.p2 || 'TBD'}`);
                                    setRefNote(String(m?.refereeNote || '').trim());
                                    setSignatureData(String(m?.signatureData || '').trim() || null);
                                    setShowRefPanel(true);
                                  }}
                                  style={{
                                    padding: '6px 10px',
                                    borderRadius: 10,
                                    border: '1px solid #334155',
                                    background: '#334155',
                                    color: '#fff',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    width: 'fit-content',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                  }}
                                  title="Open Referee Note & Signature"
                                >
                                  Ref Panel
                                </button>
                              </div>
                            </div>
                          </div>
                          {isTeamCategory && elimDropdownOpen ? (
                            <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#ffffff' }}>
                              <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 8, alignItems: 'stretch' }}>
                                <div style={{ display: 'grid', gap: 8 }}>
                                  {Array.from({ length: gpmEff }).map((_, idxG) => (
                                    <div key={`elim-team-label-${idx}-${idxG + 1}`} style={{ border: 'none', borderRadius: 0, background: 'transparent', padding: 8, display: 'flex', alignItems: 'center', fontSize: '0.72rem', fontWeight: 700, color: '#334155' }}>
                                      Game {idxG + 1}
                                    </div>
                                  ))}
                                </div>
                                <div style={{ display: 'grid', gap: 8 }}>
                                {Array.from({ length: gpmEff }).map((_, idxG) => {
                                  const g = idxG + 1;
                                  const team1Player1Key = `game${g}Team1Player`;
                                  const team1Player2Key = `game${g}Team1Player2`;
                                  const team2Player1Key = `game${g}Team2Player`;
                                  const team2Player2Key = `game${g}Team2Player2`;
                                  const team1Pick1 = String(getEditVal(idx, team1Player1Key, m?.[team1Player1Key]) || '');
                                  const team1Pick2 = String(getEditVal(idx, team1Player2Key, m?.[team1Player2Key]) || '');
                                  const team2Pick1 = String(getEditVal(idx, team2Player1Key, m?.[team2Player1Key]) || '');
                                  const team2Pick2 = String(getEditVal(idx, team2Player2Key, m?.[team2Player2Key]) || '');
                                  const team1Options = getTeamOptionsForSlot(m.player1 || m.p1 || '');
                                  const team2Options = getTeamOptionsForSlot(m.player2 || m.p2 || '');
                                  const isTeamNameOnly = (pick, teamSlotName) => {
                                    const pv = String(pick || '').trim().toLowerCase();
                                    if (!pv) return true;
                                    const tv = String(formatTeamLabel(teamSlotName, "") || "").trim().toLowerCase();
                                    return Boolean(tv && pv === tv);
                                  };
                                  const t1p1Unselected = isTeamNameOnly(team1Pick1, m.player1 || m.p1 || "");
                                  const t1p2Unselected = isTeamNameOnly(team1Pick2, m.player1 || m.p1 || "");
                                  const t2p1Unselected = isTeamNameOnly(team2Pick1, m.player2 || m.p2 || "");
                                  const t2p2Unselected = isTeamNameOnly(team2Pick2, m.player2 || m.p2 || "");
                                  return (
                                    <div key={`elim-team-pick-${idx}-${g}`} style={{ border: 'none', borderRadius: 0, background: 'transparent', padding: 8, display: 'grid', gridTemplateColumns: '1fr 60px', gap: 8, alignItems: 'center' }}>
                                      {teamMatchEditingElim[idx] ? (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                            <select
                                              value={team1Pick1}
                                              onChange={(e) => setEditVal(idx, team1Player1Key, String(e.target.value || ''))}
                                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t1p1Unselected ? '#dc2626' : '#0f172a', fontWeight: t1p1Unselected ? 700 : 500 }}
                                            >
                                              <option value="">{formatTeamLabel(m.player1 || m.p1 || "", "Team 1 - P1")}</option>
                                              {team1Options.map((opt) => (
                                                <option key={`${team1Player1Key}-${opt}`} value={opt}>{opt}</option>
                                              ))}
                                            </select>
                                            <select
                                              value={team1Pick2}
                                              onChange={(e) => setEditVal(idx, team1Player2Key, String(e.target.value || ''))}
                                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t1p2Unselected ? '#dc2626' : '#0f172a', fontWeight: t1p2Unselected ? 700 : 500 }}
                                            >
                                              <option value="">{formatTeamLabel(m.player1 || m.p1 || "", "Team 1 - P2")}</option>
                                              {team1Options.map((opt) => (
                                                <option key={`${team1Player2Key}-${opt}`} value={opt}>{opt}</option>
                                              ))}
                                            </select>
                                          </div>
                                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                                            <select
                                              value={team2Pick1}
                                              onChange={(e) => setEditVal(idx, team2Player1Key, String(e.target.value || ''))}
                                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t2p1Unselected ? '#dc2626' : '#0f172a', fontWeight: t2p1Unselected ? 700 : 500 }}
                                            >
                                              <option value="">{formatTeamLabel(m.player2 || m.p2 || "", "Team 2 - P1")}</option>
                                              {team2Options.map((opt) => (
                                                <option key={`${team2Player1Key}-${opt}`} value={opt}>{opt}</option>
                                              ))}
                                            </select>
                                            <select
                                              value={team2Pick2}
                                              onChange={(e) => setEditVal(idx, team2Player2Key, String(e.target.value || ''))}
                                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', color: t2p2Unselected ? '#dc2626' : '#0f172a', fontWeight: t2p2Unselected ? 700 : 500 }}
                                            >
                                              <option value="">{formatTeamLabel(m.player2 || m.p2 || "", "Team 2 - P2")}</option>
                                              {team2Options.map((opt) => (
                                                <option key={`${team2Player2Key}-${opt}`} value={opt}>{opt}</option>
                                              ))}
                                            </select>
                                          </div>
                                        </div>
                                      ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                          <div style={{ fontSize: '0.72rem', color: '#475569' }}>{[team1Pick1 || '-', team1Pick2 || '-'].join(' / ')}</div>
                                          <div style={{ fontSize: '0.72rem', color: '#475569' }}>{[team2Pick1 || '-', team2Pick2 || '-'].join(' / ')}</div>
                                        </div>
                                      )}
                                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                        {teamMatchEditingElim[idx] ? (
                                          <>
                                            <input
                                              type="number"
                                              min="0"
                                              step="1"
                                              value={String(getEditVal(idx, `game${g}Player1`, m[`game${g}Player1`]) ?? "0")}
                                              onChange={(e) => setEditVal(idx, `game${g}Player1`, Number(e.target.value) || 0)}
                                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', textAlign: 'center' }}
                                            />
                                            <input
                                              type="number"
                                              min="0"
                                              step="1"
                                              value={String(getEditVal(idx, `game${g}Player2`, m[`game${g}Player2`]) ?? "0")}
                                              onChange={(e) => setEditVal(idx, `game${g}Player2`, Number(e.target.value) || 0)}
                                              style={{ width: '100%', padding: '4px 6px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: '0.72rem', textAlign: 'center' }}
                                            />
                                          </>
                                        ) : (
                                          <>
                                            <div style={{ fontSize: '0.72rem', color: '#0f172a', textAlign: 'center', fontWeight: 700 }}>{String(getEditVal(idx, `game${g}Player1`, m[`game${g}Player1`]) ?? "0")}</div>
                                            <div style={{ fontSize: '0.72rem', color: '#0f172a', textAlign: 'center', fontWeight: 700 }}>{String(getEditVal(idx, `game${g}Player2`, m[`game${g}Player2`]) ?? "0")}</div>
                                          </>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                                </div>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        )}
      </div>
      {showRefPanel && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setShowRefPanel(false); }}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.55)",
            zIndex: 10000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 20
          }}
        >
          <div
            style={{
              background: "#ffffff",
              borderRadius: 12,
              width: "min(1100px, 96vw)",
              padding: 16,
              border: "1px solid #e5e7eb",
              boxShadow: "0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)"
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontWeight: 800, color: "#111827" }}>{refMatchTitle || "Referee Panel"}</div>
              <button onClick={() => setShowRefPanel(false)} style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", cursor: "pointer" }}>Close</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div>
                <div style={{ fontWeight: 700, color: "#374151", marginBottom: 6 }}>Signature</div>
                <canvas
                  ref={canvasRef}
                  style={{ width: "100%", border: "2px solid #e5e7eb", borderRadius: 8, touchAction: "none", background: "#ffffff" }}
                  onMouseDown={start}
                  onMouseMove={move}
                  onMouseUp={end}
                  onMouseLeave={end}
                  onTouchStart={start}
                  onTouchMove={move}
                  onTouchEnd={end}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button onClick={clearSig} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #e5e7eb", background: "#f8fafc", cursor: "pointer", fontWeight: 600 }}>Clear</button>
                  <button onClick={saveSig} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #059669", background: "#059669", color: "#fff", cursor: "pointer", fontWeight: 700 }}>Save</button>
                </div>
                {signatureData ? (
                  <div style={{ marginTop: 8, color: "#6b7280", fontSize: 12 }}>A saved signature is present.</div>
                ) : null}
              </div>
              <div style={{ display: "flex", flexDirection: "column" }}>
                <div style={{ fontWeight: 700, color: "#374151", marginBottom: 6 }}>Referee Note</div>
                <textarea
                  value={refNote}
                  onChange={(e) => setRefNote(e.target.value)}
                  placeholder="Enter referee notes here..."
                  style={{ width: "100%", minHeight: 220, border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, resize: "vertical", color: "#111827" }}
                />
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #e5e7eb" }}>
                <div style={{ fontWeight: 800, color: "#111827", marginBottom: 8 }}>Unlock Result</div>
                <div style={{ color: "#6b7280", fontSize: 12, lineHeight: 1.35, marginBottom: 10 }}>
                  This clears signature and resets scores to 0 so you can re-enter the correct score/status.
                </div>
                <input
                  value={unlockReason}
                  onChange={(e) => setUnlockReason(e.target.value)}
                  placeholder="Reason for unlock..."
                  style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 8, padding: 10, color: "#111827" }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
                  <button
                    type="button"
                    disabled={!unlockReason.trim() || !refMatchKey || !refGroupId || typeof onUnlockResult !== "function"}
                    onClick={async () => {
                      if (!onUnlockResult || !refMatchKey || !refGroupId) return;
                      const reason = unlockReason.trim();
                      if (!reason) return;
                      await onUnlockResult({ groupId: refGroupId, matchKey: refMatchKey, reason });
                      setUnlockReason("");
                      setShowRefPanel(false);
                    }}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      border: "1px solid #ef4444",
                      background: (!unlockReason.trim() || !refMatchKey || !refGroupId || typeof onUnlockResult !== "function") ? "#9ca3af" : "#ef4444",
                      color: "#fff",
                      cursor: (!unlockReason.trim() || !refMatchKey || !refGroupId || typeof onUnlockResult !== "function") ? "not-allowed" : "pointer",
                      fontWeight: 800,
                    }}
                  >
                    Unlock
                  </button>
                </div>
              </div>
                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8, gap: 8 }}>
                  <button
                    onClick={async () => { await saveRefData(signatureData || (canvasRef.current ? canvasRef.current.toDataURL("image/png") : ""), refNote); setShowRefPanel(false); }}
                    style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #059669", background: "#059669", color: "#fff", cursor: "pointer", fontWeight: 700 }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
