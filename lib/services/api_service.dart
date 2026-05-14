import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_dotenv/flutter_dotenv.dart';
import 'package:http/http.dart' as http;
import '../models.dart';

class ApiResult {
  final bool ok;
  final String? error;
  final User? user;
  final String? token;
  ApiResult({required this.ok, this.error, this.user, this.token});
}

class MatchQueueResult {
  final bool notModified;
  final String? etag;
  final List<TournamentMatch> matches;
  MatchQueueResult({
    required this.notModified,
    required this.matches,
    this.etag,
  });
}

class ApiService {
  String get baseUrl => dotenv.env['API_BASE_URL'] ?? 'http://localhost:5000';
  String? _token;

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        if (_token != null) 'Authorization': 'Bearer $_token',
      };

  void setToken(String token) {
    _token = token;
  }

  Future<ApiResult> signup({
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
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/auth/register'),
        headers: _headers,
        body: jsonEncode({
          'email': email,
          'password': password,
          'firstName': firstName,
          'lastName': lastName,
          'name': '$firstName $lastName',
          'phoneNumber': phoneNumber,
          'country': country,
          'city': city,
          'birthDate': birthDate,
          'gender': gender,
        }),
      );
      if (res.statusCode == 201 || res.statusCode == 200) {
        final data = jsonDecode(res.body);
        return ApiResult(ok: true, error: null, user: User.fromJson(data['user']), token: null);
      }
      return ApiResult(ok: false, error: 'Signup failed: ${res.body}', token: null);
    } catch (e) {
      return ApiResult(ok: false, error: 'Network error: $e');
    }
  }

  Future<ApiResult> login(String email, String password) async {
    try {
      final res = await http.post(
        Uri.parse('$baseUrl/api/auth/login'),
        headers: _headers,
        body: jsonEncode({'email': email, 'password': password}),
      );
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        _token = data['token'];
        final user = User.fromJson(data['user']);
        return ApiResult(ok: true, user: user, token: _token);
      }
      final errorBody = jsonDecode(res.body);
      return ApiResult(ok: false, error: errorBody['message'] ?? 'Login failed: ${res.statusCode}', token: null);
    } catch (e) {
      return ApiResult(ok: false, error: 'Network error: $e', token: null);
    }
  }

  Future<List<Tournament>> getRefereeTournaments() async {
    try {
      final ts = DateTime.now().millisecondsSinceEpoch;
      final url = '$baseUrl/api/tournaments?_ts=$ts';
      print('GET $url');
      final res = await http.get(
        Uri.parse(url),
        headers: _headers,
      );
      print('Response (${res.statusCode}): ${res.body}');
      if (res.statusCode == 200) {
        final List<dynamic> jsonList = jsonDecode(res.body);
        final list = jsonList.map((e) => Tournament.fromJson(e)).toList();
        return list;
      }
      throw Exception('Status ${res.statusCode}: ${res.body}');
    } catch (e) {
      print('Error fetching tournaments: $e');
      rethrow;
    }
  }

  Future<Tournament> getTournamentDetails(String id) async {
    try {
      final ts = DateTime.now().millisecondsSinceEpoch;
      final url = '$baseUrl/api/tournaments/$id?_ts=$ts';
      print('GET $url');
      final res = await http.get(
        Uri.parse(url),
        headers: _headers,
      );
      if (res.statusCode == 200) {
        final json = jsonDecode(res.body);
        // The API might return { tournament: { ... } } or just { ... }
        // Based on Brackets.jsx line 195: res?.data?.tournament || res?.data
        final data = json['tournament'] ?? json;
        return Tournament.fromJson(data);
      }
      throw Exception('Status ${res.statusCode}: ${res.body}');
    } catch (e) {
      print('Error fetching tournament details: $e');
      rethrow;
    }
  }

  Future<void> updateGroupMatch({
    required String tournamentId,
    required String categoryId,
    required String groupId,
    required String matchKey,
    required Map<String, dynamic> fields,
  }) async {
    try {
      final scheduleKeys = <String>{
        'date','time','court','venue','mdDate','mdTime','wdDate','wdTime','xdDate','xdTime'
      };
      final safeFields = Map<String, dynamic>.from(fields)
        ..removeWhere((key, value) {
          if (scheduleKeys.contains(key)) return true;
          if (value == null) return true;
          if (value is String && value.trim().isEmpty) return true;
          return false;
        });
      final url = '$baseUrl/api/tournaments/$tournamentId/categories/$categoryId/groups/$groupId/matches';
      final body = {
        'matches': {
          matchKey: safeFields,
        },
      };
      try {
        final preview = jsonEncode({
          'url': url,
          'matchKey': matchKey,
          'fields': safeFields.keys.toList(),
        });
        print('PUT updateGroupMatch -> $preview');
      } catch (_) {}
      final res = await http.put(
        Uri.parse(url),
        headers: _headers,
        body: jsonEncode(body),
      );
      if (res.statusCode != 200) {
        throw Exception('Status ${res.statusCode}: ${res.body}');
      }
    } catch (e) {
      rethrow;
    }
  }

  Future<MatchQueueResult> getScheduledMatches({
    required String tournamentId,
    required String date,
    required String court,
    int page = 1,
    int limit = 50,
    String? ifNoneMatch,
  }) async {
    final uri = Uri.parse('$baseUrl/api/tournaments/$tournamentId/referee/matches').replace(
      queryParameters: {
        'date': date,
        'court': court,
        'status': 'Scheduled',
        'page': '$page',
        'limit': '$limit',
      },
    );
    final headers = Map<String, String>.from(_headers);
    if (ifNoneMatch != null && ifNoneMatch.trim().isNotEmpty) {
      headers['If-None-Match'] = ifNoneMatch.trim();
    }
    final res = await http.get(uri, headers: headers);
    if (res.statusCode == 304) {
      return MatchQueueResult(notModified: true, matches: const []);
    }
    if (res.statusCode != 200) {
      throw Exception('Status ${res.statusCode}: ${res.body}');
    }
    final body = jsonDecode(res.body);
    final raw = (body is Map<String, dynamic>) ? (body['matches'] ?? const []) : body;
    final list = (raw as List).map((e) => TournamentMatch.fromJson(Map<String, dynamic>.from(e))).toList();
    return MatchQueueResult(
      notModified: false,
      matches: list,
      etag: res.headers['etag'],
    );
  }

  Future<void> submitScore(Map<String, dynamic> payload) async {
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
    final safePayload = Map<String, dynamic>.from(payload)
      ..removeWhere((key, value) {
        if (scheduleKeys.contains(key)) return true;
        if (value == null) return true;
        if (value is String && value.trim().isEmpty) return true;
        return false;
      });
    if (kDebugMode) {
      final idSummary = safePayload['type'] == 'group'
          ? 'groupId=${safePayload['groupId']}, matchKey=${safePayload['matchKey']}'
          : 'matchId=${safePayload['matchId']}';
      final game = safePayload['game'];
      print(
        '[score-sync][api] POST /api/referees/submit-score '
        'tournamentId=${safePayload['tournamentId']} '
        'categoryId=${safePayload['categoryId']} '
        '$idSummary selectedGame=${safePayload['selectedGame']} '
        'status=${safePayload['status']} game=$game',
      );
    }
    final res = await http.post(
      Uri.parse('$baseUrl/api/referees/submit-score'),
      headers: _headers,
      body: jsonEncode(safePayload),
    );
    if (kDebugMode) {
      print('[score-sync][api] RESPONSE ${res.statusCode}: ${res.body}');
    }
    if (res.statusCode != 200 && res.statusCode != 201) {
      throw Exception('Status ${res.statusCode}: ${res.body}');
    }
  }
}
