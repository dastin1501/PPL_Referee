import React, { useEffect, useRef, useState, useMemo } from "react";
import { useOutletContext } from "react-router-dom";
import { DndContext, useDraggable, useDroppable, DragOverlay } from "@dnd-kit/core";
import { nanoid } from "nanoid";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

// Helper to extract matches from tournament data
const extractMatches = (tournament) => {
  const categories = Array.isArray(tournament?.tournamentCategories) ? tournament.tournamentCategories : [];
  if (!tournament || categories.length === 0) return [];
  const matches = [];

  // Build ID to Name map from registrations
  const idToDisplay = new Map();
  const regs = Array.isArray(tournament?.registrations)
    ? tournament.registrations
    : [];
  try {
    const isObjId = (v) => typeof v === "string" && /^[a-f0-9]{24}$/i.test(v);
    const approvedRegs = regs.filter(r => String(r?.status || "").toLowerCase() === 'approved');
    approvedRegs.forEach(reg => {
      // Helper to get full name
      const getName = (p) => {
        if (!p) return "";
        const fn = p.firstName || "";
        const ln = p.lastName || "";
        return `${fn} ${ln}`.trim();
      };

      // Determine category type/division to handle teams/doubles if needed
      // For simplicity, we map all player IDs and Team IDs found
      
      // 1. Map Player ID -> Name
      const p = reg.player || reg.primaryPlayer;
      if (p && (p._id || p.id)) {
        idToDisplay.set(String(p._id || p.id), getName(p));
      } else if (typeof reg.player === "string" && isObjId(reg.player)) {
        const nm = String(reg.playerName || "").trim();
        if (nm) idToDisplay.set(reg.player, nm);
      } else if (typeof reg.primaryPlayer === "string" && isObjId(reg.primaryPlayer)) {
        const nm = String(reg.playerName || "").trim();
        if (nm) idToDisplay.set(reg.primaryPlayer, nm);
      }

      // 2. Map Partner ID -> Name (for doubles)
      const partner = reg.partner;
      if (partner && (partner._id || partner.id)) {
        idToDisplay.set(String(partner._id || partner.id), getName(partner));
      } else if (typeof reg.partner === "string" && isObjId(reg.partner)) {
        const nm = String(reg.partnerName || "").trim();
        if (nm) idToDisplay.set(reg.partner, nm);
      }

      // 3. Map Team ID/Members -> Team Name
      if (reg.teamName) {
        // If the registration represents a team, we might want to map member IDs to Team Name?
        // Or maybe just the team ID if it exists. 
        // But usually round robin players are just names or IDs.
        // Let's just map team members to team name as fallback
        if (Array.isArray(reg.teamMembers)) {
          reg.teamMembers.forEach(m => {
            const mid = typeof m === 'string' ? m : (m._id || m.id);
            if (mid) idToDisplay.set(String(mid), reg.teamName);
          });
        }
      }
    });
  } catch (e) {
    console.error("Error building idToDisplay map", e);
  }

  const resolveName = (val) => {
    if (!val) return "TBD";
    const s = String(val);
    if (idToDisplay.has(s)) return idToDisplay.get(s);
    // If it looks like an ID but not found, return it (or "Unknown")
    // But keeping it allows us to see if it's an ID
    return val;
  };

  const categoryLabel = (cat) => {
    const division = String(cat?.division || "").trim();
    const skill =
      String(cat?.skillLevel || "").trim() === "Open" && cat?.tier
        ? `Open Tier ${cat.tier}`
        : String(cat?.skillLevel || "").trim();
    const age = String(cat?.ageCategory || "").trim();
    const parts = [division, skill, age].filter((p) => p && String(p).trim());
    return parts.length ? parts.join(" - ") : "Tournament Category";
  };

  const firstYmd = (() => {
    try {
      const dates = Array.isArray(tournament?.tournamentDates) ? tournament.tournamentDates : [];
      if (dates.length > 0) {
        const d = new Date(dates[0]);
        if (!isNaN(d)) {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${y}-${m}-${dd}`;
        }
      }
    } catch (_) {}
    return "";
  })();

  const bracketLetter = (group) => {
    const id = String(group?.id || "");
    const name = String(group?.name || "");
    const m1 = id.match(/group-([a-z])/i);
    if (m1) return String(m1[1]).toUpperCase();
    const m2 = id.match(/([a-z])$/i);
    if (m2) return String(m2[1]).toUpperCase();
    const m3 = name.match(/\b([A-H])\b/i);
    if (m3) return String(m3[1]).toUpperCase();
    return "A";
  };

  const toDateValue = (md) => {
    const raw = String(md?.date || firstYmd || "").trim();
    if (!raw) return 0;
    const d = new Date(raw);
    if (!isNaN(d)) return d.getTime();
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return 0;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  };

  const toTimeValue = (md) => {
    const raw = String(md?.time || "").trim();
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return 0;
    return Number(m[1]) * 60 + Number(m[2]);
  };

  const stageLabel = (roundOrTitle) => {
    const r = String(roundOrTitle || "").toLowerCase();
    if (r.includes("bronze")) return "Battle for Bronze";
    if (r.includes("quarter")) return "Quarter-Final";
    if (r.includes("semi")) return "Semi-Final";
    if (r.includes("round of 16") || r.includes("r16")) return "Round of 16";
    if (r.includes("battle for gold")) return "Battle for Gold";
    if (r.trim() === "final" || r.startsWith("final:")) return "Battle for Gold";
    return String(roundOrTitle || "Elimination").trim();
  };

  const codeFromRound = (roundOrTitle) => {
    const s = String(roundOrTitle || "").trim();
    const lower = s.toLowerCase();
    const n = (() => {
      const m = s.match(/(\d+)/);
      return m ? Number(m[1]) : null;
    })();
    if (lower.includes("quarter")) return n ? `QF${n}` : "QF";
    if (lower.includes("semi")) return n ? `SF${n}` : "SF";
    if (lower.includes("bronze")) return "BRZ";
    if (lower.includes("final")) return "FINAL";
    return s ? s.toUpperCase() : "ELIM";
  };

  const seedsFromText = (text) => {
    const t = String(text || "");
    const m1 = t.match(/([A-Z]\d+)\s*vs\s*([A-Z]\d+)/i);
    if (m1) return { seed1: String(m1[1]).toUpperCase(), seed2: String(m1[2]).toUpperCase() };
    const m2 = t.match(/:\s*([^:]+?)\s+vs\s+(.+)\s*$/i);
    if (m2) return { seed1: String(m2[1]).trim(), seed2: String(m2[2]).trim() };
    return { seed1: "", seed2: "" };
  };

  const playerText = (val) => {
    if (!val) return "";
    let name = val;
    if (typeof val === "object") {
      const n = val?.name || val?.player || val?.playerName || val?.fullName;
      if (typeof n === "string") {
        name = n;
      } else {
        const fn = typeof val?.firstName === "string" ? val.firstName : "";
        const ln = typeof val?.lastName === "string" ? val.lastName : "";
        name = `${fn} ${ln}`.trim();
      }
    }
    // Resolve if it matches an ID in our map
    if (typeof name === "string") {
        // If name looks like an ObjectId (24 hex chars), try to resolve it
        if (/^[a-f0-9]{24}$/i.test(name)) {
            const mapped = resolveName(name);
            if (mapped && String(mapped).trim()) return mapped;
        }
        // Also check if the name itself is in the map (unlikely but safe)
        if (idToDisplay.has(name)) return idToDisplay.get(name);
    }
    return String(name);
  };

  categories.forEach((cat) => {
    const catLabel = categoryLabel(cat);
    
    // Debug removed
// Removed

    // Group Stage Matches
    const groupsSource = (() => {
      if (cat.groupStage && Array.isArray(cat.groupStage.groups) && cat.groupStage.groups.length > 0) {
        return cat.groupStage.groups;
      }
      const m = Number(cat?.bracketMode || 4);
      const valid = [1, 2, 4, 8].includes(m) ? m : 4;
      const letters = ["A", "B", "C", "D", "E", "F", "G", "H"].slice(0, Math.max(valid, 1));
      const approvedForCat = regs.filter((reg) => {
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
      const type = (() => {
        const name = String(cat?.division || cat?.name || "").toLowerCase();
        if (name.includes("doubles")) return "doubles";
        if (name.includes("team")) return "team";
        return "singles";
      })();
      const toName = (reg) => {
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
        const fromReg = (reg.playerName || "").trim();
        if (fromReg) return fromReg;
        if (typeof reg.player === "string" && /^[a-f0-9]{24}$/i.test(reg.player)) {
          const mapped = idToDisplay.get(reg.player);
          if (mapped) return mapped;
        }
        if (typeof reg.primaryPlayer === "string" && /^[a-f0-9]{24}$/i.test(reg.primaryPlayer)) {
          const mapped = idToDisplay.get(reg.primaryPlayer);
          if (mapped) return mapped;
        }
        return nameObj || (p.name || "").trim() || "Unknown Player";
      };
      const count = letters.length || 1;
      const total = approvedForCat.length;
      const base = Math.floor(total / count);
      const rem = total % count;
      const capacities = new Array(count).fill(0).map((_, i) => base + (i < rem ? 1 : 0));
      const assigned = new Array(count).fill(0);
      const distributed = letters.map((letter) => ({
        id: `group-${letter.toLowerCase()}`,
        name: `Group ${letter}`,
        standings: [],
        matches: {},
        originalPlayers: [],
      }));
      const queue = [...approvedForCat];
      while (queue.length && assigned.some((c, i) => c < capacities[i])) {
        for (let b = 0; b < count && queue.length; b++) {
          if (assigned[b] < capacities[b]) {
            const reg = queue.shift();
            const display = toName(reg);
            distributed[b].originalPlayers.push(display);
            distributed[b].standings.push({
              player: display,
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
      return distributed;
    })();
    if (Array.isArray(groupsSource) && groupsSource.length > 0) {
      groupsSource.forEach((group) => {
        const letter = bracketLetter(group);
        let playersList = [];
        if (Array.isArray(group?.originalPlayers) && group.originalPlayers.length > 0) {
          playersList = group.originalPlayers.map(playerText);
        } else if (Array.isArray(group?.standings) && group.standings.length > 0) {
          playersList = group.standings.map((s) => playerText(s?.player || s?.name || s?.playerName));
        }
        if (!playersList || playersList.length === 0) {
          const approvedForCat = regs.filter((reg) => {
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
          const type = (() => {
            const name = String(cat?.division || cat?.name || "").toLowerCase();
            if (name.includes("doubles")) return "doubles";
            if (name.includes("team")) return "team";
            return "singles";
          })();
          const toName = (reg) => {
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
            const fromReg = (reg.playerName || "").trim();
            if (fromReg) return fromReg;
            if (typeof reg.player === "string" && /^[a-f0-9]{24}$/i.test(reg.player)) {
              const mapped = idToDisplay.get(reg.player);
              if (mapped) return mapped;
            }
            if (typeof reg.primaryPlayer === "string" && /^[a-f0-9]{24}$/i.test(reg.primaryPlayer)) {
              const mapped = idToDisplay.get(reg.primaryPlayer);
              if (mapped) return mapped;
            }
            return nameObj || (p.name || "").trim() || "Unknown Player";
          };
          playersList = approvedForCat.map(toName);
        }
        
        // Filter out placeholders and invalid names
        playersList = playersList.filter((p) => {
          const s = String(p || '').trim();
          if (!s) return false;
          const lower = s.toLowerCase();
          if (lower === 'tbd') return false;
          if (lower === 'unknown' || lower === 'unknown player') return false;
          if (lower === 'undefined undefined') return false;
          return true;
        });

// Debug removed

        const allPairs = (() => {
          const out = [];
          if (playersList.length > 0) {
            for (let i = 0; i < playersList.length; i++) {
              for (let j = i + 1; j < playersList.length; j++) {
                const k = `${i}-${(j - i - 1)}`;
                const md = group?.matches?.[k] || {};
                out.push({ k, d: toDateValue(md), t: toTimeValue(md) });
              }
            }
          } else if (group.matches && Object.keys(group.matches).length > 0) {
             // Fallback: iterate existing matches if no players list found
             Object.keys(group.matches).forEach(k => {
               const md = group.matches[k];
               out.push({ k, d: toDateValue(md), t: toTimeValue(md) });
             });
          }
          return out;
        })();
        allPairs.sort((a, b) => (a.d - b.d) || (a.t - b.t));

        const groupOrder = new Map();
        const seenPerGroup = new Map();
        const ordByKey = new Map();
        const suffixByKey = new Map();
        let nextRank = 1;
        for (const e of allPairs) {
          const gk = `${e.d}-${e.t}`;
          if (!groupOrder.has(gk)) groupOrder.set(gk, nextRank++);
          const count = (seenPerGroup.get(gk) || 0) + 1;
          seenPerGroup.set(gk, count);
          ordByKey.set(e.k, groupOrder.get(gk));
          suffixByKey.set(e.k, count);
        }

        allPairs.forEach((e) => {
          const parts = String(e.k).split("-");
          const i = parseInt(parts[0]);
          const off = parseInt(parts[1]);
          const j = i + 1 + (isNaN(off) ? 0 : off);
          const key = String(e.k);
          const md = group?.matches?.[key] || {};

          const baseOrd = ordByKey.get(key) || (i + 1);
          const suffixOrd = suffixByKey.get(key) || 1;
          const totalAtGroup = seenPerGroup.get(`${toDateValue(md)}-${toTimeValue(md)}`) || 1;
          const matchNumber = totalAtGroup > 1 ? `G${baseOrd}.${suffixOrd}` : `G${baseOrd}`;

          const seed1 = `${letter}${i + 1}`;
          const seed2 = `${letter}${j + 1}`;
          const p1 = playerText(playersList?.[i] || md?.player1Name || md?.player1 || "TBD");
          const p2 = playerText(playersList?.[j] || md?.player2Name || md?.player2 || "TBD");
          const playersVs = `${p1} vs ${p2}`;
          const displayBase = ordByKey.get(key) || (i + 1);
          const displaySuffix = suffixByKey.get(key) || 1;
          const sameSlotCount = seenPerGroup.get(`${toDateValue(md)}-${toTimeValue(md)}`) || 1;
          const displayNumber = sameSlotCount > 1 ? `G${letter}${displayBase}.${displaySuffix}` : `G${letter}${displayBase}`;

          matches.push({
            id: `rr-${cat._id}-${group.id}-${key}`,
            type: "group",
            category: catLabel,
            categoryId: String(cat._id || ""),
            bracket: letter,
            matchNumber,
            displayNumber,
            seed1,
            seed2,
            seedVs: `${seed1} vs ${seed2}`,
            playersVs,
            stage: "Round robin",
            label: playersVs,
            matchKey: key,
          });
        });
      });
    }

    const groups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : groupsSource;
    const letterToGroup = new Map();
    for (const g of groups) {
      const L = bracketLetter(g);
      if (!letterToGroup.has(L)) letterToGroup.set(L, g);
    }
    const getRankedPlayers = (L) => {
      const g = letterToGroup.get(L);
      if (!g) return [];
      if (Array.isArray(g.standings) && g.standings.length > 0) {
        return g.standings.map((s) => playerText(s?.player || s?.name || s?.playerName));
      }
      if (Array.isArray(g.originalPlayers) && g.originalPlayers.length > 0) {
        return g.originalPlayers.map(playerText);
      }
      return [];
    };

    const pickSeed = (L, seedNum) => {
      const players = getRankedPlayers(L);
      return players?.[seedNum - 1] || `${L}${seedNum}`;
    };

    const addElim = (key, matchNumber, seed1, seed2, p1, p2, stage) => {
      const playersVs = `${String(p1 || "TBD")} vs ${String(p2 || "TBD")}`;
      matches.push({
        id: `elimgen-${cat._id}-${key}`,
        type: "elimination",
        category: catLabel,
        categoryId: String(cat._id || ""),
        matchNumber,
        seed1,
        seed2,
        seedVs: seed1 && seed2 ? `${seed1} vs ${seed2}` : "",
        playersVs,
        stage,
        label: playersVs,
      });
    };
    // Normalize previously added group matches to ensure names are always resolved from seeds
    (() => {
      const letters = Array.from(letterToGroup.keys());
      const playersByLetter = new Map();
      letters.forEach((L) => playersByLetter.set(L, getRankedPlayers(L)));
      const catIdStr = String(cat._id || "");
      matches.forEach((m) => {
        if (m.type !== "group") return;
        if (String(m.categoryId || "") !== catIdStr) return;
        const s1 = String(m.seed1 || "");
        const s2 = String(m.seed2 || "");
        const L1 = s1.slice(0, 1);
        const L2 = s2.slice(0, 1);
        const n1 = parseInt(s1.slice(1));
        const n2 = parseInt(s2.slice(1));
        const list1 = playersByLetter.get(L1) || [];
        const list2 = playersByLetter.get(L2) || [];
        const p1 = list1?.[isNaN(n1) ? -1 : (n1 - 1)];
        const p2 = list2?.[isNaN(n2) ? -1 : (n2 - 1)];
        const resolved1 = p1 || m.playersVs?.split(" vs ")?.[0] || s1;
        const resolved2 = p2 || m.playersVs?.split(" vs ")?.[1] || s2;
        const playersVs = `${String(resolved1)} vs ${String(resolved2)}`;
        m.playersVs = playersVs;
        m.label = playersVs;
      });
    })();
    // Elimination Matches (assuming structure based on common patterns, adjust if needed)
    if (cat.eliminationMatches && Array.isArray(cat.eliminationMatches.matches)) {
      cat.eliminationMatches.matches.forEach((match, idx) => {
        const round = String(match?.round || match?.title || "").trim();
        const seeds =
          seedsFromText(round).seed1 || seedsFromText(match?.matchId).seed1 || seedsFromText(match?.title).seed1
            ? seedsFromText(round).seed1
              ? seedsFromText(round)
              : seedsFromText(match?.matchId).seed1
                ? seedsFromText(match?.matchId)
                : seedsFromText(match?.title)
            : { seed1: "", seed2: "" };
        const p1raw = playerText(match?.player1Name || match?.player1 || "TBD");
        const p2raw = playerText(match?.player2Name || match?.player2 || "TBD");
        const p1 = (() => {
          if (String(p1raw).toLowerCase() !== "tbd") return p1raw;
          const s = String(seeds.seed1 || "");
          if (/^[A-H]\d+$/i.test(s)) {
            const L = s.slice(0, 1).toUpperCase();
            const n = parseInt(s.slice(1));
            return pickSeed(L, n);
          }
          return p1raw;
        })();
        const p2 = (() => {
          if (String(p2raw).toLowerCase() !== "tbd") return p2raw;
          const s = String(seeds.seed2 || "");
          if (/^[A-H]\d+$/i.test(s)) {
            const L = s.slice(0, 1).toUpperCase();
            const n = parseInt(s.slice(1));
            return pickSeed(L, n);
          }
          return p2raw;
        })();
        const playersVs = `${p1} vs ${p2}`;
        const code = String(match?.matchId || codeFromRound(round) || match?.id || `E${idx + 1}`);

        matches.push({
          id: `elim-${cat._id}-${match?.id || idx}`,
          type: "elimination",
          category: catLabel,
          categoryId: String(cat._id || ""),
          matchNumber: code,
          seed1: seeds.seed1,
          seed2: seeds.seed2,
          seedVs: seeds.seed1 && seeds.seed2 ? `${seeds.seed1} vs ${seeds.seed2}` : "",
          playersVs,
          stage: stageLabel(round),
          label: playersVs,
        });
      });
    } else {
      const mode = Number(cat?.bracketMode || letterToGroup.size || 0);
      const validMode = mode === 1 || mode === 2 || mode === 4 || mode === 8;
      if (validMode && letterToGroup.size > 0) {
        if (mode === 1) {
          addElim(
            "final",
            "FINAL",
            "A1",
            "A2",
            pickSeed("A", 1),
            pickSeed("A", 2),
            "Battle for Gold"
          );
          addElim(
            "bronze",
            "BRZ",
            "A3",
            "A4",
            pickSeed("A", 3),
            pickSeed("A", 4),
            "Battle for Bronze"
          );
        } else if (mode === 2) {
          addElim("sf1", "SF1", "A1", "B2", pickSeed("A", 1), pickSeed("B", 2), "Semi-Final");
          addElim("sf2", "SF2", "B1", "A2", pickSeed("B", 1), pickSeed("A", 2), "Semi-Final");
          addElim("bronze", "BRZ", "LSF1", "LSF2", "Loser SF1", "Loser SF2", "Battle for Bronze");
          addElim("final", "FINAL", "WSF1", "WSF2", "Winner SF1", "Winner SF2", "Battle for Gold");
        } else if (mode === 4) {
          addElim("qf1", "QF1", "A1", "D2", pickSeed("A", 1), pickSeed("D", 2), "Quarter-Final");
          addElim("qf2", "QF2", "B1", "C2", pickSeed("B", 1), pickSeed("C", 2), "Quarter-Final");
          addElim("qf3", "QF3", "C1", "B2", pickSeed("C", 1), pickSeed("B", 2), "Quarter-Final");
          addElim("qf4", "QF4", "D1", "A2", pickSeed("D", 1), pickSeed("A", 2), "Quarter-Final");
          addElim("sf1", "SF1", "WQF1", "WQF2", "Winner QF1", "Winner QF2", "Semi-Final");
          addElim("sf2", "SF2", "WQF3", "WQF4", "Winner QF3", "Winner QF4", "Semi-Final");
          addElim("bronze", "BRZ", "LSF1", "LSF2", "Loser SF1", "Loser SF2", "Battle for Bronze");
          addElim("final", "FINAL", "WSF1", "WSF2", "Winner SF1", "Winner SF2", "Battle for Gold");
        } else if (mode === 8) {
          addElim("r16-1", "R16-1", "A1", "H2", pickSeed("A", 1), pickSeed("H", 2), "Round of 16");
          addElim("r16-2", "R16-2", "B1", "G2", pickSeed("B", 1), pickSeed("G", 2), "Round of 16");
          addElim("r16-3", "R16-3", "C1", "F2", pickSeed("C", 1), pickSeed("F", 2), "Round of 16");
          addElim("r16-4", "R16-4", "D1", "E2", pickSeed("D", 1), pickSeed("E", 2), "Round of 16");
          addElim("r16-5", "R16-5", "E1", "D2", pickSeed("E", 1), pickSeed("D", 2), "Round of 16");
          addElim("r16-6", "R16-6", "F1", "C2", pickSeed("F", 1), pickSeed("C", 2), "Round of 16");
          addElim("r16-7", "R16-7", "G1", "B2", pickSeed("G", 1), pickSeed("B", 2), "Round of 16");
          addElim("r16-8", "R16-8", "H1", "A2", pickSeed("H", 1), pickSeed("A", 2), "Round of 16");
          addElim("qf1", "QF1", "WR16-1", "WR16-2", "Winner R16-1", "Winner R16-2", "Quarter-Final");
          addElim("qf2", "QF2", "WR16-3", "WR16-4", "Winner R16-3", "Winner R16-4", "Quarter-Final");
          addElim("qf3", "QF3", "WR16-5", "WR16-6", "Winner R16-5", "Winner R16-6", "Quarter-Final");
          addElim("qf4", "QF4", "WR16-7", "WR16-8", "Winner R16-7", "Winner R16-8", "Quarter-Final");
          addElim("sf1", "SF1", "WQF1", "WQF2", "Winner QF1", "Winner QF2", "Semi-Final");
          addElim("sf2", "SF2", "WQF3", "WQF4", "Winner QF3", "Winner QF4", "Semi-Final");
          addElim("bronze", "BRZ", "LSF1", "LSF2", "Loser SF1", "Loser SF2", "Battle for Bronze");
          addElim("final", "FINAL", "WSF1", "WSF2", "Winner SF1", "Winner SF2", "Battle for Gold");
        }
      }
    }
  });
  return matches;
};

// Draggable Match Component
const DraggableMatch = ({ match }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: match.id,
    data: match,
  });

  const categoryColor = (() => {
    const s = String(match?.category || "").toLowerCase();
    if (s.includes("mixed")) return "#8b5cf6";
    if (s.includes("women") || s.includes("female")) return "#ec4899";
    if (s.includes("men") || s.includes("male")) return "#3b82f6";
    return "#94a3b8";
  })();
  const stageColor = (() => {
    const st = String(match?.stage || "").toLowerCase();
    if (st.includes("battle for gold")) return "#ffd700";
    if (st.includes("bronze")) return "#cd7f32";
    return "";
  })();

  const style = transform ? {
    transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    zIndex: 1000,
    opacity: isDragging ? 0.5 : 1,
  } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={{
        ...style,
        padding: "8px",
        marginBottom: "8px",
        background: "white",
        border: `2px solid ${categoryColor}`,
        borderRadius: "4px",
        cursor: "grab",
        fontSize: "12px",
        boxShadow: "0 1px 2px rgba(0,0,0,0.05)"
      }}
      {...listeners}
      {...attributes}
    >
      {stageColor && (
        <div style={{ position: "absolute", top: 6, right: 6, padding: "2px 6px", borderRadius: 12, fontSize: 10, fontWeight: 700, color: "#111827", background: stageColor }}>
          {String(match.stage || "").toUpperCase().includes("BRONZE") ? "BRONZE" : (String(match.stage || "").toUpperCase().includes("BATTLE FOR GOLD") ? "GOLD" : "")}
        </div>
      )}
      <div className="text-gray-500" style={{ fontSize: 11, marginBottom: 4, fontWeight: 700 }}>
        {match.category}
      </div>
      <div className="font-semibold text-gray-800" style={{ fontSize: 12, marginBottom: 4 }}>
        {(match.displayNumber || match.matchNumber || "") + (match.seedVs ? ` - ${match.seedVs}` : "")}
      </div>
      <div className="text-gray-800" style={{ fontSize: 12, marginBottom: 4 }}>
        {match.playersVs || match.label}
      </div>
      <div className="text-gray-500" style={{ fontSize: 11 }}>
        ({match.stage || "Match"})
      </div>
    </div>
  );
};

const ScheduledDraggable = ({ assignment, row, col, onRemove }) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `assigned-${row}-${col}-${assignment.id}`,
    data: { ...assignment, originRow: row, originCol: col },
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`, zIndex: 1000, opacity: isDragging ? 0.5 : 1 }
    : undefined;
  const stageColor = (() => {
    const st = String(assignment?.stage || "").toLowerCase();
    if (st.includes("battle for gold")) return "#ffd700";
    if (st.includes("bronze")) return "#cd7f32";
    return "";
  })();
  return (
    <div
      ref={setNodeRef}
      style={{ ...style, borderRadius: "4px", padding: "4px 8px", fontSize: "12px", position: "relative", cursor: "grab" }}
      {...listeners}
      {...attributes}
    >
      {stageColor && (
        <div style={{ position: "absolute", top: 2, left: 2, padding: "2px 6px", borderRadius: 12, fontSize: 10, fontWeight: 700, color: "#111827", background: stageColor }}>
          {String(assignment.stage || "").toUpperCase().includes("BRONZE") ? "BRONZE" : (String(assignment.stage || "").toUpperCase().includes("BATTLE FOR GOLD") ? "GOLD" : "")}
        </div>
      )}
      <div className="text-gray-500" style={{ fontSize: 11, marginBottom: 2, fontWeight: 700 }}>
        {assignment.category || ""}
      </div>
      <div className="font-semibold text-gray-800" style={{ fontSize: 12, marginBottom: 2 }}>
        {[(assignment.displayNumber || assignment.matchNumber || ""), assignment.seedVs].filter(Boolean).join(" - ")}
      </div>
      <div className="text-gray-700" style={{ fontSize: 12, marginBottom: 2 }}>
        {assignment.label || assignment}
      </div>
      <div className="text-gray-500" style={{ fontSize: 11 }}>
        ({assignment.stage || "Match"})
      </div>
      <button
        onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); }}
        onTouchStart={(e) => { e.stopPropagation(); }}
        onClick={(e) => { e.stopPropagation(); onRemove(row, col); }}
        style={{ position: "absolute", top: 2, right: 2, border: "none", background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: "10px" }}
      >
        ✕
      </button>
    </div>
  );
};

// Droppable Cell Component
const DroppableCell = ({ row, col, assignment, onRemove, hasConflict, noteEdit, startNoteEdit, saveNoteEdit, cancelNoteEdit, updateNoteEdit }) => {
  const { isOver, setNodeRef } = useDroppable({
    id: `cell-${row}-${col}`,
    data: { row, col },
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        padding: 8,
        borderTop: "1px solid #e5e7eb",
        borderRight: "1px solid #e5e7eb",
        background: isOver ? "#f0fdf4" : "white",
        minHeight: "60px",
        position: "relative"
      }}
      onDoubleClick={() => {
        if (!assignment || assignment?.type === "note") {
          startNoteEdit(row, col, assignment?.text || "");
        }
      }}
    >
      {assignment && assignment.type === "note" ? (
        <div style={{
          background: (() => {
            const t = String(assignment?.text || "").toLowerCase();
            if (t.includes("break")) return "#fffbea";
            if (t.includes("sponsor")) return "#faf5ff";
            return "#f8fafc";
          })(),
          border: "1px dashed #cbd5e1",
          borderRadius: "6px",
          padding: "6px 8px",
          fontSize: "12px",
          color: "#111827",
          position: "relative"
        }}>
          {noteEdit && noteEdit.row === row && noteEdit.col === col ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                autoFocus
                value={noteEdit.text}
                onChange={(e) => updateNoteEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveNoteEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelNoteEdit();
                  }
                }}
                placeholder="Type note..."
                style={{ flex: "1 1 100%", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 12 }}
              />
              <button
                onClick={saveNoteEdit}
                style={{ padding: "6px 10px", borderRadius: 6, background: "#10b981", color: "white", border: "1px solid #0ea5e9", fontSize: 12 }}
              >
                Save
              </button>
              <button
                onClick={cancelNoteEdit}
                style={{ padding: "6px 10px", borderRadius: 6, background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", fontSize: 12 }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <>
              <div style={{ fontWeight: 700 }}>{assignment.text}</div>
              <div style={{ position: "absolute", top: 4, right: 4, display: "flex", gap: 6 }}>
                <button
                  onClick={() => startNoteEdit(row, col, assignment.text || "")}
                  style={{ border: "none", background: "transparent", color: "#6b7280", cursor: "pointer", fontSize: 12 }}
                >
                  Edit
                </button>
                <button
                  onClick={() => onRemove(row, col)}
                  style={{ border: "none", background: "transparent", color: "#ef4444", cursor: "pointer", fontSize: 12 }}
                >
                  ✕
                </button>
              </div>
            </>
          )}
        </div>
      ) : assignment ? (
        <div style={{
          background: (() => {
            if (hasConflict) return "#fee2e2";
            const s = String(assignment?.category || "").toLowerCase();
            if (s.includes("mixed")) return "#f5f3ff";
            if (s.includes("women") || s.includes("female")) return "#fce7f3";
            if (s.includes("men") || s.includes("male")) return "#eff6ff";
            return "#ecfdf5";
          })(),
          border: (() => {
            if (hasConflict) return "2px solid #ef4444";
            const s = String(assignment?.category || "").toLowerCase();
            if (s.includes("mixed")) return "2px solid #8b5cf6";
            if (s.includes("women") || s.includes("female")) return "2px solid #ec4899";
            if (s.includes("men") || s.includes("male")) return "2px solid #3b82f6";
            return "1px solid #10b981";
          })(),
          borderRadius: "4px",
          padding: "4px 8px",
          fontSize: "12px"
        }}>
          <ScheduledDraggable assignment={assignment} row={row} col={col} onRemove={onRemove} />
        </div>
      ) : (
        <>
          {noteEdit && noteEdit.row === row && noteEdit.col === col ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                autoFocus
                value={noteEdit.text}
                onChange={(e) => updateNoteEdit(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveNoteEdit();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    cancelNoteEdit();
                  }
                }}
                placeholder="Type note..."
                style={{ flex: "1 1 100%", padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 12 }}
              />
              <button
                onClick={saveNoteEdit}
                style={{ padding: "6px 10px", borderRadius: 6, background: "#10b981", color: "white", border: "1px solid #0ea5e9", fontSize: 12 }}
              >
                Save
              </button>
              <button
                onClick={cancelNoteEdit}
                style={{ padding: "6px 10px", borderRadius: 6, background: "#f3f4f6", color: "#374151", border: "1px solid #e5e7eb", fontSize: 12 }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 10 }}>
              <div style={{ color: "#9ca3af", fontSize: "12px" }}>
                Drop match here
              </div>
              <button
                type="button"
                onClick={() => startNoteEdit(row, col, "")}
                style={{ padding: "4px 8px", borderRadius: 6, background: "#f3f4f6", border: "1px solid #e5e7eb", fontSize: 12 }}
              >
                Type
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default function Schedules() {
  const { tournament } = useOutletContext() || {};
  const [tournamentForMatches, setTournamentForMatches] = useState(tournament || null);
  const [eventsHtml, setEventsHtml] = useState(tournament?.events || "");
  const [schedulePictures, setSchedulePictures] = useState(
    Array.isArray(tournament?.schedulePictures) ? tournament.schedulePictures : []
  );
  const [showMatchesSidebar, setShowMatchesSidebar] = useState(true);
  const [matchesDrawerOpen, setMatchesDrawerOpen] = useState(false);
  const [venuesForDate, setVenuesForDate] = useState([]);
  const [selectedVenueIdx, setSelectedVenueIdx] = useState(0);
  
  // Initialize state
  const initialCourtCount = Number(tournament?.courtAssignments?.courtCount || 4);
  
  // Handle legacy string timeSlots vs new object timeSlots
  const initialTimeSlots = Array.isArray(tournament?.courtAssignments?.timeSlots)
    ? tournament.courtAssignments.timeSlots.map(ts => {
        if (typeof ts === 'string') {
          return { id: nanoid(), startTime: ts, duration: '', endTime: '' };
        }
        return ts;
      })
    : [];

  const initialAssignments = Array.isArray(tournament?.courtAssignments?.assignments)
    ? tournament.courtAssignments.assignments
    : (initialTimeSlots.length > 0 ? initialTimeSlots.map(() => new Array(initialCourtCount).fill(null)) : []);

  const [activeTab, setActiveTab] = useState("post");
  const [courtCount, setCourtCount] = useState(initialCourtCount);
  const [timeSlots, setTimeSlots] = useState(initialTimeSlots);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [message, setMessage] = useState("");
  const [didClearSchedulePictures, setDidClearSchedulePictures] = useState(false);
  const toCanonDate = (val) => {
    const s = String(val || "").trim();
    if (!s) return "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!isNaN(d)) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    return s;
  };
  const dateList = useMemo(() => {
    const src = Array.isArray(tournament?.tournamentDates) ? tournament.tournamentDates : Array.isArray(tournamentForMatches?.tournamentDates) ? tournamentForMatches.tournamentDates : [];
    const canon = src.map(toCanonDate).filter(Boolean);
    return Array.from(new Set(canon));
  }, [tournament?.tournamentDates, tournamentForMatches?.tournamentDates]);
  const [selectedDate, setSelectedDate] = useState(() => {
    const caRoot = tournament?.courtAssignments || null;
    const byDate = tournament?.courtAssignmentsByDate || {};
    const pref = String(caRoot?.scheduleDate || "").trim();
    if (pref) return pref;
    const keys = Object.keys(byDate || {}).filter(Boolean);
    if (keys.length > 0) return keys[0];
    return (dateList[0] || "");
  });
  
  // Add Time Modal State
  const [isAddTimeModalOpen, setIsAddTimeModalOpen] = useState(false);
  const [newTimeSlot, setNewTimeSlot] = useState({ startTime: "", duration: "", endTime: "", countText: "" });

  const eventsEditorRef = useRef(null);
  const scheduleGridRef = useRef(null);
  const slotsAutoAddTimerRef = useRef(null);
  const slotSeriesLenRef = useRef(0);
  
  useEffect(() => {
    setTournamentForMatches(tournament || null);
    if (!tournament?._id) return;

    const id = String(tournament._id);
    const controller = new AbortController();
    (async () => {
      try {
        const res = await fetch(`/api/tournaments/${id}?t=${Date.now()}`, { signal: controller.signal });
        if (!res.ok) return;
        const data = await res.json();
        setTournamentForMatches(data || tournament || null);
      } catch (_) {}
    })();

    return () => controller.abort();
  }, [tournament?._id]);

  useEffect(() => {
    const byDate = tournamentForMatches?.courtAssignmentsByDate || {};
    const caRoot = tournamentForMatches?.courtAssignments || null;
    const pref = String(caRoot?.scheduleDate || "").trim();
    const keys = Object.keys(byDate || {}).filter(Boolean);
    if (!selectedDate) {
      if (pref) setSelectedDate(pref);
      else if (keys.length > 0) setSelectedDate(keys[0]);
      else if (dateList.length > 0) setSelectedDate(dateList[0]);
    }
  }, [tournamentForMatches?.courtAssignmentsByDate, tournamentForMatches?.courtAssignments, dateList, selectedDate]);
  useEffect(() => {
    const byDate = tournamentForMatches?.courtAssignmentsByDate || {};
    const caRoot = tournamentForMatches?.courtAssignments || null;
    const pick = (() => {
      if (selectedDate && byDate && typeof byDate === "object" && byDate[selectedDate]) {
        return byDate[selectedDate];
      }
      if (caRoot && String(caRoot.scheduleDate || "") === String(selectedDate || "")) {
        return caRoot;
      }
      return null;
    })();
    const ca = pick;
    if (!ca) {
      setTimeSlots([]);
      setAssignments([]);
      setNewTimeSlot({ startTime: "", duration: "", endTime: "", countText: "" });
      setVenuesForDate([]);
      setSelectedVenueIdx(0);
      return;
    }
    const venuesArr = Array.isArray(ca.venues) ? ca.venues : null;
    if (venuesArr && venuesArr.length > 0) {
      const normalized = venuesArr.map((v, idx) => {
        const cc = Number(v.courtCount || 0);
        const slots = Array.isArray(v.timeSlots)
          ? v.timeSlots.map(ts => (typeof ts === 'string' ? { id: nanoid(), startTime: ts, duration: '', endTime: '' } : ts))
          : [];
        const asg = Array.isArray(v.assignments)
          ? v.assignments
          : (slots.length > 0 ? slots.map(() => new Array(Math.max(1, cc || 1)).fill(null)) : []);
        return {
          name: String(v.name || v.venueName || `Venue ${idx + 1}`),
          courtCount: cc || 1,
          timeSlots: slots,
          assignments: asg,
        };
      });
      setVenuesForDate(normalized);
      setSelectedVenueIdx(Math.min(selectedVenueIdx || 0, normalized.length - 1));
      const cur = normalized[Math.min(selectedVenueIdx || 0, normalized.length - 1)];
      setCourtCount(cur.courtCount);
      setTimeSlots(cur.timeSlots);
      setAssignments(cur.assignments);
      const currentSlots = cur.timeSlots || [];
      const last = currentSlots.length > 0 ? currentSlots[currentSlots.length - 1] : null;
      setNewTimeSlot({
        startTime: String(last?.endTime || last?.startTime || ""),
        duration: String(last?.duration || ""),
        endTime: "",
        countText: ""
      });
    } else {
      const cc = Number(ca.courtCount || 0);
      const slots = Array.isArray(ca.timeSlots)
        ? ca.timeSlots.map(ts => (typeof ts === 'string' ? { id: nanoid(), startTime: ts, duration: '', endTime: '' } : ts))
        : [];
      const asg = Array.isArray(ca.assignments)
        ? ca.assignments
        : (slots.length > 0 ? slots.map(() => new Array(Math.max(1, cc || courtCount)).fill(null)) : []);
      const defaultVenue = {
        name: String(tournamentForMatches?.venueName || "Venue 1"),
        courtCount: cc || 1,
        timeSlots: slots,
        assignments: asg,
      };
      setVenuesForDate([defaultVenue]);
      setSelectedVenueIdx(0);
      if (cc > 0) setCourtCount(cc);
      setTimeSlots(slots);
      setAssignments(asg);
      const currentSlots = slots || [];
      const last = currentSlots.length > 0 ? currentSlots[currentSlots.length - 1] : null;
      setNewTimeSlot({
        startTime: String(last?.endTime || last?.startTime || ""),
        duration: String(last?.duration || ""),
        endTime: "",
        countText: ""
      });
    }
  }, [tournamentForMatches?.courtAssignmentsByDate, tournamentForMatches?.courtAssignments, selectedDate]);

  useEffect(() => {
    const v = venuesForDate[Math.min(selectedVenueIdx || 0, Math.max(0, venuesForDate.length - 1))];
    if (!v) return;
    setCourtCount(v.courtCount);
    setTimeSlots(v.timeSlots);
    setAssignments(v.assignments);
  }, [selectedVenueIdx]);

  // Generated Matches
  const allMatches = useMemo(() => extractMatches(tournamentForMatches), [tournamentForMatches]);
  const scheduledIds = useMemo(() => {
    const set = new Set();
    (assignments || []).forEach((row) => {
      (row || []).forEach((cell) => {
        if (cell && cell.id) set.add(cell.id);
      });
    });
    return set;
  }, [assignments]);
  const matchCategories = useMemo(() => {
    const set = new Set();
    (allMatches || []).forEach((m) => {
      if (m?.category) set.add(m.category);
    });
    return ["All", ...Array.from(set).sort((a, b) => String(a).localeCompare(String(b)))];
  }, [allMatches]);
  const stageOptions = useMemo(() => {
    const set = new Set();
    (allMatches || []).forEach((m) => {
      if (m?.stage) set.add(m.stage);
    });
    return ["All", ...Array.from(set).sort((a, b) => String(a).localeCompare(String(b)))];
  }, [allMatches]);
  const matchesById = useMemo(() => {
    const map = new Map();
    (allMatches || []).forEach((m) => {
      if (m?.id) map.set(m.id, m);
    });
    return map;
  }, [allMatches]);
  const [selectedMatchCategory, setSelectedMatchCategory] = useState("All");
  const [selectedMatchStage, setSelectedMatchStage] = useState("All");
  const [matchSearch, setMatchSearch] = useState("");
  const filteredMatches = useMemo(() => {
    let base = selectedMatchCategory === "All" ? (allMatches || []) : (allMatches || []).filter((m) => m?.category === selectedMatchCategory);
    base = selectedMatchStage === "All" ? base : base.filter((m) => String(m?.stage || "") === String(selectedMatchStage));
    if (matchSearch.trim()) {
      const q = matchSearch.trim().toLowerCase();
      base = base.filter((m) => {
        const hay = [
          m?.playersVs,
          m?.label,
          m?.seedVs,
          m?.displayNumber,
          m?.matchNumber,
          m?.category,
          m?.stage
        ].map((x) => String(x || "").toLowerCase()).join(" ");
        return hay.includes(q);
      });
    }
    return base.filter((m) => m?.id && !scheduledIds.has(m.id));
  }, [allMatches, selectedMatchCategory, selectedMatchStage, matchSearch, scheduledIds]);
  const [noteEdit, setNoteEdit] = useState({ row: null, col: null, text: "" });
  const startNoteEdit = (row, col, initialText = "") => setNoteEdit({ row, col, text: initialText });
  const updateNoteEdit = (text) => setNoteEdit((prev) => ({ ...prev, text }));
  const saveNoteEdit = () => {
    setAssignments((prev) => {
      const next = [...prev];
      const r = noteEdit.row;
      const c = noteEdit.col;
      if (r == null || c == null) return prev;
      const t = String(noteEdit.text || "").trim();
      const rowArr = Array.isArray(next[r]) ? [...next[r]] : [];
      rowArr[c] = t ? { id: `note-${nanoid()}`, type: "note", text: t } : null;
      next[r] = rowArr;
      return next;
    });
    setNoteEdit({ row: null, col: null, text: "" });
  };
  const cancelNoteEdit = () => setNoteEdit({ row: null, col: null, text: "" });
  
  // Drag State
  const [activeDragId, setActiveDragId] = useState(null);

  const handleGeneratePDF = async () => {
    if (!scheduleGridRef.current) return;
    try {
      const canvas = await html2canvas(scheduleGridRef.current, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff"
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({
        orientation: "landscape",
        unit: "px",
        format: [canvas.width, canvas.height]
      });
      pdf.addImage(imgData, "PNG", 0, 0, canvas.width, canvas.height);
      pdf.save("schedule-assignments.pdf");
    } catch (err) {
      console.error("PDF Generation failed", err);
      alert("Failed to generate PDF");
    }
  };

  useEffect(() => {
    if (eventsEditorRef.current && !eventsEditorRef.current.innerHTML) {
      eventsEditorRef.current.innerHTML = eventsHtml || "";
    }
  }, []);

  useEffect(() => {
    setSelectedMatchCategory("All");
  }, [tournament?._id]);

  // ... (Keep existing Rich Text Editor logic)
  const execCommand = (command, value = null) => {
    document.execCommand(command, false, value);
  };

  const formatText = (command, editorRef) => {
    if (editorRef.current) {
      editorRef.current.focus();
      const selection = window.getSelection();
      if (selection.rangeCount === 0) {
        const range = document.createRange();
        range.selectNodeContents(editorRef.current);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      execCommand(command);
      editorRef.current.focus();
    }
  };

  const insertBulletList = (editorRef) => {
    if (editorRef.current) {
      editorRef.current.focus();
      const selection = window.getSelection();
      if (selection.rangeCount === 0) {
        const range = document.createRange();
        range.selectNodeContents(editorRef.current);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      execCommand("insertUnorderedList");
      editorRef.current.focus();
    }
  };

  const handleRichTextChange = (field, editorRef) => {
    if (!editorRef.current) return;
    const content = editorRef.current.innerHTML;
    if (field === "events") setEventsHtml(content);
  };

  const handleRichTextInput = (field, editorRef) => {
    if (!editorRef.current) return;
    const content = editorRef.current.innerHTML;
    if (field === "events") setEventsHtml(content);
  };

  const handleKeyDown = (e, field, editorRef) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const selection = window.getSelection();
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        const tabNode = document.createTextNode("\u00A0\u00A0\u00A0\u00A0");
        range.deleteContents();
        range.insertNode(tabNode);
        range.setStartAfter(tabNode);
        range.setEndAfter(tabNode);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      handleRichTextInput(field, editorRef);
    }
  };

  // ... (Keep existing Image handling logic)
  const isValidImageUrl = (u) => {
    try {
      const stripWrap = (s) => {
        const t = String(s || "").trim();
        if (!t) return "";
        if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`"))) {
          return t.slice(1, -1).trim();
        }
        return t;
      };
      const s = stripWrap(u);
      if (!s) return false;
      if (s === "[]") return false;
      if (s === "null" || s === "undefined") return false;
      if (s.startsWith("http://") || s.startsWith("https://")) return true;
      if (s.startsWith("gs://")) return true;
      if (s.startsWith("/uploads/")) return true;
      if (s.startsWith("/")) return true;
      return false;
    } catch {
      return false;
    }
  };

  const unwrapString = (val) => {
    const t = String(val || "").trim();
    if (!t) return "";
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) || (t.startsWith("`") && t.endsWith("`"))) {
      return t.slice(1, -1).trim();
    }
    return t;
  };

  const toDisplayUrl = (item) => {
    if (item instanceof File) return URL.createObjectURL(item);
    if (typeof item === "string") {
      const s = unwrapString(item);
      if (!s) return "";
      const canon = s.includes("storage.cloud.google.com/")
        ? s.replace("storage.cloud.google.com", "storage.googleapis.com")
        : s;
      return canon || "";
    }
    if (item && typeof item === "object") {
      const raw = unwrapString(item.url || item.path || "");
      if (!raw) return "";
      const canon = raw.includes("storage.cloud.google.com/")
        ? raw.replace("storage.cloud.google.com", "storage.googleapis.com")
        : raw;
      return canon || "";
    }
    return "";
  };

  const cleanSchedulePictures = (input) => {
    try {
      const src = Array.isArray(input) ? input : [input];
      const out = [];
      const pushIfValid = (s) => {
        const v = unwrapString(s);
        if (isValidImageUrl(v)) out.push(v);
      };
      src.forEach((item) => {
        if (!item) return;
        if (typeof item === "string") {
          const s = unwrapString(item);
          if (!s || s === "[]") return;
          if (s.startsWith("[") || s.startsWith("{")) {
            try {
              const parsed = JSON.parse(s);
              if (Array.isArray(parsed)) parsed.forEach(pushIfValid);
              else if (parsed && typeof parsed === "object") {
                const u = parsed.url || parsed.path || "";
                pushIfValid(u);
              }
            } catch {
              pushIfValid(s);
            }
            return;
          }
          pushIfValid(s);
          return;
        }
        if (item && typeof item === "object") {
          const u = item.url || item.path || "";
          pushIfValid(u);
        }
      });
      return Array.from(new Set(out));
    } catch {
      return [];
    }
  };

  const handleScheduleImagesUpload = (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const validFiles = files.filter((file) => {
      const isValidType = ["image/jpeg", "image/png"].includes(file.type);
      const isValidSize = file.size <= 5 * 1024 * 1024;
      return isValidType && isValidSize;
    });
    const maxFiles = 3;
    const existing = Array.isArray(schedulePictures) ? schedulePictures : [];
    const availableSlots = maxFiles - existing.length;
    if (availableSlots <= 0) {
      setMessage("You can upload up to 3 schedule images");
      e.target.value = null;
      return;
    }
    const toAdd = validFiles.slice(0, availableSlots);
    setSchedulePictures([...existing, ...toAdd]);
    setDidClearSchedulePictures(false);
    e.target.value = null;
  };

  const removeSchedulePicture = (index) => {
    const next = [...(schedulePictures || [])];
    next.splice(index, 1);
    const hadPrev = (Array.isArray(schedulePictures) ? schedulePictures.length : 0) > 0
      || (Array.isArray(tournament?.schedulePictures) ? tournament.schedulePictures.length : 0) > 0;
    if (hadPrev && next.length === 0) setDidClearSchedulePictures(true);
    setSchedulePictures(next);
  };

  // --- New Logic for Schedule Assignments ---

  const updateCourtCount = (val) => {
    const n = Math.max(1, Number(val) || 1);
    setCourtCount(n);
    setAssignments((prev) =>
      (prev || []).map((row) => {
        const nextRow = Array.isArray(row) ? [...row] : [];
        if (nextRow.length < n) {
          return [...nextRow, ...new Array(n - nextRow.length).fill(null)];
        }
        if (nextRow.length > n) {
          return nextRow.slice(0, n);
        }
        return nextRow;
      }),
    );
    setVenuesForDate((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      if (!arr[selectedVenueIdx]) return arr;
      const cur = { ...(arr[selectedVenueIdx] || {}) };
      cur.courtCount = n;
      arr[selectedVenueIdx] = cur;
      return arr;
    });
  };

  // Add Time Logic
  const handleStartTimeChange = (e) => {
    const startTime = e.target.value;
    setNewTimeSlot(prev => {
        const newState = { ...prev, startTime };
        if (newState.duration) {
            const count = Math.max(1, Number(newState.countText) || 1);
            newState.endTime = calculateEndTime(startTime, Number(newState.duration) * count);
        }
        return newState;
    });
  };

  const handleDurationChange = (e) => {
    const duration = e.target.value;
    setNewTimeSlot(prev => {
        const newState = { ...prev, duration };
        if (newState.startTime) {
            const count = Math.max(1, Number(newState.countText) || 1);
            newState.endTime = calculateEndTime(newState.startTime, Number(duration) * count);
        }
        return newState;
    });
  };

  const replaceTailSlotSeries = ({ startTime, duration, count }) => {
    const safeCount = Math.max(1, Number(count) || 1);
    const safeDuration = Number(duration);
    let currentStartTime = startTime;

    if (!currentStartTime || !safeDuration) return;

    const newSlots = [];
    const newAssignments = [];

    for (let i = 0; i < safeCount; i++) {
      const endTime = calculateEndTime(currentStartTime, safeDuration);
      newSlots.push({
        id: nanoid(),
        startTime: currentStartTime,
        duration: String(safeDuration),
        endTime: endTime,
      });
      newAssignments.push(new Array(courtCount).fill(null));
      currentStartTime = endTime;
    }

    const previousSeriesLen = slotSeriesLenRef.current || 0;
    slotSeriesLenRef.current = safeCount;
    setTimeSlots((prev) => [...prev.slice(0, Math.max(0, prev.length - previousSeriesLen)), ...newSlots]);
    setAssignments((prev) => [...prev.slice(0, Math.max(0, prev.length - previousSeriesLen)), ...newAssignments]);
  };

  const handleCountChange = (e) => {
    const countText = e.target.value;
    setNewTimeSlot((prev) => {
      const startTime = prev.startTime;
      const duration = Number(prev.duration);
      const count = Math.max(1, Number(countText) || 1);
      const newState = { ...prev, countText };

      if (startTime && duration) {
        newState.endTime = calculateEndTime(startTime, duration * count);
      } else {
        newState.endTime = "";
      }

      if (slotsAutoAddTimerRef.current) {
        clearTimeout(slotsAutoAddTimerRef.current);
        slotsAutoAddTimerRef.current = null;
      }

      if (startTime && duration && String(countText).trim() !== "") {
        slotsAutoAddTimerRef.current = setTimeout(() => {
          replaceTailSlotSeries({ startTime, duration, count });
        }, 800);
      }

      return newState;
    });
  };

  const calculateEndTime = (start, durationMins) => {
    if (!start || !durationMins) return "";
    const [hours, mins] = start.split(':').map(Number);
    const date = new Date();
    date.setHours(hours);
    date.setMinutes(mins + Number(durationMins));
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  };

  const addTimeSlotsWith = ({ startTime, duration, count }) => {
    const safeCount = Math.max(1, Number(count) || 1);
    const safeDuration = Number(duration);
    let currentStartTime = startTime;

    if (!currentStartTime || !safeDuration) return "";

    const newSlots = [];
    const newAssignments = [];

    for (let i = 0; i < safeCount; i++) {
      const endTime = calculateEndTime(currentStartTime, safeDuration);
      newSlots.push({
        id: nanoid(),
        startTime: currentStartTime,
        duration: String(safeDuration),
        endTime: endTime,
      });
      newAssignments.push(new Array(courtCount).fill(null));
      currentStartTime = endTime;
    }

    setTimeSlots((prev) => [...prev, ...newSlots]);
    setAssignments((prev) => [...prev, ...newAssignments]);
    return currentStartTime;
  };

  const closeAddTime = () => {
    if (slotsAutoAddTimerRef.current) {
      clearTimeout(slotsAutoAddTimerRef.current);
      slotsAutoAddTimerRef.current = null;
    }
    slotSeriesLenRef.current = 0;
    setIsAddTimeModalOpen(false);
    setNewTimeSlot({ startTime: "", duration: "", endTime: "", countText: "" });
  };

  const removeTimeSlot = (idx) => {
    slotSeriesLenRef.current = 0;
    setTimeSlots((prev) => prev.filter((_, i) => i !== idx));
    setAssignments((prev) => prev.filter((_, i) => i !== idx));
  };

  // Drag and Drop Handlers
  const handleDragStart = (event) => {
    setActiveDragId(event.active.id);
  };

  const handleDragEnd = (event) => {
    setActiveDragId(null);
    const { active, over } = event;

    if (over && over.id.startsWith("cell-")) {
      const { row, col } = over.data.current;
      const matchData = active.data.current;

      setAssignments(prev => {
        const newAssignments = [...prev];
        if (typeof matchData.originRow === "number" && typeof matchData.originCol === "number") {
          const prevRow = [...newAssignments[matchData.originRow]];
          prevRow[matchData.originCol] = null;
          newAssignments[matchData.originRow] = prevRow;
        }
        const newRow = [...newAssignments[row]];
        newRow[col] = {
            id: matchData.id,
            key: matchData.matchKey,
            label: matchData.label,
            category: matchData.category,
            seedVs: matchData.seedVs,
            displayNumber: matchData.displayNumber,
            matchNumber: matchData.matchNumber,
            stage: matchData.stage
        };
        newAssignments[row] = newRow;
        return newAssignments;
      });
    }
  };

  const removeAssignment = (row, col) => {
    const nextAssignments = (() => {
      const base = Array.isArray(assignments) ? assignments.map(r => Array.isArray(r) ? [...r] : []) : [];
      if (!base[row]) base[row] = [];
      const newRow = [...base[row]];
      newRow[col] = null;
      base[row] = newRow;
      return base;
    })();
    setAssignments(nextAssignments);
    setVenuesForDate((prev) => {
      const arr = Array.isArray(prev) ? [...prev] : [];
      if (!arr[selectedVenueIdx]) return arr;
      const cur = { ...(arr[selectedVenueIdx] || {}) };
      cur.assignments = nextAssignments;
      arr[selectedVenueIdx] = cur;
      return arr;
    });
  };

  const onSave = async () => {
    try {
      setMessage("");
      const bracketUpdates = (() => {
        const out = {};
        const dSel = String(selectedDate || "").trim();
        const scheduledNow = new Set();
        const venuesToSave = (() => {
          const arr = Array.isArray(venuesForDate) ? venuesForDate.map((v) => ({ ...v })) : [];
          if (arr.length === 0) {
            arr.push({
              name: String(tournamentForMatches?.venueName || "Venue 1"),
              courtCount,
              timeSlots,
              assignments,
            });
          } else {
            const cur = { ...(arr[selectedVenueIdx] || {}) };
            cur.courtCount = courtCount;
            cur.timeSlots = timeSlots;
            cur.assignments = assignments;
            arr[selectedVenueIdx] = cur;
          }
          return arr;
        })();
        venuesToSave.forEach((venue) => {
          (venue.assignments || []).forEach((row, rIdx) => {
            const tslot = venue.timeSlots?.[rIdx];
            const t = String(tslot?.startTime || "").trim();
            const d = String(selectedDate || "").trim();
            (row || []).forEach((cell, cIdx) => {
              if (!cell || !cell.id) return;
              const m = matchesById.get(cell.id);
              if (!m) return;
              if (String(m?.type || "") === "group" && m?.matchKey) {
                const catId = String(m.categoryId || "");
                const gId = `group-${String(m.bracket || "A").toLowerCase()}`;
                out[catId] = out[catId] || {};
                out[catId][gId] = out[catId][gId] || {};
                out[catId][gId][String(m.matchKey)] = {
                  date: d,
                  time: t,
                  court: String(cIdx + 1),
                  venue: String(venue.name || ""),
                };
                scheduledNow.add(`${catId}|${gId}|${String(m.matchKey)}`);
              }
            });
          });
        });
        // Unschedule any previously scheduled matches on selected date that are not in current grid
        if (dSel) {
          const cats = Array.isArray(tournamentForMatches?.tournamentCategories) ? tournamentForMatches.tournamentCategories : [];
          cats.forEach((cat) => {
            const catId = String(cat?._id || "");
            const groups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
            groups.forEach((g) => {
              const gid = String(g?.id || "");
              const matches = (g?.matches && typeof g.matches === "object") ? g.matches : {};
              Object.keys(matches).forEach((mk) => {
                const md = matches[mk] || {};
                const prevDate = String(md?.date || md?.mdDate || "").trim();
                if (prevDate && prevDate === dSel) {
                  const key = `${catId}|${gid}|${mk}`;
                  if (!scheduledNow.has(key)) {
                    out[catId] = out[catId] || {};
                    out[catId][gid] = out[catId][gid] || {};
                    out[catId][gid][mk] = { date: "", time: "", court: "" };
                  }
                }
              });
            });
          });
        }
        return out;
      })();
      const fd = new FormData();
      fd.set("events", eventsHtml || "");
      const venuesPayload = (() => {
        const arr = Array.isArray(venuesForDate) ? venuesForDate.map((v) => ({ ...v })) : [];
        if (arr.length === 0) {
          arr.push({
            name: String(tournamentForMatches?.venueName || "Venue 1"),
            courtCount,
            timeSlots,
            assignments,
          });
        } else {
          const cur = { ...(arr[selectedVenueIdx] || {}) };
          cur.courtCount = courtCount;
          cur.timeSlots = timeSlots;
          cur.assignments = assignments;
          arr[selectedVenueIdx] = cur;
        }
        return arr;
      })();
      fd.set(
        "courtAssignments",
        JSON.stringify({
          scheduleDate: selectedDate || "",
          // Backward-compatible fields for single-venue consumers
          courtCount,
          timeSlots,
          assignments,
          // New multi-venue structure
          venues: venuesPayload,
        }),
      );
      fd.set("bracketUpdates", JSON.stringify(bracketUpdates));
      const hasFiles = (schedulePictures || []).some((it) => it instanceof File);
      const scheduleUrls = Array.from(
        new Set(
          cleanSchedulePictures(schedulePictures || [])
            .filter((s) => typeof s === "string")
            .map((t) => String(t).trim())
        )
      );
      if (scheduleUrls.length > 0 || hasFiles) {
        fd.set("schedulePictures", JSON.stringify(scheduleUrls));
      }
      if (didClearSchedulePictures === true) {
        fd.set("clearSchedulePictures", "true");
      }
      (schedulePictures || []).forEach((item) => {
        if (item instanceof File) {
          fd.append("schedulePictures", item);
        }
      });
      const resolveAuthToken = () => {
        try {
          const superadminToken = localStorage.getItem("superadminToken");
          const refereeToken = localStorage.getItem("refereeToken");
          const sessionUser = JSON.parse(sessionStorage.getItem("user_session") || "{}");
          const localUser = JSON.parse(localStorage.getItem("user") || "{}");
          const plainToken = localStorage.getItem("token");
          if (sessionUser?.token) return sessionUser.token;
          if (localUser?.token) return localUser.token;
          if (superadminToken) return superadminToken;
          if (refereeToken) return refereeToken;
          if (plainToken) return plainToken;
        } catch {}
        return "";
      };
      const res = await fetch(`/api/tournaments/${tournament?._id}`, {
        method: "PUT",
        body: fd,
        headers: (() => {
          const t = resolveAuthToken();
          return t ? { Authorization: `Bearer ${t}` } : {};
        })(),
      });
      if (!res.ok) throw new Error("Failed");
      setTournamentForMatches((prev) => {
        try {
          const next = prev ? { ...prev } : {};
          const cats = Array.isArray(prev?.tournamentCategories) ? prev.tournamentCategories : [];
          next.tournamentCategories = cats.map((cat) => {
            const catId = String(cat?._id || "");
            const catUpdates = bracketUpdates[catId];
            if (!catUpdates) return cat;
            const groups = Array.isArray(cat?.groupStage?.groups) ? cat.groupStage.groups : [];
            const nextGroups = groups.map((g) => {
              const gid = String(g?.id || "");
              const gUpdates = catUpdates[gid];
              if (!gUpdates) return g;
              const matches = { ...(g?.matches || {}) };
              Object.keys(gUpdates).forEach((mk) => {
                const md = matches[mk] || {};
                  matches[mk] = { ...md, date: gUpdates[mk].date, time: gUpdates[mk].time, court: gUpdates[mk].court, venue: gUpdates[mk].venue };
              });
              return { ...g, matches };
            });
            return { ...cat, groupStage: { ...(cat.groupStage || {}), groups: nextGroups } };
          });
          next.courtAssignments = {
            scheduleDate: selectedDate || "",
            courtCount,
            timeSlots,
            assignments,
            venues: venuesPayload,
          };
          const cad = { ...(prev?.courtAssignmentsByDate || {}) };
          cad[String(selectedDate || "")] = {
            scheduleDate: selectedDate || "",
            courtCount,
            timeSlots,
            assignments,
            venues: venuesPayload,
          };
          next.courtAssignmentsByDate = cad;
          return next;
        } catch {
          return prev;
        }
      });
      setMessage("Saved");
      const last = timeSlots.length > 0 ? timeSlots[timeSlots.length - 1] : null;
      setNewTimeSlot({
        startTime: String(last?.endTime || last?.startTime || ""),
        duration: String(last?.duration || ""),
        endTime: "",
        countText: ""
      });
    } catch {
      setMessage("Failed to save");
    }
  };

  return (
    <div>
      <div className="text-xl font-bold text-gray-800 mb-4">Schedules</div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setActiveTab("post")}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1.5px solid #e2e8f0",
            background: activeTab === "post" ? "#10b981" : "#ffffff",
            color: activeTab === "post" ? "#ffffff" : "#111827",
            fontWeight: 600,
          }}
        >
          Schedule Post
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("assignments")}
          style={{
            padding: "8px 12px",
            borderRadius: 8,
            border: "1.5px solid #e2e8f0",
            background: activeTab === "assignments" ? "#10b981" : "#ffffff",
            color: activeTab === "assignments" ? "#ffffff" : "#111827",
            fontWeight: 600,
          }}
        >
          Schedule Court Assignments
        </button>
      </div>

      {activeTab === "post" ? (
        <div className="tournament-guidelines-box" style={{ border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, background: "#ffffff" }}>
           {/* Existing Post Content (Schedule Images and Editor) */}
          <div className="mb-2 font-semibold text-gray-700">Schedule Images (up to 3)</div>
          <div
            onClick={() => document.getElementById("schedule-images-upload").click()}
            style={{
              border: "1.5px dashed #94a3b8",
              borderRadius: 12,
              padding: 24,
              textAlign: "center",
              background: "#f8fafc",
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: 32, lineHeight: 1 }}>📅</div>
            <div style={{ fontWeight: 600, marginTop: 8 }}>Click to upload schedule images</div>
            <div style={{ color: "#64748b", fontSize: 14 }}>JPG or PNG (max 5MB each, 3 total)</div>
          </div>
          <input
            id="schedule-images-upload"
            type="file"
            accept=".jpg,.jpeg,.png"
            multiple
            style={{ display: "none" }}
            onChange={handleScheduleImagesUpload}
          />
          {(() => {
            const display = (schedulePictures || [])
              .map((item, idx) => ({ idx, url: toDisplayUrl(item) }))
              .filter((p) => Boolean(p.url));
            if (display.length === 0) return null;
            return (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginTop: 12 }}>
                {display.map((p) => (
                  <div key={p.idx} style={{ position: "relative" }}>
                    <img
                      src={p.url}
                      alt={`Schedule ${p.idx + 1}`}
                      style={{ width: "100%", height: 140, objectFit: "cover", borderRadius: 12, border: "1px solid #e2e8f0" }}
                    />
                    <button
                      type="button"
                      onClick={() => removeSchedulePicture(p.idx)}
                      style={{
                        position: "absolute",
                        top: 8,
                        right: 8,
                        background: "#ef4444",
                        color: "white",
                        border: "none",
                        borderRadius: 8,
                        padding: "6px 10px",
                        cursor: "pointer",
                        fontSize: 12,
                      }}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            );
          })()}
          <div style={{ marginTop: 16 }}>
            <div style={{ fontWeight: 600, color: "#374151", marginBottom: 8 }}>Schedule and Activities</div>
            <div style={{ border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden", background: "#f8fafc" }}>
              <div style={{ display: "flex", gap: 8, padding: "8px 12px", borderBottom: "1px solid #e2e8f0", background: "#ffffff" }}>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); formatText("bold", eventsEditorRef); }}
                  style={{ padding: "6px 12px", border: "1.5px solid #e2e8f0", borderRadius: 8, background: "#f8fafc", cursor: "pointer", fontWeight: 600 }}
                  title="Bold"
                >
                  B
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); formatText("italic", eventsEditorRef); }}
                  style={{ padding: "6px 12px", border: "1.5px solid #e2e8f0", borderRadius: 8, background: "#f8fafc", cursor: "pointer" }}
                  title="Italic"
                >
                  /
                </button>
                <button
                  type="button"
                  onMouseDown={(e) => { e.preventDefault(); insertBulletList(eventsEditorRef); }}
                  style={{ padding: "6px 12px", border: "1.5px solid #e2e8f0", borderRadius: 8, background: "#f8fafc", cursor: "pointer", fontWeight: 500 }}
                  title="Bullet List"
                >
                  • List
                </button>
              </div>
              <div
                ref={eventsEditorRef}
                contentEditable
                suppressContentEditableWarning={true}
                data-placeholder="Describe the tournament events, schedule, and activities that will take place. Use the toolbar above to format your text."
                onInput={() => handleRichTextInput("events", eventsEditorRef)}
                onBlur={() => handleRichTextChange("events", eventsEditorRef)}
                onKeyDown={(e) => handleKeyDown(e, "events", eventsEditorRef)}
                style={{
                  minHeight: 100,
                  padding: "12px 16px",
                  fontSize: "1rem",
                  color: "#1a1a1a",
                  background: "white",
                  borderRadius: "0 0 8px 8px",
                  outline: "none",
                  fontFamily: "inherit",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                }}
              />
            </div>
          </div>
        </div>
      ) : (
        <DndContext onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
          <div style={{ display: "flex", gap: "16px" }}>
            {/* Left Sidebar: Generated Matches */}
            {showMatchesSidebar && (
            <div style={{ width: "250px", border: "1px solid #e2e8f0", borderRadius: "12px", padding: "12px", background: "#f9fafb", maxHeight: "800px", overflowY: "auto" }}>
                <h3 className="font-bold text-gray-700 mb-2">Generated Matches</h3>
                <div className="text-xs text-gray-500 mb-4">Drag matches to the schedule grid</div>
                <div style={{ marginBottom: 12 }}>
                  <select
                    value={selectedMatchCategory}
                    onChange={(e) => setSelectedMatchCategory(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1.5px solid #e2e8f0",
                      background: "white",
                      fontSize: 12,
                    }}
                  >
                    {matchCategories.map((c) => (
                      <option key={c} value={c}>
                        {c === "All" ? `All Categories (${allMatches.length})` : c}
                      </option>
                    ))}
                  </select>
              <div style={{ marginTop: 8 }}>
                <select
                  value={selectedMatchStage}
                  onChange={(e) => setSelectedMatchStage(e.target.value)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: "1.5px solid #e2e8f0",
                    background: "white",
                    fontSize: 12,
                  }}
                >
                  {stageOptions.map((s) => (
                    <option key={s} value={s}>
                      {s === "All" ? "All Stages" : s}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                value={matchSearch}
                onChange={(e) => setMatchSearch(e.target.value)}
                placeholder="Search by players, #, label…"
                style={{ marginTop: 8, width: "100%", padding: "8px 10px", borderRadius: 8, border: "1.5px solid #e2e8f0", background: "white", fontSize: 12 }}
              />
                  {selectedMatchCategory !== "All" && (
                    <div className="text-[11px] text-gray-500 mt-1">
                      Showing {filteredMatches.length} match{filteredMatches.length === 1 ? "" : "es"}
                    </div>
                  )}
                </div>
                {filteredMatches.map(match => (
                    <DraggableMatch key={match.id} match={match} />
                ))}
                {filteredMatches.length === 0 && (
                    <div className="text-gray-400 text-sm text-center py-4">No matches found</div>
                )}
            </div>
            )}

            {/* Main Content: Schedule Grid */}
            <div style={{ flex: 1, border: "1px solid #e2e8f0", borderRadius: 12, padding: 16, background: "#ffffff" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600, color: "#374151" }}>Venue</div>
        <select
          value={String(selectedVenueIdx)}
          onChange={(e) => setSelectedVenueIdx(Number(e.target.value) || 0)}
          style={{ padding: "8px 12px", border: "1.5px solid #e2e8f0", borderRadius: 8 }}
        >
          {venuesForDate.map((v, idx) => (
            <option key={idx} value={idx}>{v.name || `Venue ${idx + 1}`}</option>
          ))}
        </select>
        <input
          type="text"
          value={String(venuesForDate[selectedVenueIdx]?.name || "")}
          onChange={(e) => {
            const val = e.target.value;
            setVenuesForDate((prev) => {
              const arr = Array.isArray(prev) ? [...prev] : [];
              if (!arr[selectedVenueIdx]) return arr;
              const cur = { ...(arr[selectedVenueIdx] || {}) };
              cur.name = val;
              arr[selectedVenueIdx] = cur;
              return arr;
            });
          }}
          placeholder="Venue name"
          style={{ padding: "8px 12px", border: "1.5px solid #e2e8f0", borderRadius: 8, minWidth: 180 }}
        />
        <button
          type="button"
          onClick={() => {
            setVenuesForDate((prev) => {
              const arr = Array.isArray(prev) ? [...prev] : [];
              const name = `Venue ${arr.length + 1}`;
              arr.push({ name, courtCount: 1, timeSlots: [], assignments: [] });
              return arr;
            });
            setSelectedVenueIdx(venuesForDate.length);
            setCourtCount(1);
            setTimeSlots([]);
            setAssignments([]);
          }}
          style={{ padding: "8px 12px", borderRadius: 8, background: "#ecfeff", border: "1px solid #06b6d4", fontWeight: 700, color: "#0891b2" }}
        >
          Add Venue
        </button>
        <button
          type="button"
          disabled={venuesForDate.length <= 1}
          onClick={() => {
            const next = (() => {
              const arr = Array.isArray(venuesForDate) ? [...venuesForDate] : [];
              if (arr.length <= 1) return arr;
              arr.splice(selectedVenueIdx, 1);
              return arr;
            })();
            const nextIdx = Math.max(0, Math.min(selectedVenueIdx - 1, next.length - 1));
            setVenuesForDate(next);
            setSelectedVenueIdx(nextIdx);
            const cur = next[nextIdx];
            if (cur) {
              setCourtCount(cur.courtCount || 1);
              setTimeSlots(Array.isArray(cur.timeSlots) ? cur.timeSlots : []);
              setAssignments(Array.isArray(cur.assignments) ? cur.assignments : []);
              const ls = Array.isArray(cur.timeSlots) ? cur.timeSlots : [];
              const last = ls.length > 0 ? ls[ls.length - 1] : null;
              setNewTimeSlot({
                startTime: String(last?.endTime || last?.startTime || ""),
                duration: String(last?.duration || ""),
                endTime: "",
                countText: ""
              });
            } else {
              setCourtCount(1);
              setTimeSlots([]);
              setAssignments([]);
              setNewTimeSlot({ startTime: "", duration: "", endTime: "", countText: "" });
            }
          }}
          style={{ padding: "8px 12px", borderRadius: 8, background: venuesForDate.length <= 1 ? "#f3f4f6" : "#fee2e2", border: "1px solid #ef4444", fontWeight: 700, color: "#b91c1c" }}
        >
          Delete Venue
        </button>
                <div style={{ fontWeight: 600, color: "#374151" }}>Courts</div>
                <input
                  type="number"
                  min={1}
                  value={courtCount}
                  onChange={(e) => updateCourtCount(e.target.value)}
                  style={{ width: 100, padding: "8px 12px", border: "1.5px solid #e2e8f0", borderRadius: 8 }}
                />
                <div style={{ fontWeight: 600, color: "#374151" }}>Date</div>
                <select
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  style={{ padding: "8px 12px", border: "1.5px solid #e2e8f0", borderRadius: 8 }}
                >
                  {(dateList.length ? dateList : [""]).map((d, idx) => (
                    <option key={idx} value={d}>
                      {d ? new Date(d).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Unspecified"}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleGeneratePDF}
                  style={{ marginLeft: "auto", marginRight: "8px", padding: "8px 12px", borderRadius: 8, background: "#6366f1", color: "white", border: "1px solid #4f46e5", fontWeight: 600 }}
                >
                  Generate PDF
                </button>
                <button
                  type="button"
                  onClick={() => setIsAddTimeModalOpen(true)}
                  style={{ padding: "8px 12px", borderRadius: 8, background: "#f3f4f6", border: "1px solid #e5e7eb", fontWeight: 600 }}
                >
                  Add Time
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (showMatchesSidebar) {
                      setShowMatchesSidebar(false);
                    } else {
                      setMatchesDrawerOpen(true);
                    }
                  }}
                  style={{ padding: "8px 12px", borderRadius: 8, background: "#ecfdf5", border: "1px solid #22c55e", fontWeight: 700, color: "#16a34a" }}
                >
                  {showMatchesSidebar ? "Hide Matches" : "Show Matches"}
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>Legend:</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#111827", background: "#ffd700", padding: "2px 8px", borderRadius: 12 }}>Gold</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#111827", background: "#cd7f32", padding: "2px 8px", borderRadius: 12 }}>Bronze</span>
                </div>
              </div>

              {/* Add Time Modal/Form */}
              {isAddTimeModalOpen && (
                <div style={{ 
                    marginBottom: 16, 
                    padding: 16, 
                    background: "#f0f9ff", 
                    borderRadius: 8, 
                    border: "1px solid #bae6fd",
                    display: "flex",
                    gap: 12,
                    alignItems: "flex-end"
                }}>
                    <div>
                        <label className="block text-xs font-semibold text-gray-600 mb-1">Start Time</label>
                        <input 
                            type="time" 
                            value={newTimeSlot.startTime} 
                            onChange={handleStartTimeChange}
                            className="p-2 border rounded"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-gray-600 mb-1">Duration (min)</label>
                        <input 
                            type="number" 
                            placeholder="e.g. 30"
                            value={newTimeSlot.duration} 
                            onChange={handleDurationChange}
                            className="p-2 border rounded w-24"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-gray-600 mb-1">Slots</label>
                        <input 
                            type="text"
                            inputMode="numeric"
                            placeholder="e.g. 10"
                            value={newTimeSlot.countText} 
                            onChange={handleCountChange}
                            className="p-2 border rounded w-20"
                        />
                    </div>
                    <div>
                        <label className="block text-xs font-semibold text-gray-600 mb-1">End Time (Last)</label>
                        <input 
                            type="text" 
                            value={newTimeSlot.endTime} 
                            readOnly
                            className="p-2 border rounded bg-gray-100 w-24"
                        />
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button 
                            onClick={closeAddTime}
                            className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300"
                        >
                            Close
                        </button>
                    </div>
                </div>
              )}

              <div style={{ overflowX: "auto" }}>
                <div ref={scheduleGridRef} style={{ display: "grid", gridTemplateColumns: `160px repeat(${courtCount}, minmax(160px, 1fr))`, border: "1px solid #e5e7eb", borderRadius: 8 }}>
                  <div style={{ background: "#f8fafc", padding: 12, borderRight: "1px solid #e5e7eb", fontWeight: 600 }}>Time</div>
                  {Array.from({ length: courtCount }).map((_, i) => (
                    <div key={i} style={{ background: "#f8fafc", padding: 12, borderRight: "1px solid #e5e7eb", fontWeight: 600 }}>{`Court ${i + 1}`}</div>
                  ))}
                  {timeSlots.map((t, rowIdx) => (
                    <React.Fragment key={rowIdx}>
                      <div style={{ padding: 8, borderTop: "1px solid #e5e7eb", borderRight: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1 }} className="font-semibold">{t.startTime}</div>
                        <button
                          type="button"
                          onClick={() => removeTimeSlot(rowIdx)}
                          style={{ padding: "6px 10px", borderRadius: 8, background: "#fee2e2", color: "#b91c1c", border: "1px solid #fecaca", fontSize: 12 }}
                        >
                          Remove
                        </button>
                      </div>
                      {Array.from({ length: courtCount }).map((_, colIdx) => (
                        <DroppableCell 
                            key={`${rowIdx}-${colIdx}`} 
                            row={rowIdx} 
                            col={colIdx} 
                            assignment={assignments[rowIdx]?.[colIdx]}
                            onRemove={removeAssignment}
                            hasConflict={(() => {
                              const m = matchesById.get(assignments[rowIdx]?.[colIdx]?.id);
                              const currentCategory = String(assignments[rowIdx]?.[colIdx]?.category || "");
                              const p = (m?.playersVs || "")
                                .split(" vs ")
                                .map(s => String(s).trim())
                                .filter(x => Boolean(x) && String(x).toLowerCase() !== "tbd");
                              if (p.length === 0) return false;
                              const rowPlayers = new Map();
                              (assignments[rowIdx] || []).forEach((cell) => {
                                if (!cell) return;
                                if (String(cell.category || "") !== currentCategory) return;
                                const mm = matchesById.get(cell.id);
                                const pp = (mm?.playersVs || "")
                                  .split(" vs ")
                                  .map(s => String(s).trim())
                                  .filter(x => Boolean(x) && String(x).toLowerCase() !== "tbd");
                                pp.forEach(x => {
                                  const k = x.toLowerCase();
                                  if (!k) return;
                                  rowPlayers.set(k, (rowPlayers.get(k) || 0) + 1);
                                });
                              });
                              return p.some(x => (rowPlayers.get(String(x).toLowerCase()) || 0) > 1);
                            })()}
                            noteEdit={noteEdit}
                            startNoteEdit={startNoteEdit}
                            saveNoteEdit={saveNoteEdit}
                            cancelNoteEdit={cancelNoteEdit}
                            updateNoteEdit={updateNoteEdit}
                        />
                      ))}
                    </React.Fragment>
                  ))}
                </div>
              </div>
              {!showMatchesSidebar && !matchesDrawerOpen && (
                <button
                  type="button"
                  onClick={() => setMatchesDrawerOpen(true)}
                  style={{ position: "fixed", left: 16, bottom: 16, padding: "10px 14px", borderRadius: 999, background: "#0ea5e9", color: "white", border: "1px solid #0284c7", fontWeight: 700, zIndex: 1200 }}
                >
                  Matches
                </button>
              )}
            </div>
          </div>
          {matchesDrawerOpen && (
            <div style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 300, background: "#ffffff", borderRight: "1px solid #e2e8f0", boxShadow: "0 10px 20px rgba(0,0,0,0.12)", zIndex: 2000, display: "flex", flexDirection: "column" }}>
              <div style={{ padding: 12, borderBottom: "1px solid #e5e7eb", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div className="font-bold text-gray-700">Generated Matches</div>
                <button
                  type="button"
                  onClick={() => setMatchesDrawerOpen(false)}
                  style={{ padding: "6px 10px", borderRadius: 8, background: "#f3f4f6", border: "1px solid #e5e7eb", fontWeight: 600 }}
                >
                  Close
                </button>
              </div>
              <div style={{ padding: 12, overflowY: "auto" }}>
                <div style={{ marginBottom: 12 }}>
                  <select
                    value={selectedMatchCategory}
                    onChange={(e) => setSelectedMatchCategory(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 8,
                      border: "1.5px solid #e2e8f0",
                      background: "white",
                      fontSize: 12,
                    }}
                  >
                    {matchCategories.map((c) => (
                      <option key={c} value={c}>
                        {c === "All" ? `All Categories (${allMatches.length})` : c}
                      </option>
                    ))}
                  </select>
                  <div style={{ marginTop: 8 }}>
                    <select
                      value={selectedMatchStage}
                      onChange={(e) => setSelectedMatchStage(e.target.value)}
                      style={{
                        width: "100%",
                        padding: "8px 10px",
                        borderRadius: 8,
                        border: "1.5px solid #e2e8f0",
                        background: "white",
                        fontSize: 12,
                      }}
                    >
                      {stageOptions.map((s) => (
                        <option key={s} value={s}>
                          {s === "All" ? "All Stages" : s}
                        </option>
                      ))}
                    </select>
                  </div>
                  <input
                    type="text"
                    value={matchSearch}
                    onChange={(e) => setMatchSearch(e.target.value)}
                    placeholder="Search by players, #, label…"
                    style={{ marginTop: 8, width: "100%", padding: "8px 10px", borderRadius: 8, border: "1.5px solid #e2e8f0", background: "white", fontSize: 12 }}
                  />
                </div>
                {filteredMatches.map(match => (
                  <DraggableMatch key={match.id} match={match} />
                ))}
                {filteredMatches.length === 0 && (
                  <div className="text-gray-400 text-sm text-center py-4">No matches found</div>
                )}
              </div>
            </div>
          )}
          <DragOverlay>
            {activeDragId ? (
                <div style={{
                    padding: "8px",
                    background: "white",
                    border: "1px solid #29ba9b",
                    borderRadius: "4px",
                    boxShadow: "0 5px 15px rgba(0,0,0,0.1)",
                    opacity: 0.9,
                    cursor: "grabbing"
                }}>
                    Dragging match...
                </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}
      <div style={{ 
          position: "sticky", 
          bottom: 0, 
          background: "white", 
          padding: "16px", 
          borderTop: "1px solid #e2e8f0", 
          marginTop: "16px", 
          display: "flex", 
          alignItems: "center", 
          justifyContent: "space-between", 
          zIndex: 50,
          boxShadow: "0 -2px 10px rgba(0,0,0,0.05)"
      }}>
          <div className={`font-semibold ${message === "Saved" ? "text-green-600" : "text-red-600"}`}>
              {message}
          </div>
          <button 
              className="px-6 py-2 bg-green-600 text-white rounded-md font-bold hover:bg-green-700 shadow-sm" 
              onClick={onSave}
          >
              Save Schedule
          </button>
      </div>
    </div>
  );
}
