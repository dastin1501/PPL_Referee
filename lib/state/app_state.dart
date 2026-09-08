import 'dart:convert';
import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../services/api_service.dart';
import '../services/socket_service.dart';
import '../services/score_event_queue.dart';
import '../services/match_update_queue.dart';
import '../models.dart';
import '../models/score_event.dart';
import '../models/match_update.dart';
import '../utils/court_slug.dart';

class AppState extends ChangeNotifier {
  static const _storageTokenKey = 'referee_auth_token';
  static const _storageUserKey = 'referee_auth_user';
  static const _storageApiBaseUrlKey = 'referee_api_base_url';
  static const bool _useScheduledQueueEndpoint = false;

  final ApiService _api = ApiService();
  final SocketService _socket = SocketService.instance;
  late final ScoreEventQueue scoreQueue;
  late final MatchUpdateQueue matchUpdateQueue;

  /// Last known serving side for overlay (`team1` / `team2`) per match identity.
  final Map<String, String> _servingByMatch = {};
  String? _joinedCourtSlug;

  AppState() {
    _api.onUnauthorized = _handleUnauthorized;
    scoreQueue = ScoreEventQueue(
      api: _api,
      socket: _socket,
      onChanged: () {
        if (!_disposed) notifyListeners();
      },
    );
    matchUpdateQueue = MatchUpdateQueue(
      socket: _socket,
      onChanged: () {
        if (!_disposed) notifyListeners();
      },
    );
  }

  bool _disposed = false;
  bool _handlingUnauthorized = false;

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
  String? _joinedTournamentId;
  final Set<String> _joinedMatchIds = {};
  bool _liveListenersAttached = false;
  Timer? _scheduleRefreshDebounce;

  int get pendingScoreSyncCount => scoreQueue.pendingCount;
  int get pendingScoreSyncMatchCount => scoreQueue.pendingMatchCount;
  bool get scoreSyncHasStale => scoreQueue.hasStalePending;
  bool get socketConnected => _socket.connected;

  // Tutorial simulation mode:
  // - Uses the exact same RefereeDashboard UI
  // - Skips all backend writes, but keeps optimistic local state updates
  bool _tutorialSimulationMode = false;
  bool get tutorialSimulationMode => _tutorialSimulationMode;
  Tournament? _savedSelectedTournament;
  TournamentMatch? _savedSelectedGame;
  int _savedSelectedGameNumber = 1;

  void enterTutorialSimulation({
    required Tournament tutorialTournament,
    required TournamentMatch tutorialMatch,
    int gameNumber = 1,
  }) {
    if (!_tutorialSimulationMode) {
      _savedSelectedTournament = selectedTournament;
      _savedSelectedGame = selectedGame;
      _savedSelectedGameNumber = selectedGameNumber;
    }
    _tutorialSimulationMode = true;
    selectedTournament = tutorialTournament;
    selectedGame = tutorialMatch;
    selectedGameNumber = gameNumber;
    error = null;
    notifyListeners();
  }

  void exitTutorialSimulation() {
    _tutorialSimulationMode = false;
    selectedTournament = _savedSelectedTournament;
    selectedGame = _savedSelectedGame;
    selectedGameNumber = _savedSelectedGameNumber;
    _savedSelectedTournament = null;
    _savedSelectedGame = null;
    notifyListeners();
  }

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
    final envUrl = dotenv.env['API_BASE_URL'] ?? '';
    if (savedBaseUrl != null && savedBaseUrl.trim().isNotEmpty) {
      if (_isLocalhostUrl(savedBaseUrl) && envUrl.isNotEmpty && !_isLocalhostUrl(envUrl)) {
        await prefs.remove(_storageApiBaseUrlKey);
      } else {
        _api.setBaseUrl(savedBaseUrl);
      }
    }
    apiBaseUrl = _api.baseUrl;
    final token = prefs.getString(_storageTokenKey);
    final userJson = prefs.getString(_storageUserKey);
    await _loadOutbox();
    await trySyncOutbox();
    await scoreQueue.load();
    await matchUpdateQueue.load();
    if (token != null && userJson != null) {
      try {
        final data = jsonDecode(userJson) as Map<String, dynamic>;
        _api.setToken(token);
        currentUser = User.fromJson(data);
        _ensureLiveSocket();
      } catch (e) {
        if (e is AuthException) {
          await logout(reason: e.message);
        } else {
          currentUser = null;
        }
      }
    }
    // Leave splash immediately — tournament fetch must not block UI forever.
    initialized = true;
    notifyListeners();
    if (currentUser != null) {
      unawaited(loadTournaments());
    }
  }

  bool _isLocalhostUrl(String url) {
    final lower = url.toLowerCase();
    return lower.contains('localhost') ||
        lower.contains('127.0.0.1') ||
        lower.contains('10.0.2.2');
  }

  void _handleUnauthorized() {
    if (_handlingUnauthorized || currentUser == null) return;
    _handlingUnauthorized = true;
    logout(reason: 'Session expired. Please log in again.').whenComplete(() {
      _handlingUnauthorized = false;
    });
  }

  /// Re-fetch data when the app returns from background after long inactivity.
  Future<void> refreshOnResume() async {
    if (currentUser == null || loading) return;
    try {
      _ensureLiveSocket();
      _rejoinLiveRooms();
      unawaited(scoreQueue.flush());
      unawaited(matchUpdateQueue.flush());
      if (selectedTournament != null) {
        await refreshSelectedTournament();
      } else {
        await loadTournaments();
      }
    } on AuthException catch (e) {
      await logout(reason: e.message);
    } catch (_) {}
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
    if (currentUser != null) {
      _ensureLiveSocket();
      _rejoinLiveRooms();
    }
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
        _ensureLiveSocket();
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
      // /api/referees/tournaments is already scoped to this referee.
      tournaments = await _api.getRefereeTournaments();
    } on AuthException catch (e) {
      await logout(reason: e.message);
    } catch (e) {
      error = 'Failed to load tournaments: $e';
      tournaments = [];
    }
    loading = false;
    notifyListeners();
  }

  Future<void> selectTournament(Tournament t) async {
    leaveLiveMatchRooms();
    leaveLiveTournament();
    selectedTournament = t;
    _scheduledQueueEtag = null;
    error = null;
    loading = true;
    notifyListeners();
    try {
      // Fast path: brackets + schedule only (no registration pagination).
      final fullTournament = await _api.getTournamentDetails(
        t.id,
        includeRegistrations: false,
      );
      selectedTournament = fullTournament;
      
      // Extract courts and matches
      courts = fullTournament.courts;
      games = _normalizeServerClearedMatches(fullTournament.matches);
      try {
        final assigned = await _api.getAssignedMatches();
        _overlayAssignedMatches(assigned);
      } catch (_) {}
      _resolveEliminationPlaceholdersFromTournamentDetails();
      _applyQueuedSnapshotsToGames();
      
      selectedCourt = null;
      selectedDate = null;
      joinLiveTournament(fullTournament.id);

      // Team rosters can load after UI opens — don't block "Opening…".
      unawaited(_enrichTournamentRegistrations(t.id));
    } catch (e) {
      error = 'Failed to load tournament details: $e';
    }
    loading = false;
    notifyListeners();
  }

  Future<void> _enrichTournamentRegistrations(String tournamentId) async {
    try {
      final withRegs = await _api.getTournamentDetails(
        tournamentId,
        includeRegistrations: true,
      );
      if (selectedTournament?.id != tournamentId) return;
      selectedTournament = withRegs;
      // Re-parse matches with registrations so RR slots can fill TBD names.
      games = _mergeRefreshedMatchesWithLocalState(
        _normalizeServerClearedMatches(withRegs.matches),
      );
      try {
        final assigned = await _api.getAssignedMatches();
        _overlayAssignedMatches(assigned);
      } catch (_) {}
      _resolveEliminationPlaceholdersFromTournamentDetails();
      _applyQueuedSnapshotsToGames();
      notifyListeners();
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Background registration enrich failed: $e');
      }
    }
  }

  Future<void> selectCourt(String c) async {
    final prevSlug = courtSlug(selectedCourt);
    selectedCourt = c;
    _scheduledQueueEtag = null;
    _autoPickSelectedDate();
    _joinSelectedCourtRoom(leavePrevious: prevSlug);
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

  void _cancelPendingOngoingSync() {
    _ongoingSyncTimer?.cancel();
    _ongoingSyncTimer = null;
    _pendingOngoingFields = null;
    _pendingOngoingMatchKey = null;
  }

  bool _hasGameSignature(TournamentMatch match, int gameNo) {
    final sigs = match.gameSignatures;
    if (sigs != null && gameNo >= 1 && gameNo <= sigs.length) {
      final sig = (sigs[gameNo - 1] ?? '').toString().trim();
      if (sig.isNotEmpty) return true;
    }
    if (gameNo == 1) {
      final legacy = match.signatureData?.toString().trim() ?? '';
      final hasPerGameSigs = sigs?.any((s) => (s ?? '').toString().trim().isNotEmpty) ?? false;
      if (legacy.isNotEmpty && !hasPerGameSigs) return true;
    }
    return false;
  }

  bool _isFinishedGameScore(int a, int b) {
    final maxScore = a > b ? a : b;
    final minScore = a < b ? a : b;
    if (maxScore < 11) return false;
    return (maxScore - minScore) >= 2;
  }

  bool _hasCompletedEvidenceForGame(TournamentMatch match, int gameNo) {
    if (_hasGameSignature(match, gameNo)) return true;
    final a = _scoreForGame(match, gameNo, true) ?? 0;
    final b = _scoreForGame(match, gameNo, false) ?? 0;
    return _isFinishedGameScore(a, b);
  }

  String? _pickNonEmptySignature(dynamic value) {
    final s = value?.toString().trim() ?? '';
    return s.isEmpty ? null : s;
  }

  List<String?>? _mergeGameSignaturesList(
    List<String?>? existing,
    dynamic incoming,
  ) {
    List<String?>? asList(dynamic value) {
      if (value is! List) return null;
      return value.map((e) => e?.toString()).toList();
    }

    final inc = asList(incoming);
    if (inc == null) return existing;
    final out = List<String?>.filled(3, null);
    for (int i = 0; i < 3; i++) {
      final incStr = (i < inc.length ? (inc[i] ?? '') : '').toString().trim();
      final exStr = (existing != null && i < existing.length
              ? (existing[i] ?? '')
              : '')
          .toString()
          .trim();
      if (incStr.isNotEmpty) {
        out[i] = incStr;
      } else if (exStr.isNotEmpty) {
        out[i] = exStr;
      }
    }
    return out;
  }

  bool hasScheduleForGame(TournamentMatch match, int gameNo) {
    if (match.court.trim().isEmpty) return false;
    if (match.date.trim().isEmpty) return false;
    if (selectedTournament?.hasAuthoritativeSchedule == true &&
        match.scheduleFromAssignments != true) {
      return false;
    }
    // Whether a game exists is purely schedule-driven — mirrors the website:
    // a round only has as many games as were actually assigned time slots
    // in the court-assignment grid (e.g. QF may be best-of-1 while SF/Final
    // are best-of-3, depending on what the admin scheduled).
    if (gameNo == 1) return match.time.trim().isNotEmpty;
    if (gameNo == 2) return match.mdTime2?.toString().trim().isNotEmpty ?? false;
    if (gameNo == 3) return match.mdTime3?.toString().trim().isNotEmpty ?? false;
    return false;
  }

  // Upper bound of games to *check* for a match (actual visibility of each
  // game is still gated by hasScheduleForGame / real schedule data above).
  int gamesPerMatchFor(TournamentMatch match) {
    final tournament = selectedTournament;
    if (tournament == null) return 1;
    final catId = match.categoryId.trim();
    final fallback = catId.isEmpty
        ? 1
        : (tournament.categoryGamesPerMatch[catId] ?? 1).clamp(1, 3);

    if (match.type == 'elimination') {
      final stage = _eliminationStageKey(match);
      final stagedMap = catId.isEmpty
          ? null
          : tournament.categoryEliminationGpm[catId];
      if (stagedMap != null && stagedMap.isNotEmpty) {
        final staged = stagedMap[stage] ?? stagedMap['elimination'];
        if (staged != null) return staged.clamp(1, 3);
      }
      // Finals/Bronze with only Game 1 timed → treat as single game.
      if (stage == 'finals' || stage == 'bronze') {
        final hasG2 = match.mdTime2?.toString().trim().isNotEmpty ?? false;
        final hasG3 = match.mdTime3?.toString().trim().isNotEmpty ?? false;
        if (!hasG2 && !hasG3) return 1;
      }
      // Still scan up to 3 max so schedule-driven BO3 rounds work when
      // eliminationGpm is missing, but callers must gate on hasScheduleForGame.
      return 3;
    }
    return fallback;
  }

  String _eliminationStageKey(TournamentMatch match) {
    final id = match.id.trim().toLowerCase();
    final tail = RegExp(
      r'-(finals?|bronze|brz|qf\d+|quarter\d+|sf\d+|semi\d+|r16-?\d+|round16_?\d+|cf\d+)(?:-g\d+)?$',
      caseSensitive: false,
    ).firstMatch(id);
    final idEff = (tail != null ? tail.group(1)! : id).toLowerCase();
    final round = match.round.trim().toLowerCase();
    final label =
        '${match.matchLabel} ${match.seedLabel} ${match.roundShort} ${match.roundLabel}'.toLowerCase();
    final blob = '$idEff $round $label';
    if (idEff == 'bronze' || idEff == 'brz' || blob.contains('bronze')) return 'bronze';
    if (idEff.startsWith('round16') ||
        idEff.startsWith('r16') ||
        blob.contains('round of 16') ||
        blob.contains('round of 32')) {
      return 'r16';
    }
    if (idEff.startsWith('quarter') || idEff.startsWith('qf') || blob.contains('quarter')) {
      return 'quarters';
    }
    if (idEff.startsWith('semi') ||
        idEff.startsWith('sf') ||
        (blob.contains('semi') && !blob.contains('semis-final'))) {
      return 'semis';
    }
    if (idEff.startsWith('cf') || blob.contains('crossover') || blob.contains('semis-final')) {
      return 'cf';
    }
    if (idEff == 'final' ||
        idEff == 'finals' ||
        blob.contains('gold') ||
        blob.contains('championship') ||
        (blob.contains('final') && !blob.contains('semi') && !blob.contains('quarter'))) {
      return 'finals';
    }
    return 'elimination';
  }

  String gameStatusKey(TournamentMatch match, int gameNo) {
    final matchStatus = normalizeGameStatusKey(match.status);
    final a = _scoreForGame(match, gameNo, true) ?? 0;
    final b = _scoreForGame(match, gameNo, false) ?? 0;
    final gamePoints = a + b;

    // Staff clear/unlock sets match status to Scheduled/Unschedule with 0 points.
    // Prefer that over a stale gameNStatus="Completed" left on the embed.
    if ((matchStatus == 'scheduled' || matchStatus == 'unschedule') &&
        gamePoints <= 0 &&
        !_hasGameSignature(match, gameNo)) {
      if (matchStatus == 'scheduled' || hasScheduleForGame(match, gameNo)) {
        return 'scheduled';
      }
      return 'unschedule';
    }

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
      final normalized = normalizeGameStatusKey(raw);
      // Website sometimes stamps gameNStatus="Scheduled" after a partial unlock
      // while leaving the old 11-x score. Never show Scheduled when points exist.
      if ((normalized == 'scheduled' || normalized == 'unschedule') &&
          (gamePoints > 0 || _hasGameSignature(match, gameNo))) {
        if (_isFinishedGameScore(a, b) || _hasGameSignature(match, gameNo)) {
          return 'completed';
        }
        return 'ongoing';
      }
      if (normalized == 'ongoing' && _hasCompletedEvidenceForGame(match, gameNo)) {
        return 'completed';
      }
      // Stale per-game Completed with no points after unlock → trust match status.
      if (normalized == 'completed' &&
          gamePoints <= 0 &&
          !_hasGameSignature(match, gameNo) &&
          (matchStatus == 'scheduled' || matchStatus == 'unschedule')) {
        return matchStatus == 'scheduled' ? 'scheduled' : 'unschedule';
      }
      return normalized;
    }

    bool hasCompletedEvidence() {
      if (_hasGameSignature(match, gameNo)) return true;
      if (_isFinishedGameScore(a, b)) return true;
      return gamePoints > 0;
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
    joinLiveMatchForGame(g);
    notifyListeners();
    // Do not publish Live/OBS here — wait for START GAME.
  }

  int selectedGameNumber = 1;
  void openGameWithNumber(TournamentMatch g, int gameNo) {
    selectedGame = g;
    selectedGameNumber = gameNo;
    joinLiveMatchForGame(g);
    notifyListeners();
    // Do not publish Live/OBS here — wait for START GAME.
  }

  /// Leave match socket room when leaving the referee dashboard.
  void closeSelectedGameLive() {
    leaveLiveMatchRooms();
  }

  Future<void> refreshSelectedTournament({bool showLoading = true}) async {
    final t = selectedTournament;
    if (t == null) return;
    // Pull-to-refresh must NOT flip global loading — that rebuilds the list and
    // leaves the RefreshIndicator spinner stuck on Flutter web.
    if (showLoading) {
      loading = true;
      notifyListeners();
    }
    // Force a real schedule refetch — stale If-None-Match made pull-to-refresh
    // look like it worked (spinner) while keeping the old court queue.
    _scheduledQueueEtag = null;
    try {
      final fullTournament = await _api.getTournamentDetails(
        t.id,
        includeRegistrations: false,
      );
      selectedTournament = fullTournament;
      courts = fullTournament.courts;
      games = _mergeRefreshedMatchesWithLocalState(
        _normalizeServerClearedMatches(fullTournament.matches),
      );
      try {
        final assigned = await _api.getAssignedMatches();
        _overlayAssignedMatches(assigned);
      } catch (_) {}
      _resolveEliminationPlaceholdersFromTournamentDetails();
      _applyQueuedSnapshotsToGames();
      if (selectedGame != null) {
        final selectedKey = _matchIdentityKey(selectedGame!);
        final refreshedSelected = games.where((m) => _matchIdentityKey(m) == selectedKey).toList();
        if (refreshedSelected.isNotEmpty) {
          final incoming = refreshedSelected.first;
          final prev = selectedGame!;
          // Mid-live: keep the Ref Panel instance. Tournament embed / seed
          // re-rank can swap Final↔Bronze names (Sarah↔Emma) on refresh.
          final keepLive = normalizeGameStatusKey(prev.status) == 'ongoing' ||
              ((prev.game1Player1 ?? 0) +
                      (prev.game1Player2 ?? 0) +
                      (prev.game2Player1 ?? 0) +
                      (prev.game2Player2 ?? 0) +
                      (prev.game3Player1 ?? 0) +
                      (prev.game3Player2 ?? 0) +
                      prev.score1 +
                      prev.score2) >
                  0;
          if (!(keepLive &&
              !_isWeakPlayerLabel(prev.player1) &&
              !_isWeakPlayerLabel(prev.player2))) {
            selectedGame = incoming;
          }
        }
      }
      if (selectedCourt != null &&
          !courts.any((c) => _normalizeCourt(c) == _normalizeCourt(selectedCourt))) {
        selectedCourt = null;
      }
      _autoPickSelectedDate();
      await _refreshScheduledQueueForSelection();
      // Do not PUT leftover group-match outbox after submit/refresh.
      unawaited(_enrichTournamentRegistrations(t.id));
    } on AuthException catch (e) {
      await logout(reason: e.message);
    } catch (e) {
      error = 'Failed to refresh: $e';
    } finally {
      if (showLoading) loading = false;
      notifyListeners();
    }
  }

  void _overlayAssignedMatches(List<TournamentMatch> assigned) {
    if (assigned.isEmpty) return;
    final byKey = <String, TournamentMatch>{};
    for (final m in assigned) {
      final key = _matchIdentityKey(m);
      if (key.isNotEmpty) {
        byKey[key] = m;
      }
    }
    if (byKey.isEmpty) return;
    games = games.map((existing) {
      final key = _matchIdentityKey(existing);
      final inc = byKey[key];
      if (inc == null) return existing;

      String pickName(String fromAssigned, String fromEmbed) {
        final a = fromAssigned.trim();
        final b = fromEmbed.trim();
        // Tournament details (website bracket) win when they already have a real name.
        if (!_isWeakPlayerLabel(b)) return b;
        if (!_isWeakPlayerLabel(a)) return a;
        if (b.isNotEmpty) return b;
        if (a.isNotEmpty) return a;
        return '';
      }

      final mergedPlayer1 = pickName(inc.player1, existing.player1);
      final mergedPlayer2 = pickName(inc.player2, existing.player2);
      final mergedPlayer1Name = pickName(inc.player1Name, existing.player1Name);
      final mergedPlayer2Name = pickName(inc.player2Name, existing.player2Name);
      final mergedRoundShort = pickName(inc.roundShort, existing.roundShort);
      final mergedRoundLabel = pickName(inc.roundLabel, existing.roundLabel);
      final mergedMatchLabel = pickName(inc.matchLabel, existing.matchLabel);
      final mergedSeedLabel = pickName(inc.seedLabel, existing.seedLabel);

      return TournamentMatch(
        id: existing.id,
        documentId: existing.documentId,
        scheduleFromAssignments: existing.scheduleFromAssignments,
        player1: mergedPlayer1.isNotEmpty ? mergedPlayer1 : existing.player1,
        player2: mergedPlayer2.isNotEmpty ? mergedPlayer2 : existing.player2,
        player1Name: mergedPlayer1Name.isNotEmpty
            ? mergedPlayer1Name
            : (mergedPlayer1.isNotEmpty ? mergedPlayer1 : existing.player1Name),
        player2Name: mergedPlayer2Name.isNotEmpty
            ? mergedPlayer2Name
            : (mergedPlayer2.isNotEmpty ? mergedPlayer2 : existing.player2Name),
        score1: existing.score1,
        score2: existing.score2,
        game1Status: existing.game1Status,
        game2Status: existing.game2Status,
        game3Status: existing.game3Status,
        game1Player1: existing.game1Player1,
        game1Player2: existing.game1Player2,
        game2Player1: existing.game2Player1,
        game2Player2: existing.game2Player2,
        game3Player1: existing.game3Player1,
        game3Player2: existing.game3Player2,
        round: existing.round,
        roundShort: mergedRoundShort,
        roundLabel: mergedRoundLabel,
        court: existing.court,
        date: existing.date,
        time: existing.time,
        venue: existing.venue,
        mdTime2: existing.mdTime2,
        mdEnd2: existing.mdEnd2,
        mdTime3: existing.mdTime3,
        mdEnd3: existing.mdEnd3,
        status: existing.status,
        categoryId: existing.categoryId,
        matchKey: existing.matchKey,
        type: existing.type,
        seedLabel: mergedSeedLabel,
        matchLabel: mergedMatchLabel,
        groupId: existing.groupId,
        winner: existing.winner,
        signatureData: existing.signatureData,
        gameSignatures: existing.gameSignatures,
        refereeNote: existing.refereeNote,
        scoringFormat: existing.scoringFormat,
        game1Team1Player: existing.game1Team1Player,
        game1Team1Player2: existing.game1Team1Player2,
        game1Team2Player: existing.game1Team2Player,
        game1Team2Player2: existing.game1Team2Player2,
        game2Team1Player: existing.game2Team1Player,
        game2Team1Player2: existing.game2Team1Player2,
        game2Team2Player: existing.game2Team2Player,
        game2Team2Player2: existing.game2Team2Player2,
        game3Team1Player: existing.game3Team1Player,
        game3Team1Player2: existing.game3Team1Player2,
        game3Team2Player: existing.game3Team2Player,
        game3Team2Player2: existing.game3Team2Player2,
      );
    }).toList();
  }

  void _resolveEliminationPlaceholdersFromTournamentDetails() {
    bool isPlaceholder(String text) {
      final low = text.trim().toLowerCase();
      if (low.isEmpty) return false;
      if (low == 'tbd') return true;
      if (low.startsWith('winner')) return true;
      if (low.startsWith('loser')) return true;
      if (low.startsWith('w ')) return true;
      if (low.startsWith('l ')) return true;
      return false;
    }

    String normalizeRef(String raw) {
      var s = raw.trim().toLowerCase();
      s = s.replaceAll(RegExp(r'[\s]+'), '');
      s = s.replaceAll('_', '-');
      s = s.replaceAll(RegExp(r'[^a-z0-9-]'), '');

      final r32 = RegExp(r'^(?:round)?32-?(\d+)$').firstMatch(s) ??
          RegExp(r'^r32-?(\d+)$').firstMatch(s);
      if (r32 != null) return 'r32-${r32.group(1)}';

      final r16 = RegExp(r'^(?:round)?16-?(\d+)$').firstMatch(s) ??
          RegExp(r'^r16-?(\d+)$').firstMatch(s);
      if (r16 != null) return 'r16-${r16.group(1)}';

      final qf = RegExp(r'^(?:quarter|qf|q)-?(\d+)$').firstMatch(s);
      if (qf != null) return 'qf${qf.group(1)}';

      final sf = RegExp(r'^(?:semi|sf)-?(\d+)$').firstMatch(s);
      if (sf != null) return 'sf${sf.group(1)}';

      final cf = RegExp(r'^(?:crossover|cf)-?(\d+)$').firstMatch(s);
      if (cf != null) return 'cf${cf.group(1)}';

      if (s == 'finals' || s == 'final') return 'final';
      if (s == 'brz' || s == 'bronze') return 'bronze';
      return s;
    }

    String? extractRefFromPlaceholder(String text) {
      final trimmed = text.trim();
      final m = RegExp(r'^(Winner|Loser)\s+(.+)$', caseSensitive: false).firstMatch(trimmed);
      if (m != null) return normalizeRef(m.group(2) ?? '');
      final m2 = RegExp(r'^(W|L)\s+(.+)$', caseSensitive: false).firstMatch(trimmed);
      if (m2 != null) return normalizeRef(m2.group(2) ?? '');
      return null;
    }

    bool isWinnerPlaceholder(String text) =>
        RegExp(r'^\s*(Winner|W)\b', caseSensitive: false).hasMatch(text);

    bool isLoserPlaceholder(String text) =>
        RegExp(r'^\s*(Loser|L)\b', caseSensitive: false).hasMatch(text);

    String makeWinnerPlaceholder(String ref) => 'Winner $ref';
    String makeLoserPlaceholder(String ref) => 'Loser $ref';

    // Detect per-category elim shape from matches present.
    //
    // 1 bracket: GOLD = A1 vs A2, BRONZE = A3 vs A4 (no SF/QF)
    // 2 brackets: SF seeded from groups → GOLD/BRONZE from SF W/L
    // 4 brackets: QF → SF → GOLD/BRONZE
    // 8 brackets: R16 → QF → SF → GOLD/BRONZE
    // 16 brackets / Round of 32:
    //   R32 → R16 → QF → SF → GOLD/BRONZE
    //   R32 seeds (16 matches):
    //     1 A1-H2, 2 B1-G2, 3 C1-F2, 4 D1-E2,
    //     5 E1-D2, 6 F1-C2, 7 G1-B2, 8 H1-A2,
    //     9 I1-P2, 10 J1-O2, 11 K1-N2, 12 L1-M2,
    //     13 M1-L2, 14 N1-K2, 15 O1-J2, 16 P1-I2
    //   R16-N = winners of R32-(2N-1) vs R32-(2N)
    //   Q-N   = winners of R16-(2N-1) vs R16-(2N)
    //   SF-1  = Q-1 vs Q-2 winners; SF-2 = Q-3 vs Q-4 winners
    //   GOLD  = SF winners; BRONZE = SF losers
    final categoriesWithR32 = <String>{};
    final categoriesWithR16 = <String>{};
    final categoriesWithQF = <String>{};
    final categoriesWithSF = <String>{};
    final categoriesWithCF = <String>{};
    for (final m in games) {
      if (m.type != 'elimination') continue;
      final cat = m.categoryId.trim();
      if (cat.isEmpty) continue;
      switch (m.roundShort.trim().toUpperCase()) {
        case 'R32':
          categoriesWithR32.add(cat);
          break;
        case 'R16':
          categoriesWithR16.add(cat);
          break;
        case 'QF':
          categoriesWithQF.add(cat);
          break;
        case 'SF':
          categoriesWithSF.add(cat);
          break;
        case 'CF':
          categoriesWithCF.add(cat);
          break;
      }
    }

    List<String>? expectedPlaceholders(
      String roundShort,
      String matchKeyNorm,
      String categoryId,
    ) {
      final rs = roundShort.trim().toUpperCase();
      final cat = categoryId.trim();
      final hasR32 = categoriesWithR32.contains(cat);
      final hasCF = categoriesWithCF.contains(cat);
      final hasQF = categoriesWithQF.contains(cat);
      final hasSF = categoriesWithSF.contains(cat);
      final hasR16 = categoriesWithR16.contains(cat);
      // 1-bracket medal matches: standings labels / names already on the match.
      final isSingleBracketMedals =
          !hasSF && !hasQF && !hasCF && !hasR16 && !hasR32;

      // Round of 32: R16 is fed by consecutive R32 winners.
      // R16-1 = W(R32-1)=A1/H2 vs W(R32-2)=B1/G2, ... R16-8 = W(R32-15) vs W(R32-16).
      // In API data these R16 slots are often stored as quarter1..quarter8.
      if (rs == 'R16' && hasR32) {
        var n = int.tryParse(
          RegExp(r'^r16-(\d+)$').firstMatch(matchKeyNorm)?.group(1) ?? '',
        );
        n ??= int.tryParse(
          RegExp(r'^qf(\d+)$').firstMatch(matchKeyNorm)?.group(1) ?? '',
        );
        if (n != null && n >= 1 && n <= 8) {
          final a = (n - 1) * 2 + 1;
          final b = a + 1;
          return [
            makeWinnerPlaceholder('R32-$a'),
            makeWinnerPlaceholder('R32-$b'),
          ];
        }
      }

      // Quarters from R16 winners (8-bracket and Round of 32).
      // In Round of 32, Quarters may be stored as semi1..4 (sf keys).
      if (rs == 'QF' && hasR16) {
        final key = matchKeyNorm.startsWith('sf')
            ? 'qf${matchKeyNorm.substring(2)}'
            : matchKeyNorm;
        if (key == 'qf1') {
          return [makeWinnerPlaceholder('R16-1'), makeWinnerPlaceholder('R16-2')];
        }
        if (key == 'qf2') {
          return [makeWinnerPlaceholder('R16-3'), makeWinnerPlaceholder('R16-4')];
        }
        if (key == 'qf3') {
          return [makeWinnerPlaceholder('R16-5'), makeWinnerPlaceholder('R16-6')];
        }
        if (key == 'qf4') {
          return [makeWinnerPlaceholder('R16-7'), makeWinnerPlaceholder('R16-8')];
        }
      }

      if (rs == 'SF') {
        // Round of 32: semi1..4 are Quarters (A-H / I-P paths), not true semis.
        if (hasR32 && hasCF) {
          final n = int.tryParse(
                RegExp(r'^sf(\d+)$').firstMatch(matchKeyNorm)?.group(1) ?? '') ??
              int.tryParse(
                RegExp(r'^qf(\d+)$').firstMatch(matchKeyNorm)?.group(1) ?? '');
          if (n == 1) {
            return [makeWinnerPlaceholder('R16-1'), makeWinnerPlaceholder('R16-2')];
          }
          if (n == 2) {
            return [makeWinnerPlaceholder('R16-3'), makeWinnerPlaceholder('R16-4')];
          }
          if (n == 3) {
            return [makeWinnerPlaceholder('R16-5'), makeWinnerPlaceholder('R16-6')];
          }
          if (n == 4) {
            return [makeWinnerPlaceholder('R16-7'), makeWinnerPlaceholder('R16-8')];
          }
          return null;
        }
        // 2-bracket SF is seeded from group standings (not QF winners).
        if (!hasQF) return null;
        if (matchKeyNorm == 'sf1') {
          return [makeWinnerPlaceholder('QF1'), makeWinnerPlaceholder('QF2')];
        }
        if (matchKeyNorm == 'sf2') {
          return [makeWinnerPlaceholder('QF3'), makeWinnerPlaceholder('QF4')];
        }
        if (matchKeyNorm == 'sf3') {
          return [makeWinnerPlaceholder('QF5'), makeWinnerPlaceholder('QF6')];
        }
        if (matchKeyNorm == 'sf4') {
          return [makeWinnerPlaceholder('QF7'), makeWinnerPlaceholder('QF8')];
        }
      }
      if (rs == 'CF') {
        // True Semis (display SF). Website/API placeholders use QF = Quarters
        // (semi*), not R16 (quarter*):
        //   SF1 / cf1 = A–H = Winner QF1 vs Winner QF2
        //   SF2 / cf2 = I–P = Winner QF3 vs Winner QF4
        if (matchKeyNorm == 'cf1') {
          return [makeWinnerPlaceholder('QF1'), makeWinnerPlaceholder('QF2')];
        }
        if (matchKeyNorm == 'cf2') {
          return [makeWinnerPlaceholder('QF3'), makeWinnerPlaceholder('QF4')];
        }
        return [makeWinnerPlaceholder('QF1'), makeWinnerPlaceholder('QF2')];
      }
      if (rs == 'BRONZE') {
        if (isSingleBracketMedals) return null;
        // Round of 32 stores true semis as CF1/CF2; placeholders may say SF.
        if (hasCF) {
          return [makeLoserPlaceholder('CF1'), makeLoserPlaceholder('CF2')];
        }
        return [makeLoserPlaceholder('SF1'), makeLoserPlaceholder('SF2')];
      }
      if (rs == 'GOLD') {
        if (isSingleBracketMedals) return null;
        if (hasCF) {
          return [makeWinnerPlaceholder('CF1'), makeWinnerPlaceholder('CF2')];
        }
        return [makeWinnerPlaceholder('SF1'), makeWinnerPlaceholder('SF2')];
      }
      return null;
    }

    String scopedResultKey(String categoryId, String ref) =>
        '${categoryId.trim()}|${ref.trim()}';

    /// Round of 32 reuses legacy ids — keep winner keys separated by round:
    ///   round16_* (title R32) → r32-N
    ///   quarter*  (title R16) → r16-N
    ///   semi*     (title QF)  → sf-N / qf-N  (website "Winner QF")
    ///   cf*       (title SF)  → cf-N
    Set<String> identityKeysForMatch(TournamentMatch m) {
      final keys = <String>{};
      void addRaw(String raw) {
        final n = normalizeRef(raw);
        if (n.isNotEmpty) keys.add(n);
      }

      addRaw(m.matchKey);
      addRaw(m.id);

      final rs = m.roundShort.trim().toUpperCase();
      final hasR32 = categoriesWithR32.contains(m.categoryId.trim());

      if (hasR32 && rs == 'R32') {
        // round16_N normalizes to r16-N — do not pollute real R16 lookups.
        for (final k in [...keys]) {
          final n16 = RegExp(r'^r16-(\d+)$').firstMatch(k);
          if (n16 != null) {
            keys.remove(k);
            keys.add('r32-${n16.group(1)}');
          }
        }
      } else if (hasR32 && rs == 'R16') {
        // quarterN normalizes to qfN — reserve qf for Quarters (Winner QF).
        for (final k in [...keys]) {
          final nQf = RegExp(r'^qf(\d+)$').firstMatch(k);
          if (nQf != null) {
            keys.remove(k);
            keys.add('r16-${nQf.group(1)}');
          }
        }
      } else if (hasR32 && (rs == 'QF' || rs == 'SF')) {
        // Quarters live in semi* ids; website placeholders say Winner QF-N.
        for (final k in [...keys]) {
          final nSf = RegExp(r'^sf(\d+)$').firstMatch(k);
          if (nSf != null) {
            keys.add('sf${nSf.group(1)}');
            keys.add('qf${nSf.group(1)}');
          }
        }
      } else {
        for (final k in [...keys]) {
          final n32 = RegExp(r'^r32-(\d+)$').firstMatch(k);
          if (n32 != null) {
            keys.add('r32-${n32.group(1)}');
            keys.add('r16-${n32.group(1)}');
          }
          final n16 = RegExp(r'^r16-(\d+)$').firstMatch(k);
          if (n16 != null) {
            final num = n16.group(1)!;
            keys.add('r16-$num');
            final n = int.tryParse(num) ?? 0;
            if (n >= 9) keys.add('r32-$num');
          }
          final nSf = RegExp(r'^sf(\d+)$').firstMatch(k);
          if (rs == 'QF') {
            if (nSf != null) keys.add('qf${nSf.group(1)}');
            final nQf = RegExp(r'^qf(\d+)$').firstMatch(k);
            if (nQf != null) keys.add('sf${nQf.group(1)}');
          }
          if (rs == 'R16') {
            final nQf = RegExp(r'^qf(\d+)$').firstMatch(k);
            if (nQf != null) keys.add('r16-${nQf.group(1)}');
          }
        }
      }

      // Title / label fallback: "Round of 32 - 9" / "R32_9" / "32-9"
      final labelBlob =
          '${m.matchLabel} ${m.seedLabel} ${m.round} ${m.roundLabel} ${m.id} ${m.matchKey}';
      final fromLabel = RegExp(
        r'(?:r\s*32|round\s*of\s*32|round\s*32|32)[\s_-]*(\d+)',
        caseSensitive: false,
      ).firstMatch(labelBlob);
      if (fromLabel != null) {
        final n = fromLabel.group(1);
        if (n != null && n.isNotEmpty) {
          keys.add('r32-$n');
        }
      }
      return keys;
    }

    Set<String> lookupAliasesForRef(String ref, String categoryId) {
      final out = <String>{};
      final n = normalizeRef(ref);
      if (n.isEmpty) return out;
      final hasR32 = categoriesWithR32.contains(categoryId.trim());

      // R32: "Winner QF-N" = Quarter-Final N (semi*), never R16 (quarter*).
      final nQf = RegExp(r'^qf(\d+)$').firstMatch(n);
      if (nQf != null && hasR32) {
        out.add('sf${nQf.group(1)}');
        out.add('qf${nQf.group(1)}');
        return out;
      }

      out.add(n);
      final n32 = RegExp(r'^r32-(\d+)$').firstMatch(n);
      if (n32 != null && !hasR32) {
        // Legacy only: some R32 rows were indexed under r16-*.
        out.add('r16-${n32.group(1)}');
      }
      final n16 = RegExp(r'^r16-(\d+)$').firstMatch(n);
      if (n16 != null) {
        final num = int.tryParse(n16.group(1) ?? '') ?? 0;
        // Never fall back to r32 for real R16 slots (1..8) in Round of 32.
        if (num >= 9 && !hasR32) {
          out.add('r32-${n16.group(1)}');
        }
      }
      return out;
    }

    bool sameName(String a, String b) {
      String norm(String s) {
        return s.trim().toLowerCase().replaceAll(RegExp(r'\s+'), ' ');
      }
      return norm(a) == norm(b);
    }

    String? winnerName(TournamentMatch m) {
      final w = (m.winner ?? '').toString().trim();
      final p1 = m.player1.trim();
      final p2 = m.player2.trim();
      // Only trust an explicit winner when it is a real player name (not a
      // bracket placeholder like "Winner QF2") and matches one side.
      if (w.isNotEmpty &&
          !isPlaceholder(w) &&
          (p1.isNotEmpty || p2.isNotEmpty) &&
          (sameName(w, p1) || sameName(w, p2))) {
        return w;
      }

      // Best-of-N: count games/sets won — same as website Brackets.jsx.
      // Do NOT use the last played game's point score (e.g. Game 3 4-11),
      // which incorrectly flips the series winner.
      int p1Wins = 0;
      int p2Wins = 0;
      for (int i = 1; i <= 3; i++) {
        final a = (i == 1
                ? m.game1Player1
                : (i == 2 ? m.game2Player1 : m.game3Player1)) ??
            0;
        final b = (i == 1
                ? m.game1Player2
                : (i == 2 ? m.game2Player2 : m.game3Player2)) ??
            0;
        if (a + b <= 0) continue;
        if (a > b) {
          p1Wins += 1;
        } else if (b > a) {
          p2Wins += 1;
        }
      }
      if (p1Wins > p2Wins) {
        return p1.isNotEmpty ? p1 : null;
      }
      if (p2Wins > p1Wins) {
        return p2.isNotEmpty ? p2 : null;
      }

      // Fallback: overall point totals (single-game / incomplete series).
      if (m.score1 > m.score2) {
        return p1.isNotEmpty ? p1 : null;
      }
      if (m.score2 > m.score1) {
        return p2.isNotEmpty ? p2 : null;
      }
      return null;
    }

    String? loserName(TournamentMatch m) {
      final w = winnerName(m);
      if (w == null) return null;
      final p1 = m.player1.trim();
      final p2 = m.player2.trim();
      if (p1.isEmpty || p2.isEmpty) return null;
      if (sameName(w, p1)) return p2;
      if (sameName(w, p2)) return p1;
      return null;
    }

    final elimMatches = games.where((m) => m.type == 'elimination').toList();
    if (elimMatches.isEmpty) return;

    bool applyPlaceholderCorrections() {
      bool changed = false;
      games = games.map((m) {
        if (m.type != 'elimination') return m;
        final key = normalizeRef(m.matchKey.trim().isNotEmpty ? m.matchKey : m.id);
        final expected = expectedPlaceholders(m.roundShort, key, m.categoryId);
        if (expected == null || expected.length != 2) return m;

        String correctSide(String current, String expectedText) {
          final cur = current.trim();
          if (!isPlaceholder(cur)) return current;
          final curRef = extractRefFromPlaceholder(cur);
          final expRef = extractRefFromPlaceholder(expectedText) ?? normalizeRef(expectedText);
          if (curRef == null || curRef.isEmpty) return expectedText;
          if (curRef != expRef) return expectedText;
          if (isWinnerPlaceholder(expectedText) && !isWinnerPlaceholder(cur)) return expectedText;
          if (isLoserPlaceholder(expectedText) && !isLoserPlaceholder(cur)) return expectedText;
          return current;
        }

        final newP1 = correctSide(m.player1, expected[0]);
        final newP2 = correctSide(m.player2, expected[1]);
        if (newP1 == m.player1 && newP2 == m.player2) return m;
        changed = true;
        return TournamentMatch(
          id: m.id,
          documentId: m.documentId,
          scheduleFromAssignments: m.scheduleFromAssignments,
          player1: newP1,
          player2: newP2,
          player1Name: m.player1Name,
          player2Name: m.player2Name,
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
          roundShort: m.roundShort,
          roundLabel: m.roundLabel,
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
          scoringFormat: m.scoringFormat,
          game1Team1Player: m.game1Team1Player,
          game1Team1Player2: m.game1Team1Player2,
          game1Team2Player: m.game1Team2Player,
          game1Team2Player2: m.game1Team2Player2,
          game2Team1Player: m.game2Team1Player,
          game2Team1Player2: m.game2Team1Player2,
          game2Team2Player: m.game2Team2Player,
          game2Team2Player2: m.game2Team2Player2,
          game3Team1Player: m.game3Team1Player,
          game3Team1Player2: m.game3Team1Player2,
          game3Team2Player: m.game3Team2Player,
          game3Team2Player2: m.game3Team2Player2,
        );
      }).toList();
      return changed;
    }

    applyPlaceholderCorrections();

    for (int pass = 0; pass < 4; pass++) {
      final winners = <String, String>{};
      final losers = <String, String>{};
      final elim = games.where((m) => m.type == 'elimination').toList();
      for (final m in elim) {
        final w = winnerName(m);
        final l = loserName(m);
        final identityKeys = identityKeysForMatch(m);
        for (final key in identityKeys) {
          final scoped = scopedResultKey(m.categoryId, key);
          if (w != null && w.trim().isNotEmpty && !isPlaceholder(w)) {
            winners[scoped] = w.trim();
          }
          if (l != null && l.trim().isNotEmpty && !isPlaceholder(l)) {
            losers[scoped] = l.trim();
          }
        }
      }

      if (kDebugMode) {
        String? w(String cat, String k) => winners[scopedResultKey(cat, k)];
        String? l(String cat, String k) => losers[scopedResultKey(cat, k)];
        final sampleCat = elim.isNotEmpty ? elim.first.categoryId.trim() : '';
        debugPrint(
          '[elim-resolve] pass=$pass keys=${winners.length}/${losers.length} cat=$sampleCat '
          'w:r32-1=${w(sampleCat, 'r32-1')} r32-9=${w(sampleCat, 'r32-9')} '
          'r16-9=${w(sampleCat, 'r16-9')} '
          'sf1=${w(sampleCat, 'sf1')} sf2=${w(sampleCat, 'sf2')} '
          'l:sf1=${l(sampleCat, 'sf1')} sf2=${l(sampleCat, 'sf2')}',
        );
      }

      bool changed = false;
      games = games.map((m) {
        if (m.type != 'elimination') return m;

        final key = normalizeRef(m.matchKey.trim().isNotEmpty ? m.matchKey : m.id);
        final expected = expectedPlaceholders(m.roundShort, key, m.categoryId);
        // Never overwrite a concrete player name with a feeder placeholder.
        // Only fill empty / placeholder sides from the expected bracket path.
        String baseP1 = m.player1;
        String baseP2 = m.player2;
        if (expected != null && expected.length == 2) {
          if (baseP1.trim().isEmpty || isPlaceholder(baseP1)) {
            baseP1 = expected[0];
          }
          if (baseP2.trim().isEmpty || isPlaceholder(baseP2)) {
            baseP2 = expected[1];
          }
        }

        String? lookupResult(Map<String, String> table, String ref) {
          for (final alias in lookupAliasesForRef(ref, m.categoryId)) {
            final found = table[scopedResultKey(m.categoryId, alias)];
            if (found != null && found.trim().isNotEmpty) return found;
          }
          return null;
        }

        String resolveSide(String current) {
          final text = current.trim();
          if (!isPlaceholder(text)) return current;
          final ref = extractRefFromPlaceholder(text);
          if (ref == null || ref.isEmpty) return current;
          if (isWinnerPlaceholder(text)) {
            final found = lookupResult(winners, ref);
            if (found != null) return found;
          } else if (isLoserPlaceholder(text)) {
            final found = lookupResult(losers, ref);
            if (found != null) return found;
          }
          return current;
        }

        final p1 = resolveSide(baseP1);
        final p2 = resolveSide(baseP2);
        String syncedName(String currentName, String oldPlayer, String newPlayer) {
          final n = currentName.trim();
          if (n.isEmpty) return currentName;
          if (isPlaceholder(n)) return isPlaceholder(newPlayer) ? currentName : newPlayer;
          // Keep team/display names unless they still mirror the unresolved side.
          if (oldPlayer != newPlayer && sameName(n, oldPlayer)) return newPlayer;
          return currentName;
        }

        final nextName1 = syncedName(m.player1Name, m.player1, p1);
        final nextName2 = syncedName(m.player2Name, m.player2, p2);
        if (kDebugMode && (m.roundShort.toUpperCase() == 'GOLD' || m.roundShort.toUpperCase() == 'BRONZE')) {
          debugPrint(
            '[elim-resolve] ${m.roundShort} key=$key cat=${m.categoryId} '
            'before="${m.player1} vs ${m.player2}" '
            'base="$baseP1 vs $baseP2" resolved="$p1 vs $p2"',
          );
        }
        if (p1 == m.player1 &&
            p2 == m.player2 &&
            nextName1 == m.player1Name &&
            nextName2 == m.player2Name) {
          return m;
        }
        changed = true;
        return TournamentMatch(
          id: m.id,
          documentId: m.documentId,
          scheduleFromAssignments: m.scheduleFromAssignments,
          player1: p1,
          player2: p2,
          player1Name: nextName1,
          player2Name: nextName2,
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
          roundShort: m.roundShort,
          roundLabel: m.roundLabel,
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
          scoringFormat: m.scoringFormat,
          game1Team1Player: m.game1Team1Player,
          game1Team1Player2: m.game1Team1Player2,
          game1Team2Player: m.game1Team2Player,
          game1Team2Player2: m.game1Team2Player2,
          game2Team1Player: m.game2Team1Player,
          game2Team1Player2: m.game2Team1Player2,
          game2Team2Player: m.game2Team2Player,
          game2Team2Player2: m.game2Team2Player2,
          game3Team1Player: m.game3Team1Player,
          game3Team1Player2: m.game3Team1Player2,
          game3Team2Player: m.game3Team2Player,
          game3Team2Player2: m.game3Team2Player2,
        );
      }).toList();

      if (!changed) break;
    }
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
      final gameStatusKey = 'game${selectedIndex}Status';
      final explicitGameStatusRaw = payloadFields[gameStatusKey]?.toString().trim() ?? '';
      final hasExplicitGameStatus = explicitGameStatusRaw.isNotEmpty;
      final explicitGameStatus =
          hasExplicitGameStatus ? normalizeStatus(explicitGameStatusRaw) : '';
      payloadFields['status'] = targetStatus;
      submitFields['status'] = targetStatus;
      if (hasExplicitGameStatus) {
        payloadFields[gameStatusKey] = explicitGameStatus;
        submitFields[gameStatusKey] = explicitGameStatus;
      } else {
        payloadFields[gameStatusKey] = targetStatus;
        submitFields[gameStatusKey] = targetStatus;
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
    final matchIdentity = _matchIdentityKey(g);
    final selectedIndex = inferredIndex.clamp(1, 3);
    final gameIdentity = _matchGameIdentityKey(g, selectedIndex);
    if (matchIdentity.isEmpty || gameIdentity.isEmpty) {
      error = 'Missing stable match identifier for score sync.';
      notifyListeners();
      return;
    }
    final isOngoingStatus = status == 'Ongoing';
    final isCompletedSubmit = status == 'Completed';
    final explicitGameStatusRaw =
        payloadFields['game${selectedIndex}Status']?.toString().trim() ?? '';
    final isGameCompletedSubmit =
        normalizeGameStatusKey(explicitGameStatusRaw) == 'completed' ||
        isCompletedSubmit;

    if (isGameCompletedSubmit) {
      _cancelPendingOngoingSync();
    }

    if (!isOngoingStatus && _inFlightSubmitSeqByMatch.containsKey(gameIdentity)) {
      error = 'Submission already in progress for this match.';
      notifyListeners();
      throw StateError(error!);
    }

    final applyOptimistically = tutorialSimulationMode ||
        status == null ||
        status.isEmpty ||
        isOngoingStatus ||
        status == 'Completed';
    if (applyOptimistically) {
      final updated = _mergeMatchWithFields(g, payloadFields);
      _replaceSelectedGame(updated, g);
      notifyListeners();
    }

    // Tutorial simulation skips all backend writes. The UI already got the
    // optimistic local merge above.
    if (tutorialSimulationMode) return;

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
        final latest = _findMatchByIdentity(matchIdentity);
        if (latest != null && gameStatusKey(latest, selectedIndex) == 'completed') {
          return;
        }
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
    final status = payload['status']?.toString().trim().toLowerCase() ?? '';
    if (status == 'scheduled' ||
        status == 'unschedule' ||
        status == 'unscheduled' ||
        status == 'called') {
      payload.remove('status');
    }
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
      roundShort: g.roundShort,
      roundLabel: g.roundLabel,
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
      signatureData:
          _pickNonEmptySignature(payload['signatureData']) ?? g.signatureData,
      gameSignatures: _mergeGameSignaturesList(
        g.gameSignatures,
        payload['gameSignatures'],
      ),
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
      return _mergeGameSignaturesList(existing, incoming) ??
          existing ??
          List<String?>.filled(3, null);
    }

    return refreshed.map((m) {
      final matchIdentity = _matchIdentityKey(m);
      final existing = existingByKey[matchIdentity];
      if (existing == null) return m;

      // Website unlock / reset to Scheduled is authoritative — but only after a
      // real Completed clear. Embed often still says Scheduled/0-0 while the
      // referee is live (Match + sockets already Ongoing). Wiping the queue then
      // resets clientSeq and makes OBS/Live Scores flicker empty.
      final incomingStatus = normalizeGameStatusKey(m.status);
      final incomingPoints = (m.game1Player1 ?? 0) +
          (m.game1Player2 ?? 0) +
          (m.game2Player1 ?? 0) +
          (m.game2Player2 ?? 0) +
          (m.game3Player1 ?? 0) +
          (m.game3Player2 ?? 0) +
          m.score1 +
          m.score2;
      final existingStatus = normalizeGameStatusKey(existing.status);
      final existingPoints = (existing.game1Player1 ?? 0) +
          (existing.game1Player2 ?? 0) +
          (existing.game2Player1 ?? 0) +
          (existing.game2Player2 ?? 0) +
          (existing.game3Player1 ?? 0) +
          (existing.game3Player2 ?? 0) +
          existing.score1 +
          existing.score2;
      final isActiveRefPanel = selectedGame != null &&
          _matchIdentityKey(selectedGame!) == matchIdentity;
      final hasLiveQueue = matchIdentity.isNotEmpty &&
          (scoreQueue.hasPendingForMatch(matchIdentity) ||
              scoreQueue.latestSnapshotFor(matchIdentity) != null);
      // Only protect an actively scored / open Ref Panel match. A leftover
      // score-queue snapshot must NOT block website re-schedules on pull-refresh
      // (Round Robin vanishing until full browser reload).
      final keepLocalLive = isActiveRefPanel ||
          (existingStatus == 'ongoing' && (existingPoints > 0 || hasLiveQueue));
      final incomingHasSchedule = m.court.trim().isNotEmpty &&
          m.time.trim().isNotEmpty &&
          m.date.trim().isNotEmpty;
      if (incomingStatus == 'scheduled' || incomingStatus == 'unschedule') {
        // Staff re-scheduled this match — take the fresh court/date/time.
        if (incomingStatus == 'scheduled' &&
            incomingHasSchedule &&
            incomingPoints <= 0 &&
            !(isActiveRefPanel && existingStatus == 'ongoing')) {
          if (existingStatus == 'completed' && matchIdentity.isNotEmpty) {
            unawaited(scoreQueue.discardMatch(matchIdentity));
          }
          return m;
        }
        if (incomingPoints <= 0 && keepLocalLive) {
          return existing;
        }
        // True staff unlock after Completed — drop stale queue + clear local.
        if (incomingPoints <= 0 &&
            matchIdentity.isNotEmpty &&
            existingStatus == 'completed') {
          unawaited(scoreQueue.discardMatch(matchIdentity));
        }
        if (incomingPoints <= 0) {
          return _forceClearedMatchStatuses(m);
        }
        return m;
      }
      // Embed lag: server/tournament payload still at 0 while local is live.
      // Never discard the score queue or clobber Ongoing/Completed progress.
      if (incomingPoints <= 0 && keepLocalLive) {
        return existing;
      }

      final overrides = <String, dynamic>{};
      for (int n = 1; n <= 3; n++) {
        final existingKey = gameStatusKey(existing, n);
        final incomingKey = gameStatusKey(m, n);
        if (keyRank(existingKey) > keyRank(incomingKey)) {
          final explicitExistingStatus = (n == 1)
              ? existing.game1Status
              : (n == 2 ? existing.game2Status : existing.game3Status);
          if (existingKey == 'completed') {
            overrides['game${n}Status'] = 'Completed';
          } else if (explicitExistingStatus.trim().isNotEmpty) {
            overrides['game${n}Status'] = explicitExistingStatus;
          }
          overrides['game${n}Player1'] = _scoreForGame(existing, n, true);
          overrides['game${n}Player2'] = _scoreForGame(existing, n, false);
        } else if (existingKey == 'completed' && incomingKey != 'completed') {
          overrides['game${n}Status'] = 'Completed';
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
      if (original.type == 'group' &&
          m.type == 'group' &&
          m.categoryId == original.categoryId &&
          m.groupId == original.groupId &&
          m.matchKey == original.matchKey) {
        return updated;
      }
      if (original.documentId.isNotEmpty && m.documentId == original.documentId) {
        return updated;
      }
      return m;
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
    final gamesArray = <Map<String, int>>[];
    for (int i = 1; i <= 3; i++) {
      final a =
          _fieldAsInt(fields, 'game${i}Player1', _scoreForGame(activeMatch, i, true)) ?? 0;
      final b =
          _fieldAsInt(fields, 'game${i}Player2', _scoreForGame(activeMatch, i, false)) ?? 0;
      if (a + b > 0) {
        gamesArray.add({'a': a, 'b': b});
      }
    }

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
    if (status == 'Completed') {
      payload['status'] = 'Completed';
      payload['markCompleted'] = true;
    }
    if (activeMatch.type == 'group') {
      payload['groupId'] = activeMatch.groupId;
      payload['matchKey'] = activeMatch.matchKey;
    } else {
      // Elimination matches are stored on the backend by their raw tournament id
      // (e.g. "quarter1", "semi1", "round16_1"). matchKey may be a schedule-only
      // alias (e.g. "qf1") used for court-assignment lookup — do not submit that
      // as matchId or the backend returns 404 "Match not found".
      final rawMatchId = activeMatch.id.trim();
      final aliasMatchKey = activeMatch.matchKey.trim();
      payload['matchId'] =
          rawMatchId.isNotEmpty ? rawMatchId : aliasMatchKey;
      final alias = aliasMatchKey.isNotEmpty ? aliasMatchKey : rawMatchId;
      if (alias.isNotEmpty) {
        payload['matchKey'] = alias;
        payload['bracketMatchId'] = alias;
      }
      payload['stage'] = 'elimination';
      if (activeMatch.documentId.trim().isNotEmpty) {
        payload['documentId'] = activeMatch.documentId;
        payload['_id'] = activeMatch.documentId;
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
          : 'matchId=${payload['matchId']}, docId=${payload['documentId'] ?? ''}, alias=${activeMatch.matchKey}';
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
      notifyListeners();
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
      if (key == 'signatureData') {
        final req = _pickNonEmptySignature(requestFields['signatureData']);
        final srv = _pickNonEmptySignature(serverMatch['signatureData']);
        final best = req ?? srv;
        if (best != null) {
          authoritative[key] = best;
        }
        continue;
      }
      if (key == 'gameSignatures') {
        final merged = _mergeGameSignaturesList(
          _mergeGameSignaturesList(
            null,
            requestFields['gameSignatures'],
          ),
          serverMatch['gameSignatures'],
        );
        if (merged != null &&
            merged.any((s) => (s ?? '').toString().trim().isNotEmpty)) {
          authoritative[key] = merged;
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
    final trimmed = s.trim();
    if (trimmed.isEmpty) return '';

    final low = trimmed.toLowerCase();
    for (final name in courts) {
      if (name.trim().toLowerCase() == low) return name.trim();
    }

    final m = RegExp(r'^\s*(?:Court\s*)?(\d+)\s*$', caseSensitive: false).firstMatch(trimmed);
    if (m != null) {
      final idx = int.tryParse(m.group(1) ?? '');
      if (idx != null && idx >= 1 && idx <= courts.length) {
        return courts[idx - 1].trim();
      }
      if (idx != null && idx >= 1) {
        return 'Court $idx';
      }
      return 'Court ${m.group(1)}';
    }

    return trimmed;
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
          player1Name: m.player1Name,
          player2Name: m.player2Name,
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
          roundShort: m.roundShort,
          roundLabel: m.roundLabel,
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
          game1Team1Player: m.game1Team1Player,
          game1Team1Player2: m.game1Team1Player2,
          game1Team2Player: m.game1Team2Player,
          game1Team2Player2: m.game1Team2Player2,
          game2Team1Player: m.game2Team1Player,
          game2Team1Player2: m.game2Team1Player2,
          game2Team2Player: m.game2Team2Player,
          game2Team2Player2: m.game2Team2Player2,
          game3Team1Player: m.game3Team1Player,
          game3Team1Player2: m.game3Team1Player2,
          game3Team2Player: m.game3Team2Player,
          game3Team2Player2: m.game3Team2Player2,
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
    if (match.type == 'group' &&
        match.categoryId.trim().isNotEmpty &&
        match.groupId.trim().isNotEmpty &&
        match.matchKey.trim().isNotEmpty) {
      return 'group:${match.categoryId.trim()}:${match.groupId.trim()}:${match.matchKey.trim()}';
    }
    if (match.documentId.trim().isNotEmpty) {
      return 'doc:${match.documentId.trim()}';
    }
    if (match.id.trim().isNotEmpty) {
      return 'id:${match.categoryId.trim()}:${match.groupId.trim()}:${match.id.trim()}';
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
    // Disabled: group-match PUT unschedules and zeros scores on the website.
  }

  Future<void> trySyncOutbox() async {
    if (_outbox.isEmpty) return;
    // Drop persisted PUTs instead of sending them.
    _outbox = [];
    await _saveOutbox();
    if (kDebugMode) {
      debugPrint('[score-sync] cleared group-match outbox without PUT');
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

  String _normalizeBracketRef(String raw) {
    var s = raw.trim().toLowerCase();
    s = s.replaceAll(RegExp(r'[\s]+'), '');
    s = s.replaceAll('_', '-');
    s = s.replaceAll(RegExp(r'[^a-z0-9-]'), '');

    final r32 = RegExp(r'^(?:round)?32-?(\d+)$').firstMatch(s) ??
        RegExp(r'^r32-?(\d+)$').firstMatch(s);
    if (r32 != null) return 'r32-${r32.group(1)}';

    final r16 = RegExp(r'^(?:round)?16-?(\d+)$').firstMatch(s) ??
        RegExp(r'^r16-?(\d+)$').firstMatch(s);
    if (r16 != null) return 'r16-${r16.group(1)}';

    final qf = RegExp(r'^(?:quarter|qf|q)-?(\d+)$').firstMatch(s);
    if (qf != null) return 'qf${qf.group(1)}';

    final sf = RegExp(r'^(?:semi|sf)-?(\d+)$').firstMatch(s);
    if (sf != null) return 'sf${sf.group(1)}';

    final cf = RegExp(r'^(?:crossover|cf)-?(\d+)$').firstMatch(s);
    if (cf != null) return 'cf${cf.group(1)}';

    return s;
  }

  String _formatDisplayBracketRef(String kind, String number) {
    switch (kind) {
      case 'r32':
        return '32-$number';
      case 'r16':
        return '16-$number';
      case 'q':
        return 'Q-$number';
      case 'sf':
        return 'SF-$number';
      default:
        return '$kind-$number';
    }
  }

  /// Remap internal bracket refs (CF/QF/SF/R16) to user-facing labels.
  String displayBracketRef(String rawRef, String categoryId) {
    final ref = _normalizeBracketRef(rawRef);
    if (ref.isEmpty) return rawRef.trim();

    if (categoryHasRoundOf32(categoryId)) {
      // Logic = two R16 halves (A–H, I–P); UI names only:
      // R32→32, R16→16, QF/semi→Q, CF→SF (SF1=A–H, SF2=I–P).
      // Website "Winner QF" means Quarters (semi*), not R16.
      if (ref.startsWith('r32-')) {
        return _formatDisplayBracketRef('r32', ref.substring(4));
      }
      if (ref.startsWith('r16-')) {
        return _formatDisplayBracketRef('r16', ref.substring(4));
      }
      if (ref.startsWith('qf')) {
        return _formatDisplayBracketRef('q', ref.substring(2));
      }
      if (ref.startsWith('sf')) {
        return _formatDisplayBracketRef('q', ref.substring(2));
      }
      if (ref.startsWith('cf')) {
        return _formatDisplayBracketRef('sf', ref.substring(2));
      }
      return rawRef.trim();
    }

    if (categoryHasCrossover(categoryId)) {
      if (ref.startsWith('cf')) {
        return _formatDisplayBracketRef('sf', ref.substring(2));
      }
      if (ref.startsWith('sf')) {
        return _formatDisplayBracketRef('q', ref.substring(2));
      }
      if (ref.startsWith('qf')) {
        return _formatDisplayBracketRef('r16', ref.substring(2));
      }
      if (ref.startsWith('r16-')) {
        return _formatDisplayBracketRef('r32', ref.substring(4));
      }
      return rawRef.trim();
    }

    return rawRef.trim();
  }

  /// Remap feeder placeholders like "Winner CF1" → "Winner SF-1".
  String displayPlayerName(TournamentMatch m, String player) {
    final text = player.trim();
    if (text.isEmpty || m.type != 'elimination') return player;

    final winner = RegExp(r'^(Winner|Loser)\s+(.+)$', caseSensitive: false).firstMatch(text);
    if (winner != null) {
      final prefix = winner.group(1)!;
      final ref = displayBracketRef(winner.group(2) ?? '', m.categoryId);
      return '$prefix $ref';
    }

    final short = RegExp(r'^(W|L)\s+(.+)$', caseSensitive: false).firstMatch(text);
    if (short != null) {
      final prefix = short.group(1)!;
      final ref = displayBracketRef(short.group(2) ?? '', m.categoryId);
      return '$prefix $ref';
    }

    return player;
  }

  bool _isWeakPlayerLabel(String raw) {
    final s = raw.trim();
    if (s.isEmpty) return true;
    final low = s.toLowerCase();
    if (low == 'tbd' || RegExp(r'^team\s*[12]$').hasMatch(low)) return true;
    if (RegExp(r'^[a-p]\d+$', caseSensitive: false).hasMatch(s)) return true;
    if (low.startsWith('winner') || low.startsWith('loser')) return true;
    if (RegExp(r'^[wl]\s+', caseSensitive: false).hasMatch(s)) return true;
    return false;
  }

  /// Website Brackets edits write `player1`/`player2`. `player1Name`/`player2Name`
  /// can stay stale after unlock/repick — prefer the concrete player slot.
  String sideDisplayName(TournamentMatch g, {required bool team1}) {
    final slot = (team1 ? g.player1 : g.player2).trim();
    final named = (team1 ? g.player1Name : g.player2Name).trim();
    final slotWeak = _isWeakPlayerLabel(slot);
    final namedWeak = _isWeakPlayerLabel(named);
    String chosen;
    if (!slotWeak && !namedWeak) {
      chosen = slot; // authoritative bracket field
    } else if (!slotWeak) {
      chosen = slot;
    } else if (!namedWeak) {
      chosen = named;
    } else {
      chosen = slot.isNotEmpty ? slot : named;
    }
    return displayPlayerName(g, chosen);
  }

  /// True Round of 32 (16 first-round matches), not legacy CF remapping.
  bool categoryHasRoundOf32(String categoryId) {
    final cat = categoryId.trim();
    if (cat.isEmpty) return false;
    return games.any((m) =>
        m.type == 'elimination' &&
        m.categoryId.trim() == cat &&
        m.roundShort.trim().toUpperCase() == 'R32');
  }

  /// Legacy "double R16" brackets that used CF (Crossover) before true R32.
  bool categoryHasCrossover(String categoryId) {
    final cat = categoryId.trim();
    if (cat.isEmpty) return false;
    if (categoryHasRoundOf32(cat)) return false;
    return games.any((m) =>
        m.type == 'elimination' &&
        m.categoryId.trim() == cat &&
        m.roundShort.trim().toUpperCase() == 'CF');
  }

  int? _elimMatchNumber(TournamentMatch m) {
    final raw = (m.matchKey.trim().isNotEmpty ? m.matchKey : m.id).trim().toLowerCase();
    final compact = raw.replaceAll(RegExp(r'[\s_]+'), '-');
    for (final pattern in [
      RegExp(r'r32-?(\d+)'),
      RegExp(r'round32-?(\d+)'),
      RegExp(r'r16-?(\d+)'),
      RegExp(r'round16-?(\d+)'),
      RegExp(r'(?:quarter|qf|q)-?(\d+)'),
      RegExp(r'(?:semi|sf)-?(\d+)'),
      RegExp(r'(?:crossover|cf)-?(\d+)'),
    ]) {
      final match = pattern.firstMatch(compact);
      if (match != null) return int.tryParse(match.group(1) ?? '');
    }
    return null;
  }

  /// Compact match badge like the website: 32-1, 16-1, Q-1, SF-1, GOLD.
  String displayMatchBadge(TournamentMatch m) {
    if (m.type != 'elimination') return '';
    final rs = m.roundShort.trim().toUpperCase();
    final n = _elimMatchNumber(m);

    if (categoryHasRoundOf32(m.categoryId)) {
      switch (rs) {
        case 'R32':
          return n != null ? '32-$n' : '32';
        case 'R16':
          return n != null ? '16-$n' : '16';
        case 'QF':
          return n != null ? 'Q-$n' : 'Q';
        case 'SF':
          // R32: semi* ids are Quarters (A–H / I–P paths).
          return n != null ? 'Q-$n' : 'Q';
        case 'CF':
          // R32: cf* ids are true Semis (SF1 = A–H, SF2 = I–P).
          return n != null ? 'SF-$n' : 'SF';
        case 'GOLD':
          return 'GOLD';
        case 'BRONZE':
          return 'BRONZE';
        default:
          return m.roundShort;
      }
    }

    if (categoryHasCrossover(m.categoryId)) {
      switch (rs) {
        case 'R16':
          return n != null ? '32-$n' : '32';
        case 'QF':
          return n != null ? '16-$n' : '16';
        case 'SF':
          return n != null ? 'Q-$n' : 'Q';
        case 'CF':
          return n != null ? 'SF-$n' : 'SF';
        case 'GOLD':
          return 'GOLD';
        case 'BRONZE':
          return 'BRONZE';
        default:
          return m.roundShort;
      }
    }

    switch (rs) {
      case 'R16':
        return n != null ? '16-$n' : 'R16';
      case 'QF':
        return n != null ? 'Q-$n' : 'QF';
      case 'SF':
        return n != null ? 'SF-$n' : 'SF';
      case 'GOLD':
        return 'GOLD';
      case 'BRONZE':
        return 'BRONZE';
      default:
        return m.roundShort;
    }
  }

  /// Round of 32 display: 32-N > 16-N > Q-N > SF-N > Gold/Bronze
  /// Legacy CF display: R16>QF>SF>CF remapped to 32-N>16-N>Q-N>SF-N
  String displayRoundShort(TournamentMatch m) {
    final badge = displayMatchBadge(m);
    if (badge.isNotEmpty && m.type == 'elimination') return badge;
    return m.roundShort;
  }

  /// Same title used on court list cards and the referee dashboard AppBar.
  String displayMatchTitle(TournamentMatch m, int gameNo) {
    final gpm = gamesPerMatchFor(m).clamp(1, 3);
    final n = gameNo.clamp(1, 3);
    String base = '';
    if (m.type == 'elimination') {
      final badge = displayMatchBadge(m).trim();
      if (badge.isNotEmpty) {
        base = badge;
      } else {
        final rl = displayRoundLabel(m).trim();
        if (rl.isNotEmpty) base = rl;
      }
    }
    if (base.isEmpty) {
      final sl = m.seedLabel.trim();
      if (sl.isNotEmpty) {
        base = sl;
      } else {
        var ml = m.matchLabel.trim();
        ml = ml
            .replaceAll(
              RegExp(r'^\s*GA\d+(?:\.\d+)?\s*-\s*', caseSensitive: false),
              '',
            )
            .trim();
        base = ml.isNotEmpty ? ml : 'Match';
      }
    }
    // Single-game matches: "GOLD" only — no " · Game 1/2/3".
    if (gpm <= 1) return base;
    return '$base · Game $n';
  }

  String displayRoundLabel(TournamentMatch m) {
    if (m.type != 'elimination') return m.roundLabel;
    final rs = m.roundShort.trim().toUpperCase();

    if (categoryHasRoundOf32(m.categoryId)) {
      switch (rs) {
        case 'R32':
          return 'Round of 32';
        case 'R16':
          return 'Round of 16';
        case 'QF':
          return 'Quarter Finals';
        case 'SF':
          // R32: semi* = Quarters even if roundShort still says SF.
          return 'Quarter Finals';
        case 'CF':
          return 'Semi-Finals';
        case 'GOLD':
          return 'Battle for Gold';
        case 'BRONZE':
          return 'Battle for Bronze';
        default:
          return m.roundLabel;
      }
    }

    if (!categoryHasCrossover(m.categoryId)) {
      return m.roundLabel;
    }
    switch (rs) {
      case 'R16':
        return 'Round of 32';
      case 'QF':
        return 'Round of 16';
      case 'SF':
        return 'Quarter Finals';
      case 'CF':
        return 'Semi-Finals';
      default:
        return m.roundLabel;
    }
  }

  Future<void> logout({String? reason}) async {
    _ongoingSyncTimer?.cancel();
    _scheduleRefreshDebounce?.cancel();
    leaveLiveMatchRooms();
    leaveLiveTournament();
    _detachLiveListeners();
    _socket.disconnect();
    _tutorialSimulationMode = false;
    _savedSelectedTournament = null;
    _savedSelectedGame = null;
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
    _api.clearToken();
    error = reason;
    notifyListeners();
  }

  // ---------------------------------------------------------------------------
  // Live Socket.IO
  // - score/status/schedule: receive-only (+ room join/leave)
  // - match_update: local-first emit via MatchUpdateQueue for OBS overlays
  // ---------------------------------------------------------------------------

  void _ensureLiveSocket() {
    if (tutorialSimulationMode) return;
    final s = _socket.ensureConnected(apiBaseUrl.isNotEmpty ? apiBaseUrl : _api.baseUrl);
    if (s == null) return;
    _attachLiveListeners();
  }

  void _attachLiveListeners() {
    if (_liveListenersAttached) return;
    final s = _socket.socket;
    if (s == null) return;
    _liveListenersAttached = true;
    s.on('score-updated', _onLiveScoreUpdated);
    s.on('status-updated', _onLiveStatusUpdated);
    s.on('schedule-updated', _onLiveScheduleUpdated);
    s.on('connect', _onSocketConnect);
    s.on('reconnect', _onSocketReconnect);
  }

  void _detachLiveListeners() {
    if (!_liveListenersAttached) return;
    _liveListenersAttached = false;
    _socket.off('score-updated', _onLiveScoreUpdated);
    _socket.off('status-updated', _onLiveStatusUpdated);
    _socket.off('schedule-updated', _onLiveScheduleUpdated);
    _socket.off('connect', _onSocketConnect);
    _socket.off('reconnect', _onSocketReconnect);
  }

  void _onSocketConnect(dynamic _) => _rejoinLiveRooms(refetch: true);
  void _onSocketReconnect(dynamic _) => _rejoinLiveRooms(refetch: true);

  void _rejoinLiveRooms({bool refetch = false}) {
    final tid = _joinedTournamentId;
    if (tid != null && tid.isNotEmpty) {
      _socket.joinTournament(tid);
    }
    for (final mid in [..._joinedMatchIds]) {
      _socket.joinMatch(mid);
    }
    _joinSelectedCourtRoom();
    // Flush local queues after rooms are rejoined.
    unawaited(scoreQueue.flush());
    unawaited(matchUpdateQueue.requeueAllForReconnect());
    if (refetch && selectedTournament != null && !loading) {
      unawaited(refreshSelectedTournament());
    }
  }

  void _joinSelectedCourtRoom({String? leavePrevious}) {
    final slug = courtSlug(selectedCourt);
    final leave = (leavePrevious ?? _joinedCourtSlug ?? '').trim();
    if (leave.isNotEmpty && leave != slug) {
      _socket.leaveCourt(leave);
    }
    if (slug.isEmpty) {
      _joinedCourtSlug = null;
      return;
    }
    _socket.joinCourt(slug);
    _joinedCourtSlug = slug;
  }

  /// Overlay match id — stable per match for the broadcast consumer.
  String overlayMatchIdFor(TournamentMatch g) {
    final doc = g.documentId.trim();
    if (doc.isNotEmpty) return doc;
    final id = g.id.trim();
    if (id.isNotEmpty) return id;
    if (g.type == 'group') {
      final parts = [g.categoryId, g.groupId, g.matchKey]
          .map((e) => e.trim())
          .where((e) => e.isNotEmpty);
      return parts.join(':');
    }
    final key = g.matchKey.trim();
    if (key.isNotEmpty) return key;
    return _matchIdentityKey(g);
  }

  /// Remember serving side from the dashboard (`team1` / `team2`).
  void setMatchServingSide({
    TournamentMatch? match,
    required String serving,
  }) {
    final g = match ?? selectedGame;
    if (g == null) return;
    final mid = _matchIdentityKey(g);
    if (mid.isEmpty) return;
    final side = serving == 'team2' ? 'team2' : 'team1';
    _servingByMatch[mid] = side;
  }

  String servingSideFor(TournamentMatch g) {
    final mid = _matchIdentityKey(g);
    return _servingByMatch[mid] ?? 'team1';
  }

  /// Infer team1/team2 from a player display name on the match.
  String servingSideFromPlayer(TournamentMatch g, String? playerName) {
    final name = (playerName ?? '').trim();
    if (name.isEmpty) return servingSideFor(g);
    final left = g.player1.toLowerCase();
    final right = g.player2.toLowerCase();
    final n = name.toLowerCase();
    if (left.contains(n) || n.contains(left.split('/').first.trim())) {
      return 'team1';
    }
    if (right.contains(n) || n.contains(right.split('/').first.trim())) {
      return 'team2';
    }
    // Fallback: check split team names
    for (final part in g.player1.split(RegExp(r'[/,|&]'))) {
      if (part.trim().isNotEmpty && n.contains(part.trim().toLowerCase())) {
        return 'team1';
      }
    }
    for (final part in g.player2.split(RegExp(r'[/,|&]'))) {
      if (part.trim().isNotEmpty && n.contains(part.trim().toLowerCase())) {
        return 'team2';
      }
    }
    return servingSideFor(g);
  }

  List<bool> _gamesWonFlags(TournamentMatch g, {required bool team1}) {
    final gpm = gamesPerMatchFor(g).clamp(1, 3);
    final winsNeeded = (gpm + 1) ~/ 2;
    var wins = 0;
    for (int i = 1; i <= gpm; i++) {
      final a = _scoreForGame(g, i, true) ?? 0;
      final b = _scoreForGame(g, i, false) ?? 0;
      final status = normalizeGameStatusKey(
        i == 1 ? g.game1Status : (i == 2 ? g.game2Status : g.game3Status),
      );
      final finished = status == 'completed' ||
          (a >= 11 && (a - b) >= 2) ||
          (b >= 11 && (b - a) >= 2);
      if (!finished) continue;
      if (team1 && a > b) wins += 1;
      if (!team1 && b > a) wins += 1;
    }
    return List<bool>.generate(winsNeeded, (i) => i < wins);
  }

  int _currentGamePointScore(TournamentMatch g, int gameIndex, bool team1) {
    return _scoreForGame(g, gameIndex.clamp(1, 3), team1) ?? 0;
  }

  /// Build + enqueue a court-scoped match_update (never blocks UI).
  Future<void> publishCourtMatchUpdate({
    TournamentMatch? match,
    int? gameIndex,
    int? score1,
    int? score2,
    String? serving,
    String? servingPlayer,
    bool resetScores = false,
    bool freshStart = false,
  }) async {
    if (tutorialSimulationMode) return;
    final t = selectedTournament;
    final g = match ?? selectedGame;
    if (t == null || g == null) return;
    if (normalizeStatusKey(g.status) == 'completed') return;

    final courtName = (selectedCourt ?? g.court).trim();
    final slug = courtSlug(courtName);
    if (slug.isEmpty) return;

    _joinSelectedCourtRoom();

    final gi = (gameIndex ?? selectedGameNumber).clamp(1, 3);
    if (serving != null && serving.isNotEmpty) {
      setMatchServingSide(match: g, serving: serving);
    } else if (servingPlayer != null) {
      setMatchServingSide(
        match: g,
        serving: servingSideFromPlayer(g, servingPlayer),
      );
    }

    final team1Name = sideDisplayName(g, team1: true);
    final team2Name = sideDisplayName(g, team1: false);

    final payload = MatchUpdatePayload(
      court: slug,
      matchId: overlayMatchIdFor(g),
      tournament: t.name,
      tournamentId: t.id,
      team1Name: team1Name,
      team1Score: score1 ?? _currentGamePointScore(g, gi, true),
      team1Games: resetScores || freshStart
          ? const [false, false]
          : _gamesWonFlags(g, team1: true),
      team2Name: team2Name,
      team2Score: score2 ?? _currentGamePointScore(g, gi, false),
      team2Games: resetScores || freshStart
          ? const [false, false]
          : _gamesWonFlags(g, team1: false),
      serving: servingSideFor(g),
      resetScores: resetScores,
      freshStart: freshStart,
    );

    // Fire-and-forget local-first queue.
    unawaited(matchUpdateQueue.enqueue(payload));
  }

  void joinLiveTournament(String tournamentId) {
    if (tutorialSimulationMode) return;
    _ensureLiveSocket();
    final id = tournamentId.trim();
    if (id.isEmpty) return;
    if (_joinedTournamentId != null && _joinedTournamentId != id) {
      leaveLiveTournament();
    }
    _joinedTournamentId = id;
    _socket.joinTournament(id);
  }

  void leaveLiveTournament() {
    final id = _joinedTournamentId;
    if (id != null && id.isNotEmpty) {
      _socket.leaveTournament(id);
    }
    _joinedTournamentId = null;
  }

  /// Room ids the server may use for `match:{id}` (elim id / doc id / matchKey).
  List<String> liveMatchRoomIdsFor(TournamentMatch g) {
    final ids = <String>{};
    void add(String? v) {
      final t = (v ?? '').trim();
      if (t.isNotEmpty) ids.add(t);
    }

    add(g.documentId);
    add(g.id);
    add(g.matchKey);
    if (g.type == 'group' &&
        g.groupId.trim().isNotEmpty &&
        g.matchKey.trim().isNotEmpty) {
      add('${g.groupId.trim()}:${g.matchKey.trim()}');
    }
    return ids.toList();
  }

  void joinLiveMatchForGame(TournamentMatch g) {
    if (tutorialSimulationMode) return;
    _ensureLiveSocket();
    final tid = selectedTournament?.id.trim() ?? '';
    if (tid.isNotEmpty) joinLiveTournament(tid);

    leaveLiveMatchRooms();
    for (final mid in liveMatchRoomIdsFor(g)) {
      _joinedMatchIds.add(mid);
      _socket.joinMatch(mid);
    }
    if (kDebugMode) {
      debugPrint('[socket] join-match ids=${_joinedMatchIds.toList()}');
    }
  }

  void leaveLiveMatchRooms() {
    for (final mid in [..._joinedMatchIds]) {
      _socket.leaveMatch(mid);
    }
    _joinedMatchIds.clear();
  }

  bool _livePayloadForSelectedTournament(Map<String, dynamic> payload) {
    final tid = selectedTournament?.id.trim() ?? '';
    if (tid.isEmpty) return false;
    var pid = (payload['tournamentId'] ?? '').toString().trim();
    if (pid.isEmpty) {
      final nested = payload['tournament'];
      if (nested is Map) {
        pid = (nested['_id'] ?? nested['id'] ?? '').toString().trim();
      }
    }
    return pid.isEmpty || pid == tid;
  }

  void _onLiveScoreUpdated(dynamic data) {
    _handleLiveMatchPayload(data, source: 'score-updated');
  }

  void _onLiveStatusUpdated(dynamic data) {
    _handleLiveMatchPayload(data, source: 'status-updated');
  }

  void _onLiveScheduleUpdated(dynamic data) {
    if (tutorialSimulationMode) return;
    Map<String, dynamic>? payload;
    if (data is Map) {
      payload = Map<String, dynamic>.from(data);
    }
    if (payload == null || !_livePayloadForSelectedTournament(payload)) return;
    if (kDebugMode) debugPrint('[socket] schedule-updated');
    _scheduleRefreshDebounce?.cancel();
    _scheduleRefreshDebounce = Timer(const Duration(milliseconds: 400), () {
      if (selectedTournament != null && !loading) {
        unawaited(refreshSelectedTournament());
      }
    });
  }

  void _handleLiveMatchPayload(dynamic data, {required String source}) {
    if (tutorialSimulationMode) return;
    if (data is! Map) return;
    final payload = Map<String, dynamic>.from(data);
    if (!_livePayloadForSelectedTournament(payload)) return;

    final matchIdentity = _identityFromLivePayload(payload);
    // Local queue is source of truth until acked — ignore peer/server absolute
    // overwrites for matches we still have pending delta events for.
    if (matchIdentity != null && scoreQueue.hasPendingForMatch(matchIdentity)) {
      if (kDebugMode) {
        debugPrint('[socket] $source ignored — local pending for $matchIdentity');
      }
      return;
    }
    if (matchIdentity != null &&
        _inFlightSubmitSeqByMatch.keys.any((k) => k.startsWith('$matchIdentity:'))) {
      return;
    }

    final updateFields = payload['updateFields'];
    final matchObj = payload['match'];
    Map<String, dynamic> fields = {};
    if (updateFields is Map) {
      fields = Map<String, dynamic>.from(updateFields);
    } else if (matchObj is Map) {
      fields = Map<String, dynamic>.from(matchObj);
    }

    if (fields.isEmpty) {
      if (kDebugMode) debugPrint('[socket] $source thin payload → refresh');
      _scheduleRefreshDebounce?.cancel();
      _scheduleRefreshDebounce = Timer(const Duration(milliseconds: 350), () {
        if (selectedTournament != null && !loading) {
          unawaited(refreshSelectedTournament());
        }
      });
      return;
    }

    TournamentMatch? target;
    if (matchIdentity != null) {
      target = _findMatchByIdentity(matchIdentity);
    }
    target ??= _findMatchFromLivePayload(payload);
    if (target == null) {
      if (kDebugMode) debugPrint('[socket] $source no local match match');
      return;
    }

    final merged = _mergeMatchWithFields(target, fields);
    _replaceMatchByIdentity(_matchIdentityKey(target), merged);
    if (kDebugMode) {
      debugPrint(
        '[socket] $source applied identity=${_matchIdentityKey(target)} '
        'status=${fields['status']} score=${fields['game1Player1']}-${fields['game1Player2']}',
      );
    }
    // Defer UI rebuild to the next frame so Flutter web doesn't schedule a
    // draw against a disposed EngineFlutterView after hot restart / socket storms.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_disposed) notifyListeners();
    });
  }

  String? _identityFromLivePayload(Map<String, dynamic> payload) {
    final categoryId = (payload['categoryId'] ?? '').toString().trim();
    final type = (payload['type'] ?? '').toString().trim().toLowerCase();
    final groupId = (payload['groupId'] ?? '').toString().trim();
    final matchKey = (payload['matchKey'] ?? '').toString().trim();
    final matchId = (payload['matchId'] ?? '').toString().trim();
    final docId = (payload['documentId'] ??
            payload['_id'] ??
            (payload['match'] is Map ? payload['match']['_id'] : null) ??
            '')
        .toString()
        .trim();

    if (type == 'group' &&
        categoryId.isNotEmpty &&
        groupId.isNotEmpty &&
        matchKey.isNotEmpty) {
      return 'group:$categoryId:$groupId:$matchKey';
    }
    if ((type == 'elimination' || matchId.isNotEmpty) &&
        categoryId.isNotEmpty &&
        matchId.isNotEmpty) {
      return 'elim:$categoryId:$matchId';
    }
    if (docId.isNotEmpty) return 'doc:$docId';
    return null;
  }

  TournamentMatch? _findMatchFromLivePayload(Map<String, dynamic> payload) {
    final categoryId = (payload['categoryId'] ?? '').toString().trim();
    final groupId = (payload['groupId'] ?? '').toString().trim();
    final matchKey = (payload['matchKey'] ?? '').toString().trim();
    final matchId = (payload['matchId'] ?? '').toString().trim();
    final docId = (payload['documentId'] ?? '').toString().trim();

    for (final m in games) {
      if (docId.isNotEmpty && m.documentId.trim() == docId) return m;
      if (categoryId.isNotEmpty && m.categoryId.trim() != categoryId) continue;
      if (matchId.isNotEmpty && m.id.trim() == matchId) return m;
      if (groupId.isNotEmpty &&
          matchKey.isNotEmpty &&
          m.groupId.trim() == groupId &&
          m.matchKey.trim() == matchKey) {
        return m;
      }
    }
    return null;
  }

  /// Local-first: UI already updated. Persist delta event and flush in background.
  /// Never awaits network — referee can keep scoring / leave the match immediately.
  Future<void> enqueueScoreEvent({
    required ScoreEventAction action,
    required int gameIndex,
    required Map<String, dynamic> snapshot,
    TournamentMatch? match,
    int? side,
  }) async {
    if (tutorialSimulationMode) {
      final g = match ?? selectedGame;
      if (g != null) {
        final updated = _mergeMatchWithFields(g, snapshot);
        _replaceSelectedGame(updated, g);
        notifyListeners();
      }
      return;
    }
    final t = selectedTournament;
    final g = match ?? selectedGame;
    if (t == null || g == null) return;

    final matchIdentity = _matchIdentityKey(g);
    final gameIdentity = _matchGameIdentityKey(g, gameIndex.clamp(1, 3));
    if (matchIdentity.isEmpty || gameIdentity.isEmpty) return;

    // Optimistic local merge so court list / selectedGame stay consistent.
    final updated = _mergeMatchWithFields(g, snapshot);
    _replaceSelectedGame(updated, g);
    notifyListeners();

    final status = snapshot['status']?.toString().trim() ?? '';
    if (action == ScoreEventAction.submit && status == 'Completed') {
      final slug = courtSlug(selectedCourt ?? g.court);
      if (slug.isNotEmpty) {
        unawaited(matchUpdateQueue.clearCourt(slug));
      }
    }

    await scoreQueue.enqueue(
      matchIdentity: matchIdentity,
      gameIdentity: gameIdentity,
      tournamentId: t.id,
      categoryId: g.categoryId,
      matchType: g.type,
      groupId: g.groupId,
      matchKey: g.matchKey,
      matchId: g.id,
      documentId: g.documentId,
      action: action,
      gameIndex: gameIndex.clamp(1, 3),
      side: side,
      snapshot: snapshot,
    );
  }

  bool _serverMatchLooksCleared(TournamentMatch m) {
    final st = normalizeGameStatusKey(m.status);
    if (st != 'scheduled' && st != 'unschedule') return false;
    final pts = (m.game1Player1 ?? 0) +
        (m.game1Player2 ?? 0) +
        (m.game2Player1 ?? 0) +
        (m.game2Player2 ?? 0) +
        (m.game3Player1 ?? 0) +
        (m.game3Player2 ?? 0) +
        m.score1 +
        m.score2;
    return pts <= 0;
  }

  TournamentMatch _forceClearedMatchStatuses(TournamentMatch m) {
    // Build directly — _mergeMatchWithFields preserves non-empty signatures.
    return TournamentMatch(
      id: m.id,
      documentId: m.documentId,
      scheduleFromAssignments: m.scheduleFromAssignments,
      player1: m.player1,
      player2: m.player2,
      player1Name: m.player1Name,
      player2Name: m.player2Name,
      score1: 0,
      score2: 0,
      game1Status: m.status,
      game2Status: m.status,
      game3Status: m.status,
      game1Player1: 0,
      game1Player2: 0,
      game2Player1: 0,
      game2Player2: 0,
      game3Player1: 0,
      game3Player2: 0,
      round: m.round,
      roundShort: m.roundShort,
      roundLabel: m.roundLabel,
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
      winner: null,
      signatureData: null,
      gameSignatures: <String?>[null, null, null],
      refereeNote: '',
      scoringFormat: m.scoringFormat,
      game1Team1Player: m.game1Team1Player,
      game1Team1Player2: m.game1Team1Player2,
      game1Team2Player: m.game1Team2Player,
      game1Team2Player2: m.game1Team2Player2,
      game2Team1Player: m.game2Team1Player,
      game2Team1Player2: m.game2Team1Player2,
      game2Team2Player: m.game2Team2Player,
      game2Team2Player2: m.game2Team2Player2,
      game3Team1Player: m.game3Team1Player,
      game3Team1Player2: m.game3Team1Player2,
      game3Team2Player: m.game3Team2Player,
      game3Team2Player2: m.game3Team2Player2,
    );
  }

  List<TournamentMatch> _normalizeServerClearedMatches(List<TournamentMatch> list) {
    return list.map((m) {
      if (!_serverMatchLooksCleared(m)) return m;
      final mid = _matchIdentityKey(m);
      // Embed often lags as Scheduled/0-0 while Ref Panel is live. Never wipe
      // the score queue or force-clear in that case (drops names/scores mid-game).
      final local = mid.isNotEmpty ? _findMatchByIdentity(mid) : null;
      final localStatus = local != null ? normalizeGameStatusKey(local.status) : '';
      final localPts = local == null
          ? 0
          : (local.game1Player1 ?? 0) +
              (local.game1Player2 ?? 0) +
              (local.game2Player1 ?? 0) +
              (local.game2Player2 ?? 0) +
              (local.game3Player1 ?? 0) +
              (local.game3Player2 ?? 0) +
              local.score1 +
              local.score2;
      final isActiveRef =
          selectedGame != null && _matchIdentityKey(selectedGame!) == mid;
      final incomingHasSchedule = m.court.trim().isNotEmpty &&
          m.time.trim().isNotEmpty &&
          m.date.trim().isNotEmpty;
      final incomingStatus = normalizeGameStatusKey(m.status);

      // Website re-scheduled Round Robin (Scheduled + court/date/time): always
      // take the server row unless this match is open/live in Ref Panel.
      if (incomingStatus == 'scheduled' && incomingHasSchedule) {
        if (isActiveRef && localStatus == 'ongoing') return local ?? m;
        if (localStatus == 'ongoing' && localPts > 0) return local ?? m;
        if (localStatus == 'completed' && mid.isNotEmpty) {
          unawaited(scoreQueue.discardMatch(mid));
        }
        return m;
      }

      if (isActiveRef || (localStatus == 'ongoing' && localPts > 0)) {
        return local ?? m;
      }
      if (mid.isNotEmpty) {
        unawaited(scoreQueue.discardMatch(mid));
      }
      return _forceClearedMatchStatuses(m);
    }).toList();
  }

  /// Apply any persisted local snapshots over refreshed server matches.
  /// Never overlay 0-0 or scheduler statuses — those unschedules / wipe scores.
  /// Never resurrect Completed after staff unlock/clear on the website.
  void _applyQueuedSnapshotsToGames() {
    const scheduleKeys = {
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
    for (final mid in scoreQueue.knownMatchIdentities.toList()) {
      final snap = scoreQueue.latestSnapshotFor(mid);
      if (snap == null || snap.isEmpty) continue;
      final existing = _findMatchByIdentity(mid);
      if (existing == null) continue;

      // Website unlock/clear is authoritative — drop local Completed snapshots.
      // But not while this match is the active live Ref Panel / has points.
      if (_serverMatchLooksCleared(existing)) {
        final isActiveRef =
            selectedGame != null && _matchIdentityKey(selectedGame!) == mid;
        final localStatus = normalizeGameStatusKey(existing.status);
        final localPts = (existing.game1Player1 ?? 0) +
            (existing.game1Player2 ?? 0) +
            (existing.game2Player1 ?? 0) +
            (existing.game2Player2 ?? 0) +
            (existing.game3Player1 ?? 0) +
            (existing.game3Player2 ?? 0) +
            existing.score1 +
            existing.score2;
        if (!(isActiveRef || localStatus == 'ongoing' || localPts > 0)) {
          unawaited(scoreQueue.discardMatch(mid));
          continue;
        }
      }

      final filtered = Map<String, dynamic>.from(snap);
      filtered.removeWhere((key, _) => scheduleKeys.contains(key));
      final snapStatus = filtered['status']?.toString().trim().toLowerCase() ?? '';
      if (snapStatus == 'scheduled' ||
          snapStatus == 'unschedule' ||
          snapStatus == 'unscheduled' ||
          snapStatus == 'called') {
        filtered.remove('status');
      }
      if (normalizeStatusKey(existing.status) == 'completed' &&
          snapStatus != 'completed') {
        continue;
      }
      for (int i = 1; i <= 3; i++) {
        final aKey = 'game${i}Player1';
        final bKey = 'game${i}Player2';
        final a = _fieldAsInt(filtered, aKey, 0) ?? 0;
        final b = _fieldAsInt(filtered, bKey, 0) ?? 0;
        final existingA = _scoreForGame(existing, i, true) ?? 0;
        final existingB = _scoreForGame(existing, i, false) ?? 0;
        if (a + b == 0 && existingA + existingB > 0) {
          filtered.remove(aKey);
          filtered.remove(bKey);
        }
      }
      if (filtered.isEmpty) continue;
      final merged = _mergeMatchWithFields(existing, filtered);
      _replaceMatchByIdentity(mid, merged);
    }
  }
}
