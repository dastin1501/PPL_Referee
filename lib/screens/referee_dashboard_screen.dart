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
  Duration _elapsed = Duration.zero;
  Timer? _timer;
  final List<_Snapshot> _history = [];
  int _timeouts1 = 0;
  int _timeouts2 = 0;

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
      if (g.status == 'Ongoing') {
        setState(() {
          _gameStarted = true;
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
      child: Container(
        decoration: BoxDecoration(
          color: color.withOpacity(0.92),
          borderRadius: BorderRadius.circular(10),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withOpacity(0.25),
              blurRadius: 8,
              offset: const Offset(0, 3),
            ),
          ],
        ),
        padding: const EdgeInsets.all(12),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    name, 
                    style: const TextStyle(color: Colors.white, fontSize: 18, fontWeight: FontWeight.bold),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                if (isServing)
                  const Padding(
                    padding: EdgeInsets.only(left: 8.0),
                    child: Icon(Icons.sports_tennis, color: Colors.yellowAccent, size: 24),
                  ),
              ],
            ),
            const SizedBox(height: 6),
            Text(
              isServing ? 'Serving' : '',
              style: const TextStyle(color: Colors.white70),
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
        title: Text('Court ${app.selectedCourt ?? ''}'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(48),
          child: Container(
            color: const Color(0xFF0F766E),
            height: 48,
            alignment: Alignment.center,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0xFF0E7C6F),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: Colors.white70, width: 2),
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Text('TIME', style: TextStyle(color: Colors.white70, fontWeight: FontWeight.w600)),
                  Text(
                    timerText,
                    style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold, fontSize: 14),
                  ),
                ],
              ),
            ),
          ),
        ),
        actions: [
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
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: LayoutBuilder(builder: (_, c) {
                      final String leftTeamName = g.player1;
                      final String rightTeamName = g.player2;
                      final leftTeam = _splitTeam(leftTeamName);
                      final rightTeam = _splitTeam(rightTeamName);
                      final bool isDoubles = leftTeam.length > 1 || rightTeam.length > 1;
                      final leftTop = leftTeam.isNotEmpty ? leftTeam[0] : leftTeamName;
                      final leftBottom = leftTeam.length > 1 ? leftTeam[1] : '';
                      final rightTop = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
                      final rightBottom = rightTeam.length > 1 ? rightTeam[0] : '';
                      final serverRight = _servingPlayer != null
                          ? ((leftTeam.contains(_servingPlayer)) ? (_score1 % 2 == 0) : (_score2 % 2 == 0))
                          : true;
                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Expanded(
                            child: LayoutBuilder(
                              builder: (_, cons) {
                                final sz = cons.biggest;
                                return GestureDetector(
                                  behavior: HitTestBehavior.opaque,
                                  onTapDown: null,
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
                                            painter: _SinglesCourtPainter(highlightRight: serverRight),
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
                                          alignment: Alignment.topLeft,
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
                                          alignment: Alignment.topRight,
                                          child: FractionallySizedBox(
                                            widthFactor: 0.5,
                                            heightFactor: 0.5,
                                            child: Padding(
                                              padding: const EdgeInsets.all(8.0),
                                              child: _playerCell(
                                                rightTop,
                                                isServing: _servingPlayer == rightTop,
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
                                      ],
                                    ),
                                  ),
                                );
                              },
                            ),
                          ),
                        ],
                      );
                    }),
                  ),
                ),
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
                          onPressed: _gameStarted ? _decrementPoint : null,
                          style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade400, foregroundColor: Colors.white),
                          child: const Text('-', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                        ),
                      ),
                      SizedBox(
                        width: 160,
                        height: 56,
                        child: ElevatedButton(
                          onPressed: _gameStarted ? _sideOut : null,
                          style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade400, foregroundColor: Colors.white),
                          child: const Text('SIDE OUT', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
                        ),
                      ),
                      SizedBox(
                        width: 120,
                        height: 56,
                        child: ElevatedButton(
                          onPressed: _gameStarted ? _incrementPoint : null,
                          style: ElevatedButton.styleFrom(backgroundColor: Colors.grey.shade400, foregroundColor: Colors.white),
                          child: const Text('+', style: TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  color: const Color(0xFF0F766E),
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: SizedBox(
                          height: 56,
                          child: ElevatedButton.icon(
                            onPressed: !_gameStarted && _servingPlayer != null ? _startGame : (_gameStarted ? () => _showSubmitDialog(g) : null),
                            style: ElevatedButton.styleFrom(
                              backgroundColor: !_gameStarted ? const Color(0xFF10B981) : Colors.orange,
                              disabledBackgroundColor: Colors.grey[700],
                              foregroundColor: Colors.white,
                            ),
                            icon: Icon(!_gameStarted ? Icons.play_arrow : Icons.flag, size: 30),
                            label: Text(!_gameStarted ? 'START GAME' : 'SUBMIT', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
                          ),
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
  _Snapshot(this.s1, this.s2, this.server);
}

class _SinglesCourtPainter extends CustomPainter {
  final bool highlightRight;
  _SinglesCourtPainter({required this.highlightRight});
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
    final rightRect = Rect.fromLTWH(midX, rect.top, rect.width / 2, rect.height / 2);
    final leftRect = Rect.fromLTWH(rect.left, rect.top, rect.width / 2, rect.height / 2);
    final hl = Paint()..color = Colors.yellow.withOpacity(0.15);
    canvas.drawRect(highlightRight ? rightRect : leftRect, hl);
  }
  @override
  bool shouldRepaint(covariant _SinglesCourtPainter oldDelegate) => oldDelegate.highlightRight != highlightRight;
}

extension on _RefereeDashboardScreenState {
  void _pushSnapshot() {
    _history.add(_Snapshot(_score1, _score2, _servingPlayer));
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
      final onLeft = leftTeam.contains(_servingPlayer);
      if (onLeft) {
        _servingPlayer = rightTeam.length > 1 ? rightTeam[1] : rightTeam[0];
      } else {
        _servingPlayer = leftTeam[0];
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
      builder: (_) => SimpleDialog(
        title: const Text('Timeout'),
        children: [
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'p1'), child: Text(g.player1)),
          SimpleDialogOption(onPressed: () => Navigator.pop(context, 'p2'), child: Text(g.player2)),
        ],
      ),
    );
    if (who == 'p1') {
      setState(() {
        _timeouts1 += 1;
      });
    } else if (who == 'p2') {
      setState(() {
        _timeouts2 += 1;
      });
    }
  }

  void _onMedicalTimeout() async {
    final app = context.read<AppState>();
    final g = app.selectedGame;
    if (g == null) return;
    await showDialog<void>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Medical Timeout'),
        content: const Text('Medical timeout noted.'),
        actions: [TextButton(onPressed: () => Navigator.pop(context), child: const Text('OK'))],
      ),
    );
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
