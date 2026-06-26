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
  final String documentId;
  final bool scheduleFromAssignments;
  final String player1;
  final String player2;
  final String player1Name;
  final String player2Name;
  final int score1;
  final int score2;
  final String game1Status;
  final String game2Status;
  final String game3Status;
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
  final String scoringFormat;
  final String game1Team1Player;
  final String game1Team1Player2;
  final String game1Team2Player;
  final String game1Team2Player2;
  final String game2Team1Player;
  final String game2Team1Player2;
  final String game2Team2Player;
  final String game2Team2Player2;
  final String game3Team1Player;
  final String game3Team1Player2;
  final String game3Team2Player;
  final String game3Team2Player2;

  TournamentMatch({
    required this.id,
    this.documentId = '',
    this.scheduleFromAssignments = false,
    required this.player1,
    required this.player2,
    this.player1Name = '',
    this.player2Name = '',
    required this.score1,
    required this.score2,
    this.game1Status = '',
    this.game2Status = '',
    this.game3Status = '',
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
    this.scoringFormat = 'sideout',
    this.game1Team1Player = '',
    this.game1Team1Player2 = '',
    this.game1Team2Player = '',
    this.game1Team2Player2 = '',
    this.game2Team1Player = '',
    this.game2Team1Player2 = '',
    this.game2Team2Player = '',
    this.game2Team2Player2 = '',
    this.game3Team1Player = '',
    this.game3Team1Player2 = '',
    this.game3Team2Player = '',
    this.game3Team2Player2 = '',
  });

  static String normalizeScoringFormat(String? raw) {
    final normalized = raw
            ?.trim()
            .toLowerCase()
            .replaceAll(RegExp(r'[\s_-]+'), '') ??
        '';
    if (normalized == 'rally') return 'rally';
    if (normalized == 'sideout') return 'sideout';
    return 'sideout';
  }

  bool get isRallyScoring => normalizeScoringFormat(scoringFormat) == 'rally';

  bool get isSideOutScoring => !isRallyScoring;

  String get scoringFormatBadgeLabel =>
      isRallyScoring ? 'Scoring Format: Rally' : 'Scoring Format: Side-Out';

  factory TournamentMatch.fromJson(Map<String, dynamic> j) {
    String normalizeCourt(String s) {
      final m = RegExp(r'^\s*(?:Court\s*)?(\d+)\s*$').firstMatch(s);
      if (m != null) {
        return 'Court ${m.group(1)}';
      }
      return s;
    }
    String pickFirstNonEmpty(List<dynamic> values) {
      for (final v in values) {
        final s = (v?.toString() ?? '').trim();
        if (s.isNotEmpty) return s;
      }
      return '';
    }
    String normalizeStatus(String raw) {
      final v = raw.trim();
      if (v.isEmpty) return '';
      final low = v.toLowerCase();
      if (low == 'unschedule' || low == 'unscheduled') return 'Unscheduled';
      if (low == 'scheduled') return 'Scheduled';
      if (low == 'ongoing') return 'Ongoing';
      if (low == 'completed') return 'Completed';
      if (low == 'called') return 'Called';
      return v;
    }

    final resolvedDate = pickFirstNonEmpty([
      j['date'],
      j['mdDate'],
      j['wdDate'],
      j['xdDate'],
    ]);
    final resolvedTime = pickFirstNonEmpty([
      j['time'],
      j['mdTime'],
      j['wdTime'],
      j['xdTime'],
    ]);
    final resolvedCourt = pickFirstNonEmpty([
      j['court'],
      j['mdCourt'],
      j['wdCourt'],
      j['xdCourt'],
    ]);
    final resolvedVenue = pickFirstNonEmpty([
      j['venue'],
      j['mdVenue'],
      j['wdVenue'],
      j['xdVenue'],
    ]);
    final scheduleFromAssignments = j['_scheduleFromAssignments'] == true;

    final explicitStatus = j['status']?.toString();
    final hasWinner = j['winner'] != null && j['winner'].toString().trim().isNotEmpty;
    final hasSchedule =
        resolvedTime.isNotEmpty && resolvedCourt.isNotEmpty && resolvedDate.isNotEmpty;
    final derivedStatus = hasWinner
        ? 'Completed'
        : (hasSchedule ? 'Scheduled' : 'Unscheduled');
    final normalizedExplicit = normalizeStatus(explicitStatus ?? '');
    final resolvedStatus =
        normalizedExplicit.isNotEmpty ? normalizedExplicit : derivedStatus;

    final normalizedGame1Status = normalizeStatus(j['game1Status']?.toString() ?? '');
    final normalizedGame2Status = normalizeStatus(j['game2Status']?.toString() ?? '');
    final normalizedGame3Status = normalizeStatus(j['game3Status']?.toString() ?? '');
    List<String?>? sigs;
    final gs = j['gameSignatures'];
    if (gs is List) {
      sigs = gs.map((e) => e?.toString()).toList();
    }
    return TournamentMatch(
      id: j['id']?.toString() ?? j['matchId']?.toString() ?? j['matchKey']?.toString() ?? j['_id']?.toString() ?? '',
      documentId: j['_id']?.toString() ?? '',
      scheduleFromAssignments: scheduleFromAssignments,
      player1: j['player1']?.toString() ?? 'TBD',
      player2: j['player2']?.toString() ?? 'TBD',
      player1Name: j['player1Name']?.toString() ?? '',
      player2Name: j['player2Name']?.toString() ?? '',
      score1: int.tryParse(j['score1']?.toString() ?? '0') ?? 0,
      score2: int.tryParse(j['score2']?.toString() ?? '0') ?? 0,
      game1Status: normalizedGame1Status,
      game2Status: normalizedGame2Status,
      game3Status: normalizedGame3Status,
      game1Player1: int.tryParse(j['game1Player1']?.toString() ?? ''),
      game1Player2: int.tryParse(j['game1Player2']?.toString() ?? ''),
      game2Player1: int.tryParse(j['game2Player1']?.toString() ?? ''),
      game2Player2: int.tryParse(j['game2Player2']?.toString() ?? ''),
      game3Player1: int.tryParse(j['game3Player1']?.toString() ?? ''),
      game3Player2: int.tryParse(j['game3Player2']?.toString() ?? ''),
      round: j['round']?.toString() ?? '',
      court: normalizeCourt(resolvedCourt),
      date: resolvedDate,
      time: resolvedTime,
      venue: resolvedVenue.isNotEmpty ? resolvedVenue : null,
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
      scoringFormat: normalizeScoringFormat(
        j['scoringFormat']?.toString() ?? j['scoringType']?.toString(),
      ),
      game1Team1Player: j['game1Team1Player']?.toString() ?? '',
      game1Team1Player2: j['game1Team1Player2']?.toString() ?? '',
      game1Team2Player: j['game1Team2Player']?.toString() ?? '',
      game1Team2Player2: j['game1Team2Player2']?.toString() ?? '',
      game2Team1Player: j['game2Team1Player']?.toString() ?? '',
      game2Team1Player2: j['game2Team1Player2']?.toString() ?? '',
      game2Team2Player: j['game2Team2Player']?.toString() ?? '',
      game2Team2Player2: j['game2Team2Player2']?.toString() ?? '',
      game3Team1Player: j['game3Team1Player']?.toString() ?? '',
      game3Team1Player2: j['game3Team1Player2']?.toString() ?? '',
      game3Team2Player: j['game3Team2Player']?.toString() ?? '',
      game3Team2Player2: j['game3Team2Player2']?.toString() ?? '',
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
  final Map<String, String> categoryScoringTypes;
  final Map<String, String> categoryDivisions;
  final bool hasAuthoritativeSchedule;
  final String? preferredScheduleDate;
  final Map<String, List<TeamRegistration>> categoryTeamRegistrations;
  final Map<String, List<String>> teamRosterBySlot;
  final Map<String, List<TeamMemberInfo>> teamRosterMembersBySlot;
  final Map<String, List<String>> teamRosterSourceCategories;

  Tournament({
    required this.id,
    required this.name,
    required this.referees,
    this.matches = const [],
    this.courts = const [],
    this.categoryNames = const {},
    this.categoryGamesPerMatch = const {},
    this.categoryScoringTypes = const {},
    this.categoryDivisions = const {},
    this.hasAuthoritativeSchedule = false,
    this.preferredScheduleDate,
    this.categoryTeamRegistrations = const {},
    this.teamRosterBySlot = const {},
    this.teamRosterMembersBySlot = const {},
    this.teamRosterSourceCategories = const {},
  });

  factory Tournament.fromJson(Map<String, dynamic> j) {
    final matches = <TournamentMatch>[];
    final courts = <String>{};
    final categoryNames = <String, String>{};
    final categoryGPM = <String, int>{};
    final categoryScoringTypes = <String, String>{};
    final categoryDivisions = <String, String>{};
    final idToDisplay = <String, String>{};
    final categoryTeamRegistrations = <String, List<TeamRegistration>>{};
    final teamRosterBySlot = <String, List<String>>{};
    final teamRosterMembersBySlot = <String, List<TeamMemberInfo>>{};
    final teamRosterSourceCategories = <String, List<String>>{};
    final hasRootCourtAssignments = j['courtAssignments'] is Map<String, dynamic>;
    final hasCourtAssignmentsByDate = j['courtAssignmentsByDate'] is Map<String, dynamic>;
    final hasAuthoritativeSchedule = hasRootCourtAssignments || hasCourtAssignmentsByDate;
    final preferredScheduleDate =
        (j['courtAssignments'] is Map<String, dynamic>)
            ? (j['courtAssignments']['scheduleDate']?.toString())
            : null;

    // 0. Parse Court Assignments (Schedules.jsx source of truth)
    final scheduleMap = <String, Map<String, dynamic>>{};
    
    void mergeScheduleCell({
      required String id,
      required String date,
      required String time,
      String? endTime,
      required String court,
      String? venue,
    }) {
      final baseId = id.replaceFirst(RegExp(r'-g(\d+)$'), '');
      final gameMatch = RegExp(r'-g(\d+)$').firstMatch(id);
      final gameIndex = int.tryParse(gameMatch?.group(1) ?? '') ?? 1;
      final existing = scheduleMap[baseId] ?? <String, dynamic>{};
      existing['date'] = (existing['date']?.toString().isNotEmpty ?? false) ? existing['date'] : date;
      existing['court'] = (existing['court']?.toString().isNotEmpty ?? false) ? existing['court'] : court;
      existing['venue'] = (existing['venue']?.toString().isNotEmpty ?? false) ? existing['venue'] : (venue ?? '');
      if (gameIndex <= 1) {
        existing['time'] = time;
      } else if (gameIndex == 2) {
        existing['mdTime2'] = time;
        existing['mdEnd2'] = endTime ?? '';
      } else if (gameIndex == 3) {
        existing['mdTime3'] = time;
        existing['mdEnd3'] = endTime ?? '';
      }
      scheduleMap[baseId] = existing;
    }

    void parseScheduleVenue(Map<String, dynamic> source, String resolvedDate, {String? venueName}) {
      final assignments = source['assignments'] as List?;
      final timeSlots = source['timeSlots'] as List?;
      final courtCount = int.tryParse(source['courtCount']?.toString() ?? '');

      String normalizeBracketCode(String raw) {
        final text = raw.trim();
        if (text.isEmpty) return '';
        final m = RegExp(r'([A-D])', caseSensitive: false).allMatches(text).toList();
        if (m.isNotEmpty) {
          return (m.last.group(1) ?? '').toLowerCase();
        }
        final compact = text.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '');
        final m2 = RegExp(r'([a-d])').allMatches(compact).toList();
        if (m2.isNotEmpty) {
          return (m2.last.group(1) ?? '').toLowerCase();
        }
        return '';
      }

      if (courtCount != null && courtCount > 0) {
        for (int i = 1; i <= courtCount; i++) {
          courts.add('Court $i');
        }
      } else if (assignments != null && assignments.isNotEmpty) {
        final row = assignments[0] as List?;
        if (row != null) {
          for (int i = 1; i <= row.length; i++) {
            courts.add('Court $i');
          }
        }
      }

      if (assignments == null || timeSlots == null) return;

      for (int r = 0; r < assignments.length; r++) {
        if (r >= timeSlots.length) break;
        final row = assignments[r] as List?;
        if (row == null) continue;

        final ts = timeSlots[r];
        final startTime = (ts is Map) ? ts['startTime']?.toString() ?? '' : '';
        final endTime = (ts is Map) ? ts['endTime']?.toString() ?? '' : '';

        for (int c = 0; c < row.length; c++) {
          final cell = row[c];
          if (cell is Map) {
            final id = cell['id']?.toString();
            if (id == null || id.isEmpty) continue;
            final suffixMatch = RegExp(r'(-g\d+)$', caseSensitive: false).firstMatch(id);
            final gameSuffix = suffixMatch?.group(1) ?? '';
            final catId = cell['categoryId']?.toString().trim() ?? '';
            final bracketRaw = cell['bracket']?.toString().trim() ?? '';
            final matchKey = (cell['matchKey'] ?? cell['key'])?.toString().trim() ?? '';
            final bracketCode = normalizeBracketCode(bracketRaw);

            String? scheduleKey;
            if (catId.isNotEmpty && matchKey.isNotEmpty && bracketCode.isNotEmpty) {
              final groupId = 'group-$bracketCode';
              scheduleKey = 'rr-$catId-$groupId-$matchKey$gameSuffix';
            }
            mergeScheduleCell(
              id: scheduleKey ?? id,
              date: resolvedDate,
              time: startTime,
              endTime: endTime,
              court: 'Court ${c + 1}',
              venue: venueName,
            );
          }
        }
      }
    }

    void parseCA(Map<String, dynamic> ca, String? dateOverride) {
      final resolvedDate = dateOverride ?? ca['scheduleDate']?.toString() ?? '';
      final venues = ca['venues'] as List?;
      if (venues != null && venues.isNotEmpty) {
        for (final venue in venues) {
          if (venue is Map<String, dynamic>) {
            parseScheduleVenue(
              venue,
              resolvedDate,
              venueName: venue['name']?.toString(),
            );
          }
        }
      }

      parseScheduleVenue(
        ca,
        resolvedDate,
        venueName: ca['venue']?.toString(),
      );
    }

    if (j['courtAssignments'] is Map<String, dynamic>) {
      parseCA(j['courtAssignments'], null);
    }
    if (j['courtAssignmentsByDate'] is Map<String, dynamic>) {
      j['courtAssignmentsByDate'].forEach((k, v) {
        if (v is Map<String, dynamic>) parseCA(v, k);
      });
    }

    // Helper functions (declared first)
    String _normalizeBracketCode(String raw) {
      final text = raw.trim();
      if (text.isEmpty) return '';
      final m = RegExp(r'([A-D])', caseSensitive: false).allMatches(text).toList();
      if (m.isNotEmpty) {
        return (m.last.group(1) ?? '').toLowerCase();
      }
      final compact = text.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), '');
      final m2 = RegExp(r'([a-d])').allMatches(compact).toList();
      if (m2.isNotEmpty) {
        return (m2.last.group(1) ?? '').toLowerCase();
      }
      return '';
    }

    String _normalizeGroupId(String raw, String groupName) {
      final trimmed = raw.trim();
      if (trimmed.isEmpty) {
        final code = _normalizeBracketCode(groupName);
        return code.isNotEmpty ? 'group-$code' : '';
      }
      final low = trimmed.toLowerCase();
      if (low.startsWith('group-')) return low;
      final codeFromRaw = _normalizeBracketCode(trimmed);
      if (codeFromRaw.isNotEmpty) return 'group-$codeFromRaw';
      final codeFromName = _normalizeBracketCode(groupName);
      if (codeFromName.isNotEmpty) return 'group-$codeFromName';
      return trimmed;
    }

    String getName(dynamic p) {
      if (p == null) return '';
      if (p is Map<String, dynamic>) {
        final fn = p['firstName']?.toString() ?? '';
        final ln = p['lastName']?.toString() ?? '';
        final name = p['name']?.toString() ?? '';
        if (fn.isNotEmpty || ln.isNotEmpty) {
          return '$fn $ln'.trim();
        }
        return name;
      }
      return '';
    }

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

    String extractGender(dynamic p) {
      if (p is Map) {
        final raw = p['gender']?.toString().trim() ?? '';
        if (raw.isEmpty) return '';
        final low = raw.toLowerCase();
        if (low.startsWith('m')) return 'Male';
        if (low.startsWith('f')) return 'Female';
        return raw;
      }
      return '';
    }
    
    String normalizeTeamKey(String key) {
      var normalized = key.replaceAll(RegExp(r'\s*/\s*'), ' / ');
      normalized = normalized.replaceAll(RegExp(r'\s+'), ' ').trim().toLowerCase();
      return normalized;
    }

    void addUniqueNormalized(List<String> target, String value) {
      final trimmed = value.trim();
      if (trimmed.isEmpty || trimmed.toLowerCase() == 'tbd') return;
      final normalized = normalizeTeamKey(trimmed);
      final exists = target.any((item) => normalizeTeamKey(item) == normalized);
      if (!exists) {
        target.add(trimmed);
      }
    }

    void addOrMergeTeamMember(
      List<TeamMemberInfo> target,
      TeamMemberInfo candidate,
    ) {
      final normalizedName = normalizeTeamKey(candidate.name);
      final index = target.indexWhere(
        (item) => normalizeTeamKey(item.name) == normalizedName,
      );
      if (index < 0) {
        target.add(candidate);
        return;
      }
      final existing = target[index];
      target[index] = TeamMemberInfo(
        name: existing.name,
        gender: existing.gender.isNotEmpty ? existing.gender : candidate.gender,
        isSub: existing.isSub || candidate.isSub,
      );
    }

    List<String> extractRosterFromRegistration(Map<String, dynamic> reg) {
      final roster = <String>[];
      final teamMembers = reg['teamMembers'] as List?;

      if (teamMembers != null && teamMembers.isNotEmpty) {
        for (final member in teamMembers) {
          addUniqueNormalized(roster, extract(member));
        }
      }

      if (roster.isEmpty) {
        addUniqueNormalized(roster, extract(reg['player'] ?? reg['primaryPlayer']));
        addUniqueNormalized(roster, extract(reg['partner']));
      }

      return roster;
    }

    List<TeamMemberInfo> extractRosterMembersFromRegistration(Map<String, dynamic> reg) {
      final members = <TeamMemberInfo>[];
      final teamMembers = reg['teamMembers'] as List?;

      if (teamMembers != null && teamMembers.isNotEmpty) {
        int maleCount = 0;
        int femaleCount = 0;
        for (int i = 0; i < teamMembers.length; i++) {
          final member = teamMembers[i];
          final name = extract(member).trim();
          if (name.isEmpty || name.toLowerCase() == 'tbd') continue;
          final gender = extractGender(member);
          bool isSub = false;
          if (gender == 'Male') {
            maleCount += 1;
            isSub = maleCount > 2;
          } else if (gender == 'Female') {
            femaleCount += 1;
            isSub = femaleCount > 2;
          }
          addOrMergeTeamMember(
            members,
            TeamMemberInfo(
              name: name,
              gender: gender,
              isSub: isSub,
            ),
          );
        }
      }

      if (members.isEmpty) {
        final primary = reg['player'] ?? reg['primaryPlayer'];
        final partner = reg['partner'];
        final primaryName = extract(primary).trim();
        final partnerName = extract(partner).trim();
        if (primaryName.isNotEmpty && primaryName.toLowerCase() != 'tbd') {
          addOrMergeTeamMember(
            members,
            TeamMemberInfo(
              name: primaryName,
              gender: extractGender(primary),
              isSub: false,
            ),
          );
        }
        if (partnerName.isNotEmpty && partnerName.toLowerCase() != 'tbd') {
          addOrMergeTeamMember(
            members,
            TeamMemberInfo(
              name: partnerName,
              gender: extractGender(partner),
              isSub: false,
            ),
          );
        }
      }

      return members;
    }

    List<String> buildRosterSlotKeys(Map<String, dynamic> reg, List<String> roster) {
      final keys = <String>[];

      void addKey(dynamic value) {
        final raw = value?.toString() ?? '';
        final trimmed = raw.trim();
        if (trimmed.isEmpty) return;
        final exists = keys.any((item) => normalizeTeamKey(item) == normalizeTeamKey(trimmed));
        if (!exists) {
          keys.add(trimmed);
        }
      }

      final player = reg['player'] ?? reg['primaryPlayer'];
      addKey(reg['teamName']);
      if (player is Map<String, dynamic>) {
        addKey(player['teamName']);
      }
      addKey(reg['playerName']);
      if (roster.length >= 2) {
        addKey('${roster[0]} / ${roster[1]}');
      }
      for (final member in roster) {
        addKey(member);
      }

      return keys;
    }

    // 1. Build ID to Name map from registrations and category team registrations
    try {
      final regs = j['registrations'] as List?;
      if (regs != null) {
        for (var r in regs) {
          if (r is Map<String, dynamic>) {
            final status = r['status']?.toString().toLowerCase() ?? '';
            if (status != 'approved') continue;

            final p = r['player'] ?? r['primaryPlayer'];
            if (p is Map<String, dynamic>) {
              final id = p['_id']?.toString() ?? p['id']?.toString();
              if (id != null) idToDisplay[id] = getName(p);
            } else if (p is String) {
              final nm = r['playerName']?.toString().trim();
              if (nm != null && nm.isNotEmpty) idToDisplay[p] = nm;
            }

            final partner = r['partner'];
            if (partner is Map<String, dynamic>) {
              final id = partner['_id']?.toString() ?? partner['id']?.toString();
              if (id != null) idToDisplay[id] = getName(partner);
            } else if (partner is String) {
              final nm = r['partnerName']?.toString().trim();
              if (nm != null && nm.isNotEmpty) idToDisplay[partner] = nm;
            }

            final teamMembers = r['teamMembers'] as List?;
            if (teamMembers != null) {
              for (final member in teamMembers) {
                if (member is Map<String, dynamic>) {
                  final id = member['_id']?.toString() ?? member['id']?.toString();
                  final name = getName(member);
                  if (id != null && name.isNotEmpty) {
                    idToDisplay[id] = name;
                  }
                }
              }
            }

            final rosterMembers = extractRosterMembersFromRegistration(r);
            final roster = rosterMembers.map((member) => member.name).toList();
            if (roster.isEmpty) continue;

            final regCategory = r['categoryId']?.toString() ?? r['category']?.toString() ?? '';
            if (regCategory.isNotEmpty) {
              categoryTeamRegistrations.putIfAbsent(regCategory, () => []);
            }

            final slotKeys = buildRosterSlotKeys(r, roster);
            if (slotKeys.isEmpty) continue;

            if (regCategory.isNotEmpty) {
              for (final slot in slotKeys) {
                final existingIndex = categoryTeamRegistrations[regCategory]!.indexWhere(
                  (entry) => normalizeTeamKey(entry.teamName) == normalizeTeamKey(slot),
                );
                if (existingIndex >= 0) {
                  for (final member in roster) {
                    addUniqueNormalized(
                      categoryTeamRegistrations[regCategory]![existingIndex].members,
                      member,
                    );
                  }
                } else {
                  categoryTeamRegistrations[regCategory]!.add(
                    TeamRegistration(
                      teamName: slot,
                      members: List<String>.from(roster),
                    ),
                  );
                }
              }
            }

            for (final slot in slotKeys) {
              final normalizedKey = normalizeTeamKey(slot);
              final bucket = teamRosterBySlot.putIfAbsent(normalizedKey, () => []);
              for (final member in roster) {
                addUniqueNormalized(bucket, member);
              }
              final memberBucket = teamRosterMembersBySlot.putIfAbsent(
                normalizedKey,
                () => [],
              );
              for (final member in rosterMembers) {
                addOrMergeTeamMember(memberBucket, member);
              }
              final sourceCategories = teamRosterSourceCategories.putIfAbsent(
                normalizedKey,
                () => [],
              );
              if (regCategory.isNotEmpty && !sourceCategories.contains(regCategory)) {
                sourceCategories.add(regCategory);
              }
            }
          }
        }
      }
    } catch (e) {
      debugPrint('Error parsing registrations: $e');
    }

    void clearScheduleFields(Map<String, dynamic> m) {
      m['court'] = '';
      m['time'] = '';
      m['date'] = '';
      m['venue'] = '';
      m['mdTime2'] = '';
      m['mdEnd2'] = '';
      m['mdTime3'] = '';
      m['mdEnd3'] = '';
      m['_scheduleFromAssignments'] = false;
      final status = m['status']?.toString().trim().toLowerCase();
      if (status == 'scheduled' || status == 'called' || status == 'unschedule' || status == 'unscheduled') {
        m['status'] = 'Unscheduled';
      }
    }

    void applyScheduleInfo(Map<String, dynamic> m, Map<String, dynamic> info) {
      m['court'] = info['court'] ?? '';
      m['time'] = info['time'] ?? '';
      m['date'] = info['date'] ?? '';
      m['venue'] = info['venue'] ?? m['venue'];
      m['mdTime2'] = info['mdTime2'] ?? m['mdTime2'];
      m['mdEnd2'] = info['mdEnd2'] ?? m['mdEnd2'];
      m['mdTime3'] = info['mdTime3'] ?? m['mdTime3'];
      m['mdEnd3'] = info['mdEnd3'] ?? m['mdEnd3'];
      m['_scheduleFromAssignments'] = true;
      final currentStatus = m['status']?.toString().trim().toLowerCase() ?? '';
      if ((m['time']?.toString().trim().isNotEmpty ?? false) &&
          (currentStatus.isEmpty ||
              currentStatus == 'scheduled' ||
              currentStatus == 'called' ||
              currentStatus == 'unschedule' ||
              currentStatus == 'unscheduled')) {
        m['status'] = 'Scheduled';
      }
    }

    void parseMatches(List<dynamic> list, String type, String catId, {String groupId = ''}) {
      for (var m in list) {
        if (m is Map<String, dynamic>) {
          m['type'] = type;
          m['categoryId'] = catId;
          m['scoringFormat'] = TournamentMatch.normalizeScoringFormat(
            m['scoringFormat']?.toString() ??
                m['scoringType']?.toString() ??
                categoryScoringTypes[catId],
          );
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
                  } else if (n1.isNotEmpty) {
                    name = n1;
                  } else if (n2.isNotEmpty) {
                    name = n2;
                  }
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
    if (kDebugMode) {
      debugPrint('Parsing tournament categories: count=${categories?.length ?? 0}');
    }
    if (categories != null) {
      for (int i=0; i<categories.length; i++) {
        var c = categories[i];
        final catId = c['_id']?.toString() ?? '';
        
        // Construct category name
        final division = c['division']?.toString() ?? '';
        final age = c['ageCategory']?.toString() ?? '';
        final skill = c['skillLevel']?.toString() ?? '';
        final catName = [division, age, skill].where((s) => s.isNotEmpty).join(' ');
        if (catId.isNotEmpty) {
          categoryNames[catId] = catName;
          categoryDivisions[catId] = division;
          final gpm = int.tryParse(c['gamesPerMatch']?.toString() ?? '') ?? 1;
          categoryGPM[catId] = gpm.clamp(1, 3);
          final scoringType = c['scoringType']?.toString().trim();
          if (scoringType != null && scoringType.isNotEmpty) {
            categoryScoringTypes[catId] = scoringType;
          }
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
                    final groupId = _normalizeGroupId(
                      g['id']?.toString() ?? '',
                      g['name']?.toString() ?? '',
                    );
                    v['matchKey'] = k;
                    v['groupId'] = groupId;
                    final sId = 'rr-$catId-$groupId-$k';
                    if (scheduleMap.containsKey(sId)) {
                      applyScheduleInfo(v, scheduleMap[sId]!);
                    } else if (hasAuthoritativeSchedule) {
                      clearScheduleFields(v);
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
                            v['player1Name'] = extract(op1);
                            v['player2Name'] = extract(op2);
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
                        final groupId = _normalizeGroupId(
                          g['id']?.toString() ?? '',
                          g['name']?.toString() ?? '',
                        );
                        final sId = 'rr-$catId-$groupId-$mk';
                        if (scheduleMap.containsKey(sId)) {
                          applyScheduleInfo(m, scheduleMap[sId]!);
                        } else if (hasAuthoritativeSchedule) {
                          clearScheduleFields(m);
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
                final candidates = <String>[
                  if (mId != null && mId.isNotEmpty) 'elim-$catId-$mId',
                  if (mId != null && mId.isNotEmpty) 'elimgen-$catId-$mId',
                  'elim-$catId-$i',
                  'elimgen-$catId-$i',
                ];
                bool matchedSchedule = false;
                for (final k in candidates) {
                  if (scheduleMap.containsKey(k)) {
                    applyScheduleInfo(m, scheduleMap[k]!);
                    matchedSchedule = true;
                    break;
                  }
                }
                if (!matchedSchedule && hasAuthoritativeSchedule) {
                  clearScheduleFields(m);
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
      categoryScoringTypes: categoryScoringTypes,
      categoryDivisions: categoryDivisions,
      hasAuthoritativeSchedule: hasAuthoritativeSchedule,
      preferredScheduleDate: preferredScheduleDate,
      categoryTeamRegistrations: categoryTeamRegistrations,
      teamRosterBySlot: teamRosterBySlot,
      teamRosterMembersBySlot: teamRosterMembersBySlot,
      teamRosterSourceCategories: teamRosterSourceCategories,
    );
  }
}

class TeamRegistration {
  final String teamName;
  final List<String> members;

  TeamRegistration({
    required this.teamName,
    required this.members,
  });
}

class TeamMemberInfo {
  final String name;
  final String gender;
  final bool isSub;

  TeamMemberInfo({
    required this.name,
    this.gender = '',
    this.isSub = false,
  });

  String get displayLabel {
    final parts = <String>[];
    if (gender.isNotEmpty) {
      parts.add(gender);
    }
    if (isSub) {
      parts.add('Sub');
    }
    if (parts.isEmpty) return name;
    return '$name (${parts.join(', ')})';
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
