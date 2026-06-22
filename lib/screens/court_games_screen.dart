import 'dart:convert';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../models.dart';
import '../state/app_state.dart';

class CourtGamesScreen extends StatefulWidget {
  const CourtGamesScreen({super.key});

  @override
  State<CourtGamesScreen> createState() => _CourtGamesScreenState();
}

class _CourtGamesScreenState extends State<CourtGamesScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  void _openDashboardForGame(TournamentMatch g, int gameNo) {
    context.read<AppState>().openGameWithNumber(g, gameNo);
    Navigator.of(context).pushNamed('/dashboard').then((result) {
      if (!mounted) return;
      if (result == 'completed') {
        _tabController.animateTo(1);
      }
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final courts = List<String>.from(app.courts)
      ..sort((a, b) {
        final ma = RegExp(r'(\d+)').firstMatch(a);
        final mb = RegExp(r'(\d+)').firstMatch(b);
        if (ma != null && mb != null) {
          final na = int.tryParse(ma.group(1)!) ?? 0;
          final nb = int.tryParse(mb.group(1)!) ?? 0;
          return na.compareTo(nb);
        }
        return a.toLowerCase().compareTo(b.toLowerCase());
      });
    final hasCourt = app.selectedCourt != null;
    final dates = hasCourt ? app.availableDatesForSelectedCourt : <String>[];
    final hasDate = app.selectedDate != null;
    final List<TournamentMatch> games =
        hasCourt ? app.matchesForSelectedCourt : <TournamentMatch>[];

    return Scaffold(
        appBar: AppBar(
          title: Text(app.selectedTournament?.name ?? 'Tournament'),
          backgroundColor: Colors.white,
          foregroundColor: Colors.black87,
          elevation: 0,
          actions: [
            if (app.pendingSyncCount > 0)
              TextButton.icon(
                onPressed: () => app.trySyncOutbox(),
                icon: const Icon(Icons.sync, color: Color(0xFF22C55E)),
                label: Text('Sync ${app.pendingSyncCount}', style: const TextStyle(color: Color(0xFF22C55E))),
              ),
          ],
          bottom: TabBar(
            controller: _tabController,
            indicatorColor: const Color(0xFF22C55E),
            labelColor: const Color(0xFF22C55E),
            unselectedLabelColor: Colors.grey,
            tabs: const [
              Tab(text: 'Scheduled'),
              Tab(text: 'Completed'),
            ],
          ),
        ),
        body: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(
            children: [
              if (courts.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(16.0),
                  child: Text('No courts found for this tournament.'),
                )
              else
                DropdownButtonFormField<String>(
                  initialValue: courts.contains(app.selectedCourt) ? app.selectedCourt : null,
                  items: courts
                      .map((c) => DropdownMenuItem<String>(
                            value: c,
                            child: Text(c),
                          ))
                      .toList(),
                  onChanged: (c) {
                    if (c != null) {
                      app.selectCourt(c);
                    }
                  },
                  decoration: InputDecoration(
                    labelText: 'Select Court',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: BorderSide(color: Colors.grey.shade300),
                    ),
                    focusedBorder: const OutlineInputBorder(
                      borderRadius: BorderRadius.only(
                        topLeft: Radius.circular(14),
                        topRight: Radius.circular(14),
                        bottomLeft: Radius.circular(14),
                        bottomRight: Radius.circular(14),
                      ),
                      borderSide: BorderSide(color: Color(0xFF22C55E), width: 1.5),
                    ),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  ),
                ),
              const SizedBox(height: 12),
              Expanded(
                child: TabBarView(
                  controller: _tabController,
                  children: [
                    _buildGamesList(
                      context,
                      app,
                      games,
                      hasCourt && hasDate,
                      onOpenGame: _openDashboardForGame,
                      showScheduled: true,
                      emptyMessage: 'No scheduled matches for this court/date.',
                      noSelectionMessage: hasCourt
                          ? 'Please select a date to view matches.'
                          : 'Please select a court to view matches.',
                    ),
                    _buildGamesList(
                      context,
                      app,
                      games,
                      hasCourt && hasDate,
                      onOpenGame: _openDashboardForGame,
                      showScheduled: false,
                      emptyMessage: 'No completed matches for this court/date.',
                      noSelectionMessage: hasCourt
                          ? 'Please select a date to view matches.'
                          : 'Please select a court to view matches.',
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
              if (hasCourt)
                DropdownButtonFormField<String>(
                  initialValue: dates.contains(app.selectedDate) ? app.selectedDate : null,
                  items: dates
                      .map((d) => DropdownMenuItem<String>(
                            value: d,
                            child: Text(d),
                          ))
                      .toList(),
                  onChanged: (d) {
                    if (d != null) {
                      app.selectDate(d);
                    }
                  },
                  decoration: InputDecoration(
                    labelText: 'Select Date',
                    border: OutlineInputBorder(borderRadius: BorderRadius.circular(14)),
                    enabledBorder: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(14),
                      borderSide: BorderSide(color: Colors.grey.shade300),
                    ),
                    focusedBorder: const OutlineInputBorder(
                      borderRadius: BorderRadius.only(
                        topLeft: Radius.circular(14),
                        topRight: Radius.circular(14),
                        bottomLeft: Radius.circular(14),
                        bottomRight: Radius.circular(14),
                      ),
                      borderSide: BorderSide(color: Color(0xFF22C55E), width: 1.5),
                    ),
                    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  ),
                ),
              if (hasCourt && dates.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(top: 8.0),
                  child: Text('No schedule dates found for this court.'),
                ),
            ],
          ),
        ),
    );
  }
}

Widget _buildGamesList(
  BuildContext context,
  AppState app,
  List<TournamentMatch> games,
  bool hasCourt, {
  required void Function(TournamentMatch g, int gameNo) onOpenGame,
  required bool showScheduled,
  required String emptyMessage,
  required String noSelectionMessage,
}) {
  if (!hasCourt) {
    return Center(child: Text(noSelectionMessage));
  }
  if (games.isEmpty) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.event_busy, color: Colors.grey, size: 40),
          const SizedBox(height: 8),
          Text(emptyMessage, textAlign: TextAlign.center),
        ],
      ),
    );
  }
  // Expand per-game items (only include games that were actually scheduled)
  final items = <Map<String, dynamic>>[];
  for (final g in games) {
    final int gpm = app.selectedTournament?.categoryGamesPerMatch[g.categoryId] ?? 1;
    String label = g.matchLabel.toString() ?? '';
    if (label.isEmpty) label = 'GA';

    void addItem(int n, String? start, String? end) {
      items.add({
        'g': g,
        'n': n,
        'scheduled': (start != null && start.toString().trim().isNotEmpty),
        'start': start?.toString() ?? '',
        'end': end?.toString() ?? '',
        'taskId': '${g.type == 'group' ? g.categoryId : (g.id.isNotEmpty ? g.id : g.matchKey)}:g$n',
      });
    }

    if (gpm >= 1 && (g.time.toString().trim().isNotEmpty ?? false)) {
      addItem(1, g.time.toString(), null);
    }
    if (gpm >= 2 && (g.mdTime2?.toString().trim().isNotEmpty ?? false)) {
      addItem(2, g.mdTime2?.toString(), g.mdEnd2?.toString());
    }
    if (gpm >= 3 && (g.mdTime3?.toString().trim().isNotEmpty ?? false)) {
      addItem(3, g.mdTime3?.toString(), g.mdEnd3?.toString());
    }
  }

  // Filter by tab: scheduled vs completed
  if (showScheduled) {
    items.removeWhere((it) => !(it['scheduled'] as bool));
    items.removeWhere((it) => (it['g'].status == 'Completed'));
  } else {
    items.removeWhere((it) => !(it['scheduled'] as bool));
    items.removeWhere((it) => (it['g'].status != 'Completed'));
  }

  // If nothing remains, show empty
  if (items.isEmpty) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.event_busy, color: Colors.grey, size: 40),
          const SizedBox(height: 8),
          Text(emptyMessage, textAlign: TextAlign.center),
        ],
      ),
    );
  }

  int timeKey(Map<String, dynamic> it) {
    final raw = (it['start'] as String?)?.trim() ?? '';
    if (raw.isEmpty) return 999999; // unscheduled at bottom
    final t = raw.toUpperCase();
    final ampm = RegExp(r'^(\d{1,2}):(\d{2})\s*(AM|PM)?$').firstMatch(t)
        ?? RegExp(r'^(\d{1,2})(\d{2})\s*(AM|PM)?$').firstMatch(t);
    if (ampm != null) {
      int h = int.tryParse(ampm.group(1) ?? '0') ?? 0;
      final m = int.tryParse(ampm.group(2) ?? '0') ?? 0;
      final ap = ampm.group(3);
      if (ap == 'PM' && h < 12) h += 12;
      if (ap == 'AM' && h == 12) h = 0;
      return h * 60 + m;
    }
    return 999998;
  }
  items.sort((a, b) {
    final tk = timeKey(a).compareTo(timeKey(b));
    if (tk != 0) return tk;
    final na = a['n'] as int;
    final nb = b['n'] as int;
    if (na != nb) return na.compareTo(nb);
    final la = a['g'].matchLabel?.toString() ?? '';
    final lb = b['g'].matchLabel?.toString() ?? '';
    return la.compareTo(lb);
  });

  return RefreshIndicator(
    onRefresh: () => app.refreshSelectedTournament(),
    child: ListView.builder(
      itemCount: items.length,
      itemBuilder: (_, i) {
        final it = items[i];
        final g = it['g'];
        final n = it['n'] as int;
        final start = (it['start'] as String?) ?? '';
        final end = (it['end'] as String?) ?? '';
        final scheduled = it['scheduled'] as bool;
      final category = app.selectedTournament?.categoryNames[g.categoryId] ?? '';
      String displayCategory = category;
      if (displayCategory.isNotEmpty) {
        final pattern = RegExp(r'open[\s_-]?tier[\s_-]?\d+', caseSensitive: false);
        displayCategory = displayCategory.replaceAll(pattern, 'Open');
        displayCategory = displayCategory
            .replaceAll(RegExp(r"women'?s?\s+singles", caseSensitive: false), 'WS')
            .replaceAll(RegExp(r"men'?s?\s+singles", caseSensitive: false), 'MS')
            .replaceAll(RegExp(r"women'?s?\s+doubles", caseSensitive: false), 'WD')
            .replaceAll(RegExp(r"men'?s?\s+doubles", caseSensitive: false), 'MD')
            .replaceAll(RegExp(r"mixed\s+doubles", caseSensitive: false), 'MxD');
        displayCategory = displayCategory.replaceAll(RegExp(r'\s{2,}'), ' ').trim();
      }
      final isCompleted = g.status == 'Completed';
      final isOngoing = g.status == 'Ongoing';
      final bool disabled = showScheduled && isOngoing;
      String displayStatus;
      if (g.status.toString().isNotEmpty) {
        displayStatus = g.status.toString();
      } else {
        final hasSchedule = (n == 1)
            ? ((start.trim().isNotEmpty) && (g.court.toString().trim().isNotEmpty))
            : ((start.trim().isNotEmpty) && (g.court.toString().trim().isNotEmpty));
        displayStatus = hasSchedule ? 'Scheduled' : 'Unscheduled';
      }
        // Determine accent color by category (women=pink, men=blue, mixed=green)
        final catText = category.toLowerCase();
        final isMixed = catText.contains('mixed');
        final isWomen = catText.contains('women') || catText.contains('ladies') || catText.contains('female') || catText.contains('girls');
        final isMen = catText.contains('men') || catText.contains('male') || catText.contains('boys');
        const Color mixedGreen = Color.fromARGB(255, 26, 161, 123);
        final Color accentColor = isWomen
            ? const Color(0xFFE91E63)
            : isMen
                ? const Color(0xFF1E88E5)
                : isMixed
                    ? mixedGreen
                    : mixedGreen;
        final Color bgColor = accentColor.withValues(alpha: 0.15);
        final bool isRallyScoring = g.isRallyScoring;
        final Color scoringBg = isRallyScoring ? const Color(0xFFFFF1F2) : const Color(0xFFF0FDF4);
        final Color scoringBorder = isRallyScoring ? const Color(0xFFFB7185) : const Color(0xFF22C55E);
        final String scoringLabel = isRallyScoring ? 'Rally' : 'Side-Out';
        return InkWell(
          onTap: disabled
              ? null
              : () {
                  if (!showScheduled) {
                    _showCompletedSummaryDialog(context, g);
                  } else {
                    onOpenGame(g, n);
                  }
                },
          borderRadius: BorderRadius.circular(16),
          child: Opacity(
            opacity: disabled ? 0.55 : 1,
            child: Container(
            margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: disabled ? const Color(0xFFF5F5F7) : Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: disabled ? Colors.grey.shade300 : accentColor.withValues(alpha: 0.35)),
            ),
            child: Row(
              children: [
                CircleAvatar(
                  backgroundColor: disabled ? Colors.grey.shade200 : bgColor,
                  child: Icon(
                    isCompleted ? Icons.check : (disabled ? Icons.lock_clock : Icons.schedule),
                    color: disabled ? Colors.grey : accentColor,
                    size: 20,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (displayCategory.isNotEmpty || scoringLabel.isNotEmpty)
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            if (displayCategory.isNotEmpty)
                              Container(
                                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                                decoration: BoxDecoration(
                                  border: Border.all(color: accentColor),
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Text(displayCategory, style: TextStyle(fontSize: 12, color: accentColor)),
                              ),
                            Container(
                              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                              decoration: BoxDecoration(
                                color: scoringBg,
                                border: Border.all(color: scoringBorder),
                                borderRadius: BorderRadius.circular(8),
                              ),
                              child: Text(
                                'Scoring: $scoringLabel',
                                style: TextStyle(fontSize: 12, color: scoringBorder, fontWeight: FontWeight.w600),
                              ),
                            ),
                          ],
                        ),
                      Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2.0),
                        child: Text(
                          () {
                            final sl = g.seedLabel.toString();
                            if (sl.isNotEmpty) {
                              return '$sl - Game $n';
                            }
                            String ml = g.matchLabel.toString();
                            ml = ml.replaceAll(RegExp(r'^\s*GA\\d+(?:\\.\\d+)?\\s*-\\s*', caseSensitive: false), '');
                            ml = ml.replaceAll(RegExp(r'\\bGA\\d+(?:\\.\\d+)?\\b', caseSensitive: false), '').trim();
                            return (ml.isNotEmpty ? '$ml - Game $n' : 'Game $n');
                          }(),
                          style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                        ),
                      ),
                      RichText(
                        text: TextSpan(
                          style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500, color: Colors.black87),
                          children: [
                            TextSpan(text: g.player1),
                            const TextSpan(text: ' vs ', style: TextStyle(color: Colors.red)),
                            TextSpan(text: g.player2),
                          ],
                        ),
                      ),
                      if (scheduled)
                        Text(end.isNotEmpty ? 'Time: $start – $end' : 'Time: $start', style: const TextStyle(fontSize: 12, color: Colors.grey))
                      else
                        const Text('Unscheduled', style: TextStyle(fontSize: 12, color: Colors.grey)),
                    ],
                  ),
                ),
                Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    () {
                      int? s1;
                      int? s2;
                      if (n == 1) {
                        s1 = g.game1Player1;
                        s2 = g.game1Player2;
                      } else if (n == 2) {
                        s1 = g.game2Player1;
                        s2 = g.game2Player2;
                      } else if (n == 3) {
                        s1 = g.game3Player1;
                        s2 = g.game3Player2;
                      }
                      s1 ??= 0;
                      s2 ??= 0;
                      return Text('$s1 - $s2', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16));
                    }(),
                    Text(disabled ? 'Ongoing' : displayStatus, style: const TextStyle(fontSize: 10, color: Colors.grey)),
                    if (app.pendingForMatch(g.categoryId, g.groupId, g.matchKey))
                      const Text('Pending Sync', style: TextStyle(fontSize: 10, color: Colors.orange)),
                  ],
                ),
              ],
            ),
          ),
          ),
        );
      },
    ),
  );
}

void _showCompletedSummaryDialog(BuildContext context, dynamic g) {
  final int s1 = g.score1;
  final int s2 = g.score2;
  String winnerName = (s1 > s2 ? g.player1 : (s2 > s1 ? g.player2 : ''));
  // If we have a winner from g.winner that's longer than 1 character, use it
  final rawWinner = g.winner?.toString().trim() ?? '';
  if (rawWinner.isNotEmpty && rawWinner.length > 1) {
    winnerName = rawWinner;
  }
  String? sig = g.signatureData;
  if ((sig == null || sig.isEmpty) && g.gameSignatures is List && g.gameSignatures.isNotEmpty) {
    final first = g.gameSignatures.first;
    if (first is String && first.isNotEmpty) sig = first;
  }
  Uint8List? bytes;
  if (sig != null && sig.isNotEmpty) {
    try {
      final String cleaned = sig.startsWith('data:image') ? sig.split(',').last : sig;
      bytes = base64Decode(cleaned);
    } catch (_) {}
  }
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    builder: (sheetContext) {
      final maxH = MediaQuery.of(sheetContext).size.height * 0.85;
      return SafeArea(
        child: Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxH),
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Match Summary', style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
                  const SizedBox(height: 10),
                  _ScoringFormatBadge(
                    label: g.scoringFormatBadgeLabel.toString(),
                    isRally: g.isRallyScoring == true,
                  ),
                  const SizedBox(height: 10),
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(text: g.player1),
                        const TextSpan(text: '  vs  ', style: TextStyle(color: Colors.red)),
                        TextSpan(text: g.player2),
                      ],
                    ),
                    style: const TextStyle(fontSize: 16, height: 1.25, color: Colors.black87, fontWeight: FontWeight.w600),
                    softWrap: true,
                  ),
                  const SizedBox(height: 10),
                  Text('Final Score: $s1 - $s2', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                  if (winnerName.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text('Winner: $winnerName', style: const TextStyle(fontSize: 14)),
                  ],
                  if ((g.refereeNote?.toString().trim().isNotEmpty ?? false)) ...[
                    const SizedBox(height: 12),
                    const Text('Referee Note', style: TextStyle(color: Colors.grey)),
                    const SizedBox(height: 6),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        border: Border.all(color: Colors.black12),
                        borderRadius: BorderRadius.circular(6),
                      ),
                      child: Text(
                        g.refereeNote.toString(),
                        style: const TextStyle(fontSize: 14, height: 1.3),
                      ),
                    ),
                  ],

                  const SizedBox(height: 16),
                  Align(
                    alignment: Alignment.centerRight,
                    child: ElevatedButton(
                      onPressed: () => Navigator.of(sheetContext).pop(),
                      child: const Text('Close'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}

class _ScoringFormatBadge extends StatelessWidget {
  final String label;
  final bool isRally;

  const _ScoringFormatBadge({
    required this.label,
    required this.isRally,
  });

  @override
  Widget build(BuildContext context) {
    final bg = isRally ? const Color(0xFFFFF1F2) : const Color(0xFFF0FDF4);
    final fg = isRally ? const Color(0xFFE11D48) : const Color(0xFF15803D);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: fg.withValues(alpha: 0.4)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: fg,
          fontSize: 12,
          fontWeight: FontWeight.w700,
        ),
      ),
    );
  }
}
