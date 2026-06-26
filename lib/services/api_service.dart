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

class SubmitScoreResult {
  final Map<String, dynamic>? body;
  final Map<String, dynamic>? savedMatch;
  final String? freshnessToken;

  const SubmitScoreResult({
    this.body,
    this.savedMatch,
    this.freshnessToken,
  });
}

class ApiService {
  String? _baseUrlOverride;
  String get baseUrl => _baseUrlOverride ?? (dotenv.env['API_BASE_URL'] ?? 'http://localhost:5000');
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

  void setBaseUrl(String? url) {
    final trimmed = (url ?? '').trim();
    if (trimmed.isEmpty) {
      _baseUrlOverride = null;
      return;
    }
    _baseUrlOverride = trimmed.endsWith('/') ? trimmed.substring(0, trimmed.length - 1) : trimmed;
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
      final res = await http
          .post(
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
      )
          .timeout(const Duration(seconds: 20));
      if (res.statusCode == 201 || res.statusCode == 200) {
        final data = jsonDecode(res.body);
        return ApiResult(ok: true, error: null, user: User.fromJson(data['user']), token: null);
      }
      return ApiResult(ok: false, error: 'Signup failed: ${res.body}', token: null);
    } catch (e) {
      return ApiResult(ok: false, error: 'Network error (${baseUrl}): $e');
    }
  }

  Future<ApiResult> login(String email, String password) async {
    try {
      final res = await http
          .post(
        Uri.parse('$baseUrl/api/auth/login'),
        headers: _headers,
        body: jsonEncode({'email': email, 'password': password}),
      )
          .timeout(const Duration(seconds: 20));
      if (res.statusCode == 200) {
        final data = jsonDecode(res.body);
        _token = data['token'];
        final user = User.fromJson(data['user']);
        return ApiResult(ok: true, user: user, token: _token);
      }
      final errorBody = jsonDecode(res.body);
      return ApiResult(ok: false, error: errorBody['message'] ?? 'Login failed: ${res.statusCode}', token: null);
    } catch (e) {
      return ApiResult(ok: false, error: 'Network error (${baseUrl}): $e', token: null);
    }
  }

  Future<List<Tournament>> getRefereeTournaments() async {
    try {
      final ts = DateTime.now().millisecondsSinceEpoch;
      final url = '$baseUrl/api/tournaments?_ts=$ts';
      if (kDebugMode) {
        debugPrint('GET $url');
      }
      final res = await http.get(
        Uri.parse(url),
        headers: _headers,
      );
      if (kDebugMode) {
        debugPrint('GET /api/tournaments -> ${res.statusCode}');
      }
      if (res.statusCode == 200) {
        final List<dynamic> jsonList = jsonDecode(res.body);
        final list = jsonList.map((e) => Tournament.fromJson(e)).toList();
        return list;
      }
      throw Exception('Status ${res.statusCode}: ${res.body}');
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Error fetching tournaments: $e');
      }
      rethrow;
    }
  }

  Future<Tournament> getTournamentDetails(String id) async {
    try {
      final ts = DateTime.now().millisecondsSinceEpoch;
      final allRegistrations = <dynamic>[];
      Map<String, dynamic>? tournamentData;
      int page = 1;

      while (true) {
        final url =
            '$baseUrl/api/tournaments/$id'
            '?includeRegistrations=true'
            '&includeAssets=false'
            '&includeComputed=true'
            '&regPage=$page'
            '&regLimit=200'
            '&_ts=$ts';
        if (kDebugMode) {
          debugPrint('GET tournament details page=$page');
        }
        final res = await http.get(
          Uri.parse(url),
          headers: _headers,
        );
        if (res.statusCode != 200) {
          throw Exception('Status ${res.statusCode}: ${res.body}');
        }

        final json = jsonDecode(res.body);
        final data = Map<String, dynamic>.from(json['tournament'] ?? json);
        tournamentData ??= data;

        final regs = data['registrations'] as List? ?? const [];
        allRegistrations.addAll(regs);

        final pagination = data['registrationPagination'] as Map?;
        final total = int.tryParse(pagination?['total']?.toString() ?? '') ?? 0;
        final limit = int.tryParse(pagination?['limit']?.toString() ?? '') ?? 200;
        final hasMore = total > 0 ? allRegistrations.length < total : regs.length >= limit;
        if (kDebugMode) {
          debugPrint(
            'Tournament details page=$page status=${res.statusCode} '
            'regsLoaded=${allRegistrations.length} total=$total hasMore=$hasMore',
          );
        }
        if (!hasMore) {
          break;
        }

        page += 1;
        if (page > 200) {
          break;
        }
      }

      final merged = Map<String, dynamic>.from(tournamentData ?? <String, dynamic>{});
      merged['registrations'] = allRegistrations;
      return Tournament.fromJson(merged);
    } catch (e) {
      if (kDebugMode) {
        debugPrint('Error fetching tournament details: $e');
      }
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
      if (kDebugMode) {
        try {
          final preview = jsonEncode({
            'url': url,
            'matchKey': matchKey,
            'fields': safeFields.keys.toList(),
          });
          debugPrint('PUT updateGroupMatch -> $preview');
        } catch (_) {}
      }
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
    // The current backend does not expose this filtered referee queue endpoint.
    // Mobile already refreshes tournament details, which are the source of truth
    // for schedule rendering, so we skip this call to avoid browser 404 noise.
    return MatchQueueResult(notModified: true, matches: const []);
  }

  Future<SubmitScoreResult> submitScore(Map<String, dynamic> payload) async {
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
    final res = await http
        .post(
          Uri.parse('$baseUrl/api/referees/submit-score'),
          headers: _headers,
          body: jsonEncode(safePayload),
        )
        .timeout(const Duration(seconds: 20));
    if (kDebugMode) {
      print('[score-sync][api] RESPONSE ${res.statusCode}: ${res.body}');
    }
    if (res.statusCode != 200 && res.statusCode != 201) {
      throw Exception('Status ${res.statusCode}: ${res.body}');
    }
    Map<String, dynamic>? body;
    try {
      final decoded = jsonDecode(res.body);
      if (decoded is Map<String, dynamic>) {
        body = decoded;
      } else if (decoded is Map) {
        body = Map<String, dynamic>.from(decoded);
      }
    } catch (_) {
      body = null;
    }
    final savedMatch = _extractSavedMatch(body);
    return SubmitScoreResult(
      body: body,
      savedMatch: savedMatch,
      freshnessToken: _extractFreshnessToken(body, savedMatch),
    );
  }

  Map<String, dynamic>? _extractSavedMatch(Map<String, dynamic>? body) {
    if (body == null) return null;
    Map<String, dynamic>? asMatch(dynamic value) {
      if (value is Map) {
        final map = Map<String, dynamic>.from(value);
        final hasMatchIdentity = map.containsKey('_id') ||
            map.containsKey('id') ||
            map.containsKey('matchKey');
        final hasMatchState = map.containsKey('status') ||
            map.containsKey('game1Status') ||
            map.containsKey('game2Status') ||
            map.containsKey('game3Status') ||
            map.containsKey('score1') ||
            map.containsKey('score2') ||
            map.containsKey('winner') ||
            map.containsKey('game1Player1');
        if (hasMatchIdentity && hasMatchState) {
          return map;
        }
      }
      return null;
    }

    final direct = asMatch(body);
    if (direct != null) return direct;

    const topLevelKeys = ['match', 'savedMatch', 'updatedMatch', 'result'];
    for (final key in topLevelKeys) {
      final candidate = asMatch(body[key]);
      if (candidate != null) return candidate;
    }

    final data = body['data'];
    if (data is Map) {
      final map = Map<String, dynamic>.from(data);
      final directData = asMatch(map);
      if (directData != null) return directData;
      for (final key in topLevelKeys) {
        final candidate = asMatch(map[key]);
        if (candidate != null) return candidate;
      }
    }
    return null;
  }

  String? _extractFreshnessToken(
    Map<String, dynamic>? body,
    Map<String, dynamic>? savedMatch,
  ) {
    String? pick(Map<String, dynamic>? map) {
      if (map == null) return null;
      final candidates = [
        map['updatedAt'],
        map['savedAt'],
        map['version'],
        map['_v'],
      ];
      for (final value in candidates) {
        final text = value?.toString().trim() ?? '';
        if (text.isNotEmpty) return text;
      }
      return null;
    }

    return pick(savedMatch) ?? pick(body);
  }
}
