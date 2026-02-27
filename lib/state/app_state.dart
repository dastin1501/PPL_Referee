import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
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
  TournamentMatch? selectedGame;
  bool loading = false;
  String? error;
  bool initialized = false;

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

  // Local override to remember which court a match actually finished on
  static const _storageCourtOverrideKey = 'referee_completion_court_overrides_v1';
  Map<String, String> _completionCourtOverrides = {};
  Future<void> _loadOverrides() async {
    final prefs = await SharedPreferences.getInstance();
    final jsonStr = prefs.getString(_storageCourtOverrideKey);
    if (jsonStr != null && jsonStr.isNotEmpty) {
      try {
        final Map<String, dynamic> m = jsonDecode(jsonStr);
        _completionCourtOverrides = m.map((k, v) => MapEntry(k, v.toString()));
      } catch (_) {
        _completionCourtOverrides = {};
      }
    }
  }
  Future<void> _saveOverrides() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_storageCourtOverrideKey, jsonEncode(_completionCourtOverrides));
  }
  void markMatchCompletionCourt(String matchId, String court) {
    if (matchId.isEmpty || court.isEmpty) return;
    _completionCourtOverrides[matchId] = court;
    _saveOverrides();
  }
  String? overrideCourtFor(String matchId) => _completionCourtOverrides[matchId];

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_storageTokenKey);
    final userJson = prefs.getString(_storageUserKey);
    await _loadOutbox();
    await _loadOverrides();
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
        final server = dotenv.env['API_BASE_URL'] ?? 'localhost';
        error = 'User: ${result.user?.email}\nRoles: ${result.user?.roles}\nServer: $server\nError: Not authorized as referee.';
        notifyListeners();
        return false;
      }
    } else {
      final server = dotenv.env['API_BASE_URL'] ?? 'localhost';
      error = '${result.error}\nServer: $server';
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
    } catch (e) {
      error = 'Failed to load tournament details: $e';
    }
    loading = false;
    notifyListeners();
  }

  Future<void> selectCourt(String c) async {
    selectedCourt = c;
    notifyListeners();
    await refreshSelectedTournament();
  }
  
  List<TournamentMatch> get matchesForSelectedCourt {
    if (selectedCourt == null) return [];
    String norm(String? s) {
      if (s == null) return '';
      final m = RegExp(r'^\s*(?:Court\s*)?(\d+)\s*$').firstMatch(s);
      if (m != null) return 'Court ${m.group(1)}';
      return s;
    }
    final target = norm(selectedCourt);
    String effectiveCourt(TournamentMatch g) {
      final o = overrideCourtFor(g.id);
      if (o != null && o.isNotEmpty) return norm(o);
      return norm(g.court);
    }
    final filtered = games.where((g) => effectiveCourt(g) == target).toList();
    final seen = <String>{};
    final unique = <TournamentMatch>[];
    for (final m in filtered) {
      final key = '${m.type}-${m.categoryId}-${m.groupId}-${m.matchKey}-${m.id}';
      if (seen.add(key)) {
        unique.add(m);
      }
    }
    unique.sort((a, b) {
      return '${a.date} ${a.time}'.compareTo('${b.date} ${b.time}');
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

  void openNextScheduledForSelectedCourt() {
    final court = selectedCourt;
    if (court == null) return;
    final courtMatches = matchesForSelectedCourt;
    if (courtMatches.isEmpty) return;
    // Build per-game schedule items similar to CourtGamesScreen
    final items = <Map<String, dynamic>>[];
    int gpmFor(TournamentMatch m) =>
        selectedTournament?.categoryGamesPerMatch[m.categoryId] ?? 1;
    for (final g in courtMatches) {
      final gpm = gpmFor(g);
      void addItem(int n, String? start, String? end) {
        if (start != null && start.toString().trim().isNotEmpty) {
          items.add({
            'g': g,
            'n': n,
            'start': start.toString(),
            'end': end?.toString() ?? '',
          });
        }
      }
      if (gpm >= 1) addItem(1, g.time, null);
      if (gpm >= 2) addItem(2, g.mdTime2, g.mdEnd2);
      if (gpm >= 3) addItem(3, g.mdTime3, g.mdEnd3);
    }
    if (items.isEmpty) return;
    int timeKey(Map<String, dynamic> it) {
      final raw = (it['start'] as String?)?.trim() ?? '';
      if (raw.isEmpty) return 999999;
      final t = raw.toUpperCase();
      final ampm = RegExp(r'^(\d{1,2}):(\d{2})\s*(AM|PM)?$').firstMatch(t)
          ?? RegExp(r'^(\d{1,2})(\d{2})\s*(AM|PM)?$').firstMatch(t);
      if (ampm != null) {
        int h = int.tryParse(ampm.group(1) ?? '0') ?? 0;
        final m = int.tryParse(ampm.group(2) ?? '0') ?? 0;
        final ap = ampm.group(3);
        if (ap == 'PM' && h < 12) h += 12;
        if (ap == 'AM' && h == 12) h = 0;
        return h * 60 + m;
      }
      return 999998;
    }
    items.sort((a, b) => timeKey(a).compareTo(timeKey(b)));
    // Prefer non-completed matches
    Map<String, dynamic>? pick = items.firstWhere(
      (it) => (it['g'] as TournamentMatch).status != 'Completed',
      orElse: () => items.first,
    );
    final g = pick['g'] as TournamentMatch;
    final n = pick['n'] as int;
    openGameWithNumber(g, n);
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
      // Try syncing queued updates after refresh
      await trySyncOutbox();
    } catch (e) {
      error = 'Failed to refresh: $e';
    }
    loading = false;
    notifyListeners();
  }

  Future<void> updateSelectedMatchFields(Map<String, dynamic> fields) async {
    final t = selectedTournament;
    final g = selectedGame;
    if (t == null || g == null) return;
    if (g.type == 'group' && g.groupId.isNotEmpty && g.matchKey.isNotEmpty) {
      final scheduleKeys = <String>{
        'date','time','court','venue','mdDate','mdTime','wdDate','wdTime','xdDate','xdTime'
      };
      final payload = Map<String, dynamic>.from(fields)
        ..removeWhere((key, value) {
          if (scheduleKeys.contains(key)) return true;
          if (value == null) return true;
          if (value is String && value.trim().isEmpty) return true;
          return false;
        });
      if (!payload.containsKey('id') || payload['id'] == null || payload['id'].toString().isEmpty) {
        payload['id'] = g.id;
      }
      try {
        await _api.updateGroupMatch(
          tournamentId: t.id,
          categoryId: g.categoryId,
          groupId: g.groupId,
          matchKey: g.matchKey,
          fields: payload,
        );
        final updated = TournamentMatch(
          id: g.id,
          player1: g.player1,
          player2: g.player2,
          score1: payload['score1'] is int ? payload['score1'] as int : g.score1,
          score2: payload['score2'] is int ? payload['score2'] as int : g.score2,
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
        games = games.map((m) => m.id == g.id ? updated : m).toList();
        selectedGame = updated;
        notifyListeners();
      } catch (e) {
        // Queue offline
        await queueMatchUpdate(
          tournamentId: t.id,
          categoryId: g.categoryId,
          groupId: g.groupId,
          matchKey: g.matchKey,
          fields: payload,
        );
        error = 'Saved offline; will sync when online.';
        notifyListeners();
      }
    }
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
    currentUser = null;
    tournaments = [];
    courts = [];
    games = [];
    selectedTournament = null;
    selectedCourt = null;
    selectedGame = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_storageTokenKey);
    await prefs.remove(_storageUserKey);
    await prefs.remove(_storageOutboxKey);
    notifyListeners();
  }
}
