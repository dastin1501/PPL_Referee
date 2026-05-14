import 'dart:convert';
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';
import '../models.dart';

class AppState extends ChangeNotifier {
  static const _storageTokenKey = 'referee_auth_token';
  static const _storageUserKey = 'referee_auth_user';

  final ApiService _api = ApiService();

  User? currentUser;
  List<Tournament> tournaments = [];
  List<String> courts = [];
  List<TournamentMatch> games = [];
  Tournament? selectedTournament;
  String? selectedCourt;
  String? selectedDate;
  TournamentMatch? selectedGame;
  String? _scheduledQueueEtag;
  bool loading = false;
  String? error;
  bool initialized = false;
  bool ongoingSyncing = false;
  Timer? _ongoingSyncTimer;
  Map<String, dynamic>? _pendingOngoingFields;

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
    _autoPickSelectedDate();
    notifyListeners();
    await refreshSelectedTournament();
    await _refreshScheduledQueueForSelection();
  }

  Future<void> selectDate(String d) async {
    selectedDate = d.trim().isEmpty ? null : d.trim();
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

    final filtered = games.where((g) {
      if (_normalizeCourt(g.court) != targetCourt) return false;
      final gameDate = _normalizeDate(g.date);
      if (gameDate == null || gameDate != targetDate) return false;
      // Only show matches with valid schedule-to-court/date mapping.
      if ((g.time).trim().isEmpty) return false;
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
      games = fullTournament.matches;
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
    if (!payloadFields.containsKey('id') ||
        payloadFields['id'] == null ||
        payloadFields['id'].toString().isEmpty) {
      payloadFields['id'] = g.id;
    }
    final status = payloadFields['status']?.toString().trim();
    if (status != null && status.isNotEmpty) {
      final currentStatus = g.status.trim().isEmpty ? 'Scheduled' : g.status.trim();
      if (status != currentStatus) {
        final allowedNext = <String, Set<String>>{
          'Scheduled': {'Called', 'Ongoing', 'Completed'},
          'Called': {'Ongoing', 'Completed'},
          'Ongoing': {'Completed'},
          'Completed': <String>{},
        };
        final nextAllowed = allowedNext[currentStatus] ?? const <String>{};
        if (!nextAllowed.contains(status)) {
          error = 'Invalid status transition: $currentStatus -> $status.';
          notifyListeners();
          return;
        }
      }
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

    // Optimistic local state first for responsive scoreboard.
    final updated = _mergeMatchWithFields(g, payloadFields);
    _replaceSelectedGame(updated, g);
    notifyListeners();

    if (status == 'Ongoing' && debounceOngoing) {
      _pendingOngoingFields = payloadFields;
      _ongoingSyncTimer?.cancel();
      _ongoingSyncTimer = Timer(const Duration(milliseconds: 900), () async {
        final pending = _pendingOngoingFields;
        _pendingOngoingFields = null;
        if (pending == null) return;
        await _submitSelectedMatchPayload(
          fields: pending,
          retryOnce: true,
          throwOnFailure: false,
        );
      });
      return;
    }

    await _submitSelectedMatchPayload(
      fields: payloadFields,
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
      player1: g.player1,
      player2: g.player2,
      score1: _fieldAsInt(payload, 'score1', g.score1) ?? g.score1,
      score2: _fieldAsInt(payload, 'score2', g.score2) ?? g.score2,
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
    );
  }

  void _replaceSelectedGame(TournamentMatch updated, TournamentMatch original) {
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
    required Map<String, dynamic> fields,
    required bool retryOnce,
    required bool throwOnFailure,
  }) async {
    final t = selectedTournament;
    final g = selectedGame;
    if (t == null || g == null) return;

    final selectedIndex = selectedGameNumber.clamp(1, 3);
    final s1 = _fieldAsInt(fields, 'game${selectedIndex}Player1', _scoreForGame(g, selectedIndex, true)) ?? 0;
    final s2 = _fieldAsInt(fields, 'game${selectedIndex}Player2', _scoreForGame(g, selectedIndex, false)) ?? 0;
    final gamesArray = List.generate(3, (i) {
      final idx = i + 1;
      final a = _fieldAsInt(fields, 'game${idx}Player1', _scoreForGame(g, idx, true)) ?? 0;
      final b = _fieldAsInt(fields, 'game${idx}Player2', _scoreForGame(g, idx, false)) ?? 0;
      return {'a': a, 'b': b};
    });

    final payload = <String, dynamic>{
      'tournamentId': t.id,
      'categoryId': g.categoryId,
      'type': g.type,
      'selectedGame': selectedIndex,
      'game': {'a': s1, 'b': s2},
      'games': gamesArray,
      ...fields,
    };
    if (g.type == 'group') {
      payload['groupId'] = g.groupId;
      payload['matchKey'] = g.matchKey;
    } else {
      payload['matchId'] = g.id;
    }

    final status = (payload['status']?.toString() ?? '').trim();
    if (kDebugMode) {
      final matchRef = g.type == 'group'
          ? 'groupId=${g.groupId}, matchKey=${g.matchKey}'
          : 'matchId=${g.id}';
      debugPrint(
        '[score-sync] OUT -> tournamentId=${t.id}, categoryId=${g.categoryId}, $matchRef, '
        'selectedGame=$selectedIndex, status=$status, score=$s1-$s2, keys=${fields.keys.toList()}',
      );
    }

    Future<void> attemptSubmit() async {
      ongoingSyncing = status == 'Ongoing';
      if (ongoingSyncing) notifyListeners();
      try {
        await _api.submitScore(payload);
        if (kDebugMode) {
          debugPrint('[score-sync] IN <- submit-score success status=$status');
        }
      } finally {
        if (ongoingSyncing) {
          ongoingSyncing = false;
          notifyListeners();
        }
      }
    }

    try {
      await attemptSubmit();
    } catch (e) {
      if (retryOnce) {
        try {
          await Future<void>.delayed(const Duration(milliseconds: 350));
          await attemptSubmit();
          return;
        } catch (_) {}
      }
      if (throwOnFailure) {
        rethrow;
      }
      if (kDebugMode) {
        debugPrint('[score-sync] ongoing sync failed and skipped: $e');
      }
    }
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
    if (g.time.trim().isEmpty) return false;
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
      games = [...keep, ...incoming];
      notifyListeners();
    } catch (_) {
      // Keep fallback behavior when endpoint is not available.
    }
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
