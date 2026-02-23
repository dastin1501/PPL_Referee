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
      _score1 = g.score1;
      _score2 = g.score2;
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
    setState(() {
      _gameStarted = true;
      _elapsed = Duration.zero;
    });
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      setState(() {
        _elapsed += const Duration(seconds: 1);
      });
    });
    final app = context.read<AppState>();
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

  @override
  void dispose() {
    _timer?.cancel();
    SystemChrome.setPreferredOrientations([
      DeviceOrientation.portraitUp,
      DeviceOrientation.portraitDown,
    ]);
    super.dispose();
  }

  Widget _playerCell(String name, {Color color = const Color(0xFF0D9488), bool isServing = false}) {
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

    return Scaffold(
      appBar: AppBar(
        backgroundColor: const Color(0xFF0F766E),
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
              if (v == 'noshow_p1') {
                await _noShow(g, g.player1, g.player2);
              } else if (v == 'noshow_p2') {
                await _noShow(g, g.player2, g.player1);
              } else if (v == 'coin') {
                _showCoinTossDialog(g);
              }
            },
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'coin', child: Text('Coin Toss')),
              if (g != null) PopupMenuItem(value: 'noshow_p1', child: Text('No Show: ${g.player1}')),
              if (g != null) PopupMenuItem(value: 'noshow_p2', child: Text('No Show: ${g.player2}')),
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
                      final leftTop = leftTeam.isNotEmpty ? leftTeam[0] : leftTeamName;
                      final leftBottom = leftTeam.length > 1 ? leftTeam[1] : '';
                      final rightTop = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
                      final rightBottom = rightTeam.length > 1 ? rightTeam[0] : '';
                      final noServer = _servingPlayer == null;
                      final serverOnLeft = _servingPlayer != null && leftTeam.contains(_servingPlayer);
                      final serverOnRight = _servingPlayer != null && rightTeam.contains(_servingPlayer);
                      final serverRight = serverOnRight;
                      final serviceTop = _servingPlayer == null ? true : _serverTop;
                      return GestureDetector(
                        behavior: HitTestBehavior.opaque,
                        onTapDown: (details) {
                          if (_gameStarted) return;
                          final outerPad = 12.0;
                          final innerPad = 12.0;
                          final totalW = c.biggest.width;
                          final totalH = c.biggest.height;
                          final courtLeft = outerPad + innerPad;
                          final courtTop = outerPad + innerPad;
                          final courtW = totalW - (outerPad + innerPad) * 2;
                          final courtH = totalH - (outerPad + innerPad) * 2;
                          double x = details.localPosition.dx;
                          double y = details.localPosition.dy;
                          x = x.clamp(courtLeft, courtLeft + courtW);
                          y = y.clamp(courtTop, courtTop + courtH);
                          final leftHalf = x < courtLeft + courtW / 2;
                          final topHalf = y < courtTop + courtH / 2;
                          if (leftHalf) {
                            setState(() {
                              _servingPlayer = isDoubles ? (topHalf ? leftTop : leftBottom) : leftTop;
                            });
                          } else {
                            setState(() {
                              _servingPlayer = isDoubles ? (topHalf ? rightTop : rightBottom) : rightTop;
                            });
                          }
                        },
                        child: Container(
                        decoration: BoxDecoration(
                          gradient: const LinearGradient(
                            colors: [Color(0xFF0F766E), Color(0xFF10B981)],
                            begin: Alignment.topLeft,
                            end: Alignment.bottomRight,
                          ),
                          borderRadius: BorderRadius.circular(12),
                        ),
                        padding: const EdgeInsets.all(12),
                        child: Stack(
                          children: [
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
                                  '$_score1 - $_score2',
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
                                  child: Padding(
                                    padding: const EdgeInsets.all(8.0),
                                    child: _playerCell(
                                      rightBottom,
                                      isServing: _servingPlayer == rightBottom,
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
                                                        _serverTop = true;
                                                      }),
                                                      splashColor: Colors.white10,
                                                    ),
                                                  ),
                                                  Expanded(
                                                    child: InkWell(
                                                      onTap: () => setState(() {
                                                        _servingPlayer = leftBottom.isNotEmpty ? leftBottom : leftTop;
                                                        _serverTop = false;
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
                                                        _serverTop = true;
                                                      }),
                                                      splashColor: Colors.white10,
                                                    ),
                                                  ),
                                                  Expanded(
                                                    child: InkWell(
                                                      onTap: () => setState(() {
                                                        _servingPlayer = rightBottom.isNotEmpty ? rightBottom : rightTop;
                                                        _serverTop = false;
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
                      IconButton(onPressed: _onTimeout, icon: const Icon(Icons.timer)),
                      IconButton(onPressed: _onMedicalTimeout, icon: const Icon(Icons.healing)),
                      const Spacer(),
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
                          width: 160,
                          height: 56,
                          child: ElevatedButton(
                            onPressed: _sideOut,
                            style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade400, foregroundColor: Colors.white),
                            child: const Text('SIDE OUT', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
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
                                final bytes = await sigKey.currentState?.export();
                                final ok = await _finishSubmit(g, bytes);
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

  Future<bool> _finishSubmit(TournamentMatch g, Uint8List? signatureBytes) async {
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
      'game1Player1': _score1,
      'game1Player2': _score2,
      'status': 'Completed',
    };
    if (winnerName.isNotEmpty) {
      fields['winner'] = winnerName;
    }
    if (signatureData != null) {
      fields['signatureData'] = signatureData;
      fields['gameSignatures'] = [signatureData, null, null];
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
  _Snapshot(this.s1, this.s2, this.server, this.serverTop, this.t1, this.t2, this.mt1, this.mt2);
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

extension on _RefereeDashboardScreenState {
  void _pushSnapshot() {
    _history.add(_Snapshot(_score1, _score2, _servingPlayer, _serverTop, _timeouts1, _timeouts2, _medTimeouts1, _medTimeouts2));
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
      } else {
        _score2 += 1;
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
      } else if (!_serverOnTeam1(g) && _score2 > 0) {
        _score2 -= 1;
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
      if (wasOnLeft) {
        _servingPlayer = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
        _serverTop = (_score2 % 2 == 0);
      } else {
        _servingPlayer = leftTeam[0];
        _serverTop = (_score1 % 2 != 0);
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
