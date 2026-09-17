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
    this.categoryId = '',
    this.category = '',
    this.division = '',
    this.matchKey = '',
    this.stage = '',
    this.gamesPerMatch,
    this.currentGame = 1,
    this.scores,
    this.resetScores = false,
    this.freshStart = false,
  });

  /// Court slug (lowercase, hyphenated), e.g. `center-court`.
  final String court;
  final String matchId;
  final String tournament;
  final String tournamentId;
  final String categoryId;
  final String category;
  final String division;
  final String matchKey;
  final String stage;
  final int? gamesPerMatch;
  final int currentGame;
  final Map<String, dynamic>? scores;
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
        if (categoryId.isNotEmpty) 'categoryId': categoryId,
        if (category.isNotEmpty) 'category': category,
        if (division.isNotEmpty) 'division': division,
        if (matchKey.isNotEmpty) 'matchKey': matchKey,
        if (matchKey.isNotEmpty) 'bracketMatchId': matchKey,
        if (stage.isNotEmpty) 'stage': stage,
        if (gamesPerMatch != null) 'gamesPerMatch': gamesPerMatch,
        'currentGame': currentGame,
        if (scores != null) 'scores': scores,
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
        'playerA': team1Name,
        'playerB': team2Name,
        'scoreA': team1Score,
        'scoreB': team2Score,
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
      categoryId: (j['categoryId'] ?? '').toString(),
      category: (j['category'] ?? '').toString(),
      division: (j['division'] ?? '').toString(),
      matchKey: (j['matchKey'] ?? j['bracketMatchId'] ?? '').toString(),
      stage: (j['stage'] ?? '').toString(),
      gamesPerMatch: int.tryParse('${j['gamesPerMatch'] ?? ''}'),
      currentGame: int.tryParse('${j['currentGame'] ?? 1}') ?? 1,
      scores: j['scores'] is Map ? Map<String, dynamic>.from(j['scores'] as Map) : null,
      team1Name: (t1['name'] ?? j['playerA'] ?? '').toString(),
      team1Score: int.tryParse('${t1['score'] ?? j['scoreA']}') ?? 0,
      team1Games: gamesOf(t1['games']),
      team2Name: (t2['name'] ?? j['playerB'] ?? '').toString(),
      team2Score: int.tryParse('${t2['score'] ?? j['scoreB']}') ?? 0,
      team2Games: gamesOf(t2['games']),
      serving: (j['serving'] ?? 'team1').toString() == 'team2' ? 'team2' : 'team1',
      resetScores: j['resetScores'] == true,
      freshStart: j['freshStart'] == true,
    );
  }
}
