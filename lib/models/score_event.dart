import 'package:uuid/uuid.dart';

/// Local-first scoring actions (deltas). Never absolute-score overwrites from peers.
enum ScoreEventAction {
  pointPlus,
  pointMinus,
  sideOut,
  statusOngoing,
  submit,
  note,
}

extension ScoreEventActionX on ScoreEventAction {
  String get wire {
    switch (this) {
      case ScoreEventAction.pointPlus:
        return 'point_plus';
      case ScoreEventAction.pointMinus:
        return 'point_minus';
      case ScoreEventAction.sideOut:
        return 'side_out';
      case ScoreEventAction.statusOngoing:
        return 'status_ongoing';
      case ScoreEventAction.submit:
        return 'submit';
      case ScoreEventAction.note:
        return 'note';
    }
  }

  static ScoreEventAction fromWire(String raw) {
    switch (raw) {
      case 'point_plus':
        return ScoreEventAction.pointPlus;
      case 'point_minus':
        return ScoreEventAction.pointMinus;
      case 'side_out':
        return ScoreEventAction.sideOut;
      case 'status_ongoing':
        return ScoreEventAction.statusOngoing;
      case 'submit':
        return ScoreEventAction.submit;
      case 'note':
        return ScoreEventAction.note;
      default:
        return ScoreEventAction.pointPlus;
    }
  }
}

/// One referee tap / submit. Local UI is already updated; [snapshot] is what REST
/// needs to persist (server API is absolute-score based).
class ScoreEvent {
  ScoreEvent({
    required this.id,
    required this.seq,
    required this.matchIdentity,
    required this.gameIdentity,
    required this.tournamentId,
    required this.categoryId,
    required this.matchType,
    required this.action,
    required this.gameIndex,
    required this.snapshot,
    required this.createdAt,
    this.groupId = '',
    this.matchKey = '',
    this.matchId = '',
    this.documentId = '',
    this.side,
    this.acked = false,
    this.attempts = 0,
    this.nextRetryAt,
    this.lastError,
  });

  final String id;
  final int seq;
  final String matchIdentity;
  final String gameIdentity;
  final String tournamentId;
  final String categoryId;
  final String matchType;
  final String groupId;
  final String matchKey;
  final String matchId;
  final String documentId;
  final ScoreEventAction action;
  final int gameIndex;
  /// 1 = team/player1, 2 = team/player2 (null for side-out / status / note).
  final int? side;
  final Map<String, dynamic> snapshot;
  final DateTime createdAt;
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
        'id': id,
        'seq': seq,
        'matchIdentity': matchIdentity,
        'gameIdentity': gameIdentity,
        'tournamentId': tournamentId,
        'categoryId': categoryId,
        'matchType': matchType,
        'groupId': groupId,
        'matchKey': matchKey,
        'matchId': matchId,
        'documentId': documentId,
        'action': action.wire,
        'gameIndex': gameIndex,
        'side': side,
        'snapshot': snapshot,
        'createdAt': createdAt.toIso8601String(),
        'acked': acked,
        'attempts': attempts,
        'nextRetryAt': nextRetryAt?.toIso8601String(),
        'lastError': lastError,
      };

  factory ScoreEvent.fromJson(Map<String, dynamic> j) {
    return ScoreEvent(
      id: (j['id'] ?? '').toString(),
      seq: int.tryParse('${j['seq']}') ?? 0,
      matchIdentity: (j['matchIdentity'] ?? '').toString(),
      gameIdentity: (j['gameIdentity'] ?? '').toString(),
      tournamentId: (j['tournamentId'] ?? '').toString(),
      categoryId: (j['categoryId'] ?? '').toString(),
      matchType: (j['matchType'] ?? '').toString(),
      groupId: (j['groupId'] ?? '').toString(),
      matchKey: (j['matchKey'] ?? '').toString(),
      matchId: (j['matchId'] ?? '').toString(),
      documentId: (j['documentId'] ?? '').toString(),
      action: ScoreEventActionX.fromWire((j['action'] ?? '').toString()),
      gameIndex: int.tryParse('${j['gameIndex']}') ?? 1,
      side: j['side'] == null ? null : int.tryParse('${j['side']}'),
      snapshot: j['snapshot'] is Map
          ? Map<String, dynamic>.from(j['snapshot'] as Map)
          : <String, dynamic>{},
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

  static String newId() => const Uuid().v4();
}
