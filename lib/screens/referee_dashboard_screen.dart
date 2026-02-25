import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter/rendering.dart';
import 'package:provider/provider.dart';
import '../state/app_state.dart';
import '../models.dart';
import '../widgets/coin_toss_dialog.dart';

class RefereeDashboardScreen extends StatefulWidget {
  const RefereeDashboardScreen({super.key});

  @override
  State<RefereeDashboardScreen> createState() => _RefereeDashboardScreenState();
}

class _RefereeDashboardScreenState extends State<RefereeDashboardScreen> {
  String? _servingPlayer;

  bool _gameStarted = false;
  int _score1 = 0;
  int _score2 = 0;
  bool _serverTop = true;
  Duration _elapsed = Duration.zero;
  Timer? _timer;
  final List<_Snapshot> _history = [];
  int _timeouts1 = 0;
  int _timeouts2 = 0;
  int _medTimeouts1 = 0;
  int _medTimeouts2 = 0;
  bool _inTimeout = false;
  int _timeoutSecondsLeft = 0;
  final List<String> _refereeNotes = [];
  String _refereeNote = '';
  String _leftTopOverride = '';
  String _leftBottomOverride = '';
  String _rightTopOverride = '';
  String _rightBottomOverride = '';
  String _leftBase = '';
  String _leftSecond = '';
  String _rightBase = '';
  String _rightSecond = '';
  int _leftServeStage = 0;
  int _rightServeStage = 0;
  int _currentGame = 1;

  String _fmt(int s) {
    final m = s ~/ 60;
    final ss = s % 60;
    return '${m.toString().padLeft(2, '0')}:${ss.toString().padLeft(2, '0')}';
  }

  @override
  void initState() {
    super.initState();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.landscapeLeft,
      DeviceOrientation.landscapeRight,
    ]);

    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkCoinToss();
    });
  }

  void _checkCoinToss() {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (g != null && g.score1 == 0 && g.score2 == 0 && _servingPlayer == null && !_gameStarted) {
      _showCoinTossDialog(g);
    }
    if (g != null) {
      final assignedFromList = context.read<AppState>().selectedGameNumber;
      if (assignedFromList >= 1 && assignedFromList <= 3) {
        _currentGame = assignedFromList;
      } else {
        final label = '${g.matchLabel} ${g.seedLabel}';
        final m = RegExp(r'Game\s*(\d)', caseSensitive: false).firstMatch(label);
        if (m != null) {
          final n = int.tryParse(m.group(1) ?? '');
          if (n != null && n >= 1 && n <= 3) {
            _currentGame = n;
          }
        }
      }
      _score1 = g.score1;
      _score2 = g.score2;
      _refereeNote = g.refereeNote?.toString() ?? _refereeNote;
      if (g.status == 'Ongoing' && (g.score1 > 0 || g.score2 > 0)) {
        setState(() {
          _gameStarted = true;
        });
      } else {
        setState(() {
          _gameStarted = false;
        });
      }
    }
  }

  void _showCoinTossDialog(TournamentMatch g) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => CoinTossDialog(
        player1: g.player1,
        player2: g.player2,
      ),
    );
  }

  void _startGame() async {
    if (_servingPlayer == null) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Please select a server first (Coin Toss or tap player)')),
      );
      return;
    }
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (g != null) {
      _applyDoublesInitialServerLayout(g);
    }
    setState(() {
      _gameStarted = true;
      _elapsed = Duration.zero;
      if (g != null) {
        final leftTeam = _splitTeam(g.player1);
        final rightTeam = _splitTeam(g.player2);
        if (_servingPlayer != null && leftTeam.contains(_servingPlayer)) {
          _leftServeStage = 2;
          _rightServeStage = 0;
        } else if (_servingPlayer != null && rightTeam.contains(_servingPlayer)) {
          _rightServeStage = 2;
          _leftServeStage = 0;
        } else {
          _leftServeStage = 0;
          _rightServeStage = 0;
        }
      }
    });
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() {
        _elapsed += const Duration(seconds: 1);
      });
    });
    try {
      await app.updateSelectedMatchFields({'status': 'Ongoing'});
    } catch (_) {}
  }

  void _resumeTimerIfNeeded() {
    if (!_gameStarted) return;
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() {
        _elapsed += const Duration(seconds: 1);
      });
    });
  }

  Future<void> _runTimeoutCountdown(String title, int seconds) async {
    _timer?.cancel();
    setState(() {
      _inTimeout = true;
      _timeoutSecondsLeft = seconds;
    });
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) {
        return StatefulBuilder(
          builder: (context, setLocal) {
            return AlertDialog(
              title: Text(title),
              content: Text('${_fmt(_timeoutSecondsLeft)} remaining'),
              actions: [
                TextButton(
                  onPressed: () {
                    Navigator.of(context).pop();
                  },
                  child: const Text('Resume'),
                ),
              ],
            );
          },
        );
      },
    );
    setState(() {
      _inTimeout = false;
    });
    _resumeTimerIfNeeded();
  }

  void _applyDoublesInitialServerLayout(TournamentMatch g) {
    final leftTeam = _splitTeam(g.player1);
    final rightTeam = _splitTeam(g.player2);
    if (_servingPlayer == null) return;
    if (leftTeam.length > 1 || rightTeam.length > 1) {
      if (leftTeam.contains(_servingPlayer)) {
        final partner = leftTeam.firstWhere((p) => p != _servingPlayer, orElse: () => leftTeam.first);
        _leftTopOverride = partner;
        _leftBottomOverride = _servingPlayer!;
        _serverTop = false;
        _leftBase = _servingPlayer!;
        _leftSecond = partner;
        // Determine right base (top-right) and second (bottom-right)
        final rTop = _rightTopOverride.isNotEmpty ? _rightTopOverride : (rightTeam.length > 1 ? rightTeam[1] : rightTeam[0]);
        final rBottom = _rightBottomOverride.isNotEmpty ? _rightBottomOverride : (rightTeam.length > 1 ? rightTeam[0] : '');
        _rightBase = rTop;
        _rightSecond = rBottom.isNotEmpty ? rBottom : rTop;
      } else if (rightTeam.contains(_servingPlayer)) {
        final partner = rightTeam.firstWhere((p) => p != _servingPlayer, orElse: () => rightTeam.first);
        _rightTopOverride = _servingPlayer!;
        _rightBottomOverride = partner;
        _serverTop = true;
        _rightBase = _servingPlayer!;
        _rightSecond = partner;
        // Determine left base (bottom-left) and second (top-left)
        final lBottom = _leftBottomOverride.isNotEmpty ? _leftBottomOverride : (leftTeam.length > 1 ? leftTeam[1] : '');
        final lTop = _leftTopOverride.isNotEmpty ? _leftTopOverride : (leftTeam.isNotEmpty ? leftTeam[0] : g.player1);
        _leftBase = lBottom.isNotEmpty ? lBottom : lTop;
        _leftSecond = lTop;
      }
    }
  }

  void _toggleReceiverSide(TournamentMatch g) {
    final leftTeam = _splitTeam(g.player1);
    final rightTeam = _splitTeam(g.player2);
    if (_servingPlayer == null) return;
    if (!(leftTeam.length > 1 || rightTeam.length > 1)) return;
    if (leftTeam.contains(_servingPlayer)) {
      if (_rightTopOverride.isEmpty && _rightBottomOverride.isEmpty) {
        _rightTopOverride = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
        _rightBottomOverride = rightTeam.length > 1 ? rightTeam[0] : '';
      }
      final t = _rightTopOverride;
      _rightTopOverride = _rightBottomOverride;
      _rightBottomOverride = t;
    } else if (rightTeam.contains(_servingPlayer)) {
      if (_leftTopOverride.isEmpty && _leftBottomOverride.isEmpty) {
        _leftTopOverride = leftTeam.isNotEmpty ? leftTeam[0] : g.player1;
        _leftBottomOverride = leftTeam.length > 1 ? leftTeam[1] : '';
      }
      final t = _leftTopOverride;
      _leftTopOverride = _leftBottomOverride;
      _leftBottomOverride = t;
    }
    setState(() {});
  }

  void _toggleLeftReceiver(TournamentMatch g) {
    final leftTeam = _splitTeam(g.player1);
    if (leftTeam.length < 2) return;
    if (_servingPlayer != null && leftTeam.contains(_servingPlayer)) return;
    if (_leftTopOverride.isEmpty && _leftBottomOverride.isEmpty) {
      _leftTopOverride = leftTeam[0];
      _leftBottomOverride = leftTeam[1];
    }
    final t = _leftTopOverride;
    _leftTopOverride = _leftBottomOverride;
    _leftBottomOverride = t;
    setState(() {});
  }

  void _toggleRightReceiver(TournamentMatch g) {
    final rightTeam = _splitTeam(g.player2);
    if (rightTeam.length < 2) return;
    if (_servingPlayer != null && rightTeam.contains(_servingPlayer)) return;
    if (_rightTopOverride.isEmpty && _rightBottomOverride.isEmpty) {
      _rightTopOverride = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
      _rightBottomOverride = rightTeam.length > 1 ? rightTeam[0] : '';
    }
    final t = _rightTopOverride;
    _rightTopOverride = _rightBottomOverride;
    _rightBottomOverride = t;
    setState(() {});
  }

  Future<void> _addRefereeNote(TournamentMatch g) async {
    final ctrl = TextEditingController(text: _refereeNote);
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Referee Note'),
        content: TextField(
          controller: ctrl,
          maxLines: 5,
          decoration: const InputDecoration(hintText: 'Describe the dispute or note here'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Save')),
        ],
      ),
    );
    if (ok == true) {
      final note = ctrl.text.trim();
      if (note.isEmpty) return;
      setState(() {
        _refereeNote = note;
      });
      final app = context.read<AppState>();
      try {
        await app.updateSelectedMatchFields({'refereeNote': _refereeNote});
      } catch (_) {}
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
    ]);
    super.dispose();
  }

  Widget _playerCell(String name, {Color color = const Color(0xFF0D9488), bool isServing = false, bool isBase = false}) {
    return InkWell(
      onTap: !_gameStarted ? () {
        setState(() {
          _servingPlayer = name;
        });
      } : null,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (isBase) ...[
              const _PickleballIcon(size: 14),
              const SizedBox(width: 4),
            ],
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 240),
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 16,
                  fontWeight: FontWeight.bold,
                  shadows: [Shadow(blurRadius: 4, color: Colors.black54, offset: Offset(0, 1))],
                ),
              ),
            ),
            if (isServing)
              const Padding(
                padding: EdgeInsets.only(left: 6.0),
                child: Icon(Icons.sports_tennis, color: Colors.yellowAccent, size: 18),
              ),
          ],
        ),
      ),
    );
  }

  List<String> _splitTeam(String name) {
    final parts = name.split(RegExp(r'\s*/\s*')).map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
    if (parts.isEmpty) return [name];
    if (parts.length == 1) return parts;
    return [parts[0], parts[1]];
  }

  @override
  Widget build(BuildContext context) {
    final app = context.watch<AppState>();
    final TournamentMatch? g = app.selectedGame;
    String timerText = '${_elapsed.inMinutes.remainder(60).toString().padLeft(2, '0')}:${_elapsed.inSeconds.remainder(60).toString().padLeft(2, '0')}';

    // Category-based theming
    Color primaryColor = const Color(0xFF0F766E);
    Color secondaryColor = const Color(0xFF10B981);
    Color liningColor = Colors.transparent;
    String kind = '';
    if (g != null) {
      final catName = app.selectedTournament?.categoryNames[g.categoryId]?.toLowerCase() ?? '';
      if (catName.contains("mixed")) {
        primaryColor = const Color(0xFF7C3AED);
        secondaryColor = const Color(0xFFA78BFA);
        kind = 'mixed';
      } else if (catName.contains("women")) {
        primaryColor = const Color(0xFFEC4899);
        secondaryColor = const Color(0xFFF472B6);
        kind = 'women';
      } else if (catName.contains("men")) {
        primaryColor = const Color(0xFF2563EB);
        secondaryColor = const Color(0xFF3B82F6);
        kind = 'men';
      }
      final label = '${g.matchLabel} ${g.seedLabel}'.toLowerCase();
      if (label.contains('final')) {
        liningColor = const Color(0xFFF59E0B); // gold
      } else if (label.contains('bronze')) {
        liningColor = const Color(0xFFCD7F32); // bronze
      }
    }

    return Scaffold(
      appBar: AppBar(
        backgroundColor: primaryColor,
        title: !_gameStarted
            ? Text('Court ${app.selectedCourt ?? ''}')
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.timer, size: 18, color: Colors.white),
                  const SizedBox(width: 6),
                  Text(
                    timerText,
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold),
                  ),
                ],
              ),
        actions: [
          if (_gameStarted && g != null)
            Padding(
              padding: const EdgeInsets.only(right: 8.0),
              child: TextButton.icon(
                onPressed: () => _showSubmitDialog(g),
                icon: const Icon(Icons.flag, color: Colors.white),
                label: const Text('SUBMIT', style: TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
                style: TextButton.styleFrom(
                  foregroundColor: Colors.white,
                ),
              ),
            ),
          IconButton(
            onPressed: _undoLast,
            icon: const Icon(Icons.replay),
            tooltip: 'Redo',
          ),
          PopupMenuButton<String>(
            onSelected: (v) async {
              if (g == null) return;
              if (v == 'coin') {
                _showCoinTossDialog(g);
              } else if (v == 'note') {
                await _addRefereeNote(g);
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'coin', child: Text('Coin Toss')),
              const PopupMenuItem(value: 'note', child: Text('Referee Note')),
            ],
            icon: const Icon(Icons.settings),
          ),
        ],
      ),
      body: g == null
          ? const Center(child: Text('No game selected'))
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 6),
                  child: Row(
                    children: [
                      if (!_gameStarted)
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                          decoration: BoxDecoration(
                            color: const Color(0xFF0E7C6F),
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(color: Colors.white70, width: 2),
                          ),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              const Text('TIME', style: TextStyle(color: Colors.white70, fontWeight: FontWeight.w600)),
                              Text(
                                timerText,
                                style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 16),
                              ),
                            ],
                          ),
                        ),
                      if (!_gameStarted && _servingPlayer == null) ...[
                        const SizedBox(width: 12),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                          decoration: BoxDecoration(
                            color: Colors.black.withOpacity(0.1),
                            borderRadius: BorderRadius.circular(10),
                          ),
                          child: const Text(
                            'Tap a player to choose server',
                            style: TextStyle(color: Colors.black87, fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                      const Spacer(),
                    ],
                  ),
                ),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    child: LayoutBuilder(builder: (_, c) {
                      final String leftTeamName = g.player1;
                      final String rightTeamName = g.player2;
                      final leftTeam = _splitTeam(leftTeamName);
                      final rightTeam = _splitTeam(rightTeamName);
                      final bool isDoubles = leftTeam.length > 1 || rightTeam.length > 1;
                      final bool isSingles = !isDoubles;
                      var leftTop = _leftTopOverride.isNotEmpty
                          ? _leftTopOverride
                          : (leftTeam.isNotEmpty ? leftTeam[0] : leftTeamName);
                      var leftBottom = _leftBottomOverride.isNotEmpty
                          ? _leftBottomOverride
                          : (leftTeam.length > 1 ? leftTeam[1] : '');
                      var rightTop = _rightTopOverride.isNotEmpty
                          ? _rightTopOverride
                          : (rightTeam.length > 1 ? rightTeam[1] : rightTeam[0]);
                      var rightBottom = _rightBottomOverride.isNotEmpty
                          ? _rightBottomOverride
                          : (rightTeam.length > 1 ? rightTeam[0] : '');
                      final noServer = _servingPlayer == null;
                      final serverOnLeft = _servingPlayer != null && leftTeam.contains(_servingPlayer);
                      final serverOnRight = _servingPlayer != null && rightTeam.contains(_servingPlayer);
                      final serverRight = serverOnRight;
                      final serviceTop = _servingPlayer == null ? true : _serverTop;
                      String centerScore;
                      if (isDoubles) {
                        int sNum = 0;
                        if (_servingPlayer != null) {
                          if (serverOnLeft) {
                            sNum = _leftServeStage <= 1 ? 1 : 2;
                          } else if (serverOnRight) {
                            sNum = _rightServeStage <= 1 ? 1 : 2;
                          }
                        }
                        centerScore = '$_score1 - $_score2 - $sNum';
                      } else {
                        centerScore = '$_score1 - $_score2';
                      }
                      return GestureDetector(
                        behavior: HitTestBehavior.deferToChild,
                        child: Container(
                          decoration: BoxDecoration(
                            gradient: LinearGradient(
                              colors: [primaryColor, secondaryColor],
                              begin: Alignment.topLeft,
                              end: Alignment.bottomRight,
                            ),
                            borderRadius: BorderRadius.circular(12),
                            border: liningColor == Colors.transparent
                                ? null
                                : Border.all(color: liningColor, width: 4),
                          ),
                        padding: const EdgeInsets.all(12),
                        child: Stack(
                          children: [
                            Positioned(
                              top: 8,
                              left: 8,
                              child: _CategoryBadge(kind: kind.isEmpty ? 'ref' : kind),
                            ),
                            Positioned.fill(
                              child: CustomPaint(
                                painter: _SinglesCourtPainter(
                                  highlightRight: serverRight,
                                  highlightTop: serviceTop,
                                ),
                              ),
                            ),
                            Align(
                              alignment: Alignment.center,
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                                decoration: BoxDecoration(
                                  color: Colors.black,
                                  borderRadius: BorderRadius.circular(8),
                                ),
                                child: Text(
                                  centerScore,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                    color: Colors.white,
                                    fontSize: 48,
                                    fontWeight: FontWeight.w900,
                                  ),
                                ),
                              ),
                            ),
                            Align(
                              alignment: isSingles
                                  ? (serverOnLeft
                                      ? (serviceTop ? Alignment.topLeft : Alignment.bottomLeft)
                                      : (serviceTop ? Alignment.bottomLeft : Alignment.topLeft))
                                  : Alignment.topLeft,
                              child: FractionallySizedBox(
                                widthFactor: 0.5,
                                heightFactor: 0.5,
                                child: Padding(
                                  padding: const EdgeInsets.all(8.0),
                                  child: _playerCell(
                                    leftTop,
                                    isServing: _servingPlayer == leftTop,
                                    isBase: leftTop == _leftBase,
                                  ),
                                ),
                              ),
                            ),
                            if (isDoubles && leftBottom.isNotEmpty)
                              Align(
                                alignment: Alignment.bottomLeft,
                                child: FractionallySizedBox(
                                  widthFactor: 0.5,
                                  heightFactor: 0.5,
                                  child: Padding(
                                    padding: const EdgeInsets.all(8.0),
                                    child: _playerCell(
                                      leftBottom,
                                    isServing: _servingPlayer == leftBottom,
                                    isBase: leftBottom == _leftBase,
                                    ),
                                  ),
                                ),
                              ),
                            Align(
                              alignment: isSingles
                                  ? (serverOnRight
                                      ? (serviceTop ? Alignment.topRight : Alignment.bottomRight)
                                      : (noServer ? Alignment.topRight : (serviceTop ? Alignment.bottomRight : Alignment.topRight)))
                                  : Alignment.topRight,
                              child: FractionallySizedBox(
                                widthFactor: 0.5,
                                heightFactor: 0.5,
                                child: Align(
                                  alignment: Alignment.centerRight,
                                  child: Padding(
                                    padding: const EdgeInsets.all(8.0),
                                    child: _playerCell(
                                      rightTop,
                                    isServing: _servingPlayer == rightTop,
                                    isBase: rightTop == _rightBase,
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            if (isDoubles && rightBottom.isNotEmpty)
                              Align(
                                alignment: Alignment.bottomRight,
                                child: FractionallySizedBox(
                                  widthFactor: 0.5,
                                  heightFactor: 0.5,
                                  child: Align(
                                    alignment: Alignment.centerRight,
                                    child: Padding(
                                      padding: const EdgeInsets.all(8.0),
                                      child: _playerCell(
                                        rightBottom,
                                        isServing: _servingPlayer == rightBottom,
                                        isBase: rightBottom == _rightBase,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            if (!_gameStarted)
                              Positioned.fill(
                                child: Material(
                                  color: Colors.transparent,
                                  child: isDoubles
                                      ? Row(
                                          children: [
                                            Expanded(
                                              child: Column(
                                                children: [
                                                  Expanded(
                                                    child: InkWell(
                                                      onTap: () => setState(() {
                                                        _servingPlayer = leftTop;
                                                        _applyDoublesInitialServerLayout(g);
                                                      }),
                                                      splashColor: Colors.white10,
                                                    ),
                                                  ),
                                                  Expanded(
                                                    child: InkWell(
                                                      onTap: () => setState(() {
                                                        _servingPlayer = leftBottom.isNotEmpty ? leftBottom : leftTop;
                                                        _applyDoublesInitialServerLayout(g);
                                                      }),
                                                      splashColor: Colors.white10,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                            Expanded(
                                              child: Column(
                                                children: [
                                                  Expanded(
                                                    child: InkWell(
                                                      onTap: () => setState(() {
                                                        _servingPlayer = rightTop;
                                                        _applyDoublesInitialServerLayout(g);
                                                      }),
                                                      splashColor: Colors.white10,
                                                    ),
                                                  ),
                                                  Expanded(
                                                    child: InkWell(
                                                      onTap: () => setState(() {
                                                        _servingPlayer = rightBottom.isNotEmpty ? rightBottom : rightTop;
                                                        _applyDoublesInitialServerLayout(g);
                                                      }),
                                                      splashColor: Colors.white10,
                                                    ),
                                                  ),
                                                ],
                                              ),
                                            ),
                                          ],
                                        )
                                      : Row(
                                          children: [
                                            Expanded(
                                              child: InkWell(
                                                onTap: () => setState(() {
                                                  _servingPlayer = leftTop;
                                                  _serverTop = false;
                                                }),
                                                splashColor: Colors.white10,
                                              ),
                                            ),
                                            Expanded(
                                              child: InkWell(
                                                onTap: () => setState(() {
                                                  _servingPlayer = rightTop;
                                                  _serverTop = true;
                                                }),
                                                splashColor: Colors.white10,
                                              ),
                                            ),
                                          ],
                                        ),
                                ),
                              ),
                          ],
                        ),
                        ),
                      );
                    }),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
                  child: Row(
                    children: [
                      if (!_gameStarted && g != null) ...[
                        Builder(builder: (_) {
                          final leftTeam = _splitTeam(g.player1);
                          final rightTeam = _splitTeam(g.player2);
                          final isDoubles = leftTeam.length > 1 || rightTeam.length > 1;
                          final leftServing = _servingPlayer != null && leftTeam.contains(_servingPlayer);
                          final rightServing = _servingPlayer != null && rightTeam.contains(_servingPlayer);
                          if (!isDoubles) return const SizedBox.shrink();
                          return Row(
                            children: [
                              IconButton(
                                tooltip: 'Swap left receiver',
                                onPressed: leftServing ? null : () => _toggleLeftReceiver(g),
                                icon: const Icon(Icons.swap_vert),
                              ),
                              const SizedBox(width: 8),
                            ],
                          );
                        }),
                      ],
                      IconButton(onPressed: _onTimeout, icon: const Icon(Icons.timer)),
                      IconButton(onPressed: _onMedicalTimeout, icon: const Icon(Icons.healing)),
                      const Spacer(),
                      if (!_gameStarted && g != null) ...[
                        Builder(builder: (_) {
                          final leftTeam = _splitTeam(g.player1);
                          final rightTeam = _splitTeam(g.player2);
                          final isDoubles = leftTeam.length > 1 || rightTeam.length > 1;
                          final leftServing = _servingPlayer != null && leftTeam.contains(_servingPlayer);
                          final rightServing = _servingPlayer != null && rightTeam.contains(_servingPlayer);
                          if (!isDoubles) return const SizedBox.shrink();
                          return Row(
                            children: [
                              IconButton(
                                tooltip: 'Swap right receiver',
                                onPressed: rightServing ? null : () => _toggleRightReceiver(g),
                                icon: const Icon(Icons.swap_vert),
                              ),
                            ],
                          );
                        }),
                      ],
                    ],
                  ),
                ),
                if (!_gameStarted)
                  Container(
                    color: const Color(0xFF0F766E),
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        Expanded(
                          child: SizedBox(
                            height: 56,
                            child: ElevatedButton.icon(
                              onPressed: _servingPlayer != null ? _startGame : null,
                              style: ElevatedButton.styleFrom(
                                backgroundColor: const Color(0xFF10B981),
                                disabledBackgroundColor: Colors.grey[700],
                                foregroundColor: Colors.white,
                              ),
                              icon: const Icon(Icons.play_arrow, size: 28),
                              label: const Text('START GAME', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                            ),
                          ),
                        ),
                      ],
                    ),
                  )
                else
                  Container(
                    color: Colors.white10,
                    padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                      children: [
                        SizedBox(
                          width: 120,
                          height: 56,
                          child: ElevatedButton(
                            onPressed: _decrementPoint,
                            style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade400, foregroundColor: Colors.white),
                            child: const Text('-', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                          ),
                        ),
                        SizedBox(
                          width: 200,
                          height: 56,
                          child: ElevatedButton(
                            onPressed: _sideOut,
                            style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade400, foregroundColor: Colors.white),
                            child: Builder(builder: (_) {
                              final app = context.read<AppState>();
                              final g = app.selectedGame;
                              var label = 'SIDE OUT';
                              if (g != null) {
                                final leftTeam = _splitTeam(g.player1);
                                final rightTeam = _splitTeam(g.player2);
                                final isDoubles = leftTeam.length > 1 || rightTeam.length > 1;
                                if (isDoubles && _servingPlayer != null) {
                                  final onLeft = leftTeam.contains(_servingPlayer);
                                  final onRight = rightTeam.contains(_servingPlayer);
                                  final isFirstOnTeam = (onLeft && _servingPlayer == _leftBase) || (onRight && _servingPlayer == _rightBase);
                                  label = isFirstOnTeam ? 'SECOND SERVER' : 'SIDE OUT';
                                }
                              }
                              if (g != null && _servingPlayer != null) {
                                final leftTeam = _splitTeam(g.player1);
                                final rightTeam = _splitTeam(g.player2);
                                final isDoubles = leftTeam.length > 1 || rightTeam.length > 1;
                                if (isDoubles) {
                                  if (leftTeam.contains(_servingPlayer)) {
                                    label = _leftServeStage <= 1 ? 'SECOND SERVER' : 'SIDE OUT';
                                  } else if (rightTeam.contains(_servingPlayer)) {
                                    label = _rightServeStage <= 1 ? 'SECOND SERVER' : 'SIDE OUT';
                                  }
                                }
                              }
                              return Text(label, style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold));
                            }),
                          ),
                        ),
                        SizedBox(
                          width: 120,
                          height: 56,
                          child: ElevatedButton(
                            onPressed: _incrementPoint,
                            style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade400, foregroundColor: Colors.white),
                            child: const Text('+', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                          ),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }

  void _showSubmitDialog(TournamentMatch g) {
    final sigKey = GlobalKey<_SignaturePadState>();
    final app = context.read<AppState>();
    final category = app.selectedTournament?.categoryNames[g.categoryId] ?? '';
    final winnerName = _score1 > _score2
        ? g.player1
        : (_score2 > _score1 ? g.player2 : '');
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) {
        return Dialog(
          insetPadding: EdgeInsets.zero,
          backgroundColor: Colors.transparent,
          child: LayoutBuilder(
            builder: (context, constraints) {
              return SizedBox(
                width: constraints.maxWidth,
                height: constraints.maxHeight,
                child: Container(
                  color: Colors.white,
                  child: Column(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'Submit Match',
                              style: TextStyle(
                                fontSize: 20,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                            if (category.isNotEmpty)
                              Padding(
                                padding: const EdgeInsets.only(top: 4),
                                child: Text(
                                  category,
                                  style: const TextStyle(
                                    fontSize: 14,
                                    color: Colors.grey,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                      const Divider(height: 1),
                      Expanded(
                        child: SingleChildScrollView(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Text('${g.player1} vs ${g.player2}'),
                              const SizedBox(height: 8),
                              Text('Score: $_score1 - $_score2'),
                              if (winnerName.isNotEmpty) ...[
                                const SizedBox(height: 8),
                                Text('Winner: $winnerName'),
                              ],
                              const SizedBox(height: 16),
                              Container(
                                height: 1,
                                color: Colors.grey,
                                margin: const EdgeInsets.only(bottom: 8),
                              ),
                              const Text(
                                'Signature',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Colors.grey,
                                ),
                              ),
                              const SizedBox(height: 8),
                              SizedBox(
                                height: 260,
                                child: SignaturePad(key: sigKey),
                              ),
                            ],
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            TextButton(
                              onPressed: () {
                                Navigator.of(context).pop();
                              },
                              child: const Text('Cancel'),
                            ),
                            const SizedBox(width: 8),
                            ElevatedButton(
                              onPressed: () async {
                                bool includeNote = true;
                                if (_refereeNote.trim().isNotEmpty) {
                                  final decision = await showDialog<bool>(
                                    context: context,
                                    builder: (_) => AlertDialog(
                                      title: const Text('Attach Referee Note?'),
                                      content: const Text('Send the referee note to the website so it appears in the completed game summary?'),
                                      actions: [
                                        TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Skip')),
                                        ElevatedButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Send Note')),
                                      ],
                                    ),
                                  );
                                  includeNote = decision ?? true;
                                }
                                final bytes = await sigKey.currentState?.export();
                                final ok = await _finishSubmit(g, bytes, includeNote: includeNote);
                                if (!mounted) return;
                                if (ok) {
                                  Navigator.of(context).pop();
                                  Navigator.of(context).pop();
                                }
                              },
                              child: const Text('Finish'),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }

  Future<bool> _finishSubmit(TournamentMatch g, Uint8List? signatureBytes, {bool includeNote = true}) async {
    final app = context.read<AppState>();
    final winnerName = _score1 > _score2
        ? g.player1
        : (_score2 > _score1 ? g.player2 : '');
    String? signatureData;
    if (signatureBytes != null && signatureBytes.isNotEmpty) {
      final encoded = base64Encode(signatureBytes);
      signatureData = 'data:image/png;base64,$encoded';
    }
    final fields = <String, dynamic>{
      'score1': _score1,
      'score2': _score2,
      'finalScorePlayer1': _score1,
      'finalScorePlayer2': _score2,
      'status': 'Completed',
    };
    final gKey1 = 'game${_currentGame}Player1';
    final gKey2 = 'game${_currentGame}Player2';
    fields[gKey1] = _score1;
    fields[gKey2] = _score2;
    if (winnerName.isNotEmpty) {
      fields['winner'] = winnerName;
    }
    if (signatureData != null) {
      fields['signatureData'] = signatureData;
      fields['gameSignatures'] = [signatureData, null, null];
    }
    if (includeNote && _refereeNote.trim().isNotEmpty) {
      fields['refereeNote'] = _refereeNote.trim();
    }
    try {
      await app.updateSelectedMatchFields(fields);
      await app.refreshSelectedTournament();
      if (mounted) {
        setState(() {
          _gameStarted = false;
        });
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Match submitted')),
        );
      }
      return true;
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Failed to submit match')),
        );
      }
      return false;
    }
  }
}

class _Snapshot {
  final int s1;
  final int s2;
  final String? server;
  final bool serverTop;
  final int t1;
  final int t2;
  final int mt1;
  final int mt2;
  final int ls;
  final int rs;
  _Snapshot(this.s1, this.s2, this.server, this.serverTop, this.t1, this.t2, this.mt1, this.mt2, this.ls, this.rs);
}

class _SinglesCourtPainter extends CustomPainter {
  final bool highlightRight;
  final bool highlightTop;
  _SinglesCourtPainter({required this.highlightRight, required this.highlightTop});
  @override
  void paint(Canvas canvas, Size size) {
    final bg = Paint()..color = const Color(0xFF064E3B);
    canvas.drawRRect(
      RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(10)),
      bg,
    );
    final line = Paint()
      ..color = Colors.white
      ..strokeWidth = 2;
    final w = size.width;
    final h = size.height;
    final pad = 12.0;
    final rect = Rect.fromLTWH(pad, pad, w - pad * 2, h - pad * 2);
    canvas.drawRect(rect, Paint()..style = PaintingStyle.stroke..color = Colors.white..strokeWidth = 3);
    final midX = rect.left + rect.width / 2;
    final midY = rect.top + rect.height / 2;
    canvas.drawLine(Offset(midX, rect.top), Offset(midX, rect.bottom), line);
    canvas.drawLine(Offset(rect.left, midY), Offset(rect.right, midY), line);
    final rightRectTop = Rect.fromLTWH(midX, rect.top, rect.width / 2, rect.height / 2);
    final rightRectBottom = Rect.fromLTWH(midX, midY, rect.width / 2, rect.height / 2);
    final leftRectTop = Rect.fromLTWH(rect.left, rect.top, rect.width / 2, rect.height / 2);
    final leftRectBottom = Rect.fromLTWH(rect.left, midY, rect.width / 2, rect.height / 2);
    final hl = Paint()..color = Colors.yellow.withOpacity(0.15);
    Rect toDraw;
    if (highlightRight) {
      toDraw = highlightTop ? rightRectTop : rightRectBottom;
    } else {
      toDraw = highlightTop ? leftRectTop : leftRectBottom;
    }
    canvas.drawRect(toDraw, hl);
  }
  @override
  bool shouldRepaint(covariant _SinglesCourtPainter oldDelegate) =>
      oldDelegate.highlightRight != highlightRight || oldDelegate.highlightTop != highlightTop;
}

class _PickleballIcon extends StatelessWidget {
  final double size;
  const _PickleballIcon({this.size = 14});
  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size,
      height: size,
      child: CustomPaint(
        painter: _PickleballIconPainter(),
      ),
    );
  }
}

class _PickleballIconPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final r = size.shortestSide / 2;
    final c = Offset(size.width / 2, size.height / 2);
    final paint = Paint()
      ..shader = ui.Gradient.radial(
        c,
        r,
        [const Color(0xFF34D399), const Color(0xFF059669)],
      );
    canvas.drawCircle(c, r, paint);
    final hole = Paint()..color = Colors.white;
    final hr = r * 0.18;
    canvas.drawCircle(c, hr, hole);
    final d = r * 0.6;
    canvas.drawCircle(Offset(c.dx, c.dy - d), hr, hole);
    canvas.drawCircle(Offset(c.dx + d, c.dy), hr, hole);
    canvas.drawCircle(Offset(c.dx - d, c.dy), hr, hole);
    canvas.drawCircle(Offset(c.dx, c.dy + d), hr, hole);
  }
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _CategoryBadge extends StatelessWidget {
  final String kind;
  const _CategoryBadge({required this.kind});
  @override
  Widget build(BuildContext context) {
    Color bg;
    String text;
    switch (kind) {
      case 'men':
        bg = const Color(0xFF2563EB);
        text = 'M';
        break;
      case 'women':
        bg = const Color(0xFFEC4899);
        text = 'W';
        break;
      case 'mixed':
        bg = const Color(0xFF7C3AED);
        text = 'X';
        break;
      default:
        bg = const Color(0xFF0F766E);
        text = 'R';
    }
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: bg.withOpacity(0.9),
        borderRadius: BorderRadius.circular(8),
        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 4, offset: Offset(0, 2))],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.sports_tennis, color: Colors.white, size: 14),
          const SizedBox(width: 4),
          Text(text, style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}
extension on _RefereeDashboardScreenState {
  void _pushSnapshot() {
    _history.add(_Snapshot(_score1, _score2, _servingPlayer, _serverTop, _timeouts1, _timeouts2, _medTimeouts1, _medTimeouts2, _leftServeStage, _rightServeStage));
  }

  bool _serverOnTeam1(TournamentMatch g) {
    final leftTeam = _splitTeam(g.player1);
    return _servingPlayer != null && leftTeam.contains(_servingPlayer);
  }

  void _secondServe() {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (!_gameStarted || g == null || _servingPlayer == null) return;
    final leftTeam = _splitTeam(g.player1);
    final rightTeam = _splitTeam(g.player2);
    setState(() {
      if (leftTeam.contains(_servingPlayer) && leftTeam.length > 1) {
        _servingPlayer = _servingPlayer == leftTeam[0] ? leftTeam[1] : leftTeam[0];
      } else if (rightTeam.contains(_servingPlayer) && rightTeam.length > 1) {
        _servingPlayer = _servingPlayer == rightTeam[0] ? (rightTeam.length > 1 ? rightTeam[1] : rightTeam[0]) : rightTeam[0];
      }
    });
  }

  void _undoLast() {
    if (_history.isEmpty) return;
    final last = _history.removeLast();
    setState(() {
      _score1 = last.s1;
      _score2 = last.s2;
      _servingPlayer = last.server;
      _serverTop = last.serverTop;
      _timeouts1 = last.t1;
      _timeouts2 = last.t2;
      _medTimeouts1 = last.mt1;
      _medTimeouts2 = last.mt2;
      _leftServeStage = last.ls;
      _rightServeStage = last.rs;
    });
  }

  void _incrementPoint() {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (!_gameStarted || g == null || _servingPlayer == null) return;
    _pushSnapshot();
    setState(() {
      if (_serverOnTeam1(g)) {
        _score1 += 1;
        final leftTeam = _splitTeam(g.player1);
        if (leftTeam.length > 1) {
          if (_leftTopOverride.isEmpty && _leftBottomOverride.isEmpty) {
            _leftTopOverride = leftTeam[0];
            _leftBottomOverride = leftTeam.length > 1 ? leftTeam[1] : '';
          }
          final t = _leftTopOverride;
          _leftTopOverride = _leftBottomOverride;
          _leftBottomOverride = t;
        }
      } else {
        _score2 += 1;
        final rightTeam = _splitTeam(g.player2);
        if (rightTeam.length > 1) {
          if (_rightTopOverride.isEmpty && _rightBottomOverride.isEmpty) {
            _rightTopOverride = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
            _rightBottomOverride = rightTeam.length > 1 ? rightTeam[0] : '';
          }
          final t = _rightTopOverride;
          _rightTopOverride = _rightBottomOverride;
          _rightBottomOverride = t;
        }
      }
      _serverTop = !_serverTop;
    });
  }

  void _decrementPoint() {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (!_gameStarted || g == null || _servingPlayer == null) return;
    _pushSnapshot();
    setState(() {
      if (_serverOnTeam1(g) && _score1 > 0) {
        _score1 -= 1;
        final leftTeam = _splitTeam(g.player1);
        if (leftTeam.length > 1) {
          if (_leftTopOverride.isEmpty && _leftBottomOverride.isEmpty) {
            _leftTopOverride = leftTeam[0];
            _leftBottomOverride = leftTeam.length > 1 ? leftTeam[1] : '';
          }
          final t = _leftTopOverride;
          _leftTopOverride = _leftBottomOverride;
          _leftBottomOverride = t;
        }
      } else if (!_serverOnTeam1(g) && _score2 > 0) {
        _score2 -= 1;
        final rightTeam = _splitTeam(g.player2);
        if (rightTeam.length > 1) {
          if (_rightTopOverride.isEmpty && _rightBottomOverride.isEmpty) {
            _rightTopOverride = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
            _rightBottomOverride = rightTeam.length > 1 ? rightTeam[0] : '';
          }
          final t = _rightTopOverride;
          _rightTopOverride = _rightBottomOverride;
          _rightBottomOverride = t;
        }
      }
      _serverTop = !_serverTop;
    });
  }

  void _sideOut() {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (!_gameStarted || g == null || _servingPlayer == null) return;
    _pushSnapshot();
    setState(() {
      final leftTeam = _splitTeam(g.player1);
      final rightTeam = _splitTeam(g.player2);
      final wasOnLeft = leftTeam.contains(_servingPlayer);
      final isDoubles = leftTeam.length > 1 || rightTeam.length > 1;
      if (isDoubles) {
        if (wasOnLeft) {
          if (_leftServeStage <= 1) {
            _leftServeStage = 2;
            _servingPlayer = _servingPlayer == leftTeam[0] ? (leftTeam.length > 1 ? leftTeam[1] : leftTeam[0]) : leftTeam[0];
          } else {
            _leftServeStage = 0;
            _rightServeStage = 1;
            final rightSide = _rightTopOverride.isNotEmpty ? _rightTopOverride : (rightTeam.length > 1 ? rightTeam[1] : rightTeam[0]);
            _servingPlayer = rightSide;
            _serverTop = true;
          }
        } else {
          if (_rightServeStage <= 1) {
            _rightServeStage = 2;
            _servingPlayer = _servingPlayer == rightTeam[0] ? (rightTeam.length > 1 ? rightTeam[1] : rightTeam[0]) : rightTeam[0];
          } else {
            _rightServeStage = 0;
            _leftServeStage = 1;
            final rightSide = _leftBottomOverride.isNotEmpty ? _leftBottomOverride : (leftTeam.length > 1 ? leftTeam[1] : (leftTeam.isNotEmpty ? leftTeam[0] : g.player1));
            _servingPlayer = rightSide;
            _serverTop = false;
          }
        }
      } else {
        // Singles: previous behavior
        if (wasOnLeft) {
          _servingPlayer = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
          _serverTop = (_score2 % 2 == 0);
        } else {
          _servingPlayer = leftTeam[0];
          _serverTop = (_score1 % 2 != 0);
        }
      }
    });
  }

  Future<void> _noShow(TournamentMatch g, String noShowPlayer, String winner) async {
    final app = context.read<AppState>();
    final ok = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Confirm No Show'),
        content: Text('$noShowPlayer did not show up. Award to $winner?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('Confirm')),
        ],
      ),
    );
    if (ok != true) return;
    final fields = <String, dynamic>{
      'winner': winner,
      'status': 'Completed',
      'score1': _score1,
      'score2': _score2,
      'finalScorePlayer1': _score1,
      'finalScorePlayer2': _score2,
    };
    try {
      await app.updateSelectedMatchFields(fields);
      await app.refreshSelectedTournament();
      if (mounted) {
        setState(() {
          _gameStarted = false;
        });
      }
    } catch (_) {}
  }

  void _onTimeout() async {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (g == null) return;
    final who = await showDialog<String>(
      context: context,
      builder: (_) {
        final p1Disabled = _timeouts1 >= 1;
        final p2Disabled = _timeouts2 >= 1;
        return SimpleDialog(
          title: const Text('Timeout'),
          children: [
            ListTile(
              title: Text(g.player1),
              enabled: !p1Disabled,
              onTap: p1Disabled ? null : () => Navigator.pop(context, 'p1'),
            ),
            ListTile(
              title: Text(g.player2),
              enabled: !p2Disabled,
              onTap: p2Disabled ? null : () => Navigator.pop(context, 'p2'),
            ),
          ],
        );
      },
    );
    if (who == null) return;
    final name = who == 'p1' ? g.player1 : g.player2;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Confirm Timeout'),
        content: Text('Are you sure you want to timeout $name?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('OK')),
        ],
      ),
    );
    if (confirm != true) return;
    _pushSnapshot();
    if (who == 'p1') {
      setState(() {
        _timeouts1 += 1;
      });
    } else if (who == 'p2') {
      setState(() {
        _timeouts2 += 1;
      });
    }
    int remaining = 60;
    _timer?.cancel();
    setState(() {
      _inTimeout = true;
      _timeoutSecondsLeft = remaining;
    });
    Timer? localTimer;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) {
        return StatefulBuilder(builder: (context, setLocal) {
          localTimer ??= Timer.periodic(const Duration(seconds: 1), (t) {
            if (!mounted) return;
            if (remaining <= 1) {
              t.cancel();
              Navigator.of(context).pop();
              return;
            }
            remaining -= 1;
            setLocal(() {
              _timeoutSecondsLeft = remaining;
            });
          });
          return AlertDialog(
            title: const Text('Timeout'),
            content: Text('${_fmt(_timeoutSecondsLeft)} remaining'),
            actions: [
              TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Resume')),
            ],
          );
        });
      },
    );
    localTimer?.cancel();
    setState(() {
      _inTimeout = false;
    });
    _resumeTimerIfNeeded();
  }

  void _onMedicalTimeout() async {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (g == null) return;
    final who = await showDialog<String>(
      context: context,
      builder: (_) {
        final p1Disabled = _medTimeouts1 >= 1;
        final p2Disabled = _medTimeouts2 >= 1;
        return SimpleDialog(
          title: const Text('Medical Timeout'),
          children: [
            ListTile(
              title: Text(g.player1),
              enabled: !p1Disabled,
              onTap: p1Disabled ? null : () => Navigator.pop(context, 'p1'),
            ),
            ListTile(
              title: Text(g.player2),
              enabled: !p2Disabled,
              onTap: p2Disabled ? null : () => Navigator.pop(context, 'p2'),
            ),
          ],
        );
      },
    );
    if (who == null) return;
    final name = who == 'p1' ? g.player1 : g.player2;
    final confirm = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Confirm Medical Timeout'),
        content: Text('Are you sure you want to start a medical timeout for $name?'),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          ElevatedButton(onPressed: () => Navigator.of(context).pop(true), child: const Text('OK')),
        ],
      ),
    );
    if (confirm != true) return;
    _pushSnapshot();
    if (who == 'p1') {
      setState(() {
        _medTimeouts1 += 1;
      });
    } else if (who == 'p2') {
      setState(() {
        _medTimeouts2 += 1;
      });
    }
    int remaining = 300;
    _timer?.cancel();
    setState(() {
      _inTimeout = true;
      _timeoutSecondsLeft = remaining;
    });
    Timer? localTimer;
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (_) {
        return StatefulBuilder(builder: (context, setLocal) {
          localTimer ??= Timer.periodic(const Duration(seconds: 1), (t) {
            if (!mounted) return;
            if (remaining <= 1) {
              t.cancel();
              Navigator.of(context).pop();
              return;
            }
            remaining -= 1;
            setLocal(() {
              _timeoutSecondsLeft = remaining;
            });
          });
          return AlertDialog(
            title: const Text('Medical Timeout'),
            content: Text('${_fmt(_timeoutSecondsLeft)} remaining'),
            actions: [
              TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Resume')),
            ],
          );
        });
      },
    );
    localTimer?.cancel();
    setState(() {
      _inTimeout = false;
    });
    _resumeTimerIfNeeded();
  }
}

class SignaturePad extends StatefulWidget {
  const SignaturePad({super.key});

  @override
  State<SignaturePad> createState() => _SignaturePadState();
}

class _SignaturePadState extends State<SignaturePad> {
  final List<Offset?> _points = [];
  final GlobalKey _repaintKey = GlobalKey();

  Future<Uint8List?> export() async {
    final boundary = _repaintKey.currentContext?.findRenderObject() as RenderRepaintBoundary?;
    if (boundary == null) return null;
    final image = await boundary.toImage(pixelRatio: 3.0);
    final byteData = await image.toByteData(format: ui.ImageByteFormat.png);
    return byteData?.buffer.asUint8List();
  }

  @override
  Widget build(BuildContext context) {
    return RepaintBoundary(
      key: _repaintKey,
      child: Container(
        color: Colors.white,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onPanDown: (details) {
            final box = context.findRenderObject() as RenderBox?;
            if (box == null) return;
            final local = box.globalToLocal(details.globalPosition);
            setState(() {
              _points.add(local);
            });
          },
          onPanUpdate: (details) {
            final box = context.findRenderObject() as RenderBox?;
            if (box == null) return;
            final local = box.globalToLocal(details.globalPosition);
            setState(() {
              _points.add(local);
            });
          },
          onPanEnd: (_) {
            setState(() {
              _points.add(null);
            });
          },
          child: CustomPaint(
            painter: _SignaturePainter(_points),
            size: const Size(double.infinity, double.infinity),
          ),
        ),
      ),
    );
  }
}

class _SignaturePainter extends CustomPainter {
  final List<Offset?> points;

  _SignaturePainter(this.points);

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.black
      ..strokeWidth = 2.0
      ..strokeCap = StrokeCap.round;
    for (int i = 0; i < points.length - 1; i++) {
      final p1 = points[i];
      final p2 = points[i + 1];
      if (p1 != null && p2 != null) {
        canvas.drawLine(p1, p2, paint);
      }
    }
  }

  @override
  bool shouldRepaint(covariant _SignaturePainter oldDelegate) {
    return true;
  }
}
