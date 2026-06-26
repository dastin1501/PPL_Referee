import 'dart:math';
import 'package:flutter/material.dart';

class CoinTossDialog extends StatefulWidget {
  final String player1;
  final String player2;

  const CoinTossDialog({
    super.key,
    required this.player1,
    required this.player2,
  });

  @override
  State<CoinTossDialog> createState() => _CoinTossDialogState();
}

class _CoinTossDialogState extends State<CoinTossDialog> with SingleTickerProviderStateMixin {
  late AnimationController _controller;
  bool _isFlipping = false;
  String? _result; // 'Heads' or 'Tails'

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(seconds: 2),
      vsync: this,
    );
  }

  void _flipCoin() {
    setState(() {
      _isFlipping = true;
      _result = null;
    });
    _controller.forward(from: 0).then((_) {
      setState(() {
        _isFlipping = false;
        _result = Random().nextBool() ? 'Heads' : 'Tails';
      });
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Widget _coinFace(String asset) {
    return ClipOval(
      child: Image.asset(
        asset,
        fit: BoxFit.cover,
        errorBuilder: (context, error, stackTrace) {
          return const Center(
            child: Icon(Icons.monetization_on, size: 56, color: Colors.amber),
          );
        },
      ),
    );
  }

  String get _frontCoinAsset => 'assets/images/front.png';
  String get _backCoinAsset => 'assets/images/back.png';

  String get _coinResultAsset {
    return _result == 'Tails' ? _backCoinAsset : _frontCoinAsset;
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: null,
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Align(
              alignment: Alignment.topRight,
              child: IconButton(
                icon: const Icon(Icons.close),
                onPressed: () => Navigator.of(context).pop(),
              ),
            ),
            AnimatedBuilder(
              animation: _controller,
              builder: (context, child) {
                final value = _controller.value;
                final angle = value * pi * 10;
                final showBack = (angle % (2 * pi)) > pi;
                return GestureDetector(
                  onTap: _isFlipping ? null : _flipCoin,
                  child: Transform(
                    transform: Matrix4.identity()
                      ..setEntry(3, 2, 0.001)
                      ..rotateY(angle),
                    alignment: Alignment.center,
                    child: SizedBox(
                      width: 200,
                      height: 200,
                      child: ClipOval(
                        child: _isFlipping
                            ? _coinFace(showBack ? _backCoinAsset : _frontCoinAsset)
                            : _coinFace(_result == null ? _frontCoinAsset : _coinResultAsset),
                      ),
                    ),
                  ),
                );
              },
            ),
            const SizedBox(height: 16),
            if (_result != null) ...[
              Text(
                'Result: $_result',
                style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Colors.blueGrey),
              ),
            ],
          ],
        ),
      ),
      actions: [],
    );
  }
}
