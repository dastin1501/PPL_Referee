import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../models.dart';
import '../state/app_state.dart';
import 'team_match_confirmation_screen.dart';

class CourtGamesScreen extends StatefulWidget {
  const CourtGamesScreen({super.key});

  @override
  State<CourtGamesScreen> createState() => _CourtGamesScreenState();
}

class _CourtGamesScreenState extends State<CourtGamesScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabController;

  static const _brand = Color(0xFF0F766E);
  static const _bg = Color(0xFFF4F7F6);

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
  }

  void _openDashboardForGame(TournamentMatch g, int gameNo) {
    final app = context.read<AppState>();
    final division =
        app.selectedTournament?.categoryDivisions[g.categoryId]?.toLowerCase() ?? '';
    final isTeamCategory = division.contains('team');

    final resolvedGameNo = app.resolveBestScheduledGameNo(g, preferred: gameNo);
    if (kDebugMode) {
      final ref = g.type == 'group'
          ? 'groupId=${g.groupId} matchKey=${g.matchKey}'
          : 'matchId=${g.id} docId=${g.documentId}';
      final start = resolvedGameNo == 1
          ? g.time
          : (resolvedGameNo == 2 ? (g.mdTime2 ?? '') : (g.mdTime3 ?? ''));
      final s1 = resolvedGameNo == 1
          ? (g.game1Player1 ?? 0)
          : (resolvedGameNo == 2 ? (g.game2Player1 ?? 0) : (g.game3Player1 ?? 0));
      final s2 = resolvedGameNo == 1
          ? (g.game1Player2 ?? 0)
          : (resolvedGameNo == 2 ? (g.game2Player2 ?? 0) : (g.game3Player2 ?? 0));
      debugPrint(
        '[call-match] type=${g.type} categoryId=${g.categoryId} $ref '
        'resolvedGame=$resolvedGameNo date=${g.date} time=$start court=${g.court} '
        'status=${app.gameStatusLabel(g, resolvedGameNo)} score=$s1-$s2',
      );
    }
    final statusKey = app.gameStatusKey(g, resolvedGameNo);
    final hasSchedule = app.hasScheduleForGame(g, resolvedGameNo);
    if (statusKey == 'unschedule') {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Match is not scheduled yet.')),
      );
      return;
    }
    if (statusKey == 'scheduled' && !hasSchedule) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Game has no schedule assignment yet.')),
      );
      return;
    }

    if (isTeamCategory) {
      Navigator.of(context)
          .push(
            MaterialPageRoute(
              builder: (_) => TeamMatchConfirmationScreen(
                match: g,
                gameNo: resolvedGameNo,
              ),
            ),
          )
          .then(_handleMatchFlowResult);
    } else {
      app.openGameWithNumber(g, resolvedGameNo);
      Navigator.of(context).pushNamed('/dashboard').then(_handleMatchFlowResult);
    }
  }

  Future<void> _handleMatchFlowResult(Object? result) async {
    if (result is! String) return;
    if (result != 'ongoing' && result != 'completed') return;
    final app = context.read<AppState>();
    await app.refreshSelectedTournament();
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result == 'completed' ? 'Match submitted' : 'Game submitted',
        ),
      ),
    );
    if (result == 'completed') {
      _tabController.animateTo(1);
    }
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  List<String> _sortedCourts(List<String> raw) {
    final courts = List<String>.from(raw);
    courts.sort((a, b) {
      int typeRank(String s) {
        final low = s.trim().toLowerCase();
        if (low == 'center court' || low.contains('center court')) return 0;
        final m = RegExp(r'\bcourt\s*(\d+)\b', caseSensitive: false).firstMatch(s) ??
            RegExp(r'^\s*(\d+)\s*$').firstMatch(s);
        if (m != null) return 1;
        return 2;
      }

      int numberValue(String s) {
        final m = RegExp(r'\bcourt\s*(\d+)\b', caseSensitive: false).firstMatch(s) ??
            RegExp(r'^\s*(\d+)\s*$').firstMatch(s);
        return int.tryParse(m?.group(1) ?? '') ?? 0;
      }

      final ra = typeRank(a);
      final rb = typeRank(b);
      if (ra != rb) return ra.compareTo(rb);
      if (ra == 1) return numberValue(a).compareTo(numberValue(b));
      return a.toLowerCase().compareTo(b.toLowerCase());
    });
    return courts;
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final courts = _sortedCourts(app.courts);
    final hasCourt = app.selectedCourt != null;
    final dates = hasCourt ? app.availableDatesForSelectedCourt : <String>[];
    final hasDate = app.selectedDate != null;
    final games = hasCourt ? app.matchesForSelectedCourt : <TournamentMatch>[];

    return Scaffold(
      backgroundColor: _bg,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              app.selectedTournament?.name ?? 'Tournament',
              style: const TextStyle(
                fontWeight: FontWeight.w700,
                fontSize: 17,
                color: Color(0xFF0F172A),
              ),
            ),
            const Text(
              'Court Schedule',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w500,
                color: Color(0xFF64748B),
              ),
            ),
          ],
        ),
        backgroundColor: Colors.white,
        foregroundColor: const Color(0xFF0F172A),
        elevation: 0,
        surfaceTintColor: Colors.transparent,
        actions: [
          if (app.pendingSyncCount > 0)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: TextButton.icon(
                onPressed: () => app.trySyncOutbox(),
                icon: const Icon(Icons.sync, color: _brand, size: 18),
                label: Text(
                  'Sync ${app.pendingSyncCount}',
                  style: const TextStyle(color: _brand, fontWeight: FontWeight.w600),
                ),
              ),
            ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Container(
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border(bottom: BorderSide(color: Colors.grey.shade200)),
            ),
            child: TabBar(
              controller: _tabController,
              indicatorColor: _brand,
              indicatorWeight: 3,
              labelColor: _brand,
              unselectedLabelColor: const Color(0xFF94A3B8),
              labelStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
              unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14),
              tabs: const [
                Tab(text: 'Scheduled'),
                Tab(text: 'Completed'),
              ],
            ),
          ),
        ),
      ),
      body: Column(
        children: [
          _FilterHeader(
            courts: courts,
            dates: dates,
            selectedCourt: app.selectedCourt,
            selectedDate: app.selectedDate,
            onCourtChanged: (c) => app.selectCourt(c),
            onDateChanged: (d) => app.selectDate(d),
          ),
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
                  emptyMessage: 'No scheduled matches for this court and date.',
                  noSelectionMessage: hasCourt
                      ? 'Select a date to view matches.'
                      : 'Select a court to view matches.',
                ),
                _buildGamesList(
                  context,
                  app,
                  games,
                  hasCourt && hasDate,
                  onOpenGame: _openDashboardForGame,
                  showScheduled: false,
                  emptyMessage: 'No completed matches for this court and date.',
                  noSelectionMessage: hasCourt
                      ? 'Select a date to view matches.'
                      : 'Select a court to view matches.',
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _FilterHeader extends StatelessWidget {
  final List<String> courts;
  final List<String> dates;
  final String? selectedCourt;
  final String? selectedDate;
  final ValueChanged<String> onCourtChanged;
  final ValueChanged<String> onDateChanged;

  const _FilterHeader({
    required this.courts,
    required this.dates,
    required this.selectedCourt,
    required this.selectedDate,
    required this.onCourtChanged,
    required this.onDateChanged,
  });

  static const _brand = Color(0xFF0F766E);

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (courts.isEmpty)
            const Text(
              'No courts found for this tournament.',
              style: TextStyle(color: Color(0xFF64748B)),
            )
          else ...[
            const Text(
              'Court',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w600,
                color: Color(0xFF64748B),
                letterSpacing: 0.2,
              ),
            ),
            const SizedBox(height: 8),
            DropdownButtonFormField<String>(
              initialValue: courts.contains(selectedCourt) ? selectedCourt : null,
              isExpanded: true,
              icon: const Icon(Icons.keyboard_arrow_down_rounded, color: _brand),
              items: courts
                  .map(
                    (c) => DropdownMenuItem<String>(
                      value: c,
                      child: Row(
                        children: [
                          const Icon(Icons.sports_tennis, size: 18, color: _brand),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              c,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                                color: Color(0xFF0F172A),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  )
                  .toList(),
              onChanged: (c) {
                if (c != null) onCourtChanged(c);
              },
              decoration: InputDecoration(
                filled: true,
                fillColor: const Color(0xFFF0FDFA),
                contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: _brand.withValues(alpha: 0.25)),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: BorderSide(color: _brand.withValues(alpha: 0.2)),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(14),
                  borderSide: const BorderSide(color: _brand, width: 1.5),
                ),
              ),
            ),
          ],
          if (selectedCourt != null) ...[
            const SizedBox(height: 16),
            Row(
              children: [
                const Text(
                  'Date',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w600,
                    color: Color(0xFF64748B),
                    letterSpacing: 0.2,
                  ),
                ),
                const Spacer(),
                if (selectedDate != null)
                  Text(
                    _formatDateLong(selectedDate!),
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: _brand,
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 8),
            if (dates.isEmpty)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                decoration: BoxDecoration(
                  color: const Color(0xFFF8FAFC),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: Colors.grey.shade200),
                ),
                child: const Text(
                  'No schedule dates found for this court.',
                  style: TextStyle(color: Color(0xFF94A3B8), fontSize: 13),
                ),
              )
            else
              SizedBox(
                height: 84,
                child: ListView.separated(
                  scrollDirection: Axis.horizontal,
                  itemCount: dates.length,
                  separatorBuilder: (_, __) => const SizedBox(width: 8),
                  itemBuilder: (context, index) {
                    final raw = dates[index];
                    final selected = raw == selectedDate;
                    final parts = _dateParts(raw);
                    return Material(
                      color: Colors.transparent,
                      child: InkWell(
                        onTap: () => onDateChanged(raw),
                        borderRadius: BorderRadius.circular(14),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 180),
                          width: 68,
                          padding: const EdgeInsets.symmetric(vertical: 6, horizontal: 4),
                          decoration: BoxDecoration(
                            color: selected ? _brand : const Color(0xFFF8FAFC),
                            borderRadius: BorderRadius.circular(14),
                            border: Border.all(
                              color: selected ? _brand : Colors.grey.shade200,
                              width: selected ? 1.5 : 1,
                            ),
                            boxShadow: selected
                                ? [
                                    BoxShadow(
                                      color: _brand.withValues(alpha: 0.22),
                                      blurRadius: 10,
                                      offset: const Offset(0, 4),
                                    ),
                                  ]
                                : null,
                          ),
                          child: Column(
                            mainAxisAlignment: MainAxisAlignment.center,
                            mainAxisSize: MainAxisSize.max,
                            children: [
                              Text(
                                parts.$1,
                                maxLines: 1,
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                  height: 1.0,
                                  letterSpacing: 0.2,
                                  color: selected
                                      ? Colors.white.withValues(alpha: 0.85)
                                      : const Color(0xFF94A3B8),
                                ),
                              ),
                              const SizedBox(height: 4),
                              Text(
                                parts.$2,
                                maxLines: 1,
                                style: TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w800,
                                  height: 1.0,
                                  color: selected ? Colors.white : const Color(0xFF0F172A),
                                ),
                              ),
                              const SizedBox(height: 3),
                              Text(
                                parts.$3,
                                maxLines: 1,
                                style: TextStyle(
                                  fontSize: 10,
                                  fontWeight: FontWeight.w600,
                                  height: 1.0,
                                  color: selected
                                      ? Colors.white.withValues(alpha: 0.85)
                                      : const Color(0xFF64748B),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
          ],
        ],
      ),
    );
  }
}

/// Returns (weekday short, day number, month short) e.g. ("Thu", "1", "Jan").
(String, String, String) _dateParts(String raw) {
  final dt = DateTime.tryParse(raw.trim());
  if (dt == null) return (raw, '', '');
  return (
    DateFormat('EEE').format(dt),
    DateFormat('d').format(dt),
    DateFormat('MMM').format(dt),
  );
}

String _formatDateLong(String raw) {
  final dt = DateTime.tryParse(raw.trim());
  if (dt == null) return raw;
  return DateFormat('EEEE, MMM d, yyyy').format(dt);
}

String _formatTimeDisplay(String start, String end) {
  String pretty(String raw) {
    final t = raw.trim();
    if (t.isEmpty) return '';
    // Already has AM/PM
    if (RegExp(r'(AM|PM)', caseSensitive: false).hasMatch(t)) return t.toUpperCase();
    final m = RegExp(r'^(\d{1,2}):(\d{2})$').firstMatch(t);
    if (m == null) return t;
    var h = int.tryParse(m.group(1)!) ?? 0;
    final min = m.group(2)!;
    final ap = h >= 12 ? 'PM' : 'AM';
    final h12 = h == 0 ? 12 : (h > 12 ? h - 12 : h);
    return '$h12:$min $ap';
  }

  final s = pretty(start);
  final e = pretty(end);
  if (s.isEmpty) return '';
  if (e.isEmpty) return s;
  return '$s – $e';
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
    return _EmptyState(
      icon: Icons.sports_tennis_outlined,
      message: noSelectionMessage,
    );
  }
  if (games.isEmpty) {
    return _EmptyState(icon: Icons.event_busy, message: emptyMessage);
  }

  final items = <Map<String, dynamic>>[];
  for (final g in games) {
    final int gpm = app.gamesPerMatchFor(g);

    void addItem(int n, String? start, String? end) {
      final hasSchedule = app.hasScheduleForGame(g, n);
      final statusKey = app.gameStatusKey(g, n);
      items.add({
        'g': g,
        'n': n,
        'hasSchedule': hasSchedule,
        'statusKey': statusKey,
        'start': start?.toString() ?? '',
        'end': end?.toString() ?? '',
      });
    }

    if (gpm >= 1) {
      final s = g.time.toString().trim();
      final include = app.hasScheduleForGame(g, 1) || app.gameStatusKey(g, 1) != 'unschedule';
      if (include) addItem(1, s, null);
    }
    if (gpm >= 2) {
      final s = (g.mdTime2?.toString() ?? '').trim();
      final include = app.hasScheduleForGame(g, 2) || app.gameStatusKey(g, 2) != 'unschedule';
      if (include) addItem(2, s, g.mdEnd2?.toString());
    }
    if (gpm >= 3) {
      final s = (g.mdTime3?.toString() ?? '').trim();
      final include = app.hasScheduleForGame(g, 3) || app.gameStatusKey(g, 3) != 'unschedule';
      if (include) addItem(3, s, g.mdEnd3?.toString());
    }
  }

  if (showScheduled) {
    items.removeWhere((it) {
      final hasSchedule = it['hasSchedule'] as bool? ?? false;
      final statusKey = it['statusKey'] as String? ?? 'unschedule';
      if (statusKey == 'completed') return true;
      if (statusKey == 'scheduled' || statusKey == 'ongoing') return false;
      if (hasSchedule) return false;
      return true;
    });
  } else {
    items.removeWhere((it) => (it['statusKey'] as String? ?? 'unschedule') != 'completed');
  }

  if (items.isEmpty) {
    return _EmptyState(icon: Icons.event_busy, message: emptyMessage);
  }

  int timeKey(Map<String, dynamic> it) {
    final raw = (it['start'] as String?)?.trim() ?? '';
    if (raw.isEmpty) return 999999;
    final t = raw.toUpperCase();
    final ampm = RegExp(r'^(\d{1,2}):(\d{2})\s*(AM|PM)?$').firstMatch(t) ??
        RegExp(r'^(\d{1,2})(\d{2})\s*(AM|PM)?$').firstMatch(t);
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
    color: const Color(0xFF0F766E),
    onRefresh: () => app.refreshSelectedTournament(),
    child: ListView.builder(
      padding: const EdgeInsets.fromLTRB(12, 12, 12, 24),
      itemCount: items.length,
      itemBuilder: (_, i) {
        final it = items[i];
        final g = it['g'] as TournamentMatch;
        final n = it['n'] as int;
        final start = (it['start'] as String?) ?? '';
        final end = (it['end'] as String?) ?? '';
        final hasSchedule = it['hasSchedule'] as bool? ?? false;
        final statusKey = it['statusKey'] as String? ?? 'unschedule';
        final category = app.selectedTournament?.categoryNames[g.categoryId] ?? '';
        var displayCategory = category;
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
        final isOngoing = statusKey == 'ongoing';
        final disabled =
            showScheduled && (isOngoing || (!hasSchedule && statusKey == 'scheduled'));
        final displayStatus = app.gameStatusLabel(g, n);

        final catText = category.toLowerCase();
        final isMixed = catText.contains('mixed');
        final isWomen = catText.contains('women') ||
            catText.contains('ladies') ||
            catText.contains('female') ||
            catText.contains('girls');
        final isMen = catText.contains('men') ||
            catText.contains('male') ||
            catText.contains('boys');
        const mixedGreen = Color(0xFF0F766E);
        final accentColor = isWomen
            ? const Color(0xFFE91E63)
            : isMen
                ? const Color(0xFF1E88E5)
                : isMixed
                    ? mixedGreen
                    : mixedGreen;
        final effectiveAccent = disabled ? Colors.grey : accentColor;
        final isRallyScoring = g.isRallyScoring;
        final scoringLabel = isRallyScoring ? 'Rally' : 'Side-Out';

        String matchTitle() {
          if (g.type == 'elimination') {
            final rs = g.roundShort.toString().trim();
            final rl = g.roundLabel.toString().trim();
            if (rs.isNotEmpty) return '$rs · Game $n';
            if (rl.isNotEmpty) return '$rl · Game $n';
          }
          final sl = g.seedLabel.toString();
          if (sl.isNotEmpty) return '$sl · Game $n';
          var ml = g.matchLabel.toString();
          ml = ml
              .replaceAll(
                RegExp(r'^\s*GA\d+(?:\.\d+)?\s*-\s*', caseSensitive: false),
                '',
              )
              .trim();
          return ml.isNotEmpty ? '$ml · Game $n' : 'Game $n';
        }

        int s1 = 0;
        int s2 = 0;
        if (n == 1) {
          s1 = g.game1Player1 ?? 0;
          s2 = g.game1Player2 ?? 0;
        } else if (n == 2) {
          s1 = g.game2Player1 ?? 0;
          s2 = g.game2Player2 ?? 0;
        } else if (n == 3) {
          s1 = g.game3Player1 ?? 0;
          s2 = g.game3Player2 ?? 0;
        }

        final p1 = g.player1Name.trim().isNotEmpty ? g.player1Name : g.player1;
        final p2 = g.player2Name.trim().isNotEmpty ? g.player2Name : g.player2;
        final timeLabel = _formatTimeDisplay(start, end);

        Color statusBg;
        Color statusFg;
        switch (statusKey) {
          case 'ongoing':
            statusBg = const Color(0xFFFFF7ED);
            statusFg = const Color(0xFFEA580C);
            break;
          case 'completed':
            statusBg = const Color(0xFFECFDF5);
            statusFg = const Color(0xFF059669);
            break;
          default:
            statusBg = const Color(0xFFEFF6FF);
            statusFg = const Color(0xFF2563EB);
        }

        return Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Material(
            color: Colors.transparent,
            child: InkWell(
              onTap: disabled
                  ? null
                  : () {
                      if (!showScheduled) {
                        _showCompletedSummaryDialog(context, g, n);
                      } else {
                        onOpenGame(g, n);
                      }
                    },
              borderRadius: BorderRadius.circular(18),
              child: Opacity(
                opacity: disabled ? 0.5 : 1,
                child: Container(
                  decoration: BoxDecoration(
                    color: disabled ? const Color(0xFFF8FAFC) : Colors.white,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(
                      color: disabled
                          ? Colors.grey.shade200
                          : accentColor.withValues(alpha: 0.28),
                    ),
                    boxShadow: disabled
                        ? null
                        : [
                            BoxShadow(
                              color: Colors.black.withValues(alpha: 0.04),
                              blurRadius: 12,
                              offset: const Offset(0, 4),
                            ),
                          ],
                  ),
                  child: IntrinsicHeight(
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Container(
                          width: 5,
                          decoration: BoxDecoration(
                            color: effectiveAccent,
                            borderRadius: const BorderRadius.only(
                              topLeft: Radius.circular(18),
                              bottomLeft: Radius.circular(18),
                            ),
                          ),
                        ),
                        Expanded(
                          child: Padding(
                            padding: const EdgeInsets.fromLTRB(14, 14, 14, 14),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    if (displayCategory.isNotEmpty)
                                      Flexible(
                                        child: Container(
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 8,
                                            vertical: 3,
                                          ),
                                          decoration: BoxDecoration(
                                            color: effectiveAccent.withValues(alpha: 0.1),
                                            borderRadius: BorderRadius.circular(8),
                                          ),
                                          child: Text(
                                            displayCategory,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                              fontSize: 11,
                                              fontWeight: FontWeight.w700,
                                              color: effectiveAccent,
                                            ),
                                          ),
                                        ),
                                      ),
                                    const SizedBox(width: 6),
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 3,
                                      ),
                                      decoration: BoxDecoration(
                                        color: isRallyScoring
                                            ? const Color(0xFF111827)
                                            : const Color(0xFFF1F5F9),
                                        borderRadius: BorderRadius.circular(8),
                                      ),
                                      child: Text(
                                        scoringLabel,
                                        style: TextStyle(
                                          fontSize: 11,
                                          fontWeight: FontWeight.w700,
                                          color: isRallyScoring
                                              ? Colors.white
                                              : const Color(0xFF334155),
                                        ),
                                      ),
                                    ),
                                    const Spacer(),
                                    Container(
                                      padding: const EdgeInsets.symmetric(
                                        horizontal: 8,
                                        vertical: 3,
                                      ),
                                      decoration: BoxDecoration(
                                        color: statusBg,
                                        borderRadius: BorderRadius.circular(999),
                                      ),
                                      child: Text(
                                        displayStatus,
                                        style: TextStyle(
                                          fontSize: 11,
                                          fontWeight: FontWeight.w700,
                                          color: statusFg,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 10),
                                Text(
                                  matchTitle(),
                                  style: TextStyle(
                                    fontWeight: FontWeight.w800,
                                    fontSize: 15,
                                    color: disabled
                                        ? Colors.black54
                                        : const Color(0xFF0F172A),
                                  ),
                                ),
                                if (g.type == 'elimination' &&
                                    g.roundLabel.toString().trim().isNotEmpty) ...[
                                  const SizedBox(height: 2),
                                  Text(
                                    g.roundLabel.toString().trim(),
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: Color(0xFF94A3B8),
                                      fontWeight: FontWeight.w500,
                                    ),
                                  ),
                                ],
                                const SizedBox(height: 8),
                                Text.rich(
                                  TextSpan(
                                    style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                      height: 1.3,
                                      color: disabled
                                          ? Colors.black54
                                          : const Color(0xFF1E293B),
                                    ),
                                    children: [
                                      TextSpan(text: p1),
                                      TextSpan(
                                        text: '  vs  ',
                                        style: TextStyle(
                                          color: disabled
                                              ? Colors.black38
                                              : const Color(0xFFDC2626),
                                          fontWeight: FontWeight.w700,
                                        ),
                                      ),
                                      TextSpan(text: p2),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 12),
                                Row(
                                  children: [
                                    Icon(
                                      Icons.schedule_rounded,
                                      size: 15,
                                      color: disabled
                                          ? Colors.grey
                                          : const Color(0xFF64748B),
                                    ),
                                    const SizedBox(width: 5),
                                    Expanded(
                                      child: Text(
                                        hasSchedule
                                            ? (timeLabel.isNotEmpty ? timeLabel : 'Scheduled')
                                            : 'Unscheduled',
                                        style: TextStyle(
                                          fontSize: 12,
                                          fontWeight: FontWeight.w600,
                                          color: disabled
                                              ? Colors.grey
                                              : const Color(0xFF64748B),
                                        ),
                                      ),
                                    ),
                                    Text(
                                      '$s1 – $s2',
                                      style: TextStyle(
                                        fontWeight: FontWeight.w800,
                                        fontSize: 18,
                                        color: disabled
                                            ? Colors.black45
                                            : const Color(0xFF0F172A),
                                      ),
                                    ),
                                  ],
                                ),
                                if (app.pendingForMatch(
                                  g.categoryId,
                                  g.groupId,
                                  g.matchKey,
                                )) ...[
                                  const SizedBox(height: 6),
                                  const Text(
                                    'Pending Sync',
                                    style: TextStyle(
                                      fontSize: 11,
                                      color: Color(0xFFEA580C),
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
      },
    ),
  );
}

class _EmptyState extends StatelessWidget {
  final IconData icon;
  final String message;

  const _EmptyState({required this.icon, required this.message});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: const Color(0xFF0F766E).withValues(alpha: 0.08),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, color: const Color(0xFF0F766E), size: 28),
            ),
            const SizedBox(height: 14),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: Color(0xFF64748B),
                fontSize: 14,
                height: 1.4,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

void _showCompletedSummaryDialog(BuildContext context, TournamentMatch g, int gameNo) {
  final int s1 = (gameNo == 1
      ? (g.game1Player1 ?? 0)
      : (gameNo == 2 ? (g.game2Player1 ?? 0) : (g.game3Player1 ?? 0)));
  final int s2 = (gameNo == 1
      ? (g.game1Player2 ?? 0)
      : (gameNo == 2 ? (g.game2Player2 ?? 0) : (g.game3Player2 ?? 0)));
  String winnerName = (s1 > s2 ? g.player1 : (s2 > s1 ? g.player2 : ''));
  final rawWinner = g.winner?.toString().trim() ?? '';
  if (rawWinner.isNotEmpty && rawWinner.length > 1) {
    winnerName = rawWinner;
  }
  String? sig;
  final sigs = g.gameSignatures;
  if (sigs != null && sigs.length >= gameNo) {
    final v = (sigs[gameNo - 1] ?? '').toString().trim();
    if (v.isNotEmpty) sig = v;
  }
  sig ??= g.signatureData;
  if (sig != null && sig.isNotEmpty && sig.trim().isEmpty) {
    sig = null;
  }
  Uint8List? bytes;
  if (sig != null && sig.isNotEmpty) {
    try {
      final cleaned = sig.startsWith('data:image') ? sig.split(',').last : sig;
      bytes = base64Decode(cleaned);
    } catch (_) {}
  }
  showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (sheetContext) {
      final maxH = MediaQuery.of(sheetContext).size.height * 0.85;
      return SafeArea(
        child: Padding(
          padding: EdgeInsets.only(bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
          child: ConstrainedBox(
            constraints: BoxConstraints(maxHeight: maxH),
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(20, 12, 20, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Center(
                    child: Container(
                      width: 40,
                      height: 4,
                      margin: const EdgeInsets.only(bottom: 16),
                      decoration: BoxDecoration(
                        color: Colors.grey.shade300,
                        borderRadius: BorderRadius.circular(999),
                      ),
                    ),
                  ),
                  const Text(
                    'Match Summary',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 12),
                  _ScoringFormatBadge(
                    label: g.scoringFormatBadgeLabel.toString(),
                    isRally: g.isRallyScoring == true,
                  ),
                  const SizedBox(height: 12),
                  Text.rich(
                    TextSpan(
                      children: [
                        TextSpan(text: g.player1),
                        const TextSpan(
                          text: '  vs  ',
                          style: TextStyle(color: Color(0xFFDC2626), fontWeight: FontWeight.w700),
                        ),
                        TextSpan(text: g.player2),
                      ],
                    ),
                    style: const TextStyle(
                      fontSize: 16,
                      height: 1.25,
                      color: Color(0xFF0F172A),
                      fontWeight: FontWeight.w600,
                    ),
                    softWrap: true,
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'Game $gameNo Score: $s1 – $s2',
                    style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
                  ),
                  if (winnerName.isNotEmpty) ...[
                    const SizedBox(height: 6),
                    Text(
                      'Winner: $winnerName',
                      style: const TextStyle(fontSize: 14, color: Color(0xFF0F766E), fontWeight: FontWeight.w600),
                    ),
                  ],
                  if ((g.refereeNote?.toString().trim().isNotEmpty ?? false)) ...[
                    const SizedBox(height: 14),
                    const Text('Referee Note', style: TextStyle(color: Color(0xFF94A3B8), fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    Container(
                      width: double.infinity,
                      padding: const EdgeInsets.all(12),
                      decoration: BoxDecoration(
                        color: const Color(0xFFF8FAFC),
                        border: Border.all(color: Colors.black12),
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(
                        g.refereeNote.toString(),
                        style: const TextStyle(fontSize: 14, height: 1.3),
                      ),
                    ),
                  ],
                  if (bytes != null) ...[
                    const SizedBox(height: 14),
                    const Text('Signature', style: TextStyle(color: Color(0xFF94A3B8), fontWeight: FontWeight.w600)),
                    const SizedBox(height: 6),
                    ClipRRect(
                      borderRadius: BorderRadius.circular(10),
                      child: Image.memory(bytes, height: 120, fit: BoxFit.contain),
                    ),
                  ],
                  const SizedBox(height: 18),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      onPressed: () => Navigator.of(sheetContext).pop(),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFF0F766E),
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      child: const Text('Close', style: TextStyle(fontWeight: FontWeight.w700)),
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
    final bg = isRally ? const Color(0xFF111827) : Colors.white;
    final fg = isRally ? Colors.white : const Color(0xFF111827);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: const Color(0xFF111827).withValues(alpha: 0.8)),
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
