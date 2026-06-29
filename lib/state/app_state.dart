import 'dart:convert';
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';
import '../models.dart';

class AppState extends ChangeNotifier {
  static const _storageTokenKey = 'referee_auth_token';
  static const _storageUserKey = 'referee_auth_user';
  static const _storageApiBaseUrlKey = 'referee_api_base_url';
  static const bool _useScheduledQueueEndpoint = false;

  final ApiService _api = ApiService();

  User? currentUser;
  String apiBaseUrl = '';
  List<Tournament> tournaments = [];
  List<String> courts = [];
  List<TournamentMatch> games = [];
  Tournament? selectedTournament;
  String? selectedCourt;
  String? selectedDate;
  TournamentMatch? selectedGame;
  String? _scheduledQueueEtag;
  int _submitSequenceCounter = 0;
  final Map<String, int> _latestStartedSubmitSeqByMatch = {};
  final Map<String, int> _inFlightSubmitSeqByMatch = {};
  bool loading = false;
  String? error;
  bool initialized = false;
  bool ongoingSyncing = false;
  Timer? _ongoingSyncTimer;
  Map<String, dynamic>? _pendingOngoingFields;
  String? _pendingOngoingMatchKey;

  // Offline outbox for match updates
  static const _storageOutboxKey = 'referee_outbox_v1';
  List<Map<String, dynamic>> _outbox = [];
  int get pendingSyncCount => _outbox.length;
  bool pendingForMatch(String categoryId, String groupId, String matchKey) {
    return _outbox.any((e) =>
        e['categoryId'] == categoryId &&
        e['groupId'] == groupId &&
        e['matchKey'] == matchKey);
  }

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    final savedBaseUrl = prefs.getString(_storageApiBaseUrlKey);
    if (savedBaseUrl != null && savedBaseUrl.trim().isNotEmpty) {
      _api.setBaseUrl(savedBaseUrl);
    }
    apiBaseUrl = _api.baseUrl;
    final token = prefs.getString(_storageTokenKey);
    final userJson = prefs.getString(_storageUserKey);
    await _loadOutbox();
    if (token != null && userJson != null) {
      try {
        final data = jsonDecode(userJson) as Map<String, dynamic>;
        _api.setToken(token);
        currentUser = User.fromJson(data);
        await loadTournaments();
      } catch (_) {
        currentUser = null;
      }
    }
    initialized = true;
    notifyListeners();
  }

  Future<void> setApiBaseUrl(String url) async {
    final prefs = await SharedPreferences.getInstance();
    final trimmed = url.trim();
    if (trimmed.isEmpty) {
      await prefs.remove(_storageApiBaseUrlKey);
      _api.setBaseUrl(null);
      apiBaseUrl = _api.baseUrl;
      notifyListeners();
      return;
    }
    final normalized = trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
    await prefs.setString(_storageApiBaseUrlKey, normalized);
    _api.setBaseUrl(normalized);
    apiBaseUrl = _api.baseUrl;
    notifyListeners();
  }

  Future<bool> signup({
    required String email,
    required String password,
    required String firstName,
    required String lastName,
    required String phoneNumber,
    required String country,
    required String city,
    required String birthDate,
    required String gender,
  }) async {
    loading = true;
    error = null;
    notifyListeners();
    final result = await _api.signup(
      email: email,
      password: password,
      firstName: firstName,
      lastName: lastName,
      phoneNumber: phoneNumber,
      country: country,
      city: city,
      birthDate: birthDate,
      gender: gender,
    );
    loading = false;
    error = result.error;
    notifyListeners();
    return result.ok;
  }

  Future<bool> login(String email, String password) async {
    loading = true;
    error = null;
    notifyListeners();
    final result = await _api.login(email, password);
    loading = false;
    error = result.error;
    if (result.user != null) {
      if (result.user!.isReferee) {
        currentUser = result.user;
        final prefs = await SharedPreferences.getInstance();
        if (result.token != null && result.token!.isNotEmpty) {
          await prefs.setString(_storageTokenKey, result.token!);
        }
        await prefs.setString(_storageUserKey, jsonEncode(result.user!.toJson()));
        notifyListeners();
        await loadTournaments();
        return true;
      } else {
        error = 'Invalid email or password';
        notifyListeners();
        return false;
      }
    } else {
      error = 'Invalid email or password';
      notifyListeners();
      return false;
    }
  }

  Future<void> loadTournaments() async {
    if (currentUser == null) return;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final allTournaments = await _api.getRefereeTournaments();
      tournaments = allTournaments.where((t) => t.referees.contains(currentUser!.id)).toList();
      // Opportunistic sync when loading
      await trySyncOutbox();
    } catch (e) {
      error = 'Failed to load tournaments: $e';
      tournaments = [];
    }
    loading = false;
    notifyListeners();
  }

  Future<void> selectTournament(Tournament t) async {
    selectedTournament = t;
    _scheduledQueueEtag = null;
    loading = true;
    notifyListeners();
    try {
      // Fetch full details
      final fullTournament = await _api.getTournamentDetails(t.id);
      selectedTournament = fullTournament;
      
      // Extract courts and matches
      courts = fullTournament.courts;
      games = fullTournament.matches;
      
      selectedCourt = null;
      selectedDate = null;
    } catch (e) {
      error = 'Failed to load tournament details: $e';
    }
    loading = false;
    notifyListeners();
  }

  Future<void> selectCourt(String c) async {
    selectedCourt = c;
    _scheduledQueueEtag = null;
    _autoPickSelectedDate();
    notifyListeners();
    await refreshSelectedTournament();
    await _refreshScheduledQueueForSelection();
  }

  Future<void> selectDate(String d) async {
    selectedDate = d.trim().isEmpty ? null : d.trim();
    _scheduledQueueEtag = null;
    notifyListeners();
    await refreshSelectedTournament();
    await _refreshScheduledQueueForSelection();
  }

  List<String> get availableDatesForSelectedCourt {
    if (selectedCourt == null) return const [];
    final targetCourt = _normalizeCourt(selectedCourt);
    final dates = <String>{};
    for (final g in games) {
      if (_normalizeCourt(g.court) != targetCourt) continue;
      final d = _normalizeDate(g.date);
      if (d != null) dates.add(d);
    }
    final sorted = dates.toList()
      ..sort((a, b) => _parseDateValue(a).compareTo(_parseDateValue(b)));
    return sorted;
  }
  
  List<TournamentMatch> get matchesForSelectedCourt {
    if (selectedCourt == null || selectedDate == null) return [];
    final targetCourt = _normalizeCourt(selectedCourt);
    final targetDate = _normalizeDate(selectedDate);
    if (targetDate == null) return [];

    bool hasAnyScheduledGameTime(TournamentMatch g) {
      if (g.time.trim().isNotEmpty) return true;
      if ((g.mdTime2?.toString().trim().isNotEmpty ?? false)) return true;
      if ((g.mdTime3?.toString().trim().isNotEmpty ?? false)) return true;
      return false;
    }

    bool hasAnyExplicitGameStatus(TournamentMatch g) {
      final s1 = normalizeGameStatusKey(g.game1Status);
      final s2 = normalizeGameStatusKey(g.game2Status);
      final s3 = normalizeGameStatusKey(g.game3Status);
      return s1 != 'unschedule' || s2 != 'unschedule' || s3 != 'unschedule';
    }

    final filtered = games.where((g) {
      if (_normalizeCourt(g.court) != targetCourt) return false;
      final gameDate = _normalizeDate(g.date);
      if (gameDate == null || gameDate != targetDate) return false;
      if (selectedTournament?.hasAuthoritativeSchedule == true &&
          g.scheduleFromAssignments != true) {
        return false;
      }
      // Only show matches with valid schedule-to-court/date mapping.
      if (!hasAnyScheduledGameTime(g) && !hasAnyExplicitGameStatus(g)) return false;
      return true;
    }).toList();
    final seen = <String>{};
    final unique = <TournamentMatch>[];
    for (final m in filtered) {
      final key = '${m.type}-${m.categoryId}-${m.groupId}-${m.matchKey}-${m.id}';
      if (seen.add(key)) {
        unique.add(m);
      }
    }
    unique.sort((a, b) {
      final ta = _timeSortValue(a.time);
      final tb = _timeSortValue(b.time);
      if (ta != tb) return ta.compareTo(tb);
      return '${a.matchLabel}-${a.matchKey}-${a.id}'
          .compareTo('${b.matchLabel}-${b.matchKey}-${b.id}');
    });
    return unique;
  }

  String normalizeStatusKey(String? raw) {
    final s = (raw ?? '').trim().toLowerCase();
    if (s.isEmpty) return 'unschedule';
    final compact = s.replaceAll(RegExp(r'[\s_-]+'), '');
    if (compact == 'unschedule' || compact == 'unscheduled') return 'unschedule';
    if (compact == 'scheduled') return 'scheduled';
    if (compact == 'called') return 'called';
    if (compact == 'ongoing') return 'ongoing';
    if (compact == 'completed') return 'completed';
    return s;
  }

  String normalizeGameStatusKey(String? raw) {
    final s = (raw ?? '').trim().toLowerCase();
    if (s.isEmpty) return 'unschedule';
    final compact = s.replaceAll(RegExp(r'[\s_-]+'), '');
    if (compact == 'unschedule' || compact == 'unscheduled') return 'unschedule';
    if (compact == 'scheduled') return 'scheduled';
    if (compact == 'ongoing') return 'ongoing';
    if (compact == 'completed') return 'completed';
    return s;
  }

  bool hasScheduleForGame(TournamentMatch match, int gameNo) {
    if (match.court.trim().isEmpty) return false;
    if (match.date.trim().isEmpty) return false;
    if (selectedTournament?.hasAuthoritativeSchedule == true &&
        match.scheduleFromAssignments != true) {
      return false;
    }
    if (gameNo == 1) return match.time.trim().isNotEmpty;
    if (gameNo == 2) return (match.mdTime2?.toString().trim().isNotEmpty ?? false);
    if (gameNo == 3) return (match.mdTime3?.toString().trim().isNotEmpty ?? false);
    return false;
  }

  String gameStatusKey(TournamentMatch match, int gameNo) {
    String raw;
    if (gameNo == 1) {
      raw = match.game1Status;
    } else if (gameNo == 2) {
      raw = match.game2Status;
    } else if (gameNo == 3) {
      raw = match.game3Status;
    } else {
      raw = '';
    }
    if (raw.trim().isNotEmpty) {
      return normalizeGameStatusKey(raw);
    }

    bool hasCompletedEvidence() {
      final sigs = match.gameSignatures;
      if (sigs != null && sigs.length >= gameNo) {
        final sig = (sigs[gameNo - 1] ?? '').toString().trim();
        if (sig.isNotEmpty) return true;
      }
      final a = _scoreForGame(match, gameNo, true) ?? 0;
      final b = _scoreForGame(match, gameNo, false) ?? 0;
      return (a + b) > 0;
    }

    if (hasCompletedEvidence()) return 'completed';
    if (hasScheduleForGame(match, gameNo)) return 'scheduled';
    return 'unschedule';
  }

  String gameStatusLabel(TournamentMatch match, int gameNo) {
    switch (gameStatusKey(match, gameNo)) {
      case 'scheduled':
        return 'Scheduled';
      case 'ongoing':
        return 'Ongoing';
      case 'completed':
        return 'Completed';
      default:
        return 'Unscheduled';
    }
  }

  bool isCallableMatchGame(TournamentMatch match, int gameNo) {
    final statusKey = gameStatusKey(match, gameNo);
    if (statusKey != 'scheduled') return false;
    return hasScheduleForGame(match, gameNo);
  }

  bool isGameScheduled(TournamentMatch match, int gameNo) {
    return isCallableMatchGame(match, gameNo);
  }

  List<int> scheduledGames(TournamentMatch match) {
    final out = <int>[];
    for (int i = 1; i <= 3; i++) {
      final statusKey = gameStatusKey(match, i);
      if (statusKey == 'unschedule') continue;
      if (hasScheduleForGame(match, i) || statusKey == 'scheduled' || statusKey == 'ongoing') {
        out.add(i);
      }
    }
    return out;
  }

  int resolveBestScheduledGameNo(TournamentMatch match, {int? preferred}) {
    final scheduled = scheduledGames(match);
    if (preferred != null && scheduled.contains(preferred)) {
      return preferred;
    }
    if (scheduled.isEmpty) return 1;

    int s1For(int idx) {
      if (idx == 1) return match.game1Player1 ?? 0;
      if (idx == 2) return match.game2Player1 ?? 0;
      if (idx == 3) return match.game3Player1 ?? 0;
      return 0;
    }

    int s2For(int idx) {
      if (idx == 1) return match.game1Player2 ?? 0;
      if (idx == 2) return match.game2Player2 ?? 0;
      if (idx == 3) return match.game3Player2 ?? 0;
      return 0;
    }

    for (final idx in scheduled) {
      if (gameStatusKey(match, idx) != 'completed' && (s1For(idx) + s2For(idx)) == 0) {
        return idx;
      }
    }
    return scheduled.first;
  }

  void openGame(TournamentMatch g) {
    selectedGame = g;
    notifyListeners();
  }

  int selectedGameNumber = 1;
  void openGameWithNumber(TournamentMatch g, int gameNo) {
    selectedGame = g;
    selectedGameNumber = gameNo;
    notifyListeners();
  }

  Future<void> refreshSelectedTournament() async {
    final t = selectedTournament;
    if (t == null) return;
    loading = true;
    notifyListeners();
    try {
      final fullTournament = await _api.getTournamentDetails(t.id);
      selectedTournament = fullTournament;
      courts = fullTournament.courts;
      games = _mergeRefreshedMatchesWithLocalState(fullTournament.matches);
      if (selectedGame != null) {
        final selectedKey = _matchIdentityKey(selectedGame!);
        final refreshedSelected = games.where((m) => _matchIdentityKey(m) == selectedKey).toList();
        if (refreshedSelected.isNotEmpty) {
          selectedGame = refreshedSelected.first;
        }
      }
      if (selectedCourt != null &&
          !courts.any((c) => _normalizeCourt(c) == _normalizeCourt(selectedCourt))) {
        selectedCourt = null;
      }
      _autoPickSelectedDate();
      await _refreshScheduledQueueForSelection();
      // Try syncing queued updates after refresh
      await trySyncOutbox();
    } catch (e) {
      error = 'Failed to refresh: $e';
    }
    loading = false;
    notifyListeners();
  }

  Future<void> updateSelectedMatchFields(
    Map<String, dynamic> fields, {
    bool debounceOngoing = false,
  }) async {
    final t = selectedTournament;
    final g = selectedGame;
    if (t == null || g == null) return;
    final payloadFields = _sanitizeMatchFields(fields);
    final submitFields = Map<String, dynamic>.from(payloadFields);

    int inferSelectedIndex(Map<String, dynamic> payload) {
      final keys = payload.keys.toList();
      int? found;
      for (final key in keys) {
        final m = RegExp(r'^game([1-3])', caseSensitive: false).firstMatch(key);
        if (m != null) {
          final n = int.tryParse(m.group(1) ?? '');
          if (n != null) {
            found = (found == null) ? n : (n > found ? n : found);
          }
        }
      }
      return (found ?? selectedGameNumber).clamp(1, 3);
    }

    final inferredIndex = inferSelectedIndex(payloadFields);
    if (selectedGameNumber != inferredIndex) {
      selectedGameNumber = inferredIndex;
    }
    if (!payloadFields.containsKey('id') ||
        payloadFields['id'] == null ||
        payloadFields['id'].toString().isEmpty) {
      payloadFields['id'] = g.id;
      submitFields['id'] = g.id;
    }
    final status = payloadFields['status']?.toString().trim();
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
    if (status != null && status.isNotEmpty) {
      final targetStatus = normalizeStatus(status);
      final selectedIndex = inferredIndex.clamp(1, 3);
      payloadFields['game${selectedIndex}Status'] = targetStatus;
      submitFields['status'] = targetStatus;
      submitFields['game${selectedIndex}Status'] = targetStatus;
      payloadFields.remove('status');
    }
    if (!_hasStableIdentifiers(g)) {
      error = 'Missing stable match identifier for score sync.';
      notifyListeners();
      return;
    }
    if (!_hasValidSelectedScheduleContext(g) && kDebugMode) {
      debugPrint(
        '[score-sync] proceeding with weak schedule context: '
        'court=${g.court}, date=${g.date}, selectedCourt=$selectedCourt, selectedDate=$selectedDate',
      );
    }
    final matchIdentity = _matchIdentityKey(g);
    final selectedIndex = inferredIndex.clamp(1, 3);
    final gameIdentity = _matchGameIdentityKey(g, selectedIndex);
    if (matchIdentity.isEmpty || gameIdentity.isEmpty) {
      error = 'Missing stable match identifier for score sync.';
      notifyListeners();
      return;
    }
    final isOngoingStatus = status == 'Ongoing';
    if (!isOngoingStatus && _inFlightSubmitSeqByMatch.containsKey(gameIdentity)) {
      error = 'Submission already in progress for this match.';
      notifyListeners();
      throw StateError(error!);
    }

    final applyOptimistically = status == null ||
        status.isEmpty ||
        isOngoingStatus ||
        (g.type != 'group' && status == 'Completed');
    if (applyOptimistically) {
      final updated = _mergeMatchWithFields(g, payloadFields);
      _replaceSelectedGame(updated, g);
      notifyListeners();
    }

    if (status == 'Ongoing' && debounceOngoing) {
      _pendingOngoingFields = submitFields;
      _pendingOngoingMatchKey = gameIdentity;
      _ongoingSyncTimer?.cancel();
      _ongoingSyncTimer = Timer(const Duration(milliseconds: 900), () async {
        final pending = _pendingOngoingFields;
        final pendingMatchKey = _pendingOngoingMatchKey;
        _pendingOngoingFields = null;
        _pendingOngoingMatchKey = null;
        if (pending == null || pendingMatchKey != gameIdentity) return;
        await _submitSelectedMatchPayload(
          tournament: t,
          match: _findMatchByIdentity(matchIdentity) ?? g,
          matchIdentity: matchIdentity,
          gameIdentity: gameIdentity,
          fields: pending,
          retryOnce: true,
          throwOnFailure: false,
        );
      });
      return;
    }

    await _submitSelectedMatchPayload(
      tournament: t,
      match: _findMatchByIdentity(matchIdentity) ?? g,
      matchIdentity: matchIdentity,
      gameIdentity: gameIdentity,
      fields: submitFields,
      retryOnce: status == 'Ongoing',
      throwOnFailure: status != 'Ongoing',
    );
  }

  Map<String, dynamic> _sanitizeMatchFields(Map<String, dynamic> fields) {
    final scheduleKeys = <String>{
      'date',
      'time',
      'court',
      'venue',
      'mdDate',
      'mdTime',
      'wdDate',
      'wdTime',
      'xdDate',
      'xdTime',
    };
    final payload = Map<String, dynamic>.from(fields)
      ..removeWhere((key, value) {
        if (scheduleKeys.contains(key)) return true;
        if (value == null) return true;
        if (value is String && value.trim().isEmpty) return true;
        return false;
      });
    return payload;
  }

  bool _hasStableIdentifiers(TournamentMatch g) {
    if (selectedTournament == null || g.categoryId.trim().isEmpty) return false;
    if (g.type == 'group') {
      return g.groupId.trim().isNotEmpty && g.matchKey.trim().isNotEmpty;
    }
    if (g.type == 'elimination') {
      return g.id.trim().isNotEmpty;
    }
    return false;
  }

  TournamentMatch _mergeMatchWithFields(TournamentMatch g, Map<String, dynamic> payload) {
    return TournamentMatch(
      id: g.id,
      documentId: g.documentId,
      scheduleFromAssignments: g.scheduleFromAssignments,
      player1: g.player1,
      player2: g.player2,
      player1Name: g.player1Name,
      player2Name: g.player2Name,
      score1: _fieldAsInt(payload, 'score1', g.score1) ?? g.score1,
      score2: _fieldAsInt(payload, 'score2', g.score2) ?? g.score2,
      game1Status: payload['game1Status']?.toString() ?? g.game1Status,
      game2Status: payload['game2Status']?.toString() ?? g.game2Status,
      game3Status: payload['game3Status']?.toString() ?? g.game3Status,
      game1Player1: _fieldAsInt(payload, 'game1Player1', g.game1Player1),
      game1Player2: _fieldAsInt(payload, 'game1Player2', g.game1Player2),
      game2Player1: _fieldAsInt(payload, 'game2Player1', g.game2Player1),
      game2Player2: _fieldAsInt(payload, 'game2Player2', g.game2Player2),
      game3Player1: _fieldAsInt(payload, 'game3Player1', g.game3Player1),
      game3Player2: _fieldAsInt(payload, 'game3Player2', g.game3Player2),
      round: g.round,
      court: g.court,
      date: g.date,
      time: g.time,
      venue: g.venue,
      mdTime2: g.mdTime2,
      mdEnd2: g.mdEnd2,
      mdTime3: g.mdTime3,
      mdEnd3: g.mdEnd3,
      status: payload['status']?.toString() ?? g.status,
      categoryId: g.categoryId,
      matchKey: g.matchKey,
      type: g.type,
      seedLabel: g.seedLabel,
      matchLabel: g.matchLabel,
      groupId: g.groupId,
      winner: payload['winner']?.toString() ?? g.winner,
      signatureData: payload['signatureData']?.toString() ?? g.signatureData,
      gameSignatures: (payload['gameSignatures'] is List)
          ? (payload['gameSignatures'] as List).map((e) => e?.toString()).toList()
          : g.gameSignatures,
      refereeNote: payload['refereeNote']?.toString() ?? g.refereeNote,
      scoringFormat: g.scoringFormat,
      game1Team1Player: payload['game1Team1Player']?.toString() ?? g.game1Team1Player,
      game1Team1Player2: payload['game1Team1Player2']?.toString() ?? g.game1Team1Player2,
      game1Team2Player: payload['game1Team2Player']?.toString() ?? g.game1Team2Player,
      game1Team2Player2: payload['game1Team2Player2']?.toString() ?? g.game1Team2Player2,
      game2Team1Player: payload['game2Team1Player']?.toString() ?? g.game2Team1Player,
      game2Team1Player2: payload['game2Team1Player2']?.toString() ?? g.game2Team1Player2,
      game2Team2Player: payload['game2Team2Player']?.toString() ?? g.game2Team2Player,
      game2Team2Player2: payload['game2Team2Player2']?.toString() ?? g.game2Team2Player2,
      game3Team1Player: payload['game3Team1Player']?.toString() ?? g.game3Team1Player,
      game3Team1Player2: payload['game3Team1Player2']?.toString() ?? g.game3Team1Player2,
      game3Team2Player: payload['game3Team2Player']?.toString() ?? g.game3Team2Player,
      game3Team2Player2: payload['game3Team2Player2']?.toString() ?? g.game3Team2Player2,
    );
  }

  List<TournamentMatch> _mergeRefreshedMatchesWithLocalState(List<TournamentMatch> refreshed) {
    final existingByKey = <String, TournamentMatch>{};
    for (final m in games) {
      final key = _matchIdentityKey(m);
      if (key.isNotEmpty) existingByKey[key] = m;
    }
    int keyRank(String key) {
      switch (key) {
        case 'unschedule':
          return 0;
        case 'scheduled':
          return 1;
        case 'ongoing':
          return 2;
        case 'completed':
          return 3;
        default:
          return 1;
      }
    }

    List<String?> mergeGameSignatures(List<String?>? existing, List<String?>? incoming) {
      final out = List<String?>.filled(3, null);
      for (int i = 0; i < 3; i++) {
        final inc = (incoming != null && incoming.length > i) ? incoming[i] : null;
        final ex = (existing != null && existing.length > i) ? existing[i] : null;
        final incStr = (inc ?? '').toString().trim();
        final exStr = (ex ?? '').toString().trim();
        if (incStr.isNotEmpty) {
          out[i] = incStr;
        } else if (exStr.isNotEmpty) {
          out[i] = exStr;
        } else {
          out[i] = null;
        }
      }
      return out;
    }

    return refreshed.map((m) {
      final matchIdentity = _matchIdentityKey(m);
      final existing = existingByKey[matchIdentity];
      if (existing == null) return m;

      final overrides = <String, dynamic>{};
      for (int n = 1; n <= 3; n++) {
        final existingKey = gameStatusKey(existing, n);
        final incomingKey = gameStatusKey(m, n);
        if (keyRank(existingKey) > keyRank(incomingKey)) {
          final explicitExistingStatus = (n == 1)
              ? existing.game1Status
              : (n == 2 ? existing.game2Status : existing.game3Status);
          if (explicitExistingStatus.trim().isNotEmpty) {
            overrides['game${n}Status'] = explicitExistingStatus;
          }
          overrides['game${n}Player1'] = _scoreForGame(existing, n, true);
          overrides['game${n}Player2'] = _scoreForGame(existing, n, false);
        }
      }

      final mergedSigs = mergeGameSignatures(existing.gameSignatures, m.gameSignatures);
      if (mergedSigs.any((s) => (s ?? '').toString().trim().isNotEmpty)) {
        overrides['gameSignatures'] = mergedSigs;
      }
      if ((existing.refereeNote?.toString().trim().isNotEmpty ?? false) &&
          (m.refereeNote?.toString().trim().isEmpty ?? true)) {
        overrides['refereeNote'] = existing.refereeNote;
      }

      return overrides.isEmpty ? m : _mergeMatchWithFields(m, overrides);
    }).toList();
  }

  void _replaceSelectedGame(TournamentMatch updated, TournamentMatch original) {
    final matchIdentity = _matchIdentityKey(original);
    if (matchIdentity.isNotEmpty) {
      _replaceMatchByIdentity(matchIdentity, updated);
      return;
    }
    games = games.map((m) {
      final sameId = original.id.isNotEmpty && m.id == original.id;
      final sameComposite = m.categoryId == original.categoryId &&
          m.groupId == original.groupId &&
          m.matchKey == original.matchKey;
      return (sameId || sameComposite) ? updated : m;
    }).toList();
    selectedGame = updated;
  }

  Future<void> _submitSelectedMatchPayload({
    required Tournament tournament,
    required TournamentMatch match,
    required String matchIdentity,
    required String gameIdentity,
    required Map<String, dynamic> fields,
    required bool retryOnce,
    required bool throwOnFailure,
  }) async {
    final activeMatch = _findMatchByIdentity(matchIdentity) ?? match;
    final status = (fields['status']?.toString() ?? '').trim();
    final isOngoingStatus = status == 'Ongoing';
    if (isOngoingStatus && _inFlightSubmitSeqByMatch.containsKey(gameIdentity)) {
      _pendingOngoingFields = fields;
      _pendingOngoingMatchKey = gameIdentity;
      return;
    }
    if (!isOngoingStatus && _inFlightSubmitSeqByMatch.containsKey(gameIdentity)) {
      throw StateError('A save is already in progress for this match.');
    }

    final submitSeq = ++_submitSequenceCounter;
    _latestStartedSubmitSeqByMatch[gameIdentity] = submitSeq;
    _inFlightSubmitSeqByMatch[gameIdentity] = submitSeq;

    final selectedIndex = selectedGameNumber.clamp(1, 3);
    final s1 = _fieldAsInt(
          fields,
          'game${selectedIndex}Player1',
          _scoreForGame(activeMatch, selectedIndex, true),
        ) ??
        0;
    final s2 = _fieldAsInt(
          fields,
          'game${selectedIndex}Player2',
          _scoreForGame(activeMatch, selectedIndex, false),
        ) ??
        0;
    final gamesArray = List.generate(3, (i) {
      final idx = i + 1;
      final a =
          _fieldAsInt(fields, 'game${idx}Player1', _scoreForGame(activeMatch, idx, true)) ?? 0;
      final b =
          _fieldAsInt(fields, 'game${idx}Player2', _scoreForGame(activeMatch, idx, false)) ?? 0;
      return {'a': a, 'b': b};
    });

    final payload = <String, dynamic>{
      'tournamentId': tournament.id,
      'categoryId': activeMatch.categoryId,
      'type': activeMatch.type,
      'selectedGame': selectedIndex,
      'assignedGame': selectedIndex,
      'gameIndex': selectedIndex,
      'game': {'a': s1, 'b': s2},
      'games': gamesArray,
      ...fields,
    };
    if (activeMatch.type == 'group') {
      payload['groupId'] = activeMatch.groupId;
      payload['matchKey'] = activeMatch.matchKey;
    } else {
      payload['matchId'] = activeMatch.id;
      if (activeMatch.documentId.trim().isNotEmpty) {
        payload['documentId'] = activeMatch.documentId;
      }
    }

    final division = tournament.categoryDivisions[activeMatch.categoryId]?.toLowerCase() ?? '';
    final isTeamCategory = division.contains('team');
    if (isTeamCategory) {
      String vFor(String key) {
        switch (key) {
          case 'game1Team1Player':
            return activeMatch.game1Team1Player;
          case 'game1Team1Player2':
            return activeMatch.game1Team1Player2;
          case 'game1Team2Player':
            return activeMatch.game1Team2Player;
          case 'game1Team2Player2':
            return activeMatch.game1Team2Player2;
          case 'game2Team1Player':
            return activeMatch.game2Team1Player;
          case 'game2Team1Player2':
            return activeMatch.game2Team1Player2;
          case 'game2Team2Player':
            return activeMatch.game2Team2Player;
          case 'game2Team2Player2':
            return activeMatch.game2Team2Player2;
          case 'game3Team1Player':
            return activeMatch.game3Team1Player;
          case 'game3Team1Player2':
            return activeMatch.game3Team1Player2;
          case 'game3Team2Player':
            return activeMatch.game3Team2Player;
          case 'game3Team2Player2':
            return activeMatch.game3Team2Player2;
          default:
            return '';
        }
      }

      final n = selectedIndex;
      final teamKeys = <String>[
        'game${n}Team1Player',
        'game${n}Team1Player2',
        'game${n}Team2Player',
        'game${n}Team2Player2',
      ];
      final teamFields = <String, dynamic>{};
      for (final k in teamKeys) {
        final val = vFor(k);
        if (val.trim().isNotEmpty) {
          teamFields[k] = val.trim();
        }
      }
      if (teamFields.isNotEmpty) {
        final existingFields = payload['fields'];
        if (existingFields is Map) {
          payload['fields'] = {...Map<String, dynamic>.from(existingFields), ...teamFields};
        } else {
          payload['fields'] = teamFields;
        }
      }
    }

    if (kDebugMode) {
      final matchRef = activeMatch.type == 'group'
          ? 'groupId=${activeMatch.groupId}, matchKey=${activeMatch.matchKey}'
          : 'matchId=${activeMatch.id}';
      final sig = payload['signatureData']?.toString() ?? '';
      final sigPrefix = sig.startsWith('data:image') ? 'data:image' : (sig.isNotEmpty ? 'base64' : 'none');
      final sigLen = sig.length;
      final hasGameSignatures = payload['gameSignatures'] is List || (payload['fields'] is Map && (payload['fields'] as Map).containsKey('gameSignatures'));
      final hasFieldsSig = payload['fields'] is Map && (payload['fields'] as Map).containsKey('signatureData');
      final used = sig.isNotEmpty ? 'signatureData' : (hasFieldsSig ? 'fields.signatureData' : (hasGameSignatures ? 'gameSignatures[idx]' : 'none'));
      debugPrint(
        '[score-sync] OUT -> tournamentId=${tournament.id}, categoryId=${activeMatch.categoryId}, '
        '$matchRef, selectedGame=$selectedIndex, status=$status, score=$s1-$s2, '
        'sig=$sigPrefix len=$sigLen via=$used keys=${fields.keys.toList()}, seq=$submitSeq',
      );
    }

    Future<SubmitScoreResult> attemptSubmit() async {
      ongoingSyncing = isOngoingStatus;
      if (ongoingSyncing) notifyListeners();
      try {
        final result = await _api.submitScore(payload);
        if (kDebugMode) {
          debugPrint('[score-sync] IN <- submit-score success status=$status seq=$submitSeq');
        }
        return result;
      } finally {
        if (ongoingSyncing) {
          ongoingSyncing = false;
          notifyListeners();
        }
      }
    }

    try {
      final result = await attemptSubmit();
      _applySubmitResult(
        matchIdentity: matchIdentity,
        gameIdentity: gameIdentity,
        fallbackMatch: activeMatch,
        submitSeq: submitSeq,
        requestFields: fields,
        result: result,
      );
    } catch (e) {
      if (retryOnce) {
        try {
          await Future<void>.delayed(const Duration(milliseconds: 350));
          final result = await attemptSubmit();
          _applySubmitResult(
            matchIdentity: matchIdentity,
            gameIdentity: gameIdentity,
            fallbackMatch: activeMatch,
            submitSeq: submitSeq,
            requestFields: fields,
            result: result,
          );
          return;
        } catch (_) {}
      }
      if (throwOnFailure) {
        rethrow;
      }
      if (kDebugMode) {
        debugPrint('[score-sync] ongoing sync failed and skipped: $e');
      }
    } finally {
      if (_inFlightSubmitSeqByMatch[gameIdentity] == submitSeq) {
        _inFlightSubmitSeqByMatch.remove(gameIdentity);
      }
      final pending = _pendingOngoingFields;
      final pendingMatchKey = _pendingOngoingMatchKey;
      if (isOngoingStatus && pending != null && pendingMatchKey == gameIdentity) {
        _pendingOngoingFields = null;
        _pendingOngoingMatchKey = null;
        unawaited(_submitSelectedMatchPayload(
          tournament: tournament,
          match: _findMatchByIdentity(matchIdentity) ?? activeMatch,
          matchIdentity: matchIdentity,
          gameIdentity: gameIdentity,
          fields: pending,
          retryOnce: true,
          throwOnFailure: false,
        ));
      }
    }
  }

  void _applySubmitResult({
    required String matchIdentity,
    required String gameIdentity,
    required TournamentMatch fallbackMatch,
    required int submitSeq,
    required Map<String, dynamic> requestFields,
    required SubmitScoreResult result,
  }) {
    if (_latestStartedSubmitSeqByMatch[gameIdentity] != submitSeq) {
      return;
    }
    final current = _findMatchByIdentity(matchIdentity) ?? fallbackMatch;
    final authoritativeFields = _resolveAuthoritativeFields(
      requestFields: requestFields,
      serverMatch: result.savedMatch,
    );
    final updated = _mergeMatchWithFields(current, authoritativeFields);
    _replaceMatchByIdentity(matchIdentity, updated);
    notifyListeners();
  }

  Map<String, dynamic> _resolveAuthoritativeFields({
    required Map<String, dynamic> requestFields,
    Map<String, dynamic>? serverMatch,
  }) {
    if (serverMatch == null || serverMatch.isEmpty) {
      return requestFields;
    }
    final authoritative = Map<String, dynamic>.from(requestFields);
    const keys = [
      'score1',
      'score2',
      'game1Player1',
      'game1Player2',
      'game2Player1',
      'game2Player2',
      'game3Player1',
      'game3Player2',
      'status',
      'game1Status',
      'game2Status',
      'game3Status',
      'winner',
      'signatureData',
      'gameSignatures',
      'refereeNote',
    ];
    int statusRank(String? raw) {
      switch (normalizeStatusKey(raw)) {
        case 'unschedule':
          return 0;
        case 'scheduled':
          return 1;
        case 'called':
          return 2;
        case 'ongoing':
          return 3;
        case 'completed':
          return 4;
        default:
          return 1;
      }
    }

    final requestStatus = requestFields['status']?.toString();
    final serverStatus = serverMatch['status']?.toString();
    int gameStatusRank(String? raw) {
      switch (normalizeGameStatusKey(raw)) {
        case 'unschedule':
          return 0;
        case 'scheduled':
          return 1;
        case 'ongoing':
          return 2;
        case 'completed':
          return 3;
        default:
          return 1;
      }
    }

    for (final key in keys) {
      if (!serverMatch.containsKey(key) || serverMatch[key] == null) continue;
      if (key == 'status') {
        final best = statusRank(serverStatus) >= statusRank(requestStatus) ? serverStatus : requestStatus;
        if (best != null && best.trim().isNotEmpty) {
          authoritative[key] = best;
        }
        continue;
      }
      if (key == 'game1Status' || key == 'game2Status' || key == 'game3Status') {
        final req = requestFields[key]?.toString();
        final srv = serverMatch[key]?.toString();
        final best = gameStatusRank(srv) >= gameStatusRank(req) ? srv : req;
        if (best != null && best.trim().isNotEmpty) {
          authoritative[key] = best;
        }
        continue;
      }
      authoritative[key] = serverMatch[key];
    }
    return authoritative;
  }

  int? _scoreForGame(TournamentMatch g, int gameIndex, bool teamA) {
    switch (gameIndex) {
      case 1:
        return teamA ? g.game1Player1 : g.game1Player2;
      case 2:
        return teamA ? g.game2Player1 : g.game2Player2;
      case 3:
        return teamA ? g.game3Player1 : g.game3Player2;
      default:
        return 0;
    }
  }

  bool _hasValidSelectedScheduleContext(TournamentMatch g) {
    if (selectedCourt == null || selectedDate == null) return false;
    final c = _normalizeCourt(g.court);
    final d = _normalizeDate(g.date);
    final sc = _normalizeCourt(selectedCourt);
    final sd = _normalizeDate(selectedDate);
    if (d == null || sd == null) return false;
    if (!hasScheduleForGame(g, selectedGameNumber.clamp(1, 3))) return false;
    return c == sc && d == sd;
  }

  void _autoPickSelectedDate() {
    final dates = availableDatesForSelectedCourt;
    if (dates.isEmpty) {
      selectedDate = null;
      return;
    }
    final current = _normalizeDate(selectedDate);
    if (current != null && dates.contains(current)) {
      selectedDate = current;
      return;
    }
    final preferred = _normalizeDate(selectedTournament?.preferredScheduleDate);
    if (preferred != null && dates.contains(preferred)) {
      selectedDate = preferred;
      return;
    }
    selectedDate = dates.first;
  }

  String _normalizeCourt(String? s) {
    if (s == null) return '';
    final m = RegExp(r'^\s*(?:Court\s*)?(\d+)\s*$', caseSensitive: false).firstMatch(s);
    if (m != null) return 'Court ${m.group(1)}';
    return s.trim();
  }

  String? _normalizeDate(String? input) {
    if (input == null) return null;
    final raw = input.trim();
    if (raw.isEmpty) return null;
    final dt = _parseDateValue(raw);
    return _formatDateIso(dt);
  }

  DateTime _parseDateValue(String input) {
    final parsed = DateTime.tryParse(input);
    if (parsed != null) {
      return DateTime(parsed.year, parsed.month, parsed.day);
    }
    final slash = RegExp(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})$').firstMatch(input);
    if (slash != null) {
      var month = int.tryParse(slash.group(1) ?? '') ?? 1;
      var day = int.tryParse(slash.group(2) ?? '') ?? 1;
      var year = int.tryParse(slash.group(3) ?? '') ?? DateTime.now().year;
      if (year < 100) year += 2000;
      month = month.clamp(1, 12);
      day = day.clamp(1, 31);
      return DateTime(year, month, day);
    }
    return DateTime(1970, 1, 1);
  }

  String _formatDateIso(DateTime dt) {
    final y = dt.year.toString().padLeft(4, '0');
    final m = dt.month.toString().padLeft(2, '0');
    final d = dt.day.toString().padLeft(2, '0');
    return '$y-$m-$d';
  }

  int _timeSortValue(String raw) {
    final text = raw.trim().toUpperCase();
    if (text.isEmpty) return 999999;
    final m = RegExp(r'^(\d{1,2}):(\d{2})\s*(AM|PM)?$').firstMatch(text) ??
        RegExp(r'^(\d{1,2})(\d{2})\s*(AM|PM)?$').firstMatch(text);
    if (m == null) return 999998;
    var h = int.tryParse(m.group(1) ?? '') ?? 0;
    final mins = int.tryParse(m.group(2) ?? '') ?? 0;
    final ap = m.group(3);
    if (ap == 'PM' && h < 12) h += 12;
    if (ap == 'AM' && h == 12) h = 0;
    return h * 60 + mins;
  }

  Future<void> _refreshScheduledQueueForSelection() async {
    if (!_useScheduledQueueEndpoint) return;
    final t = selectedTournament;
    if (t == null || selectedCourt == null || selectedDate == null) return;
    try {
      final response = await _api.getScheduledMatches(
        tournamentId: t.id,
        date: selectedDate!,
        court: selectedCourt!,
        page: 1,
        limit: 100,
        ifNoneMatch: _scheduledQueueEtag,
      );
      if (response.notModified) return;
      _scheduledQueueEtag = response.etag ?? _scheduledQueueEtag;
      final incoming = response.matches;
      final existingByKey = <String, TournamentMatch>{};
      for (final m in games) {
        final key = _matchIdentityKey(m);
        if (key.isNotEmpty) existingByKey[key] = m;
      }
      final mergedIncoming = incoming.map((m) {
        final existing = existingByKey[_matchIdentityKey(m)];
        if (existing == null) return m;
        if (m.scoringFormat != 'sideout' || existing.scoringFormat == 'sideout') {
          return m;
        }
        return TournamentMatch(
          id: m.id,
          documentId: m.documentId,
          scheduleFromAssignments: m.scheduleFromAssignments,
          player1: m.player1,
          player2: m.player2,
          score1: m.score1,
          score2: m.score2,
          game1Status: m.game1Status,
          game2Status: m.game2Status,
          game3Status: m.game3Status,
          game1Player1: m.game1Player1,
          game1Player2: m.game1Player2,
          game2Player1: m.game2Player1,
          game2Player2: m.game2Player2,
          game3Player1: m.game3Player1,
          game3Player2: m.game3Player2,
          round: m.round,
          court: m.court,
          date: m.date,
          time: m.time,
          venue: m.venue,
          mdTime2: m.mdTime2,
          mdEnd2: m.mdEnd2,
          mdTime3: m.mdTime3,
          mdEnd3: m.mdEnd3,
          status: m.status,
          categoryId: m.categoryId,
          matchKey: m.matchKey,
          type: m.type,
          seedLabel: m.seedLabel,
          matchLabel: m.matchLabel,
          groupId: m.groupId,
          winner: m.winner,
          signatureData: m.signatureData,
          gameSignatures: m.gameSignatures,
          refereeNote: m.refereeNote,
          scoringFormat: existing.scoringFormat,
        );
      }).toList();
      final incomingIds = incoming
          .where((m) => m.id.isNotEmpty)
          .map((m) => m.id)
          .toSet();
      final keep = games.where((m) {
        // Keep non-scheduled or non-selected context matches from current cache.
        final selectedCourtNorm = _normalizeCourt(selectedCourt);
        final selectedDateNorm = _normalizeDate(selectedDate);
        final sameCourt = _normalizeCourt(m.court) == selectedCourtNorm;
        final sameDate = _normalizeDate(m.date) == selectedDateNorm;
        if (sameCourt && sameDate && m.status == 'Scheduled') {
          if (m.id.isNotEmpty) return !incomingIds.contains(m.id);
        }
        return true;
      }).toList();
      games = [...keep, ...mergedIncoming];
      notifyListeners();
    } catch (_) {
      // Keep fallback behavior when endpoint is not available.
    }
  }

  TournamentMatch? _findMatchByIdentity(String matchIdentity) {
    for (final match in games) {
      if (_matchIdentityKey(match) == matchIdentity) {
        return match;
      }
    }
    return null;
  }

  void _replaceMatchByIdentity(String matchIdentity, TournamentMatch updated) {
    games = games.map((m) {
      return _matchIdentityKey(m) == matchIdentity ? updated : m;
    }).toList();
    if (selectedGame != null && _matchIdentityKey(selectedGame!) == matchIdentity) {
      selectedGame = updated;
    }
  }

  String _matchGameIdentityKey(TournamentMatch match, int gameIndex) {
    final base = _matchIdentityKey(match);
    if (base.isEmpty) return '';
    final idx = gameIndex.clamp(1, 3);
    return '$base:g$idx';
  }

  String _matchIdentityKey(TournamentMatch match) {
    if (match.type == 'elimination' &&
        match.categoryId.trim().isNotEmpty &&
        match.id.trim().isNotEmpty) {
      return 'elim:${match.categoryId.trim()}:${match.id.trim()}';
    }
    if (match.id.trim().isNotEmpty) {
      return 'id:${match.id.trim()}';
    }
    if (match.type == 'group' &&
        match.categoryId.trim().isNotEmpty &&
        match.groupId.trim().isNotEmpty &&
        match.matchKey.trim().isNotEmpty) {
      return 'group:${match.categoryId.trim()}:${match.groupId.trim()}:${match.matchKey.trim()}';
    }
    return '';
  }

  int? _fieldAsInt(Map<String, dynamic> source, String key, int? fallback) {
    final v = source[key];
    if (v is int) return v;
    if (v is num) return v.toInt();
    final parsed = int.tryParse(v?.toString() ?? '');
    return parsed ?? fallback;
  }

  Future<void> queueMatchUpdate({
    required String tournamentId,
    required String categoryId,
    required String groupId,
    required String matchKey,
    required Map<String, dynamic> fields,
  }) async {
    final item = {
      'tournamentId': tournamentId,
      'categoryId': categoryId,
      'groupId': groupId,
      'matchKey': matchKey,
      'fields': fields,
      'ts': DateTime.now().toIso8601String(),
    };
    _outbox.add(item);
    await _saveOutbox();
  }

  Future<void> trySyncOutbox() async {
    if (_outbox.isEmpty) return;
    final copy = List<Map<String, dynamic>>.from(_outbox);
    final succeeded = <Map<String, dynamic>>[];
    for (final item in copy) {
      try {
        await _api.updateGroupMatch(
          tournamentId: item['tournamentId'],
          categoryId: item['categoryId'],
          groupId: item['groupId'],
          matchKey: item['matchKey'],
          fields: Map<String, dynamic>.from(item['fields'] as Map),
        );
        succeeded.add(item);
      } catch (_) {
        // keep in outbox
      }
    }
    if (succeeded.isNotEmpty) {
      _outbox.removeWhere((e) => succeeded.contains(e));
      await _saveOutbox();
      await refreshSelectedTournament();
    }
  }

  Future<void> _loadOutbox() async {
    final prefs = await SharedPreferences.getInstance();
    final s = prefs.getString(_storageOutboxKey);
    if (s != null && s.isNotEmpty) {
      try {
        final list = jsonDecode(s);
        if (list is List) {
          _outbox = list.map<Map<String, dynamic>>((e) => Map<String, dynamic>.from(e as Map)).toList();
        }
      } catch (_) {
        _outbox = [];
      }
    }
  }

  Future<void> _saveOutbox() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_storageOutboxKey, jsonEncode(_outbox));
  }

  Future<void> logout() async {
    _ongoingSyncTimer?.cancel();
    currentUser = null;
    tournaments = [];
    courts = [];
    games = [];
    selectedTournament = null;
    selectedCourt = null;
    selectedDate = null;
    selectedGame = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_storageTokenKey);
    await prefs.remove(_storageUserKey);
    await prefs.remove(_storageOutboxKey);
    notifyListeners();
  }
}
