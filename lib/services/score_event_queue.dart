import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/score_event.dart';
import 'api_service.dart';

typedef ScoreQueueListener = void Function();

/// Local-first score event queue.
///
/// - UI applies deltas immediately (caller does that before enqueue).
/// - Each event is persisted, then flushed in per-match sequence order.
/// - Large signatures are stored as files (not SharedPreferences) so they
///   don't get silently dropped when prefs overflow.
/// - Ack = successful authenticated REST `submit-score`.
/// - Never blocks the referee; retries with exponential backoff in background.
class ScoreEventQueue {
  ScoreEventQueue({
    required ApiService api,
    this.onChanged,
  }) : _api = api;

  static const _storageKey = 'referee_score_event_queue_v1';
  static const _seqKey = 'referee_score_event_seq_v1';
  static const _sigKeys = {'signatureData', 'gameSignatures'};

  final ApiService _api;
  final ScoreQueueListener? onChanged;

  final List<ScoreEvent> _events = [];
  final Map<String, int> _seqByMatch = {};
  /// In-memory signature payloads keyed by event id (rehydrated from disk).
  final Map<String, Map<String, dynamic>> _signatureExtras = {};
  bool _loaded = false;
  bool _flushing = false;
  Timer? _retryTimer;
  final Set<String> _inFlightEventIds = {};
  Directory? _sigDir;

  List<ScoreEvent> get events => List.unmodifiable(_events);
  List<ScoreEvent> get pending =>
      _events.where((e) => e.isPending).toList(growable: false);

  int get pendingCount => pending.length;

  /// Distinct matches that still have unacked events.
  int get pendingMatchCount {
    final ids = <String>{};
    for (final e in _events) {
      if (e.isPending) ids.add(e.matchIdentity);
    }
    return ids.length;
  }

  bool get hasStalePending => _events.any((e) => e.isStale);

  bool hasPendingForMatch(String matchIdentity) {
    final id = matchIdentity.trim();
    if (id.isEmpty) return false;
    return _events.any((e) => e.isPending && e.matchIdentity == id);
  }

  Future<Directory> _signatureDir() async {
    if (_sigDir != null) return _sigDir!;
    final root = await getApplicationDocumentsDirectory();
    final dir = Directory('${root.path}/score_event_signatures');
    if (!await dir.exists()) {
      await dir.create(recursive: true);
    }
    _sigDir = dir;
    return dir;
  }

  Future<File> _signatureFile(String eventId) async {
    final dir = await _signatureDir();
    return File('${dir.path}/$eventId.json');
  }

  bool _snapshotHasSignature(Map<String, dynamic> snap) {
    final sig = snap['signatureData']?.toString().trim() ?? '';
    if (sig.isNotEmpty) return true;
    final gs = snap['gameSignatures'];
    if (gs is List) {
      for (final e in gs) {
        if ((e?.toString().trim() ?? '').isNotEmpty) return true;
      }
    }
    return false;
  }

  Map<String, dynamic> _extractSignatureExtras(Map<String, dynamic> snap) {
    final out = <String, dynamic>{};
    for (final key in _sigKeys) {
      if (snap.containsKey(key) && snap[key] != null) {
        out[key] = snap[key];
      }
    }
    return out;
  }

  Map<String, dynamic> _snapshotWithoutSignatures(Map<String, dynamic> snap) {
    final out = Map<String, dynamic>.from(snap);
    out.remove('signatureData');
    out.remove('gameSignatures');
    return out;
  }

  Future<void> _writeSignatureExtras(
    String eventId,
    Map<String, dynamic> extras,
  ) async {
    if (extras.isEmpty) return;
    try {
      final file = await _signatureFile(eventId);
      await file.writeAsString(jsonEncode(extras), flush: true);
      _signatureExtras[eventId] = extras;
    } catch (e) {
      if (kDebugMode) debugPrint('[score-queue] sig write failed: $e');
      // Keep in memory even if disk write fails.
      _signatureExtras[eventId] = extras;
    }
  }

  Future<void> _loadSignatureExtras(String eventId) async {
    if (_signatureExtras.containsKey(eventId)) return;
    try {
      final file = await _signatureFile(eventId);
      if (!await file.exists()) return;
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is Map) {
        _signatureExtras[eventId] = Map<String, dynamic>.from(decoded);
      }
    } catch (e) {
      if (kDebugMode) debugPrint('[score-queue] sig load failed: $e');
    }
  }

  Future<void> _deleteSignatureExtras(String eventId) async {
    _signatureExtras.remove(eventId);
    try {
      final file = await _signatureFile(eventId);
      if (await file.exists()) await file.delete();
    } catch (_) {}
  }

  Map<String, dynamic> _fullSnapshot(ScoreEvent event) {
    final snap = Map<String, dynamic>.from(event.snapshot);
    final extras = _signatureExtras[event.id];
    if (extras != null) {
      snap.addAll(extras);
    }
    return snap;
  }

  Future<void> load() async {
    if (_loaded) return;
    final prefs = await SharedPreferences.getInstance();
    try {
      final raw = prefs.getString(_storageKey);
      if (raw != null && raw.isNotEmpty) {
        final list = jsonDecode(raw);
        if (list is List) {
          _events
            ..clear()
            ..addAll(
              list
                  .whereType<Map>()
                  .map((e) => ScoreEvent.fromJson(Map<String, dynamic>.from(e))),
            );
        }
      }
      // Migrate any legacy in-prefs signatures onto disk, then strip them.
      var migrated = false;
      for (final e in _events) {
        final extras = _extractSignatureExtras(e.snapshot);
        if (extras.isNotEmpty) {
          await _writeSignatureExtras(e.id, extras);
          e.snapshot
            ..remove('signatureData')
            ..remove('gameSignatures');
          migrated = true;
        }
      }
      if (migrated) {
        await _persist();
      }
      final seqRaw = prefs.getString(_seqKey);
      if (seqRaw != null && seqRaw.isNotEmpty) {
        final map = jsonDecode(seqRaw);
        if (map is Map) {
          _seqByMatch
            ..clear()
            ..addAll(
              map.map((k, v) => MapEntry(k.toString(), int.tryParse('$v') ?? 0)),
            );
        }
      }
      // Drop acked events older than 24h to keep storage small.
      final cutoff = DateTime.now().subtract(const Duration(hours: 24));
      final removed = <ScoreEvent>[];
      _events.removeWhere((e) {
        final drop = e.acked && e.createdAt.isBefore(cutoff);
        if (drop) removed.add(e);
        return drop;
      });
      for (final e in removed) {
        await _deleteSignatureExtras(e.id);
      }
      // Rehydrate signatures for every queued event (pending + kept acked).
      for (final e in _events) {
        await _loadSignatureExtras(e.id);
        final extras = _signatureExtras[e.id];
        if (extras != null && extras.isNotEmpty) {
          e.snapshot.addAll(extras);
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('[score-queue] load failed: $e');
    }
    _loaded = true;
    _notify();
    _scheduleFlush();
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    // Never put huge base64 signatures into SharedPreferences.
    final lean = _events.map((e) {
      final j = e.toJson();
      final snap = j['snapshot'];
      if (snap is Map) {
        j['snapshot'] = _snapshotWithoutSignatures(Map<String, dynamic>.from(snap));
      }
      return j;
    }).toList();
    try {
      await prefs.setString(_storageKey, jsonEncode(lean));
      await prefs.setString(_seqKey, jsonEncode(_seqByMatch));
    } catch (e) {
      if (kDebugMode) debugPrint('[score-queue] prefs persist failed: $e');
      rethrow;
    }
  }

  void _notify() {
    onChanged?.call();
  }

  /// Enqueue after local UI already applied the action. Returns the event id.
  Future<ScoreEvent> enqueue({
    required String matchIdentity,
    required String gameIdentity,
    required String tournamentId,
    required String categoryId,
    required String matchType,
    required ScoreEventAction action,
    required int gameIndex,
    required Map<String, dynamic> snapshot,
    String groupId = '',
    String matchKey = '',
    String matchId = '',
    String documentId = '',
    int? side,
  }) async {
    await load();
    final mid = matchIdentity.trim();
    final nextSeq = (_seqByMatch[mid] ?? 0) + 1;
    _seqByMatch[mid] = nextSeq;

    final fullSnap = Map<String, dynamic>.from(snapshot);
    final extras = _extractSignatureExtras(fullSnap);
    final leanSnap = _snapshotWithoutSignatures(fullSnap);

    final event = ScoreEvent(
      id: ScoreEvent.newId(),
      seq: nextSeq,
      matchIdentity: mid,
      gameIdentity: gameIdentity.trim(),
      tournamentId: tournamentId.trim(),
      categoryId: categoryId.trim(),
      matchType: matchType.trim(),
      groupId: groupId.trim(),
      matchKey: matchKey.trim(),
      matchId: matchId.trim(),
      documentId: documentId.trim(),
      action: action,
      gameIndex: gameIndex.clamp(1, 3),
      side: side,
      snapshot: leanSnap,
      createdAt: DateTime.now(),
    );
    _events.add(event);
    if (extras.isNotEmpty || _snapshotHasSignature(fullSnap)) {
      await _writeSignatureExtras(event.id, extras);
    }
    // Keep full snapshot in-memory for immediate flush / UI merges.
    event.snapshot.addAll(extras);
    await _persist();
    _notify();
    if (kDebugMode) {
      debugPrint(
        '[score-queue] enqueue ${event.action.wire} seq=${event.seq} '
        'match=$mid pending=$pendingCount hasSig=${extras.isNotEmpty}',
      );
    }
    _scheduleFlush();
    return event;
  }

  void _scheduleFlush({Duration delay = Duration.zero}) {
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () {
      unawaited(flush());
    });
  }

  /// Flush unacked events (call on reconnect / resume).
  Future<void> flush() async {
    await load();
    if (_flushing) return;
    _flushing = true;
    try {
      while (true) {
        final batch = _nextFlushBatch();
        if (batch.isEmpty) break;
        await Future.wait(batch.map(_sendOne));
      }
    } finally {
      _flushing = false;
    }
    // Schedule next wake if anything is still pending (backoff).
    final pendingNow = pending;
    if (pendingNow.isEmpty) {
      _notify();
      return;
    }
    DateTime? soonest;
    for (final e in pendingNow) {
      final t = e.nextRetryAt ?? DateTime.now();
      if (soonest == null || t.isBefore(soonest)) soonest = t;
    }
    final wait = soonest!.difference(DateTime.now());
    _scheduleFlush(delay: wait.isNegative ? Duration.zero : wait);
    _notify();
  }

  /// Oldest ready unacked event per match (sequence order within a match).
  List<ScoreEvent> _nextFlushBatch() {
    final byMatch = <String, List<ScoreEvent>>{};
    for (final e in _events) {
      if (!e.isPending) continue;
      if (_inFlightEventIds.contains(e.id)) continue;
      final ready = e.nextRetryAt == null ||
          !e.nextRetryAt!.isAfter(DateTime.now());
      if (!ready) continue;
      byMatch.putIfAbsent(e.matchIdentity, () => []).add(e);
    }
    final out = <ScoreEvent>[];
    for (final list in byMatch.values) {
      list.sort((a, b) => a.seq.compareTo(b.seq));
      out.add(list.first);
    }
    return out;
  }

  Duration _backoffForAttempt(int attempts) {
    // 1s, 2s, 4s... capped at 15s
    final seconds = (1 << (attempts.clamp(0, 10))).clamp(1, 15);
    return Duration(seconds: seconds);
  }

  Future<void> _sendOne(ScoreEvent event) async {
    if (_inFlightEventIds.contains(event.id) || event.acked) return;
    _inFlightEventIds.add(event.id);
    _notify();
    try {
      await _loadSignatureExtras(event.id);
      final payload = _buildSubmitPayload(event);
      await _api.submitScore(payload);
      event.acked = true;
      event.lastError = null;
      event.nextRetryAt = null;
      if (kDebugMode) {
        debugPrint(
          '[score-queue] acked ${event.id} seq=${event.seq} '
          'action=${event.action.wire}',
        );
      }
      // Compact: drop trailing acked events for this match once contiguous.
      await _compactAcked(event.matchIdentity);
      await _persist();
    } catch (e) {
      event.attempts += 1;
      event.lastError = e.toString();
      event.nextRetryAt = DateTime.now().add(_backoffForAttempt(event.attempts));
      if (kDebugMode) {
        debugPrint(
          '[score-queue] fail ${event.id} attempt=${event.attempts} '
          'retryAt=${event.nextRetryAt} err=$e',
        );
      }
      await _persist();
    } finally {
      _inFlightEventIds.remove(event.id);
      _notify();
    }
  }

  Future<void> _compactAcked(String matchIdentity) async {
    final forMatch = _events
        .where((e) => e.matchIdentity == matchIdentity)
        .toList()
      ..sort((a, b) => a.seq.compareTo(b.seq));
    var contiguousAcked = 0;
    for (final e in forMatch) {
      if (!e.acked) break;
      contiguousAcked++;
    }
    if (contiguousAcked == 0) return;
    final dropIds = forMatch.take(contiguousAcked).map((e) => e.id).toSet();
    // Keep the latest acked snapshot event so restart can restore state.
    if (dropIds.length > 1) {
      final keep = forMatch[contiguousAcked - 1].id;
      dropIds.remove(keep);
      for (final id in dropIds) {
        await _deleteSignatureExtras(id);
      }
      _events.removeWhere((e) => dropIds.contains(e.id));
    }
  }

  /// Latest snapshot for a match (acked or not) — used after cold start.
  Map<String, dynamic>? latestSnapshotFor(String matchIdentity) {
    ScoreEvent? best;
    for (final e in _events) {
      if (e.matchIdentity != matchIdentity) continue;
      if (best == null || e.seq > best.seq) best = e;
    }
    if (best == null) return null;
    return _fullSnapshot(best);
  }

  Iterable<String> get knownMatchIdentities sync* {
    final seen = <String>{};
    for (final e in _events) {
      if (seen.add(e.matchIdentity)) yield e.matchIdentity;
    }
  }

  Map<String, dynamic> _buildSubmitPayload(ScoreEvent event) {
    final snap = _fullSnapshot(event);
    final gameIndex = event.gameIndex.clamp(1, 3);
    final s1 = _asInt(snap['game${gameIndex}Player1']) ??
        _asInt(snap['score1']) ??
        0;
    final s2 = _asInt(snap['game${gameIndex}Player2']) ??
        _asInt(snap['score2']) ??
        0;
    final gamesArray = List.generate(3, (i) {
      final idx = i + 1;
      return {
        'a': _asInt(snap['game${idx}Player1']) ?? 0,
        'b': _asInt(snap['game${idx}Player2']) ?? 0,
      };
    });

    final payload = <String, dynamic>{
      'tournamentId': event.tournamentId,
      'categoryId': event.categoryId,
      'type': event.matchType,
      'selectedGame': gameIndex,
      'assignedGame': gameIndex,
      'gameIndex': gameIndex,
      'game': {'a': s1, 'b': s2},
      'games': gamesArray,
      'clientEventId': event.id,
      'clientSeq': event.seq,
      'clientAction': event.action.wire,
      ...snap,
    };

    if (event.matchType == 'group') {
      payload['groupId'] = event.groupId;
      payload['matchKey'] = event.matchKey;
    } else {
      final rawMatchId =
          event.matchId.isNotEmpty ? event.matchId : event.matchKey;
      payload['matchId'] = rawMatchId;
      if (event.documentId.isNotEmpty) {
        payload['documentId'] = event.documentId;
        payload['_id'] = event.documentId;
      }
    }
    return payload;
  }

  int? _asInt(dynamic v) {
    if (v is int) return v;
    if (v is num) return v.toInt();
    return int.tryParse(v?.toString() ?? '');
  }

  void dispose() {
    _retryTimer?.cancel();
  }
}
