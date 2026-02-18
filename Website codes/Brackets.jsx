import React, { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import CategoryBracketModal from "../../components/CategoryBracketModal";
import apiClient from "../../utils/axiosConfig";

export default function Brackets() {
  const { tournament, setTournament } = useOutletContext() || {};
  const [selectedCategoryId, setSelectedCategoryId] = useState(() => tournament?.tournamentCategories?.[0]?._id || "");
  const [showRoundRobinMap, setShowRoundRobinMap] = useState({});
  const [showEliminationMap, setShowEliminationMap] = useState({});
  const [selectedBrackets, setSelectedBrackets] = useState({});
  const [bracketMode, setBracketMode] = useState({});
  const [availableBrackets, setAvailableBrackets] = useState({});
  const [isEditing, setIsEditing] = useState(false);
  const [matchEdits, setMatchEdits] = useState({});

  const categories = Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : [];
  const selectedCategoryRaw = categories.find((c) => String(c._id) === String(selectedCategoryId)) || categories[0];

  const getCategoryType = (name) => {
    if (!name) return "singles";
    const s = String(name).toLowerCase();
    if (s.includes("doubles")) return "doubles";
    if (s.includes("team")) return "team";
    return "singles";
  };

  const approvedRegsForCategory = useMemo(() => {
    const regs = Array.isArray(tournament?.registrations) ? tournament.registrations : [];
    const cat = selectedCategoryRaw;
    if (!cat) return [];
    return regs.filter((reg) => {
      const status = String(reg?.status || "").toLowerCase();
      if (status !== "approved") return false;
      const regCatId = reg?.categoryId;
      const regCat = reg?.category;
      const regCatStr = typeof regCat === "string" ? regCat : (regCat?._id || regCat?.division);
      const catId = cat?._id;
      const catDiv = cat?.division;
      return (
        (regCatId && (String(regCatId) === String(catId))) ||
        (regCatStr && (String(regCatStr) === String(catId) || String(regCatStr) === String(catDiv)))
      );
    });
  }, [tournament, selectedCategoryRaw]);

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

  const computeLetters = (cat) => {
    const mode = bracketMode[cat?._id] ?? cat?.bracketMode ?? (cat?.groupStage?.groups?.length || 4);
    const m = [1, 2, 4, 8].includes(Number(mode)) ? Number(mode) : 4;
    return ["A", "B", "C", "D", "E", "F", "G", "H"].slice(0, Math.max(m, 1));
  };

  const selectedCategory = useMemo(() => {
    const cat = selectedCategoryRaw;
    if (!cat) return undefined;
    const letters = computeLetters(cat);
    const existingGroups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
    const baseGroups = letters.map((letter) => {
      const id = `group-${letter.toLowerCase()}`;
      const found = existingGroups.find((g) => g.id === id);
      const k = `${cat._id}:${id}`;
      const overlay = matchEdits[k] || {};
      const baseMatches = found?.matches || {};
      const mergedMatches = {};
      const allKeys = new Set([...Object.keys(baseMatches), ...Object.keys(overlay)]);
      allKeys.forEach((mk) => {
        const orig = baseMatches[mk] || {};
        const ov = overlay[mk] || {};
        mergedMatches[mk] = { ...orig, ...ov };
      });
      return {
        id,
        name: `Group ${letter}`,
        standings: [],
        matches: mergedMatches,
        originalPlayers: Array.isArray(found?.originalPlayers) ? found.originalPlayers : [],
      };
    });
    const approved = approvedRegsForCategory;
    const count = letters.length || 1;
    const total = approved.length;
    const base = Math.floor(total / count);
    const rem = total % count;
    const capacities = new Array(count).fill(0).map((_, i) => base + (i < rem ? 1 : 0));
    const assigned = new Array(count).fill(0);
    const distributed = baseGroups.map((g) => ({ ...g }));
    const queue = [...approved];
    while (queue.length && assigned.some((c, i) => c < capacities[i])) {
      for (let b = 0; b < count && queue.length; b++) {
        if (assigned[b] < capacities[b]) {
          const reg = queue.shift();
          const name = derivePlayerName(reg, cat?.division || cat?.name || "");
          distributed[b].originalPlayers = Array.isArray(distributed[b].originalPlayers) ? distributed[b].originalPlayers : [];
          distributed[b].originalPlayers.push(name);
          distributed[b].standings = Array.isArray(distributed[b].standings) ? distributed[b].standings : [];
          distributed[b].standings.push({
            player: name,
            wins: 0,
            losses: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            qualified: false,
          });
          assigned[b] += 1;
        }
      }
    }
    const nextCat = { ...cat, groupStage: { groups: distributed } };
    setAvailableBrackets((prev) => ({ ...prev, [cat._id]: letters }));
    return nextCat;
  }, [selectedCategoryRaw, approvedRegsForCategory, bracketMode, matchEdits]);

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
    if (!selectedCategory) return;
    const letters = availableBrackets[selectedCategory._id] || computeLetters(selectedCategory);
    setSelectedBrackets((prev) => {
      const current = prev[selectedCategory._id];
      const next = letters.includes(current) ? current : letters[0];
      return { ...prev, [selectedCategory._id]: next };
    });
    setShowRoundRobinMap((prev) => ({ ...prev, [selectedCategory._id]: true }));
    setShowEliminationMap((prev) => ({ ...prev, [selectedCategory._id]: false }));
  }, [selectedCategory, availableBrackets]);

  const handleChangeMode = (newMode) => {
    const cat = selectedCategory;
    if (!cat) return;
    const valid = [1, 2, 4, 8].includes(Number(newMode)) ? Number(newMode) : 4;
    setBracketMode((prev) => ({ ...prev, [cat._id]: valid }));
  };

  const handleToggleEdit = () => setIsEditing((v) => !v);

  const handleSave = async (payload) => {
    try {
      const cat = selectedCategory;
      if (!cat) return;
      const n = Math.min(Math.max(Number(payload?.gamesPerMatch ?? 3), 1), 3);
      const updated = categories.map((c) => {
        if (String(c._id) === String(cat._id)) {
          const bm = bracketMode[cat._id];
          const bmValid = [1, 2, 4, 8].includes(Number(bm)) ? Number(bm) : c.bracketMode;
          return { ...c, gamesPerMatch: n, bracketMode: bmValid };
        }
        return c;
      });
      const res = await apiClient.put(`/tournaments/${tournament?._id}`, { tournamentCategories: JSON.stringify(updated) });
      const next = res?.data?.tournament || null;
      if (next) {
        setTournament(next);
      }
      try {
        const freshRes = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
        const fresh = freshRes?.data?.tournament || freshRes?.data || null;
        if (fresh) setTournament(fresh);
      } catch {}
      // Persist current group's match edits if any
      try {
        const letter = selectedBrackets[cat._id];
        const gid = `group-${String(letter || "").toLowerCase()}`;
        const k = `${cat._id}:${gid}`;
        const overlay = matchEdits[k] || {};
        const base = (selectedCategory?.groupStage?.groups || []).find((g) => g.id === gid)?.matches || {};
        const toPersist = {};
        const allKeys = new Set([...Object.keys(base), ...Object.keys(overlay)]);
        allKeys.forEach((mk) => {
          const orig = base[mk] || {};
          const ov = overlay[mk] || {};
          toPersist[mk] = { ...orig, ...ov };
        });
        await apiClient.put(`/tournaments/${tournament?._id}/categories/${cat?._id}/groups/${gid}/matches`, { matches: toPersist });
        // Clear local edits for this group after successful save
        setMatchEdits((prev) => {
          const nextEdits = { ...prev };
          delete nextEdits[k];
          return nextEdits;
        });
        // Refresh tournament to reflect server state
        try {
          const freshRes2 = await apiClient.get(`/tournaments/${tournament?._id}?ts=${Date.now()}`);
          const fresh2 = freshRes2?.data?.tournament || freshRes2?.data || null;
          if (fresh2) setTournament(fresh2);
        } catch {}
      } catch {}
      setIsEditing(false);
    } catch {
      // keep editing state if save failed
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
        const nextMatch = { ...currentMatch, [field]: value };
        return { ...prev, [k]: { ...currentGroup, [matchKey]: nextMatch } };
      });
    } catch {}
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="text-xl font-bold text-gray-800">Brackets</div>
        <select
          className="border rounded-md p-2"
          value={selectedCategoryId}
          onChange={(e) => setSelectedCategoryId(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c._id} value={c._id}>
              {[c.division, c.skillLevel, c.ageCategory].filter(Boolean).join(" • ")}
            </option>
          ))}
        </select>
      </div>
      {selectedCategory && (
        <CategoryBracketModal
          category={selectedCategory}
          bracketMode={bracketMode}
          availableBrackets={availableBrackets}
          selectedBrackets={selectedBrackets}
          tournamentDates={tournament?.tournamentDates}
          onClose={() => {}}
          onRoundRobin={() => setShowRoundRobinMap((prev) => ({ ...prev, [selectedCategory._id]: true }))}
          onElimination={() => setShowEliminationMap((prev) => ({ ...prev, [selectedCategory._id]: true }))}
          onChangeMode={handleChangeMode}
          onSelectBracket={(b) => setSelectedBrackets((prev) => ({ ...prev, [selectedCategory._id]: b }))}
          showRoundRobin={Boolean(showRoundRobinMap[selectedCategory._id])}
          showElimination={Boolean(showEliminationMap[selectedCategory._id])}
          isEditing={isEditing}
          onToggleEdit={handleToggleEdit}
          onSave={handleSave}
          onChangeMatch={onChangeMatch}
          approvedOptions={[]}
          handleStandingChange={() => {}}
          onSubmitPoints={onSubmitPoints}
          canSubmitPoints={canSubmitPoints}
        />
      )}
    </div>
  );
}
