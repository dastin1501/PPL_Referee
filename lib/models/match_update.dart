/// Court-scoped overlay payload (`type: match_update`).
class MatchUpdatePayload {
  MatchUpdatePayload({
    required this.court,
    required this.matchId,
    required this.tournament,
    required this.team1Name,
    required this.team1Score,
    required this.team1Games,
    required this.team2Name,
    required this.team2Score,
    required this.team2Games,
    required this.serving,
    this.tournamentId = '',
    this.resetScores = false,
    this.freshStart = false,
  });

  /// Court slug (lowercase, hyphenated), e.g. `center-court`.
  final String court;
  final String matchId;
  final String tournament;
  final String tournamentId;
  final String team1Name;
  final int team1Score;
  final List<bool> team1Games;
  final String team2Name;
  final int team2Score;
  final List<bool> team2Games;

  /// `"team1"` or `"team2"`.
  final String serving;

  /// Start Game / restart — clients must accept even if score totals drop.
  final bool resetScores;
  final bool freshStart;

  Map<String, dynamic> toJson() => {
        'type': 'match_update',
        'court': court,
        'matchId': matchId,
        'tournament': tournament,
        if (tournamentId.isNotEmpty) 'tournamentId': tournamentId,
        'team1': {
          'name': team1Name,
          'score': team1Score,
          'games': team1Games,
        },
        'team2': {
          'name': team2Name,
          'score': team2Score,
          'games': team2Games,
        },
        'serving': serving,
        if (resetScores) 'resetScores': true,
        if (freshStart) 'freshStart': true,
        'updatedAt': DateTime.now().toUtc().toIso8601String(),
      };

  factory MatchUpdatePayload.fromJson(Map<String, dynamic> j) {
    List<bool> gamesOf(dynamic raw) {
      if (raw is! List) return const [false, false];
      return raw.map((e) => e == true).toList();
    }

    Map<String, dynamic> team(dynamic raw) =>
        raw is Map ? Map<String, dynamic>.from(raw) : <String, dynamic>{};

    final t1 = team(j['team1']);
    final t2 = team(j['team2']);
    return MatchUpdatePayload(
      court: (j['court'] ?? '').toString(),
      matchId: (j['matchId'] ?? '').toString(),
      tournament: (j['tournament'] ?? '').toString(),
      tournamentId: (j['tournamentId'] ?? '').toString(),
      team1Name: (t1['name'] ?? '').toString(),
      team1Score: int.tryParse('${t1['score']}') ?? 0,
      team1Games: gamesOf(t1['games']),
      team2Name: (t2['name'] ?? '').toString(),
      team2Score: int.tryParse('${t2['score']}') ?? 0,
      team2Games: gamesOf(t2['games']),
      serving: (j['serving'] ?? 'team1').toString() == 'team2' ? 'team2' : 'team1',
      resetScores: j['resetScores'] == true,
      freshStart: j['freshStart'] == true,
    );
  }
}
