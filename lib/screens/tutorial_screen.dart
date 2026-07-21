import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../models.dart';
import '../state/app_state.dart';
import 'referee_dashboard_screen.dart';

class TutorialTab extends StatelessWidget {
  const TutorialTab({super.key});

  static const _brand = Color(0xFF0F766E);

  @override
  Widget build(BuildContext context) {
    const items = [
      _TutorialItem(event: 'Singles', format: 'Side-Out', catId: 'tutorial_singles_sideout'),
      _TutorialItem(event: 'Doubles', format: 'Side-Out', catId: 'tutorial_doubles_sideout'),
      _TutorialItem(event: 'Teams', format: 'Side-Out', catId: 'tutorial_teams_sideout'),
      _TutorialItem(event: 'Singles', format: 'Rally', catId: 'tutorial_singles_rally'),
      _TutorialItem(event: 'Doubles', format: 'Rally', catId: 'tutorial_doubles_rally'),
      _TutorialItem(event: 'Team', format: 'Rally', catId: 'tutorial_team_rally'),
    ];

    return ListView.separated(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 28),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 12),
      itemBuilder: (context, i) {
        final item = items[i];
        return _TutorialCard(
          title: '${item.event} - ${item.format}',
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute(
              builder: (_) => TutorialSimulationScreen(catId: item.catId),
            ),
          ),
        );
      },
    );
  }
}

class _TutorialCard extends StatelessWidget {
  final String title;
  final VoidCallback onTap;

  const _TutorialCard({
    required this.title,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    const brand = Color(0xFF0F766E);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(18),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 14),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(18),
            border: Border.all(color: brand.withValues(alpha: 0.12)),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.03),
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 38,
                    height: 38,
                    decoration: BoxDecoration(
                      color: brand.withValues(alpha: 0.12),
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Icon(Icons.play_arrow_rounded, color: brand),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      title,
                      style: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w900,
                        color: Color(0xFF0F172A),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 10),
              Text(
                'Simulation (exact replica of referee dashboard)',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: const Color(0xFF94A3B8),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TutorialItem {
  final String event;
  final String format;
  final String catId;

  const _TutorialItem({
    required this.event,
    required this.format,
    required this.catId,
  });
}

class TutorialSimulationScreen extends StatefulWidget {
  final String catId;

  const TutorialSimulationScreen({super.key, required this.catId});

  @override
  State<TutorialSimulationScreen> createState() => _TutorialSimulationScreenState();
}

class _TutorialSimulationScreenState extends State<TutorialSimulationScreen> {
  @override
  void initState() {
    super.initState();
    final app = context.read<AppState>();
    app.enterTutorialSimulation(
      tutorialTournament: _buildTutorialTournament(widget.catId),
      tutorialMatch: _buildTutorialMatch(widget.catId),
      gameNumber: 1,
    );
  }

  @override
  void dispose() {
    final app = context.read<AppState>();
    app.exitTutorialSimulation();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return const RefereeDashboardScreen();
  }
}

Tournament _buildTutorialTournament(String catId) {
  final today = DateTime.now().toIso8601String().split('T').first;
  return Tournament(
    id: 'tutorial',
    name: 'Tutorial',
    referees: const [],
    courts: const ['Court 1'],
    hasAuthoritativeSchedule: false,
    preferredScheduleDate: today,
    categoryNames: {catId: catId},
    categoryGamesPerMatch: {catId: 1},
    categoryScoringTypes: const {},
    categoryDivisions: {catId: catId.contains('team') ? 'team' : 'singles'},
  );
}

TournamentMatch _buildTutorialMatch(String catId) {
  final today = DateTime.now().toIso8601String().split('T').first;
  final isRally = catId.contains('rally');

  String p1;
  String p2;

  if (catId.contains('doubles') || catId.contains('team') && !catId.contains('teams_sideout')) {
    // Doubles / Team (treated similarly by the dashboard using " / " splitting).
    p1 = 'A1 / A2';
    p2 = 'B1 / B2';
  } else if (catId.contains('teams_sideout')) {
    p1 = 'T1 / T2';
    p2 = 'U1 / U2';
  } else {
    // Singles
    p1 = 'Player A';
    p2 = 'Player B';
  }

  // Round of 32-style simulator doesn't need elimination logic; we just
  // need the dashboard to behave normally.
  return TournamentMatch(
    id: 'tutorial:${catId}',
    documentId: '',
    scheduleFromAssignments: false,
    player1: p1,
    player2: p2,
    score1: 0,
    score2: 0,
    round: 'Tutorial',
    court: 'Court 1',
    date: today,
    time: '10:00',
    type: 'elimination',
    status: 'Scheduled',
    categoryId: catId,
    matchKey: 'tutorial_match_${catId}',
    matchLabel: 'Tutorial',
    seedLabel: 'Game 1',
    scoringFormat: isRally ? 'rally' : 'sideout',
  );
}

