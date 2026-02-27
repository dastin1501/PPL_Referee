import 'package:flutter/foundation.dart';

class User {
  final String id;
  final String name;
  final String email;
  final List<String> roles;
  final bool isReferee;
  final String? avatarUrl;
  final String? bio;
  final String? pplId;
  final String? duprId;
  final String? gender;
  final String? country;
  final String? city;
  final DateTime? birthDate;
  final String? initials;
  final double? singlesRating;
  final double? doublesRating;

  User({
    required this.id,
    required this.name,
    required this.email,
    required this.roles,
    required this.isReferee,
    this.avatarUrl,
    this.bio,
    this.pplId,
    this.duprId,
    this.gender,
    this.country,
    this.city,
    this.birthDate,
    this.initials,
    this.singlesRating,
    this.doublesRating,
  });

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      '_id': id,
      'name': name,
      'email': email,
      'roles': roles,
      'isReferee': isReferee,
      'avatarUrl': avatarUrl,
      'bio': bio,
      'pplId': pplId,
      'duprId': duprId,
      'gender': gender,
      'country': country,
      'city': city,
      'birthDate': birthDate?.toIso8601String(),
      'initials': initials,
      'dupr': {
        'singlesRating': singlesRating,
        'doublesRating': doublesRating,
      },
    };
  }

  factory User.fromJson(Map<String, dynamic> j) {
    final roles = (j['roles'] as List?)?.map((e) => e.toString()).toList() ?? [];
    final dupr = j['dupr'] as Map<String, dynamic>?;
    
    return User(
      id: j['_id']?.toString() ?? j['id']?.toString() ?? '',
      name: j['name']?.toString() ?? '',
      email: j['email']?.toString() ?? '',
      roles: roles,
      isReferee: j['isReferee'] == true || roles.any((r) => r.toLowerCase() == 'referee'),
      avatarUrl: j['avatarUrl']?.toString(),
      bio: j['bio']?.toString(),
      pplId: j['pplId']?.toString(),
      duprId: j['duprId']?.toString(),
      gender: j['gender']?.toString(),
      country: j['country']?.toString(),
      city: j['city']?.toString(),
      birthDate: DateTime.tryParse(j['birthDate']?.toString() ?? ''),
      initials: j['initials']?.toString(),
      singlesRating: dupr?['singlesRating'] is num ? (dupr!['singlesRating'] as num).toDouble() : null,
      doublesRating: dupr?['doublesRating'] is num ? (dupr!['doublesRating'] as num).toDouble() : null,
    );
  }
}

class TournamentMatch {
  final String id;
  final String player1;
  final String player2;
  final int score1;
  final int score2;
  final int? game1Player1;
  final int? game1Player2;
  final int? game2Player1;
  final int? game2Player2;
  final int? game3Player1;
  final int? game3Player2;
  final String round;
  final String court;
  final String date;
  final String time;
  final String? venue;
  // Per-game schedule fields for web-managed scheduling
  final String? mdTime2;
  final String? mdEnd2;
  final String? mdTime3;
  final String? mdEnd3;
  final String status;
  final String categoryId;
  final String matchKey;
  final String type;
  final String seedLabel;
  final String matchLabel;
  final String groupId;
  final String? winner;
  final String? signatureData;
  final List<String?>? gameSignatures;
  final String? refereeNote;
  // Status coming from Court Assignments cell, if any (e.g., 'Completed')
  final String caStatus;

  TournamentMatch({
    required this.id,
    required this.player1,
    required this.player2,
    required this.score1,
    required this.score2,
    this.game1Player1,
    this.game1Player2,
    this.game2Player1,
    this.game2Player2,
    this.game3Player1,
    this.game3Player2,
    required this.round,
    required this.court,
    required this.date,
    required this.time,
    this.venue,
    this.mdTime2,
    this.mdEnd2,
    this.mdTime3,
    this.mdEnd3,
    this.status = '',
    this.categoryId = '',
    this.matchKey = '',
    this.type = '',
    this.seedLabel = '',
    this.matchLabel = '',
    this.groupId = '',
    this.winner,
    this.signatureData,
    this.gameSignatures,
    this.refereeNote,
    this.caStatus = '',
  });

  factory TournamentMatch.fromJson(Map<String, dynamic> j) {
    String normalizeCourt(String s) {
      final m = RegExp(r'^\s*(?:Court\s*)?(\d+)\s*$').firstMatch(s);
      if (m != null) {
        return 'Court ${m.group(1)}';
      }
      return s;
    }
    final explicitStatus = j['status']?.toString();
    final derivedStatus = j['winner'] != null ? 'Completed' : 'Scheduled';
    final resolvedStatus = (explicitStatus != null && explicitStatus.isNotEmpty) ? explicitStatus : derivedStatus;
    List<String?>? sigs;
    final gs = j['gameSignatures'];
    if (gs is List) {
      sigs = gs.map((e) => e?.toString()).toList();
    }
    return TournamentMatch(
      id: j['_id']?.toString() ?? j['id']?.toString() ?? '',
      player1: j['player1']?.toString() ?? 'TBD',
      player2: j['player2']?.toString() ?? 'TBD',
      score1: int.tryParse(j['score1']?.toString() ?? '0') ?? 0,
      score2: int.tryParse(j['score2']?.toString() ?? '0') ?? 0,
      game1Player1: int.tryParse(j['game1Player1']?.toString() ?? ''),
      game1Player2: int.tryParse(j['game1Player2']?.toString() ?? ''),
      game2Player1: int.tryParse(j['game2Player1']?.toString() ?? ''),
      game2Player2: int.tryParse(j['game2Player2']?.toString() ?? ''),
      game3Player1: int.tryParse(j['game3Player1']?.toString() ?? ''),
      game3Player2: int.tryParse(j['game3Player2']?.toString() ?? ''),
      round: j['round']?.toString() ?? '',
      court: normalizeCourt(j['court']?.toString() ?? ''),
      date: j['date']?.toString() ?? '',
      time: j['time']?.toString() ?? '',
      venue: j['venue']?.toString(),
      mdTime2: j['mdTime2']?.toString(),
      mdEnd2: j['mdEnd2']?.toString(),
      mdTime3: j['mdTime3']?.toString(),
      mdEnd3: j['mdEnd3']?.toString(),
      status: resolvedStatus,
      categoryId: j['categoryId']?.toString() ?? '',
      matchKey: j['matchKey']?.toString() ?? '',
      type: j['type']?.toString() ?? '',
      seedLabel: j['seedLabel']?.toString() ?? '',
      matchLabel: j['matchLabel']?.toString() ?? '',
      groupId: j['groupId']?.toString() ?? '',
      winner: j['winner']?.toString(),
      signatureData: j['signatureData']?.toString(),
      gameSignatures: sigs,
      refereeNote: j['refereeNote']?.toString(),
      caStatus: j['caStatus']?.toString() ?? '',
    );
  }
}

class Tournament {
  final String id;
  final String name;
  final List<String> referees;
  final List<TournamentMatch> matches;
  final List<String> courts;
  final Map<String, String> categoryNames;
  final Map<String, int> categoryGamesPerMatch;

  Tournament({
    required this.id,
    required this.name,
    required this.referees,
    this.matches = const [],
    this.courts = const [],
    this.categoryNames = const {},
    this.categoryGamesPerMatch = const {},
  });

  factory Tournament.fromJson(Map<String, dynamic> j) {
    final matches = <TournamentMatch>[];
    final courts = <String>{};
    final categoryNames = <String, String>{};
    final categoryGPM = <String, int>{};
    final idToDisplay = <String, String>{};

    // 0. Parse Court Assignments (Schedules.jsx source of truth)
    final scheduleMap = <String, Map<String, dynamic>>{};
    
    void parseCA(Map<String, dynamic> ca, String? dateOverride) {
      final assignments = ca['assignments'] as List?;
      final timeSlots = ca['timeSlots'] as List?;
      final courtCount = int.tryParse(ca['courtCount']?.toString() ?? '');

      if (courtCount != null && courtCount > 0) {
        for (int i = 1; i <= courtCount; i++) {
          courts.add('Court $i');
        }
      } else if (assignments != null && assignments.isNotEmpty) {
         // Fallback: derive from column count
         final row = assignments[0] as List?;
         if (row != null) {
            for (int i = 1; i <= row.length; i++) {
               courts.add('Court $i');
            }
         }
      }
      
      if (assignments != null && timeSlots != null) {
        for (int r = 0; r < assignments.length; r++) {
          if (r >= timeSlots.length) break;
          final row = assignments[r] as List?;
          if (row == null) continue;
          
          final ts = timeSlots[r];
          final time = (ts is Map) ? ts['startTime']?.toString() : null;
          
          for (int c = 0; c < row.length; c++) {
            final cell = row[c];
            if (cell is Map) {
              final id = cell['id']?.toString();
              if (id != null) {
                scheduleMap[id] = {
                  'court': 'Court ${c + 1}',
                  'time': time ?? '',
                  'date': dateOverride ?? ca['scheduleDate']?.toString() ?? '',
                  'status': cell['status']?.toString() ?? '',
                };
              }
            }
          }
        }
      }
    }

    if (j['courtAssignments'] is Map<String, dynamic>) {
      parseCA(j['courtAssignments'], null);
    }
    if (j['courtAssignmentsByDate'] is Map<String, dynamic>) {
      j['courtAssignmentsByDate'].forEach((k, v) {
        if (v is Map<String, dynamic>) parseCA(v, k);
      });
    }

    // 1. Build ID to Name map from registrations
    try {
      final regs = j['registrations'] as List?;
      if (regs != null) {
        for (var r in regs) {
          if (r is Map<String, dynamic>) {
             // Check status
             final status = r['status']?.toString().toLowerCase() ?? '';
             if (status != 'approved') continue;

             String getName(Map<String, dynamic>? p) {
               if (p == null) return '';
               final fn = p['firstName']?.toString() ?? '';
               final ln = p['lastName']?.toString() ?? '';
               final name = p['name']?.toString() ?? '';
               if (fn.isNotEmpty || ln.isNotEmpty) {
                 return '$fn $ln'.trim();
               }
               return name;
             }

             // Player / Primary Player
             final p = r['player'] ?? r['primaryPlayer'];
             if (p is Map<String, dynamic>) {
               final id = p['_id']?.toString() ?? p['id']?.toString();
               if (id != null) idToDisplay[id] = getName(p);
             } else if (p is String) {
               final nm = r['playerName']?.toString().trim();
               if (nm != null && nm.isNotEmpty) idToDisplay[p] = nm;
             }

             // Partner
             final partner = r['partner'];
             if (partner is Map<String, dynamic>) {
               final id = partner['_id']?.toString() ?? partner['id']?.toString();
               if (id != null) idToDisplay[id] = getName(partner);
             } else if (partner is String) {
               final nm = r['partnerName']?.toString().trim();
               if (nm != null && nm.isNotEmpty) idToDisplay[partner] = nm;
             }
             
             // Team Members
             final teamName = r['teamName']?.toString();
             final members = r['teamMembers'] as List?;
             if (teamName != null && members != null) {
               for (var m in members) {
                  String? mid;
                  if (m is Map) mid = m['_id']?.toString() ?? m['id']?.toString();
                  if (m is String) mid = m;
                  if (mid != null) idToDisplay[mid] = teamName;
               }
             }
          }
        }
      }
    } catch (e) {
      debugPrint('Error parsing registrations: $e');
    }

    // Helper to resolve name from string ID or name
    String resolveName(dynamic val) {
      if (val == null) return 'TBD';
      String s = val.toString();
      // If it's an ID (simple check: 24 hex chars), try to map it
      if (s.length == 24 && idToDisplay.containsKey(s)) {
        return idToDisplay[s]!;
      }
      // If the name itself is in the map (unlikely but possible)
      if (idToDisplay.containsKey(s)) {
        return idToDisplay[s]!;
      }
      return s;
    }

    // Helper to extract name from object or string
    String extract(dynamic p) {
      if (p is Map) {
        final fn = p['firstName']?.toString() ?? '';
        final ln = p['lastName']?.toString() ?? '';
        final n = p['name']?.toString() ?? '';
        if (fn.isNotEmpty || ln.isNotEmpty) return '$fn $ln'.trim();
        return n;
      }
      return resolveName(p);
    }

    void parseMatches(List<dynamic> list, String type, String catId, {String groupId = ''}) {
      for (var m in list) {
        if (m is Map<String, dynamic>) {
          m['type'] = type;
          m['categoryId'] = catId;
          if (groupId.isNotEmpty) {
            m['groupId'] = groupId;
          }
          dynamic p1 = m['player1'];
          dynamic p2 = m['player2'];

          m['player1'] = extract(p1);
          m['player2'] = extract(p2);

          final match = TournamentMatch.fromJson(m);
          matches.add(match);
          if (match.court.isNotEmpty) {
            courts.add(match.court);
          }
        }
      }
    }

    // Helper to get approved players for a category (fallback for missing originalPlayers)
    List<String> getApprovedPlayers(String catId, String catDiv) {
      final regs = j['registrations'] as List?;
      final approved = <String>[];
      if (regs != null) {
        for (var r in regs) {
          if (r is Map<String, dynamic>) {
            final status = r['status']?.toString().toLowerCase() ?? '';
            if (status != 'approved') continue;
            
            final rCatId = r['categoryId']?.toString();
            final rCat = r['category'];
            String? rCatStr;
            if (rCat is String) rCatStr = rCat;
            if (rCat is Map) rCatStr = rCat['_id']?.toString() ?? rCat['division']?.toString();
            
            // Match logic
            bool match = false;
            if (rCatId != null && rCatId == catId) match = true;
            if (!match && rCatStr != null && (rCatStr == catId || rCatStr == catDiv)) match = true;
            
            if (match) {
               // Construct name
               String name = '';
               final tName = r['teamName']?.toString();
               if (tName != null && tName.isNotEmpty) {
                 name = tName;
               } else {
                 final p1 = r['player'] ?? r['primaryPlayer'];
                 final p2 = r['partner'];
                 
                 String n1 = extract(p1);
                 
                 if (p2 != null) {
                   String n2 = extract(p2);
                   // Clean up TBDs
                   if (n1 == 'TBD') n1 = '';
                   if (n2 == 'TBD') n2 = '';
                   
                   if (n1.isNotEmpty && n2.isNotEmpty) {
                     name = '$n1 / $n2';
                   } else if (n1.isNotEmpty) name = n1;
                   else if (n2.isNotEmpty) name = n2;
                 } else {
                   name = n1;
                 }
               }
               if (name.isNotEmpty && name != 'TBD') {
                 approved.add(name);
               }
            }
          }
        }
      }
      return approved;
    }

    // Parse categories
    final categories = j['tournamentCategories'] as List?;
    if (categories != null) {
      for (var c in categories) {
        final catId = c['_id']?.toString() ?? '';
        
        // Construct category name
        final division = c['division']?.toString() ?? '';
        final age = c['ageCategory']?.toString() ?? '';
        final skill = c['skillLevel']?.toString() ?? '';
        final catName = [division, age, skill].where((s) => s.isNotEmpty).join(' ');
        if (catId.isNotEmpty) {
          categoryNames[catId] = catName;
          final gpm = int.tryParse(c['gamesPerMatch']?.toString() ?? '') ?? 1;
          categoryGPM[catId] = gpm.clamp(1, 3);
        }

        // Group Stage
        final groupStage = c['groupStage'] as Map<String, dynamic>?;
        if (groupStage != null) {
          final groups = groupStage['groups'] as List?;
          if (groups != null) {
            for (var g in groups) {
              final groupMatches = g['matches'];
              if (groupMatches is Map) {
                groupMatches.forEach((k, v) {
                  if (v is Map<String, dynamic>) {
                    final groupId = g['id']?.toString() ?? '';
                    // Clear any stale schedule only for not-completed items; completed should preserve their court/time
                    bool _shouldClear(Map<String, dynamic> x) {
                      final status = x['status']?.toString().toLowerCase() ?? '';
                      final hasWinner = (x['winner']?.toString().trim().isNotEmpty ?? false);
                      return status != 'completed' && !hasWinner;
                    }
                    if (_shouldClear(v)) {
                      v['court'] = '';
                      v['time'] = '';
                      v['date'] = '';
                      v['mdTime2'] = '';
                      v['mdEnd2'] = '';
                      v['mdTime3'] = '';
                      v['mdEnd3'] = '';
                    }
                    v['matchKey'] = k;
                    v['groupId'] = groupId;
                    final sId = 'rr-$catId-$groupId-$k';
                    if (scheduleMap.containsKey(sId)) {
                      final info = scheduleMap[sId]!;
                      v['court'] = info['court'];
                      v['time'] = info['time'];
                      v['date'] = info['date'];
                      v['caStatus'] = info['status'];
                    }
                    var originalPlayers = g['originalPlayers'] as List?;
                    if (originalPlayers == null || originalPlayers.isEmpty) {
                      final fallback = getApprovedPlayers(catId, division);
                      if (fallback.isNotEmpty) {
                        originalPlayers = fallback;
                      }
                    }
                    if (originalPlayers != null && k is String && k.contains('-')) {
                      final parts = k.split('-');
                      if (parts.length == 2) {
                        final i = int.tryParse(parts[0]);
                        final off = int.tryParse(parts[1]);
                        if (i != null && off != null) {
                          final idx1 = i;
                          final idx2 = i + 1 + off;
                          if (idx1 < originalPlayers.length && idx2 < originalPlayers.length) {
                            dynamic op1 = originalPlayers[idx1];
                            dynamic op2 = originalPlayers[idx2];
                            if (v['player1'] == null || v['player1'] == 'TBD') {
                              v['player1'] = extract(op1);
                            }
                            if (v['player2'] == null || v['player2'] == 'TBD') {
                              v['player2'] = extract(op2);
                            }
                            String gName = g['name']?.toString() ?? 'A';
                            String letter = gName.trim().split(' ').last;
                            if (letter.isEmpty) letter = 'A';
                            v['seedLabel'] = '$letter${idx1 + 1} vs $letter${idx2 + 1}';
                            v['matchLabel'] = 'G$letter${idx1 + 1}.${idx2 + 1}';
                          }
                        }
                      }
                    }
                    parseMatches([v], 'group', catId, groupId: groupId);
                  }
                });
              } else if (groupMatches is List) {
                 for (int i=0; i<groupMatches.length; i++) {
                   var m = groupMatches[i];
                   if (m is Map<String, dynamic>) {
                     final mk = m['matchKey']?.toString();
                     if (mk != null) {
                        final groupId = g['id']?.toString() ?? '';
                        // Clear any stale schedule only for not-completed items
                        bool _shouldClear(Map<String, dynamic> x) {
                          final status = x['status']?.toString().toLowerCase() ?? '';
                          final hasWinner = (x['winner']?.toString().trim().isNotEmpty ?? false);
                          return status != 'completed' && !hasWinner;
                        }
                        if (_shouldClear(m)) {
                          m['court'] = '';
                          m['time'] = '';
                          m['date'] = '';
                          m['mdTime2'] = '';
                          m['mdEnd2'] = '';
                          m['mdTime3'] = '';
                          m['mdEnd3'] = '';
                        }
                        final sId = 'rr-$catId-$groupId-$mk';
                        if (scheduleMap.containsKey(sId)) {
                          final info = scheduleMap[sId]!;
                          m['court'] = info['court'];
                          m['time'] = info['time'];
                          m['date'] = info['date'];
                          m['caStatus'] = info['status'];
                        }
                        m['groupId'] = groupId;
                     }
                   }
                 }
                 parseMatches(groupMatches, 'group', catId);
              }
            }
          }
        }

        // Elimination Matches
        final elim = c['eliminationMatches'] as Map<String, dynamic>?;
        if (elim != null) {
          final elimMatches = elim['matches'] as List?;
          if (elimMatches != null) {
            // Apply schedule overrides and labels
            for (int i = 0; i < elimMatches.length; i++) {
              var m = elimMatches[i];
              if (m is Map<String, dynamic>) {
                final mId = m['id']?.toString();
                // Try multiple key forms used by web scheduler
              // Clear any stale schedule only for not-completed items
              bool _shouldClear(Map<String, dynamic> x) {
                final status = x['status']?.toString().toLowerCase() ?? '';
                final hasWinner = (x['winner']?.toString().trim().isNotEmpty ?? false);
                return status != 'completed' && !hasWinner;
              }
              if (_shouldClear(m)) {
                m['court'] = '';
                m['time'] = '';
                m['date'] = '';
                m['mdTime2'] = '';
                m['mdEnd2'] = '';
                m['mdTime3'] = '';
                m['mdEnd3'] = '';
              }
                final candidates = <String>[
                  if (mId != null && mId.isNotEmpty) 'elim-$catId-$mId',
                  if (mId != null && mId.isNotEmpty) 'elimgen-$catId-$mId',
                  'elim-$catId-$i',
                  'elimgen-$catId-$i',
                ];
                for (final k in candidates) {
                  if (scheduleMap.containsKey(k)) {
                    final info = scheduleMap[k]!;
                    m['court'] = info['court'];
                    m['time'] = info['time'];
                    m['date'] = info['date'];
                    m['caStatus'] = info['status'];
                    break;
                  }
                }
                // Provide a match label for elimination rounds
                final title = m['title']?.toString();
                final round = m['round']?.toString();
                if (m['matchLabel'] == null || (m['matchLabel'] as String?)?.isEmpty == true) {
                  if (title != null && title.isNotEmpty) {
                    m['matchLabel'] = title;
                  } else if (round != null && round.isNotEmpty) {
                    m['matchLabel'] = round;
                  } else {
                    m['matchLabel'] = 'Elimination';
                  }
                }
              }
            }
            parseMatches(elimMatches, 'elimination', catId);
          }
        }
      }
    }

    return Tournament(
      id: j['_id']?.toString() ?? j['id']?.toString() ?? '',
      name: j['tournamentName']?.toString() ?? j['name']?.toString() ?? 'Unnamed Tournament',
      referees: (j['referees'] as List?)?.map((e) {
        if (e is Map) {
          return e['_id']?.toString() ?? e['id']?.toString() ?? '';
        }
        return e.toString();
      }).toList() ?? [],
      matches: matches,
      courts: courts.toList()..sort(),
      categoryNames: categoryNames,
      categoryGamesPerMatch: categoryGPM,
    );
  }
}

class Court {
  final String id;
  final String label;
  Court({required this.id, required this.label});
  
  // Keep for compatibility if needed, but we might just use String for court names
  factory Court.fromJson(Map<String, dynamic> j) {
    return Court(
      id: j['_id']?.toString() ?? j['id']?.toString() ?? '',
      label: j['label']?.toString() ?? j['name']?.toString() ?? '',
    );
  }
}
