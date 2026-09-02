import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/score_event.dart';
import 'api_service.dart';
import 'socket_service.dart';

typedef ScoreQueueListener = void Function();

/// Local-first score event queue.
///
/// - UI applies deltas immediately (caller does that before enqueue).
/// - Each event is persisted, then flushed in per-match sequence order.
/// - Large signatures are stored as files (not SharedPreferences) so they
///   don't get silently dropped when prefs overflow.
/// - Score taps (plus / minus / side / serve): socket `live:point` or
///   `live:score-set` only. status Ongoing. Never REST, never Completed.
/// - Complete / Submit: REST `submit-score` with actual scores, then
///   `live:submit` + `live:flush-complete` with markCompleted.
/// - Never blocks the referee; retries with exponential backoff in background.
class ScoreEventQueue {
  ScoreEventQueue({
    required ApiService api,
    SocketService? socket,
    this.onChanged,
  })  : _api = api,
        _socket = socket ?? SocketService.instance;

  static const _storageKey = 'referee_score_event_queue_v1';
  static const _seqKey = 'referee_score_event_seq_v1';
  static const _sigKeys = {'signatureData', 'gameSignatures'};

  final ApiService _api;
  final SocketService _socket;
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
    if (action != ScoreEventAction.submit) {
      fullSnap['status'] = 'Ongoing';
      fullSnap.remove('markCompleted');
    }
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
    // Completed submit must not be followed by older live/point snapshots
    // that would REST-write status Ongoing and keep OBS on.
    if (_isCompletedSubmit(event)) {
      await _dropPendingBeforeCompletedSubmit(event);
    }
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
      if (_isSupersededByCompletedSubmit(e)) continue;
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
    if (_isSupersededByCompletedSubmit(event)) {
      event.acked = true;
      event.lastError = null;
      event.nextRetryAt = null;
      await _persist();
      return;
    }
    _inFlightEventIds.add(event.id);
    _notify();
    try {
      await _loadSignatureExtras(event.id);
      // Re-check after in-flight start: Complete may have landed while we waited.
      if (_isSupersededByCompletedSubmit(event)) {
        event.acked = true;
        event.lastError = null;
        event.nextRetryAt = null;
        await _persist();
        return;
      }
      if (_isCompletedSubmit(event)) {
        final payload = _buildCompletedPayloadFrom(event);
        await _api.submitScore(payload);
        event.acked = true;
        event.lastError = null;
        event.nextRetryAt = null;
        _emitCompletedLive(event, payload);
      } else if (event.action == ScoreEventAction.submit) {
        // Mid-match Finish & Submit (not last game): persist signature, stay Ongoing.
        final payload = _buildOngoingSubmitPayload(event);
        await _api.submitScore(payload);
        event.acked = true;
        event.lastError = null;
        event.nextRetryAt = null;
      } else if (event.action == ScoreEventAction.note) {
        final payload = _buildNotePayload(event);
        await _api.submitScore(payload);
        event.acked = true;
        event.lastError = null;
        event.nextRetryAt = null;
      } else {
        // Score tap / start / serve: socket only. Never REST, never Complete.
        _emitLiveScore(event);
        event.acked = true;
        event.lastError = null;
        event.nextRetryAt = null;
      }
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

  bool _snapshotStatusIsCompleted(Map<String, dynamic> snap) {
    return snap['status']?.toString().trim().toLowerCase() == 'completed';
  }

  bool _isCompletedSubmit(ScoreEvent event) {
    return event.action == ScoreEventAction.submit &&
        _snapshotStatusIsCompleted(event.snapshot);
  }

  bool _isSupersededByCompletedSubmit(ScoreEvent event) {
    if (_isCompletedSubmit(event)) return false;
    // Any live/point/note after (or still pending before) Complete must not
    // emit zeros or keep OBS on.
    return _events.any(
      (e) => e.matchIdentity == event.matchIdentity && _isCompletedSubmit(e),
    );
  }

  Future<void> _dropPendingBeforeCompletedSubmit(ScoreEvent submit) async {
    final drop = _events
        .where(
          (e) =>
              e.matchIdentity == submit.matchIdentity &&
              e.id != submit.id &&
              e.isPending &&
              e.seq < submit.seq,
        )
        .toList();
    for (final e in drop) {
      e.acked = true;
      e.lastError = null;
      e.nextRetryAt = null;
      await _deleteSignatureExtras(e.id);
    }
    if (drop.isNotEmpty && kDebugMode) {
      debugPrint(
        '[score-queue] dropped ${drop.length} pending events before '
        'Completed submit seq=${submit.seq}',
      );
    }
  }

  void _emitCompletedLive(ScoreEvent event, Map<String, dynamic> payload) {
    try {
      if (!_socket.connected) return;
      // Do not copy `game` / `side` / `delta` onto live:submit — the backend
      // treats those as a live tick and refuses to mark Completed.
      final live = <String, dynamic>{
        'eventId': event.id,
        'clientSeq': event.seq,
        'clientAction': 'submit',
        'tournamentId': event.tournamentId,
        'categoryId': event.categoryId,
        'type': event.matchType,
        'status': 'Completed',
        'markCompleted': true,
        'gameIndex': event.gameIndex.clamp(1, 3),
        if (payload['game1Player1'] != null) 'game1Player1': payload['game1Player1'],
        if (payload['game1Player2'] != null) 'game1Player2': payload['game1Player2'],
        if (payload['game2Player1'] != null) 'game2Player1': payload['game2Player1'],
        if (payload['game2Player2'] != null) 'game2Player2': payload['game2Player2'],
        if (payload['game3Player1'] != null) 'game3Player1': payload['game3Player1'],
        if (payload['game3Player2'] != null) 'game3Player2': payload['game3Player2'],
        if (payload['games'] != null) 'games': payload['games'],
        if (payload['score1'] != null) 'score1': payload['score1'],
        if (payload['score2'] != null) 'score2': payload['score2'],
        if (payload['finalScorePlayer1'] != null)
          'finalScorePlayer1': payload['finalScorePlayer1'],
        if (payload['finalScorePlayer2'] != null)
          'finalScorePlayer2': payload['finalScorePlayer2'],
        if (payload['winner'] != null) 'winner': payload['winner'],
      };
      _stripScheduleFields(live);
      _attachMatchIdentity(live, event);
      _socket.emitLiveSubmit(live);
      final flush = <String, dynamic>{
        'eventId': 'flush-${event.id}',
        'clientSeq': event.seq,
        'markCompleted': true,
        'status': 'Completed',
        'tournamentId': event.tournamentId,
        'categoryId': event.categoryId,
        'type': event.matchType,
      };
      _attachMatchIdentity(flush, event);
      _stripScheduleFields(flush);
      _socket.emitLiveFlushComplete(flush);
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[score-queue] live:submit/flush-complete emit failed: $e');
      }
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
      ScoreEvent? keepCompleted;
      for (final e in forMatch.take(contiguousAcked)) {
        if (_isCompletedSubmit(e)) keepCompleted = e;
      }
      final keep = (keepCompleted ?? forMatch[contiguousAcked - 1]).id;
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

  /// Drop all queued events for a match after staff unlock/clear on the website.
  /// Without this, cold start / refresh re-applies local Completed over Scheduled.
  Future<void> discardMatch(String matchIdentity) async {
    final id = matchIdentity.trim();
    if (id.isEmpty) return;
    await load();
    final removed = <ScoreEvent>[];
    _events.removeWhere((e) {
      final drop = e.matchIdentity == id;
      if (drop) removed.add(e);
      return drop;
    });
    if (removed.isEmpty) return;
    for (final e in removed) {
      _inFlightEventIds.remove(e.id);
      await _deleteSignatureExtras(e.id);
    }
    _seqByMatch.remove(id);
    await _persist();
    _notify();
    if (kDebugMode) {
      debugPrint('[score-queue] discarded ${removed.length} event(s) for $id');
    }
  }

  Iterable<String> get knownMatchIdentities sync* {
    final seen = <String>{};
    for (final e in _events) {
      if (seen.add(e.matchIdentity)) yield e.matchIdentity;
    }
  }

  Map<String, dynamic> _buildCompletedPayloadFrom(ScoreEvent event) {
    final snap = _fullSnapshot(event);
    final gameIndex = event.gameIndex.clamp(1, 3);
    final s1 = _asInt(snap['game${gameIndex}Player1']) ?? 0;
    final s2 = _asInt(snap['game${gameIndex}Player2']) ?? 0;
    return _buildCompletedPayload(event, snap, gameIndex, s1, s2);
  }

  Map<String, dynamic> _buildNotePayload(ScoreEvent event) {
    final snap = _fullSnapshot(event);
    final payload = <String, dynamic>{
      'tournamentId': event.tournamentId,
      'categoryId': event.categoryId,
      'type': event.matchType,
      'gameIndex': event.gameIndex.clamp(1, 3),
      'clientEventId': event.id,
      'clientSeq': event.seq,
      'clientAction': event.action.wire,
      if (snap['refereeNote'] != null) 'refereeNote': snap['refereeNote'],
    };
    _attachMatchIdentity(payload, event);
    _stripScheduleFields(payload);
    payload.remove('markCompleted');
    payload.remove('status');
    return payload;
  }

  void _emitLiveScore(ScoreEvent event) {
    if (_isSupersededByCompletedSubmit(event)) return;
    if (event.action == ScoreEventAction.pointPlus ||
        event.action == ScoreEventAction.pointMinus) {
      final side = event.side;
      if (side == 1 || side == 2) {
        final point = <String, dynamic>{
          'eventId': event.id,
          'clientSeq': event.seq,
          'tournamentId': event.tournamentId,
          'categoryId': event.categoryId,
          'type': event.matchType,
          'game': event.gameIndex.clamp(1, 3),
          'gameIndex': event.gameIndex.clamp(1, 3),
          'side': side,
          'delta': event.action == ScoreEventAction.pointPlus ? 1 : -1,
          'status': 'Ongoing',
        };
        final snap = _fullSnapshot(event);
        if (snap['serving'] != null) point['serving'] = snap['serving'];
        if (snap['servingPlayer'] != null) {
          point['servingPlayer'] = snap['servingPlayer'];
        }
        _attachMatchIdentity(point, event);
        _prepareLiveTickPayload(point);
        _socket.emitLivePoint(point);
        return;
      }
    }
    final payload = _buildLiveScoreSetPayload(event);
    _socket.emitLiveScoreSet(payload);
  }

  Map<String, dynamic> _buildLiveScoreSetPayload(ScoreEvent event) {
    final snap = _fullSnapshot(event);
    final gameIndex = event.gameIndex.clamp(1, 3);
    final s1 = _asInt(snap['game${gameIndex}Player1']) ??
        _asInt(snap['score1']) ??
        0;
    final s2 = _asInt(snap['game${gameIndex}Player2']) ??
        _asInt(snap['score2']) ??
        0;
    final scores = <String, dynamic>{
      'game$gameIndex': {'team1': s1, 'team2': s2},
    };
    final payload = <String, dynamic>{
      'eventId': event.id,
      'clientSeq': event.seq,
      'tournamentId': event.tournamentId,
      'categoryId': event.categoryId,
      'type': event.matchType,
      'game': gameIndex,
      'gameIndex': gameIndex,
      'status': 'Ongoing',
      'game${gameIndex}Player1': s1,
      'game${gameIndex}Player2': s2,
      'scores': scores,
      if (snap['serving'] != null) 'serving': snap['serving'],
      if (snap['servingPlayer'] != null) 'servingPlayer': snap['servingPlayer'],
    };
    // Include other played games from the snapshot only — never pad 0-0
    // (that would wipe earlier games on live:score-set).
    for (int i = 1; i <= 3; i++) {
      if (i == gameIndex) continue;
      final a = _asInt(snap['game${i}Player1']);
      final b = _asInt(snap['game${i}Player2']);
      if (a == null || b == null || a + b <= 0) continue;
      payload['game${i}Player1'] = a;
      payload['game${i}Player2'] = b;
      scores['game$i'] = {'team1': a, 'team2': b};
    }
    _attachMatchIdentity(payload, event);
    _prepareLiveTickPayload(payload);
    return payload;
  }

  Map<String, dynamic> _buildOngoingSubmitPayload(ScoreEvent event) {
    final snap = _fullSnapshot(event);
    final gameIndex = event.gameIndex.clamp(1, 3);
    final s1 = _asInt(snap['game${gameIndex}Player1']) ??
        _asInt(snap['score1']) ??
        0;
    final s2 = _asInt(snap['game${gameIndex}Player2']) ??
        _asInt(snap['score2']) ??
        0;
    final payload = <String, dynamic>{
      'tournamentId': event.tournamentId,
      'categoryId': event.categoryId,
      'type': event.matchType,
      'selectedGame': gameIndex,
      'assignedGame': gameIndex,
      'gameIndex': gameIndex,
      'status': 'Ongoing',
      'game${gameIndex}Status': 'Completed',
      'game': {'a': s1, 'b': s2},
      'clientEventId': event.id,
      'clientSeq': event.seq,
      'clientAction': event.action.wire,
      if (snap['signatureData'] != null) 'signatureData': snap['signatureData'],
      if (snap['gameSignatures'] != null) 'gameSignatures': snap['gameSignatures'],
      if (snap['refereeNote'] != null) 'refereeNote': snap['refereeNote'],
    };
    payload.remove('markCompleted');
    for (int i = 1; i <= 3; i++) {
      final a = _asInt(snap['game${i}Player1']);
      final b = _asInt(snap['game${i}Player2']);
      if (a != null && b != null && (a + b) > 0) {
        payload['game${i}Player1'] = a;
        payload['game${i}Player2'] = b;
      }
    }
    payload['game${gameIndex}Player1'] = s1;
    payload['game${gameIndex}Player2'] = s2;
    _attachMatchIdentity(payload, event);
    _stripScheduleFields(payload);
    return payload;
  }

  void _prepareLiveTickPayload(Map<String, dynamic> payload) {
    payload['status'] = 'Ongoing';
    payload.remove('markCompleted');
    payload.remove('winner');
    payload.remove('finalScorePlayer1');
    payload.remove('finalScorePlayer2');
    _stripScheduleFields(payload);
  }

  void _stripScheduleFields(Map<String, dynamic> payload) {
    const keys = {
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
    for (final key in keys) {
      payload.remove(key);
    }
    final status = payload['status']?.toString().trim().toLowerCase() ?? '';
    if (status == 'scheduled' ||
        status == 'unschedule' ||
        status == 'unscheduled' ||
        status == 'called') {
      payload.remove('status');
    }
  }

  Map<String, dynamic> _buildCompletedPayload(
    ScoreEvent event,
    Map<String, dynamic> snap,
    int gameIndex,
    int s1,
    int s2,
  ) {
    final gamesArray = <Map<String, int>>[];
    for (int i = 1; i <= 3; i++) {
      final a = i == gameIndex ? s1 : (_asInt(snap['game${i}Player1']) ?? 0);
      final b = i == gameIndex ? s2 : (_asInt(snap['game${i}Player2']) ?? 0);
      if (a + b > 0) {
        gamesArray.add({'a': a, 'b': b});
      }
    }
    if (gamesArray.isEmpty && (s1 + s2) > 0) {
      gamesArray.add({'a': s1, 'b': s2});
    }

    final payload = <String, dynamic>{
      'tournamentId': event.tournamentId,
      'categoryId': event.categoryId,
      'type': event.matchType,
      'selectedGame': gameIndex,
      'assignedGame': gameIndex,
      'gameIndex': gameIndex,
      'status': 'Completed',
      'markCompleted': true,
      'game${gameIndex}Status': 'Completed',
      'game': {'a': s1, 'b': s2},
      'games': gamesArray,
      'clientEventId': event.id,
      'clientSeq': event.seq,
      'clientAction': event.action.wire,
      if (snap['winner'] != null) 'winner': snap['winner'],
      if (snap['finalScorePlayer1'] != null)
        'finalScorePlayer1': snap['finalScorePlayer1'],
      if (snap['finalScorePlayer2'] != null)
        'finalScorePlayer2': snap['finalScorePlayer2'],
      if (snap['score1'] != null) 'score1': snap['score1'],
      if (snap['score2'] != null) 'score2': snap['score2'],
      if (snap['signatureData'] != null) 'signatureData': snap['signatureData'],
      if (snap['gameSignatures'] != null) 'gameSignatures': snap['gameSignatures'],
      if (snap['refereeNote'] != null) 'refereeNote': snap['refereeNote'],
    };
    for (int i = 1; i <= 3; i++) {
      final a = _asInt(snap['game${i}Player1']);
      final b = _asInt(snap['game${i}Player2']);
      if (a != null && b != null && (a + b) > 0) {
        payload['game${i}Player1'] = a;
        payload['game${i}Player2'] = b;
      }
    }
    payload['game${gameIndex}Player1'] = s1;
    payload['game${gameIndex}Player2'] = s2;
    _attachMatchIdentity(payload, event);
    _stripScheduleFields(payload);
    return payload;
  }

  void _attachMatchIdentity(Map<String, dynamic> payload, ScoreEvent event) {
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
