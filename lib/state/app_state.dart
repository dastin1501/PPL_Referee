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

  Future<void> init() async {
    final prefs = await SharedPreferences.getInstance();
    final token = prefs.getString(_storageTokenKey);
    final userJson = prefs.getString(_storageUserKey);
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
    final filtered = games.where((g) => norm(g.court) == target).toList();
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
        error = 'Failed to update match: $e';
        notifyListeners();
        rethrow;
      }
    }
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
    notifyListeners();
  }
}
