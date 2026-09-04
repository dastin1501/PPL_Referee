import 'dart:async';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/match_update.dart';
import 'socket_service.dart';

typedef MatchUpdateQueueListener = void Function();

/// Local-first court-scoped [match_update] queue for OBS / broadcast overlays.
///
/// - Latest payload per court wins (coalesced) — overlay only needs current state.
/// - Never blocks the referee UI; flushes in background with exponential backoff.
/// - Ack = successfully emitted on a connected Socket.IO session (server relays;
///   overlay clients do not ack back to the referee app).
class MatchUpdateQueue {
  MatchUpdateQueue({
    required SocketService socket,
    this.onChanged,
  }) : _socket = socket;

  static const _storageKey = 'referee_match_update_queue_v1';

  final SocketService _socket;
  final MatchUpdateQueueListener? onChanged;

  final Map<String, _PendingMatchUpdate> _byCourt = {};
  bool _loaded = false;
  bool _flushing = false;
  Timer? _retryTimer;
  final Set<String> _inFlightCourts = {};

  int get pendingCount =>
      _byCourt.values.where((e) => e.isPending).length;

  bool get hasStalePending =>
      _byCourt.values.any((e) => e.isPending && e.isStale);

  Future<void> load() async {
    if (_loaded) return;
    final prefs = await SharedPreferences.getInstance();
    try {
      final raw = prefs.getString(_storageKey);
      if (raw != null && raw.isNotEmpty) {
        final decoded = jsonDecode(raw);
        if (decoded is Map) {
          _byCourt
            ..clear()
            ..addAll(
              decoded.map((k, v) {
                final map = v is Map
                    ? Map<String, dynamic>.from(v)
                    : <String, dynamic>{};
                return MapEntry(
                  k.toString(),
                  _PendingMatchUpdate.fromJson(map),
                );
              }),
            );
        }
      }
    } catch (e) {
      if (kDebugMode) debugPrint('[match-update-queue] load failed: $e');
    }
    _loaded = true;
    _notify();
    _scheduleFlush();
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    final lean = <String, dynamic>{};
    for (final e in _byCourt.entries) {
      lean[e.key] = e.value.toJson();
    }
    try {
      await prefs.setString(_storageKey, jsonEncode(lean));
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[match-update-queue] prefs persist failed: $e');
      }
    }
  }

  void _notify() => onChanged?.call();

  /// Replace the pending overlay snapshot for [payload.court] and flush soon.
  Future<void> enqueue(MatchUpdatePayload payload) async {
    await load();
    final court = payload.court.trim();
    if (court.isEmpty) return;

    final existing = _byCourt[court];
    _byCourt[court] = _PendingMatchUpdate(
      payload: payload,
      createdAt: existing?.isPending == true
          ? existing!.createdAt
          : DateTime.now(),
      acked: false,
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
    );
    await _persist();
    _notify();
    if (kDebugMode) {
      debugPrint(
        '[match-update-queue] enqueue court=$court '
        'matchId=${payload.matchId} serving=${payload.serving} '
        'score=${payload.team1Score}-${payload.team2Score}',
      );
    }
    _scheduleFlush();
  }

  void _scheduleFlush({Duration delay = Duration.zero}) {
    _retryTimer?.cancel();
    _retryTimer = Timer(delay, () {
      unawaited(flush());
    });
  }

  Future<void> flush() async {
    await load();
    if (_flushing) return;
    _flushing = true;
    try {
      final ready = _byCourt.entries
          .where((e) => e.value.isPending)
          .where((e) => !_inFlightCourts.contains(e.key))
          .where((e) {
            final t = e.value.nextRetryAt;
            return t == null || !t.isAfter(DateTime.now());
          })
          .toList();
      await Future.wait(ready.map((e) => _sendOne(e.key, e.value)));
    } finally {
      _flushing = false;
    }

    final pending = _byCourt.values.where((e) => e.isPending).toList();
    if (pending.isEmpty) {
      _notify();
      return;
    }
    DateTime? soonest;
    for (final e in pending) {
      final t = e.nextRetryAt ?? DateTime.now();
      if (soonest == null || t.isBefore(soonest)) soonest = t;
    }
    final wait = soonest!.difference(DateTime.now());
    _scheduleFlush(delay: wait.isNegative ? Duration.zero : wait);
    _notify();
  }

  Duration _backoffForAttempt(int attempts) {
    final seconds = (1 << (attempts.clamp(0, 10))).clamp(1, 15);
    return Duration(seconds: seconds);
  }

  Future<void> _sendOne(String court, _PendingMatchUpdate event) async {
    if (_inFlightCourts.contains(court) || event.acked) return;
    _inFlightCourts.add(court);
    _notify();
    try {
      if (!_socket.connected) {
        throw StateError('socket disconnected');
      }
      _socket.joinCourt(court);
      _socket.emitMatchUpdate(event.payload.toJson());
      event.acked = true;
      event.lastError = null;
      event.nextRetryAt = null;
      if (kDebugMode) {
        debugPrint(
          '[match-update-queue] emitted court=$court '
          'matchId=${event.payload.matchId}',
        );
      }
      // Keep last acked snapshot briefly so reconnect can re-broadcast.
      await _persist();
    } catch (e) {
      event.attempts += 1;
      event.lastError = e.toString();
      event.nextRetryAt =
          DateTime.now().add(_backoffForAttempt(event.attempts));
      if (kDebugMode) {
        debugPrint(
          '[match-update-queue] fail court=$court '
          'attempt=${event.attempts} err=$e',
        );
      }
      await _persist();
    } finally {
      _inFlightCourts.remove(court);
      _notify();
    }
  }

  /// Drop overlay snapshots for a court and tell the server to clear Live/OBS.
  Future<void> clearCourt(String courtSlug) async {
    await load();
    final court = courtSlug.trim();
    if (court.isEmpty) return;
    _byCourt.remove(court);
    await _persist();
    _notify();
    if (kDebugMode) {
      debugPrint('[match-update-queue] cleared court=$court');
    }
    try {
      if (_socket.connected) {
        _socket.joinCourt(court);
        _socket.emitMatchUpdate({
          'type': 'match_clear',
          'court': court,
          'status': 'empty',
          'updatedAt': DateTime.now().toUtc().toIso8601String(),
        });
      }
    } catch (e) {
      if (kDebugMode) {
        debugPrint('[match-update-queue] clear emit failed court=$court err=$e');
      }
    }
  }

  /// On reconnect: re-broadcast the latest overlay snapshot, but never a 0-0
  /// leftover from match open (that flickers OBS empty after live scores).
  Future<void> requeueAllForReconnect() async {
    await load();
    var any = false;
    final drop = <String>[];
    for (final e in _byCourt.entries) {
      final p = e.value.payload;
      if (p.team1Score + p.team2Score <= 0) {
        drop.add(e.key);
        continue;
      }
      e.value.acked = false;
      e.value.nextRetryAt = null;
      e.value.lastError = null;
      any = true;
    }
    for (final court in drop) {
      _byCourt.remove(court);
      any = true;
    }
    if (any) {
      await _persist();
      _scheduleFlush();
      _notify();
    }
  }

  void dispose() {
    _retryTimer?.cancel();
  }
}

class _PendingMatchUpdate {
  _PendingMatchUpdate({
    required this.payload,
    required this.createdAt,
    this.acked = false,
    this.attempts = 0,
    this.nextRetryAt,
    this.lastError,
  });

  MatchUpdatePayload payload;
  DateTime createdAt;
  bool acked;
  int attempts;
  DateTime? nextRetryAt;
  String? lastError;

  bool get isPending => !acked;
  bool get isStale {
    if (acked) return false;
    return DateTime.now().difference(createdAt) >= const Duration(seconds: 60);
  }

  Map<String, dynamic> toJson() => {
        'payload': payload.toJson(),
        'createdAt': createdAt.toIso8601String(),
        'acked': acked,
        'attempts': attempts,
        'nextRetryAt': nextRetryAt?.toIso8601String(),
        'lastError': lastError,
      };

  factory _PendingMatchUpdate.fromJson(Map<String, dynamic> j) {
    final rawPayload = j['payload'];
    return _PendingMatchUpdate(
      payload: MatchUpdatePayload.fromJson(
        rawPayload is Map
            ? Map<String, dynamic>.from(rawPayload)
            : <String, dynamic>{},
      ),
      createdAt: DateTime.tryParse((j['createdAt'] ?? '').toString()) ??
          DateTime.now(),
      acked: j['acked'] == true,
      attempts: int.tryParse('${j['attempts']}') ?? 0,
      nextRetryAt: j['nextRetryAt'] != null
          ? DateTime.tryParse(j['nextRetryAt'].toString())
          : null,
      lastError: j['lastError']?.toString(),
    );
  }
}
