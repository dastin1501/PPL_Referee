import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import '../models.dart';
import '../state/app_state.dart';

class TeamMatchConfirmationScreen extends StatefulWidget {
  final TournamentMatch match;
  final int gameNo;

  const TeamMatchConfirmationScreen({
    super.key,
    required this.match,
    required this.gameNo,
  });

  @override
  State<TeamMatchConfirmationScreen> createState() => _TeamMatchConfirmationScreenState();
}

class _TeamMatchConfirmationScreenState extends State<TeamMatchConfirmationScreen> {
  String? _selectedTeam1Player1;
  String? _selectedTeam1Player2;
  String? _selectedTeam2Player1;
  String? _selectedTeam2Player2;
  /// When true, skip restoring portrait in dispose (handing off to dashboard).
  bool _retainLandscapeOnExit = false;

  String _slotLabelForTeam1() {
    return widget.match.player1Name.trim().isNotEmpty
        ? widget.match.player1Name
        : widget.match.player1;
  }

  String _slotLabelForTeam2() {
    return widget.match.player2Name.trim().isNotEmpty
        ? widget.match.player2Name
        : widget.match.player2;
  }

  List<String> _savedSelectionsForGame() {
    switch (widget.gameNo) {
      case 1:
        return [
          widget.match.game1Team1Player,
          widget.match.game1Team1Player2,
          widget.match.game1Team2Player,
          widget.match.game1Team2Player2,
        ];
      case 2:
        return [
          widget.match.game2Team1Player,
          widget.match.game2Team1Player2,
          widget.match.game2Team2Player,
          widget.match.game2Team2Player2,
        ];
      case 3:
        return [
          widget.match.game3Team1Player,
          widget.match.game3Team1Player2,
          widget.match.game3Team2Player,
          widget.match.game3Team2Player2,
        ];
      default:
        return const <String>[];
    }
  }

  void _applySavedSelections() {
    switch (widget.gameNo) {
      case 1:
        _selectedTeam1Player1 = widget.match.game1Team1Player.trim().isNotEmpty
            ? widget.match.game1Team1Player
            : _selectedTeam1Player1;
        _selectedTeam1Player2 = widget.match.game1Team1Player2.trim().isNotEmpty
            ? widget.match.game1Team1Player2
            : _selectedTeam1Player2;
        _selectedTeam2Player1 = widget.match.game1Team2Player.trim().isNotEmpty
            ? widget.match.game1Team2Player
            : _selectedTeam2Player1;
        _selectedTeam2Player2 = widget.match.game1Team2Player2.trim().isNotEmpty
            ? widget.match.game1Team2Player2
            : _selectedTeam2Player2;
        break;
      case 2:
        _selectedTeam1Player1 = widget.match.game2Team1Player.trim().isNotEmpty
            ? widget.match.game2Team1Player
            : _selectedTeam1Player1;
        _selectedTeam1Player2 = widget.match.game2Team1Player2.trim().isNotEmpty
            ? widget.match.game2Team1Player2
            : _selectedTeam1Player2;
        _selectedTeam2Player1 = widget.match.game2Team2Player.trim().isNotEmpty
            ? widget.match.game2Team2Player
            : _selectedTeam2Player1;
        _selectedTeam2Player2 = widget.match.game2Team2Player2.trim().isNotEmpty
            ? widget.match.game2Team2Player2
            : _selectedTeam2Player2;
        break;
      case 3:
        _selectedTeam1Player1 = widget.match.game3Team1Player.trim().isNotEmpty
            ? widget.match.game3Team1Player
            : _selectedTeam1Player1;
        _selectedTeam1Player2 = widget.match.game3Team1Player2.trim().isNotEmpty
            ? widget.match.game3Team1Player2
            : _selectedTeam1Player2;
        _selectedTeam2Player1 = widget.match.game3Team2Player.trim().isNotEmpty
            ? widget.match.game3Team2Player
            : _selectedTeam2Player1;
        _selectedTeam2Player2 = widget.match.game3Team2Player2.trim().isNotEmpty
            ? widget.match.game3Team2Player2
            : _selectedTeam2Player2;
        break;
    }
  }

  List<String> _splitTeam(String name) {
    final parts = name
        .split(RegExp(r'\s*/\s*'))
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .toList();
    if (parts.isEmpty) return [name];
    if (parts.length == 1) return parts;
    return [parts[0], parts[1]];
  }

  String _normalizeTeamKey(String value) {
    var normalized = value.replaceAll(RegExp(r'\s*/\s*'), ' / ');
    normalized = normalized.replaceAll(RegExp(r'\s+'), ' ').trim().toLowerCase();
    return normalized;
  }

  List<String> _buildFallbackKeys(String slotLabel) {
    final keys = <String>[slotLabel];
    final parts = _splitTeam(slotLabel);
    if (parts.length >= 2) {
      keys.add('${parts[0]} / ${parts[1]}');
    }
    for (final part in parts) {
      if (part.trim().isNotEmpty) {
        keys.add(part.trim());
      }
    }
    return keys;
  }

  List<TeamMemberInfo> _getTeamOptionsForSlot(
    String slotLabel,
    Tournament? tournament,
    List<String> savedValues,
  ) {
    final rosterMap =
        tournament?.teamRosterMembersBySlot ?? const <String, List<TeamMemberInfo>>{};
    final rosterSources = tournament?.teamRosterSourceCategories ?? const <String, List<String>>{};
    final fallbackKeys = _buildFallbackKeys(slotLabel);

    for (final key in fallbackKeys) {
      final normalizedKey = _normalizeTeamKey(key);
      final options = rosterMap[normalizedKey] ?? const <TeamMemberInfo>[];
      if (options.isNotEmpty) {
        final merged = List<TeamMemberInfo>.from(options);
        for (final value in savedValues) {
          final trimmed = value.trim();
          if (trimmed.isEmpty) continue;
          if (!merged.any((item) => _normalizeTeamKey(item.name) == _normalizeTeamKey(trimmed))) {
            merged.add(TeamMemberInfo(name: trimmed));
          }
        }
        return merged;
      }
    }

    final normalizedSlot = _normalizeTeamKey(slotLabel);
    final fallbackOptions = <TeamMemberInfo>[];
    for (final value in savedValues) {
      final trimmed = value.trim();
      if (trimmed.isEmpty) continue;
      if (!fallbackOptions.any((item) => _normalizeTeamKey(item.name) == _normalizeTeamKey(trimmed))) {
        fallbackOptions.add(TeamMemberInfo(name: trimmed));
      }
    }
    if (kDebugMode) {
      debugPrint(
        'Team roster lookup fallback: '
        'matchCategoryId=${widget.match.categoryId}, '
        'sourceRegistrationCategoryIds=${rosterSources[normalizedSlot] ?? const <String>[]}, '
        'matchSlotLabel=$slotLabel, '
        'normalizedSlotLabel=$normalizedSlot, '
        'availableRosterKeys=${rosterMap.keys.take(20).toList()}, '
        'savedValues=$savedValues, '
        'fallbackOptions=${fallbackOptions.map((e) => e.displayLabel).toList()}',
      );
    }
    return fallbackOptions;
  }

  void _proceedToDashboard() {
    final app = context.read<AppState>();

    final t1p1 = widget.gameNo == 1
        ? (_selectedTeam1Player1 ?? widget.match.game1Team1Player)
        : (widget.gameNo == 2
            ? (_selectedTeam1Player1 ?? widget.match.game2Team1Player)
            : (_selectedTeam1Player1 ?? widget.match.game3Team1Player));
    final t1p2 = widget.gameNo == 1
        ? (_selectedTeam1Player2 ?? widget.match.game1Team1Player2)
        : (widget.gameNo == 2
            ? (_selectedTeam1Player2 ?? widget.match.game2Team1Player2)
            : (_selectedTeam1Player2 ?? widget.match.game3Team1Player2));
    final t2p1 = widget.gameNo == 1
        ? (_selectedTeam2Player1 ?? widget.match.game1Team2Player)
        : (widget.gameNo == 2
            ? (_selectedTeam2Player1 ?? widget.match.game2Team2Player)
            : (_selectedTeam2Player1 ?? widget.match.game3Team2Player));
    final t2p2 = widget.gameNo == 1
        ? (_selectedTeam2Player2 ?? widget.match.game1Team2Player2)
        : (widget.gameNo == 2
            ? (_selectedTeam2Player2 ?? widget.match.game2Team2Player2)
            : (_selectedTeam2Player2 ?? widget.match.game3Team2Player2));

    bool invalid(String s) {
      final v = s.trim();
      return v.isEmpty || v.toLowerCase() == 'tbd';
    }

    if (invalid(t1p1) || invalid(t1p2) || invalid(t2p1) || invalid(t2p2)) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select 2 players per team before continuing.')),
      );
      return;
    }

    String asDoublesLabel(String a, String b, String fallback) {
      final p1 = a.trim();
      final p2 = b.trim();
      final parts = <String>[];
      if (p1.isNotEmpty && p1.toLowerCase() != 'tbd') parts.add(p1);
      if (p2.isNotEmpty && p2.toLowerCase() != 'tbd' && p2 != p1) parts.add(p2);
      if (parts.isEmpty) return fallback;
      if (parts.length == 1) return parts.first;
      return '${parts[0]} / ${parts[1]}';
    }

    final displayLeft = asDoublesLabel(t1p1, t1p2, widget.match.player1);
    final displayRight = asDoublesLabel(t2p1, t2p2, widget.match.player2);
    final teamLeft = widget.match.player1Name.trim().isNotEmpty ? widget.match.player1Name : widget.match.player1;
    final teamRight = widget.match.player2Name.trim().isNotEmpty ? widget.match.player2Name : widget.match.player2;
    final updatedMatch = TournamentMatch(
      id: widget.match.id,
      documentId: widget.match.documentId,
      scheduleFromAssignments: widget.match.scheduleFromAssignments,
      player1: displayLeft,
      player2: displayRight,
      player1Name: teamLeft,
      player2Name: teamRight,
      score1: widget.match.score1,
      score2: widget.match.score2,
      game1Status: widget.match.game1Status,
      game2Status: widget.match.game2Status,
      game3Status: widget.match.game3Status,
      game1Player1: widget.match.game1Player1,
      game1Player2: widget.match.game1Player2,
      game2Player1: widget.match.game2Player1,
      game2Player2: widget.match.game2Player2,
      game3Player1: widget.match.game3Player1,
      game3Player2: widget.match.game3Player2,
      round: widget.match.round,
      roundShort: widget.match.roundShort,
      roundLabel: widget.match.roundLabel,
      court: widget.match.court,
      date: widget.match.date,
      time: widget.match.time,
      venue: widget.match.venue,
      mdTime2: widget.match.mdTime2,
      mdEnd2: widget.match.mdEnd2,
      mdTime3: widget.match.mdTime3,
      mdEnd3: widget.match.mdEnd3,
      status: widget.match.status,
      categoryId: widget.match.categoryId,
      matchKey: widget.match.matchKey,
      type: widget.match.type,
      seedLabel: widget.match.seedLabel,
      matchLabel: widget.match.matchLabel,
      groupId: widget.match.groupId,
      winner: widget.match.winner,
      signatureData: widget.match.signatureData,
      gameSignatures: widget.match.gameSignatures,
      refereeNote: widget.match.refereeNote,
      scoringFormat: widget.match.scoringFormat,
      game1Team1Player: widget.gameNo == 1
          ? (_selectedTeam1Player1 ?? widget.match.game1Team1Player)
          : widget.match.game1Team1Player,
      game1Team1Player2: widget.gameNo == 1
          ? (_selectedTeam1Player2 ?? widget.match.game1Team1Player2)
          : widget.match.game1Team1Player2,
      game1Team2Player: widget.gameNo == 1
          ? (_selectedTeam2Player1 ?? widget.match.game1Team2Player)
          : widget.match.game1Team2Player,
      game1Team2Player2: widget.gameNo == 1
          ? (_selectedTeam2Player2 ?? widget.match.game1Team2Player2)
          : widget.match.game1Team2Player2,
      game2Team1Player: widget.gameNo == 2
          ? (_selectedTeam1Player1 ?? widget.match.game2Team1Player)
          : widget.match.game2Team1Player,
      game2Team1Player2: widget.gameNo == 2
          ? (_selectedTeam1Player2 ?? widget.match.game2Team1Player2)
          : widget.match.game2Team1Player2,
      game2Team2Player: widget.gameNo == 2
          ? (_selectedTeam2Player1 ?? widget.match.game2Team2Player)
          : widget.match.game2Team2Player,
      game2Team2Player2: widget.gameNo == 2
          ? (_selectedTeam2Player2 ?? widget.match.game2Team2Player2)
          : widget.match.game2Team2Player2,
      game3Team1Player: widget.gameNo == 3
          ? (_selectedTeam1Player1 ?? widget.match.game3Team1Player)
          : widget.match.game3Team1Player,
      game3Team1Player2: widget.gameNo == 3
          ? (_selectedTeam1Player2 ?? widget.match.game3Team1Player2)
          : widget.match.game3Team1Player2,
      game3Team2Player: widget.gameNo == 3
          ? (_selectedTeam2Player1 ?? widget.match.game3Team2Player)
          : widget.match.game3Team2Player,
      game3Team2Player2: widget.gameNo == 3
          ? (_selectedTeam2Player2 ?? widget.match.game3Team2Player2)
          : widget.match.game3Team2Player2,
    );
    app.openGameWithNumber(updatedMatch, widget.gameNo);
    // Keep landscape while handing off to the scoring dashboard.
    // (dispose would otherwise flip back to portrait and win the race.)
    _retainLandscapeOnExit = true;
    Navigator.of(context).pushReplacementNamed('/dashboard').then((result) {
      if (mounted && result == 'completed') {
        Navigator.of(context).pop('completed');
      }
    });
  }

  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);
    _selectedTeam1Player1 = null;
    _selectedTeam1Player2 = null;
    _selectedTeam2Player1 = null;
    _selectedTeam2Player2 = null;
    _applySavedSelections();
  }

  @override
  void dispose() {
    if (!_retainLandscapeOnExit) {
      SystemChrome.setPreferredOrientations([
        DeviceOrientation.portraitUp,
        DeviceOrientation.portraitDown,
      ]);
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final categoryName = app.selectedTournament?.categoryNames[widget.match.categoryId] ?? '';
    final categoryDivision =
        app.selectedTournament?.categoryDivisions[widget.match.categoryId] ?? '';
    final isTeamCategory = categoryDivision.toLowerCase().contains('team');
    final team1Saved = _savedSelectionsForGame().take(2).toList();
    final team2Saved = _savedSelectionsForGame().skip(2).take(2).toList();
    final team1Label = _slotLabelForTeam1();
    final team2Label = _slotLabelForTeam2();
    final team1Options = _getTeamOptionsForSlot(team1Label, app.selectedTournament, team1Saved);
    final team2Options = _getTeamOptionsForSlot(team2Label, app.selectedTournament, team2Saved);

    if (kDebugMode) {
      debugPrint(
        'TEAM Select Players: '
        'division=$categoryDivision, '
        'isTeamCategory=$isTeamCategory, '
        'player1=${widget.match.player1}, '
        'player2=${widget.match.player2}, '
        'lookupKey1=${_normalizeTeamKey(team1Label)}, '
        'lookupKey2=${_normalizeTeamKey(team2Label)}, '
        'rosterKeyCount=${app.selectedTournament?.teamRosterMembersBySlot.length ?? 0}, '
        'team1Count=${team1Options.length}, '
        'team2Count=${team2Options.length}, '
        'savedGame${widget.gameNo}=${_savedSelectionsForGame()}',
      );
    }

    return Scaffold(
      appBar: AppBar(
        title: Text(
          categoryName.isEmpty ? 'Select Players' : 'Select Players • $categoryName',
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        centerTitle: true,
        backgroundColor: const Color(0xFF1F2937),
        foregroundColor: Colors.white,
        elevation: 0,
      ),
      body: Container(
        color: const Color(0xFFF3F4F6),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(
                  child: SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text(
                                'GAME ${widget.gameNo}',
                                style: const TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w900,
                                  color: Color(0xFF111827),
                                  letterSpacing: 0.6,
                                ),
                                textAlign: TextAlign.center,
                              ),
                              const SizedBox(height: 8),
                              Container(
                                height: 1,
                                color: const Color(0xFFE5E7EB),
                              ),
                            ],
                          ),
                        ),
                        const SizedBox(height: 24),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: _buildTeamColumn(
                                'Team 1',
                                team1Label,
                                team1Options,
                                const Color(0xFF3B82F6),
                              ),
                            ),
                            const SizedBox(width: 14),
                            Padding(
                              padding: const EdgeInsets.only(top: 52),
                              child: Container(
                                width: 40,
                                height: 40,
                                alignment: Alignment.center,
                                decoration: BoxDecoration(
                                  color: const Color(0xFF111827),
                                  shape: BoxShape.circle,
                                  boxShadow: [
                                    BoxShadow(
                                      color: Colors.black.withValues(alpha: 0.06),
                                      blurRadius: 12,
                                      offset: const Offset(0, 4),
                                    ),
                                  ],
                                ),
                                child: const Text(
                                  'VS',
                                  style: TextStyle(
                                    fontSize: 14,
                                    fontWeight: FontWeight.w700,
                                    color: Colors.white,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(width: 14),
                            Expanded(
                              child: _buildTeamColumn(
                                'Team 2',
                                team2Label,
                                team2Options,
                                const Color(0xFFEF4444),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                ElevatedButton(
                  onPressed: _proceedToDashboard,
                  style: ElevatedButton.styleFrom(
                    backgroundColor: const Color(0xFF111827),
                    foregroundColor: Colors.white,
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(20),
                    ),
                  ),
                  child: const Text(
                    'CONTINUE',
                    style: TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildTeamColumn(
    String label,
    String teamName,
    List<TeamMemberInfo> availableMembers,
    Color color,
  ) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: const Color(0xFFE5E7EB)),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.04),
            blurRadius: 12,
            offset: const Offset(0, 6),
          ),
        ],
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 6,
            decoration: BoxDecoration(
              color: color,
              borderRadius: const BorderRadius.only(
                topLeft: Radius.circular(18),
                topRight: Radius.circular(18),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  label.toUpperCase(),
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF6B7280),
                    letterSpacing: 0.6,
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 8),
                Text(
                  teamName,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w800,
                    color: Color(0xFF111827),
                  ),
                  textAlign: TextAlign.center,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 6),
                Text(
                  '${availableMembers.length} available players',
                  style: const TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                    color: Color(0xFF6B7280),
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: _buildPlayerDropdown(
                    label: 'Player 1',
                    value: label == 'Team 1' ? _selectedTeam1Player1 : _selectedTeam2Player1,
                    options: availableMembers,
                    color: color,
                    onChanged: (value) {
                      setState(() {
                        if (label == 'Team 1') {
                          _selectedTeam1Player1 = value;
                          if (_selectedTeam1Player2 != null &&
                              _normalizeTeamKey(_selectedTeam1Player2!) ==
                                  _normalizeTeamKey(value ?? '')) {
                            _selectedTeam1Player2 = null;
                          }
                        } else {
                          _selectedTeam2Player1 = value;
                          if (_selectedTeam2Player2 != null &&
                              _normalizeTeamKey(_selectedTeam2Player2!) ==
                                  _normalizeTeamKey(value ?? '')) {
                            _selectedTeam2Player2 = null;
                          }
                        }
                      });
                    },
                  ),
                ),
                _buildPlayerDropdown(
                  label: 'Player 2',
                  value: label == 'Team 1' ? _selectedTeam1Player2 : _selectedTeam2Player2,
                  options: availableMembers,
                  color: color,
                  onChanged: (value) {
                    setState(() {
                      if (label == 'Team 1') {
                        _selectedTeam1Player2 = value;
                        if (_selectedTeam1Player1 != null &&
                            _normalizeTeamKey(_selectedTeam1Player1!) ==
                                _normalizeTeamKey(value ?? '')) {
                          _selectedTeam1Player1 = null;
                        }
                      } else {
                        _selectedTeam2Player2 = value;
                        if (_selectedTeam2Player1 != null &&
                            _normalizeTeamKey(_selectedTeam2Player1!) ==
                                _normalizeTeamKey(value ?? '')) {
                          _selectedTeam2Player1 = null;
                        }
                      }
                    });
                  },
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
        ],
      ),
    );
  }

  Widget _buildPlayerDropdown({
    required String label,
    required String? value,
    required List<TeamMemberInfo> options,
    required Color color,
    required ValueChanged<String?> onChanged,
  }) {
    Color? genderColor(String raw) {
      final g = raw.trim().toLowerCase();
      if (g.isEmpty) return null;
      if (g.contains('female') || g == 'f' || g.startsWith('f ')) return const Color(0xFFEC4899);
      if ((g.contains('male') && !g.contains('female')) || g == 'm' || g.startsWith('m ')) {
        return const Color(0xFF2563EB);
      }
      return null;
    }

    Widget memberLabel(TeamMemberInfo option, {required bool disabled}) {
      final baseColor = disabled ? const Color(0xFF9CA3AF) : (genderColor(option.gender) ?? const Color(0xFF111827));
      final subColor = disabled ? const Color(0xFF9CA3AF) : const Color(0xFF6B7280);
      return Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: option.name,
              style: TextStyle(
                color: baseColor,
                fontWeight: FontWeight.w700,
              ),
            ),
            if (option.isSub)
              TextSpan(
                text: ' (Sub)',
                style: TextStyle(
                  color: subColor,
                  fontWeight: FontWeight.w600,
                ),
              ),
          ],
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        style: const TextStyle(fontSize: 14),
      );
    }

    // Ensure value is in options
    String? effectiveValue = value;
    if (effectiveValue != null &&
        !options.any((option) => _normalizeTeamKey(option.name) == _normalizeTeamKey(effectiveValue!))) {
      effectiveValue = options.isNotEmpty ? options.first.name : null;
    }

    final blockedKeys = <String>{};
    final selections = <String?>[
      _selectedTeam1Player1,
      _selectedTeam1Player2,
      _selectedTeam2Player1,
      _selectedTeam2Player2,
    ];
    for (final s in selections) {
      final trimmed = (s ?? '').trim();
      if (trimmed.isEmpty) continue;
      blockedKeys.add(_normalizeTeamKey(trimmed));
    }
    final selfKey = _normalizeTeamKey((effectiveValue ?? '').trim());
    if (selfKey.isNotEmpty) {
      blockedKeys.remove(selfKey);
    }

    Future<void> openPicker() async {
      if (options.isEmpty) return;
      final picked = await showDialog<String>(
        context: context,
        barrierDismissible: true,
        builder: (dialogContext) {
          final screen = MediaQuery.of(dialogContext).size;
          final maxWidth = (screen.width * 0.72).clamp(320, 560).toDouble();
          final maxHeight = (screen.height * 0.70).clamp(280, 520).toDouble();

          return Dialog(
            backgroundColor: Colors.white,
            insetPadding: const EdgeInsets.symmetric(horizontal: 18, vertical: 18),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxWidth, maxHeight: maxHeight),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 14, 8, 10),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            'Select $label',
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w900,
                              color: Color(0xFF111827),
                            ),
                          ),
                        ),
                        IconButton(
                          onPressed: () => Navigator.of(dialogContext).pop(),
                          icon: const Icon(Icons.close, color: Color(0xFF6B7280)),
                        ),
                      ],
                    ),
                  ),
                  const Divider(height: 1),
                  Expanded(
                    child: ListView.separated(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      itemCount: options.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (context, index) {
                        final option = options[index];
                        final isDisabled = blockedKeys.contains(_normalizeTeamKey(option.name));
                        final isSelected = effectiveValue != null &&
                            _normalizeTeamKey(option.name) == _normalizeTeamKey(effectiveValue!);
                        final dotColor = genderColor(option.gender) ?? const Color(0xFF9CA3AF);
                        return ListTile(
                          contentPadding: const EdgeInsets.symmetric(horizontal: 16),
                          enabled: !isDisabled,
                          onTap: isDisabled ? null : () => Navigator.of(dialogContext).pop(option.name),
                          leading: Container(
                            width: 10,
                            height: 10,
                            decoration: BoxDecoration(
                              color: isDisabled ? const Color(0xFFD1D5DB) : dotColor,
                              shape: BoxShape.circle,
                            ),
                          ),
                          title: memberLabel(option, disabled: isDisabled),
                          trailing: isSelected
                              ? const Icon(Icons.check_circle, color: Color(0xFF10B981))
                              : (isDisabled
                                  ? const Icon(Icons.block, color: Color(0xFFD1D5DB))
                                  : const Icon(Icons.chevron_right, color: Color(0xFF9CA3AF))),
                        );
                      },
                    ),
                  ),
                ],
              ),
            ),
          );
        },
      );
      if (picked != null) {
        onChanged(picked);
      }
    }

    final TeamMemberInfo? selectedOption = effectiveValue == null
        ? null
        : options.cast<TeamMemberInfo?>().firstWhere(
              (o) => o != null && _normalizeTeamKey(o.name) == _normalizeTeamKey(effectiveValue!),
              orElse: () => null,
            );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Material(
          color: Colors.white,
          borderRadius: BorderRadius.circular(14),
          child: InkWell(
            borderRadius: BorderRadius.circular(14),
            onTap: openPicker,
            child: Container(
              decoration: BoxDecoration(
                border: Border.all(color: const Color(0xFFE5E7EB)),
                borderRadius: BorderRadius.circular(14),
              ),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
              child: Row(
                children: [
                  Expanded(
                    child: selectedOption == null
                        ? Text(
                            'Select $label',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 14,
                              color: Color(0xFF9CA3AF),
                              fontWeight: FontWeight.w600,
                            ),
                          )
                        : memberLabel(selectedOption, disabled: false),
                  ),
                  const SizedBox(width: 10),
                  const Icon(Icons.unfold_more_rounded, color: Color(0xFF6B7280)),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}
