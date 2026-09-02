import 'package:flutter/foundation.dart';
import 'package:socket_io_client/socket_io_client.dart' as io;

/// Shared Socket.IO singleton — mirrors website `src/utils/socket.js`.
///
/// Score taps emit live:point / live:score-set (Ongoing) only — never REST.
/// Match Complete uses [ScoreEventQueue] → REST submit-score + live:submit.
class SocketService {
  SocketService._();
  static final SocketService instance = SocketService._();

  io.Socket? _socket;
  String? _origin;

  io.Socket? get socket => _socket;
  bool get connected => _socket?.connected == true;

  /// HTTP origin of the API host (strip trailing `/api` if present).
  static String originFromApiBase(String apiBaseUrl) {
    var raw = apiBaseUrl.trim();
    if (raw.endsWith('/')) raw = raw.substring(0, raw.length - 1);
    raw = raw.replaceFirst(RegExp(r'/api$', caseSensitive: false), '');
    if (raw.isEmpty) return 'http://localhost:5000';
    return raw;
  }

  /// Reuse the existing connection; recreate only if the API origin changed.
  io.Socket? ensureConnected(String apiBaseUrl) {
    final origin = originFromApiBase(apiBaseUrl);
    if (_socket != null && _origin == origin) {
      if (!_socket!.connected) {
        try {
          _socket!.connect();
        } catch (_) {}
      }
      return _socket;
    }
    disconnect();
    _origin = origin;
    try {
      _socket = io.io(
        origin,
        io.OptionBuilder()
            .setTransports(['websocket', 'polling'])
            .enableAutoConnect()
            .enableReconnection()
            .setReconnectionAttempts(20)
            .setReconnectionDelay(800)
            .build(),
      );
      if (kDebugMode) {
        _socket!
          ..onConnect((_) => debugPrint('[socket] connected $origin'))
          ..onDisconnect((_) => debugPrint('[socket] disconnected'))
          ..onConnectError((e) => debugPrint('[socket] connect error: $e'));
      }
    } catch (e) {
      if (kDebugMode) debugPrint('[socket] init failed: $e');
      _socket = null;
    }
    return _socket;
  }

  void disconnect() {
    try {
      _socket?.dispose();
    } catch (_) {}
    _socket = null;
    _origin = null;
  }

  void joinTournament(String tournamentId) {
    final s = _socket;
    final id = tournamentId.trim();
    if (s == null || id.isEmpty) return;
    try {
      s.emit('join-tournament', id);
      s.emit('tournament:join', id);
    } catch (_) {}
  }

  void leaveTournament(String tournamentId) {
    final s = _socket;
    final id = tournamentId.trim();
    if (s == null || id.isEmpty) return;
    try {
      s.emit('leave-tournament', id);
      s.emit('tournament:leave', id);
    } catch (_) {}
  }

  void joinMatch(String matchId) {
    final s = _socket;
    final id = matchId.trim();
    if (s == null || id.isEmpty) return;
    try {
      s.emit('join-match', id);
    } catch (_) {}
  }

  void leaveMatch(String matchId) {
    final s = _socket;
    final id = matchId.trim();
    if (s == null || id.isEmpty) return;
    try {
      s.emit('leave-match', id);
    } catch (_) {}
  }

  void joinCourt(String courtSlug) {
    final s = _socket;
    final slug = courtSlug.trim();
    if (s == null || slug.isEmpty) return;
    try {
      s.emit('join-court', slug);
      s.emit('court:join', slug);
    } catch (_) {}
  }

  void leaveCourt(String courtSlug) {
    final s = _socket;
    final slug = courtSlug.trim();
    if (s == null || slug.isEmpty) return;
    try {
      s.emit('leave-court', slug);
      s.emit('court:leave', slug);
    } catch (_) {}
  }

  /// Fire-and-forget overlay broadcast (server relays; no overlay ack expected).
  void emitMatchUpdate(Map<String, dynamic> payload) {
    final s = _socket;
    if (s == null || !s.connected) {
      throw StateError('socket not connected');
    }
    s.emit('match_update', payload);
  }

  /// Absolute live score (plus / minus / side / serve). Always Ongoing.
  void emitLiveScoreSet(Map<String, dynamic> payload) {
    final s = _socket;
    if (s == null || !s.connected) {
      throw StateError('socket not connected');
    }
    s.emit('live:score-set', payload);
  }

  /// Delta live point. Always Ongoing. Do not use after Complete.
  void emitLivePoint(Map<String, dynamic> payload) {
    final s = _socket;
    if (s == null || !s.connected) {
      throw StateError('socket not connected');
    }
    s.emit('live:point', payload);
  }

  /// Match Complete only. Never emit on score taps.
  void emitLiveSubmit(Map<String, dynamic> payload) {
    final s = _socket;
    if (s == null || !s.connected) {
      throw StateError('socket not connected');
    }
    s.emit('live:submit', payload);
  }

  /// Marks the live Match doc confirmed/Completed so OBS / live-scores clear.
  void emitLiveFlushComplete(Map<String, dynamic> payload) {
    final s = _socket;
    if (s == null || !s.connected) {
      throw StateError('socket not connected');
    }
    s.emit('live:flush-complete', payload);
  }

  void on(String event, void Function(dynamic) handler) {
    _socket?.on(event, handler);
  }

  void off(String event, [void Function(dynamic)? handler]) {
    if (handler != null) {
      _socket?.off(event, handler);
    } else {
      _socket?.off(event);
    }
  }
}
